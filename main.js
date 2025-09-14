import fetch from "node-fetch";
import fs from "fs-extra";
import path from "path";
import AdmZip from "adm-zip";
import promptSync from "prompt-sync";
import translate from "google-translate-api-x";

const VERSION_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const OUTPUT_JAR = "client.jar";
const OUTPUT_DIR = "assets_extracted";
const TARGET_FILE = "assets/minecraft/lang/en_us.json";
const RESOURCE_DIR = "output_resource_pack";

async function getLanguages() {
    return Object.keys(translate.languages);
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

// Delay helper
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Concurrent translation queue with start delays and retry delays
async function translateQueue(items, workerCount, translator, startDelay = 0, retryDelay = 10000) {
    if (!workerCount) {
        // Unlimited concurrency
        return Promise.all(items.map((item, i) => translator(item, i)));
    }

    let index = 0;
    const results = [];
    async function worker(workerIndex) {
        if (startDelay) await sleep(workerIndex * startDelay); // stagger start

        while (index < items.length) {
            const i = index++;
            while (true) {
                try {
                    results[i] = await translator(items[i], i);
                    break; // success
                } catch (err) {
                    console.error(`⚠️ Translation failed at index ${i}, retrying in ${retryDelay / 1000}s...`);
                    await sleep(retryDelay);
                }
            }
        }
    }
    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    return results;
}

async function translateJsonConcurrent(obj, times = 1, languages = [], threads = 5, startDelay = 0, retryDelay = 10000, pathPrefix = "") {
    if (Array.isArray(obj)) {
        return translateQueue(
            obj.map((v, i) => ({ value: v, path: `${pathPrefix}[${i}]` })),
            threads,
            async ({ value, path }) => translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, path)
        );
    } else if (obj && typeof obj === "object") {
        const keys = Object.keys(obj);
        const translatedValues = await translateQueue(
            keys.map(key => ({ key, value: obj[key], path: pathPrefix ? `${pathPrefix}.${key}` : key })),
            threads,
            async ({ key, value, path }) => ({
                key,
                value: await translateJsonConcurrent(value, times, languages, threads, startDelay, retryDelay, path)
            })
        );
        return translatedValues.reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
    } else if (typeof obj === "string") {
        let text = obj;
        for (let i = 0; i < times; i++) {
            const lang = languages[Math.floor(Math.random() * languages.length)];
            const attempt = async () => {
                const res = await translate(text, { to: lang });
                console.log(`🔹 [${pathPrefix}] Pass ${i + 1} -> ${lang}: "${text}" => "${res.text}"`);
                text = res.text;
            };
            try {
                await attempt();
            } catch (err) {
                console.error(`⚠️ Translation error at ${pathPrefix}, retrying in ${retryDelay / 1000}s...`);
                await sleep(retryDelay);
                await attempt();
            }
        }
        try {
            const back = await translate(text, { to: "en" });
            console.log(`🔸 [${pathPrefix}] Back to English: "${text}" => "${back.text}"`);
            text = back.text;
        } catch (err) {
            console.error(`⚠️ Back-to-English error at ${pathPrefix}:`, err.message);
        }
        return text;
    } else {
        return obj;
    }
}

async function main() {
    await cleanup();
    const { versions, manifest } = await getVersions();
    const prompt = promptSync();

    const version = process.argv[2] || prompt("Enter Minecraft version (leave blank for latest release): ").trim() || manifest.latest.release;
    const repeatCount = parseInt(process.argv[3] || prompt("Enter number of translation passes: ").trim() || "3");

    if (!versions.find(v => v.id === version)) {
        console.log("❌ Invalid version ID.");
        return;
    }

    const { jarPath, versionInfo } = await downloadJar(version, manifest);
    const langPath = await extractLang(jarPath);
    if (!langPath) return;

    const langJson = await fs.readJson(langPath);
    const totalEntries = Object.keys(langJson).length;
    console.log(`📝 Lang file contains ${totalEntries} entries.`);

    // Threads
    let threadsInput = process.argv[4] || prompt(`Enter number of concurrent threads (blank = unlimited, default = default): `).trim();
    const threads = threadsInput.toLowerCase() === "default" || threadsInput === "" ? 0 : parseInt(threadsInput);

    // Start delay
    let startDelayInput = process.argv[5] || prompt(`Enter start delay per thread in ms (blank = default based on repeatCount, default = default): `).trim();
    const defaultStartDelay = repeatCount * 50; // default 50ms per translation
    const startDelay = startDelayInput.toLowerCase() === "default" || startDelayInput === "" ? defaultStartDelay : parseInt(startDelayInput);

    // Retry delay
    let retryDelayInput = process.argv[6] || prompt(`Enter retry delay in ms (blank = 10000ms, default = default): `).trim();
    const retryDelay = retryDelayInput.toLowerCase() === "default" || retryDelayInput === "" ? 10000 : parseInt(retryDelayInput);

    // Create resource pack
    await fs.ensureDir(RESOURCE_DIR);
    const extractedAssetsDir = path.join(OUTPUT_DIR, "assets");
    if (await fs.pathExists(extractedAssetsDir)) {
        await fs.copy(extractedAssetsDir, path.join(RESOURCE_DIR, "assets"));
    }

    const packMcmeta = {
        pack: {
            pack_format: versionInfo.assetIndex?.id || "1",
            description: `Google Translated Minecraft ${version}`,
        }
    };
    await fs.writeJson(path.join(RESOURCE_DIR, "pack.mcmeta"), packMcmeta, { spaces: 4 });

    console.log(`✅ Resource pack created at ${RESOURCE_DIR}`);
    console.log(`🔄 Starting concurrent Google translation with ${threads || "unlimited"} threads...`);

    const languages = await getLanguages();
    const translatedJson = await translateJsonConcurrent(langJson, repeatCount, languages, threads, startDelay, retryDelay);
    await fs.writeJson(langPath, translatedJson, { spaces: 4 });

    console.log(`✅ Translated file saved: ${langPath}`);
    console.log("🎉 All done!");
    console.log("You can now put the output_resource_pack folder into your Minecraft resourcepacks folder and enable it in-game.");
}

main().catch(err => console.error(err));
