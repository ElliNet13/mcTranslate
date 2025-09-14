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
    .argv;

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

async function cleanup() {
    await fs.remove(OUTPUT_JAR);
    await fs.remove(OUTPUT_DIR);
    await fs.remove(RESOURCE_DIR);
}

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

async function translateQueue(items, workerCount, translator, startDelay = 0, retryDelay = 10000) {
    if (!workerCount) return Promise.all(items.map((item, i) => translator(item, i)));

    let index = 0;
    const results = [];
    async function worker(workerIndex) {
        if (startDelay) await sleep(workerIndex * startDelay);

        while (index < items.length) {
            const i = index++;
            while (true) {
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

async function translateJsonConcurrent(obj, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, pathPrefix = "") {
    if (Array.isArray(obj)) {
        return translateQueue(
            obj.map((v, i) => ({ value: v, path: `${pathPrefix}[${i}]` })),
            threads,
            async ({ value, path }) => translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, path)
        );
    } else if (obj && typeof obj === "object") {
        const keys = Object.keys(obj);
        const translatedValues = await translateQueue(
            keys.map(key => ({ key, value: obj[key], path: pathPrefix ? `${pathPrefix}.${key}` : key })),
            threads,
            async ({ key, value, path }) => ({
                key,
                value: await translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, transEngine, engine, extraArgs, path)
            })
        );
        return translatedValues.reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
    } else if (typeof obj === "string") {
        let text = obj;
        for (let i = 0; i < times; i++) {
            const lang = languages[Math.floor(Math.random() * languages.length)];
            const attempt = async () => {
                if (transEngine === "translate-shell") {
                    text = await transShellTranslate(text, lang, engine, extraArgs);
                } else {
                    const res = await translate(text, { to: lang });
                    text = res.text;
                }
                console.log(`🔹 [${pathPrefix}] Pass ${i + 1} -> ${lang}: "${text}"`);
            };
            try {
                await attempt();
            } catch {
                await sleep(retryDelay);
                await attempt();
            }
        }
        try {
            if (transEngine === "translate-shell") {
                text = await transShellTranslate(text, "en", engine, extraArgs);
            } else {
                const back = await translate(text, { to: "en" });
                text = back.text;
            }
            console.log(`🔸 [${pathPrefix}] Back to English: "${text}"`);
        } catch {}
        return text;
    } else return obj;
}

async function main() {
    await cleanup();
    const { versions, manifest } = await getVersions();

    const version = argv.mcVersion || manifest.latest.release;
    const repeatCount = argv.repeat;
    const threads = argv.threads;
    const startDelay = argv.startDelay || repeatCount * 50;
    const retryDelay = argv.retryDelay;
    const transEngine = argv.transEngine;
    const extraArgs = argv.extraTransArgs;
    const engine = argv.engine;

    if (!versions.find(v => v.id === version)) {
        console.log("❌ Invalid version ID.");
        return;
    }

    const { jarPath, versionInfo } = await downloadJar(version, manifest);
    const langPath = await extractLang(jarPath);
    if (!langPath) return;

    const langJson = await fs.readJson(langPath);
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

    console.log(`✅ Resource pack created at ${RESOURCE_DIR}`);

    const languages = await getLanguages(transEngine, engine);
    console.log(`🌐 Loaded ${languages.length} languages for translation.`);

    console.log(`🔄 Starting translation with ${threads || "unlimited"} threads using ${transEngine}...`);
    const translatedJson = await translateJsonConcurrent(
        langJson,
        repeatCount,
        languages,
        threads,
        startDelay,
        retryDelay,
        transEngine,
        engine,
        extraArgs
    );
    await fs.writeJson(langPath, translatedJson, { spaces: 4 });

    console.log(`✅ Translated file saved: ${langPath}`);
    console.log("🎉 All done!");
}

main().catch(err => console.error(err));
