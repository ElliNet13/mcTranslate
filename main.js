import fetch from "node-fetch";
import fs from "fs-extra";
import path from "path";
import AdmZip from "adm-zip";
import { exec } from "child_process";
import translate from "google-translate-api-x";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

const VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const OUTPUT_JAR = "client.jar";
const OUTPUT_DIR = "assets_extracted";
const TARGET_FILE = "assets/minecraft/lang/en_us.json";
const RESOURCE_DIR = "output_resource_pack";
const RESUME_FILE = ".translation_resume.json";

// CLI args
const argv = yargs(hideBin(process.argv))
    .option("mcVersion", { type: "string", describe: "Minecraft version" })
    .option("repeat", { type: "number", default: 20, describe: "Number of translation passes" })
    .option("threads", { type: "number", default: 10, describe: "Concurrent threads (0 = unlimited)" })
    .option("startDelay", { type: "number", default: 0, describe: "Start delay per thread (ms)" })
    .option("retryDelay", { type: "number", default: 10000, describe: "Retry delay for failed translations (ms)" })
    .option("transEngine", { type: "string", default: "google-api", describe: "Translation engine: google-api or translate-shell" })
    .option("extraTransArgs", { type: "string", default: "", describe: "Extra arguments to pass to trans when using translate-shell" })
    .option("engine", { type: "string", default: "google", describe: "Engine to pass to trans via -engine when using translate-shell" })
    .option("resume", { type: "boolean", default: false, describe: "Resume from last saved progress" })
    .argv;

let isExiting = false;
process.on("SIGINT", () => {
    console.log("\n⚠️ Ctrl+C detected, saving progress...");
    isExiting = true;
});

// Helper sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fetch languages
async function getLanguages(transEngine, engine) {
    if (transEngine === "translate-shell") {
        return new Promise((resolve, reject) => {
            exec(`trans -R ${engine} -list-codes`, (err, stdout) => {
                if (err) return reject(err);
                const langs = stdout.split("\n").map(l => l.trim()).filter(l => l);
                resolve(langs);
            });
        });
    } else {
        return Object.keys(translate.languages);
    }
}

// Cleanup output
async function cleanup() {
    await fs.remove(OUTPUT_JAR);
    await fs.remove(OUTPUT_DIR);
    await fs.remove(RESOURCE_DIR);
}

// Download versions
async function getVersions() {
    const res = await fetch(VERSION_MANIFEST);
    const manifest = await res.json();
    return { versions: manifest.versions, manifest };
}

async function downloadJar(version, manifest) {
    const versionInfoUrl = manifest.versions.find(v => v.id === version).url;
    const versionInfo = await (await fetch(versionInfoUrl)).json();
    const clientUrl = versionInfo.downloads.client.url;

    console.log(`⬇️  Downloading Minecraft ${version} client jar...`);
    const data = Buffer.from(await (await fetch(clientUrl)).arrayBuffer());
    await fs.writeFile(OUTPUT_JAR, data);
    console.log(`✅ Saved as ${OUTPUT_JAR}`);

    return { jarPath: OUTPUT_JAR, versionInfo };
}

async function extractLang(jarPath, outputDir = OUTPUT_DIR, target = TARGET_FILE) {
    const zip = new AdmZip(jarPath);
    const entry = zip.getEntry(target);

    if (entry) {
        const fullPath = path.join(outputDir, entry.entryName);
        await fs.ensureDir(path.dirname(fullPath));
        fs.writeFileSync(fullPath, entry.getData());
        console.log(`✅ Extracted ${target} to ${fullPath}`);
        return fullPath;
    } else {
        console.log(`❌ ${target} not found in ${jarPath}`);
        return null;
    }
}

// Translate using translate-shell
function transShellTranslate(text, toLang, engine, extraArgs) {
    return new Promise((resolve, reject) => {
        const cmd = `trans ${extraArgs} -engine ${engine} --brief :${toLang} "${text.replace(/"/g, '\\"')}"`;
        exec(cmd, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
        });
    });
}

// Queue processing
async function translateQueue(items, workerCount, translator, startDelay = 0, retryDelay = 10000) {
    if (!workerCount) return Promise.all(items.map((item, i) => translator(item, i)));

    let index = 0;
    const results = [];
    async function worker(workerIndex) {
        if (startDelay) await sleep(workerIndex * startDelay);

        while (index < items.length && !isExiting) {
            const i = index++;
            while (!isExiting) {
                try {
                    results[i] = await translator(items[i], i);
                    break;
                } catch {
                    await sleep(retryDelay);
                }
            }
        }
    }
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    return results;
}

// Recursive translation with resume support
async function translateJsonConcurrent(obj, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, pathPrefix = "", progress = {}) {
    if (Array.isArray(obj)) {
        return translateQueue(
            obj.map((v, i) => ({ value: v, path: `${pathPrefix}[${i}]` })),
            threads,
            async ({ value, path }) => translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, path, progress)
        );
    } else if (obj && typeof obj === "object") {
        const keys = Object.keys(obj);
        const translatedValues = await translateQueue(
            keys.map(key => ({ key, value: obj[key], path: pathPrefix ? `${pathPrefix}.${key}` : key })),
            threads,
            async ({ key, value, path }) => ({
                key,
                value: await translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, path, progress)
            })
        );
        return translatedValues.reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
    } else if (typeof obj === "string") {
        const uniquePath = pathPrefix;
        if (!progress[uniquePath]) progress[uniquePath] = 0;
        let text = obj;

        for (let i = progress[uniquePath]; i < times && !isExiting; i++) {
            let lang = languages[Math.floor(Math.random() * languages.length)];
            let attemptSucceeded = false;

            while (!attemptSucceeded && !isExiting) {
                try {
                    if (transEngine === "translate-shell") {
                        text = await transShellTranslate(text, lang, engine, extraArgs);
                    } else {
                        const res = await translate(text, { to: lang });
                        text = res.text;
                    }

                    if (!text) throw new Error("Empty translation, retrying...");
                    console.log(`🔹 [${uniquePath}] Pass ${i + 1} -> ${lang}: "${text}"`);
                    attemptSucceeded = true;
                } catch {
                    await sleep(retryDelay);
                    lang = languages[Math.floor(Math.random() * languages.length)]; // rechoose lang
                }
            }

            progress[uniquePath] = i + 1;

            // Save progress
            if (isExiting) {
                await fs.writeJson(RESUME_FILE, { json: obj, progress, argv: argv }, { spaces: 4 });
                process.exit();
            }
        }

        // Translate back to English at the end
        try {
            if (transEngine === "translate-shell") {
                text = await transShellTranslate(text, "en", engine, extraArgs);
            } else {
                const back = await translate(text, { to: "en" });
                text = back.text;
            }
            console.log(`🔸 [${uniquePath}] Back to English: "${text}"`);
        } catch {}
        return text;
    } else return obj;
}

// Main
async function main() {
    let resumeData = null;
    if (argv.resume && await fs.pathExists(RESUME_FILE)) {
        resumeData = await fs.readJson(RESUME_FILE);
        console.log("🔄 Resuming from last saved progress...");
    }

    if (!resumeData) {
        await cleanup();
    }

    const { versions, manifest } = await getVersions();

    const version = resumeData?.argv?.mcVersion || argv.mcVersion || manifest.latest.release;
    const repeatCount = resumeData?.argv?.repeat || argv.repeat;
    const threads = resumeData?.argv?.threads || argv.threads;
    const startDelay = resumeData?.argv?.startDelay || argv.startDelay || repeatCount * 50;
    const retryDelay = resumeData?.argv?.retryDelay || argv.retryDelay;
    const transEngine = resumeData?.argv?.transEngine || argv.transEngine;
    const extraArgs = resumeData?.argv?.extraTransArgs || argv.extraTransArgs;
    const engine = resumeData?.argv?.engine || argv.engine;

    if (!versions.find(v => v.id === version)) {
        console.log("❌ Invalid version ID.");
        return;
    }

    const { jarPath, versionInfo } = await downloadJar(version, manifest);
    const langPath = await extractLang(jarPath);
    if (!langPath) return;

    let langJson = resumeData?.json || await fs.readJson(langPath);
    console.log(`📝 Lang file contains ${Object.keys(langJson).length} entries.`);

    await fs.ensureDir(RESOURCE_DIR);
    const extractedAssetsDir = path.join(OUTPUT_DIR, "assets");
    if (await fs.pathExists(extractedAssetsDir)) {
        await fs.copy(extractedAssetsDir, path.join(RESOURCE_DIR, "assets"));
    }

    const packMcmeta = {
        pack: {
            pack_format: versionInfo.assetIndex?.id || "1",
            description: `Translated Minecraft ${version}`,
        }
    };
    await fs.writeJson(path.join(RESOURCE_DIR, "pack.mcmeta"), packMcmeta, { spaces: 4 });

    const languages = await getLanguages(transEngine, engine);
    console.log(`🌐 Loaded ${languages.length} languages for translation.`);

    const progress = resumeData?.progress || {};
    const translatedJson = await translateJsonConcurrent(
        langJson,
        repeatCount,
        languages,
        threads,
        startDelay,
        retryDelay,
        transEngine,
        engine,
        extraArgs,
        "",
        progress
    );

    await fs.writeJson(langPath, translatedJson, { spaces: 4 });
    if (await fs.pathExists(RESUME_FILE)) await fs.remove(RESUME_FILE);

    console.log(`✅ Translated file saved: ${langPath}`);
    console.log("🎉 All done!");
}

main().catch(err => console.error(err));
