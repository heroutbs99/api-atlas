import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, "data", "apis.json");
const reportPath = join(root, "data", "link-check-report.json");
const timeoutMs = Number(process.env.LINK_TIMEOUT_MS || 9000);
const concurrency = Number(process.env.LINK_CONCURRENCY || 24);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const apis = Array.isArray(catalog.apis) ? catalog.apis : [];
const urls = uniqueUrls(apis);

const results = [];
let cursor = 0;

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < urls.length) {
    const index = cursor;
    cursor += 1;
    results[index] = await checkUrl(urls[index]);
    if ((index + 1) % 250 === 0) {
      console.log(`Checked ${(index + 1).toLocaleString()} / ${urls.length.toLocaleString()} links`);
    }
  }
}));

const byUrl = new Map(results.map((result) => [result.url, result]));
const problemApis = [];

for (const api of apis) {
  const checkedUrls = [api.url, api.openApiUrl].filter(Boolean);
  const issues = checkedUrls
    .map((url) => byUrl.get(url))
    .filter((result) => result && !result.ok);

  if (issues.length) {
    problemApis.push({
      name: api.name,
      provider: api.provider,
      category: api.category,
      sources: api.sources || [api.source].filter(Boolean),
      links: issues
    });
  }
}

const report = {
  checkedAt: new Date().toISOString(),
  timeoutMs,
  concurrency,
  totalApis: apis.length,
  totalUrls: urls.length,
  okUrls: results.filter((result) => result.ok).length,
  problemUrls: results.filter((result) => !result.ok).length,
  problemApis: problemApis.length,
  problems: problemApis
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (report.problemUrls) {
  console.error(`Found ${report.problemUrls.toLocaleString()} problem links. See ${reportPath}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${report.totalUrls.toLocaleString()} catalog links.`);
}

function uniqueUrls(rows) {
  const seen = new Set();
  const output = [];

  for (const api of rows) {
    for (const url of [api.url, api.openApiUrl]) {
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      output.push(url);
    }
  }

  return output;
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 API Atlas link verifier"
      }
    });
    clearTimeout(timer);

    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("text/html") ? await response.text() : "";
    const deadEndReason = body ? detectDeadEnd(body, response.url) : "";
    const statusOk = response.status < 400 || [401, 403, 405, 429].includes(response.status);

    return {
      url,
      finalUrl: response.url,
      status: response.status,
      ok: statusOk && !deadEndReason,
      reason: !statusOk ? `HTTP ${response.status}` : deadEndReason
    };
  } catch (error) {
    clearTimeout(timer);
    return {
      url,
      finalUrl: "",
      status: 0,
      ok: false,
      reason: error.name || error.message
    };
  }
}

function detectDeadEnd(html, finalUrl) {
  const title = html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis)]
    .slice(0, 5)
    .map((match) => match[1])
    .join(" ");
  const signal = `${title} ${headings} ${html.slice(0, 1500)}`
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const finalPath = (() => {
    try {
      return new URL(finalUrl).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const titleText = title.toLowerCase();
  if (/page not found|not found|404|410/.test(titleText) && /not found|page not found|missing|404|410/.test(signal)) {
    return "not found page";
  }
  if (/page not found|404 page|404 error|does not exist|we can't find|we could not find|this page is unavailable/.test(signal)) {
    return "not found page";
  }
  if (/domain for sale|buy this domain|parked domain|expired domain/.test(signal)) {
    return "parked or expired domain";
  }
  if (/access denied|blocked by cloudflare|just a moment/.test(signal) && /\/api|\/docs|\/developer|\/reference/.test(finalPath)) {
    return "";
  }

  return "";
}
