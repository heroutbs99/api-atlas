import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const curatedPath = join(root, "data", "curated-popular-apis.json");
const timeoutMs = 12000;

const payload = JSON.parse(await readFile(curatedPath, "utf8"));
const entries = payload.entries || [];
const results = [];

for (let i = 0; i < entries.length; i += 8) {
  const batch = entries.slice(i, i + 8);
  results.push(...await Promise.all(batch.map(checkEntry)));
}

const failures = results.filter((result) => !result.ok);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`Verified ${results.length.toLocaleString()} curated API links.`);
}

async function checkEntry(entry) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(entry.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 API Atlas link verifier"
      }
    });
    clearTimeout(timer);

    return {
      name: entry.name,
      url: entry.url,
      status: response.status,
      ok: response.status < 400 || response.status === 403,
      finalUrl: response.url
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      name: entry.name,
      url: entry.url,
      status: 0,
      ok: false,
      error: error.name || error.message
    };
  }
}
