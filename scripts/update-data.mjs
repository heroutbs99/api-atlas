import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(root, "data", "apis.json");
const denylistPath = join(root, "data", "dead-hosts.json");
const curatedPath = join(root, "data", "curated-popular-apis.json");
const linkQualityPath = join(root, "data", "link-quality-rules.json");

// Hosts confirmed dead by a connectivity sweep (cannot resolve / cannot connect).
// Excluded on every build so dead domains don't creep back in. See data/dead-hosts.json.
async function loadDenylist() {
  try {
    const parsed = JSON.parse(await readFile(denylistPath, "utf8"));
    return new Set(parsed.hosts || []);
  } catch {
    return new Set();
  }
}

const sources = {
  apiGuru: {
    name: "APIs.guru",
    url: "https://api.apis.guru/v2/list.json",
    homepage: "https://apis.guru/"
  },
  publicApiLists: {
    name: "Public API Lists",
    url: "https://public-api-lists.github.io/public-api-lists/api/all.json",
    homepage: "https://public-api-lists.github.io/public-api-lists/"
  },
  curatedPopular: {
    name: "Curated Popular APIs",
    url: "data/curated-popular-apis.json",
    homepage: "./data/curated-popular-apis.json"
  }
};

async function main() {
  const [apiGuru, publicApiLists, curatedPopular, linkQuality] = await Promise.all([
    fetchJson(sources.apiGuru.url),
    fetchJson(sources.publicApiLists.url),
    loadCuratedPopular(),
    loadLinkQuality()
  ]);

  const records = [
    ...fromApiGuru(apiGuru),
    ...fromPublicApiLists(publicApiLists),
    ...fromCuratedPopular(curatedPopular)
  ];

  const deny = await loadDenylist();
  const apis = dedupe(records)
    .map((api) => applyLinkQuality(api, linkQuality))
    .filter((api) => api.url || api.openApiUrl)
    .filter((api) => {
      const hosts = cleanList([
        hostFromUrl(api.url),
        hostFromUrl(api.openApiUrl),
        hostFromProvider(api.provider)
      ]);
      return hosts.every((host) => !isReservedHost(host) && !deny.has(host));
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const catalog = {
    generatedAt: new Date().toISOString(),
    sources: Object.values(sources),
    stats: {
      total: apis.length,
      categories: new Set(apis.map((api) => api.category).filter(Boolean)).size,
      withOpenApiSpecs: apis.filter((api) => api.openApiUrl).length,
      sourceEntries: records.length
    },
    apis
  };

  // Write minified. The client rebuilds a search index on load, so we omit the
  // per-record searchText field here — it duplicated ~2.4MB of catalog text.
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(catalog)}\n`);

  console.log(`Wrote ${apis.length.toLocaleString()} APIs to ${outputPath}`);
}

async function loadCuratedPopular() {
  try {
    return JSON.parse(await readFile(curatedPath, "utf8"));
  } catch {
    return { entries: [] };
  }
}

async function loadLinkQuality() {
  try {
    const parsed = JSON.parse(await readFile(linkQualityPath, "utf8"));
    return {
      replacements: parsed.replacements || {},
      deadLinks: new Set(parsed.deadLinks || [])
    };
  } catch {
    return { replacements: {}, deadLinks: new Set() };
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "api-atlas-data-refresh"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function fromApiGuru(payload) {
  return Object.entries(payload).flatMap(([id, entry]) => {
    const version = entry.versions?.[entry.preferred] || Object.values(entry.versions || {})[0];
    if (!version) {
      return [];
    }

    const info = version.info || {};
    const categories = info["x-apisguru-categories"] || [];
    const provider = info["x-providerName"] || providerFromApiGuruId(id);
    const openApiUrl = firstUrl([version.link, version.swaggerUrl]);
    const url = bestApiGuruUrl(info, version, provider, openApiUrl);
    const logo = info["x-logo"]?.url || "";

    return [{
      id: `apis-guru:${id}`,
      name: clean(info.title || provider || id),
      description: clean(info.description || ""),
      category: titleCase(categories[0] || "OpenAPI"),
      provider: clean(provider || ""),
      url,
      auth: "Unknown",
      cors: "Unknown",
      https: url ? url.startsWith("https://") : true,
      source: sources.apiGuru.name,
      sources: [sources.apiGuru.name],
      openApiUrl,
      logo,
      updatedAt: version.updated || entry.added || "",
      tags: cleanList([
        ...categories,
        version.openapiVer ? `OpenAPI ${version.openapiVer}` : "",
        provider
      ])
    }];
  });
}

function bestApiGuruUrl(info, version, provider, openApiUrl) {
  const candidates = [
    info.externalDocs?.url,
    info.contact?.url,
    provider ? `https://${provider}` : ""
  ]
    .map((url) => firstUrl([url]))
    .filter(Boolean);

  const apiInfoUrl = candidates.find((url) => isApiInfoUrl(url) && !isDeadEndishUrl(url));
  if (apiInfoUrl) {
    return apiInfoUrl;
  }

  const nonDeadEndUrl = candidates.find((url) => !isDeadEndishUrl(url));
  return openApiUrl || nonDeadEndUrl || "";
}

function fromPublicApiLists(payload) {
  return (payload.entries || []).map((entry) => ({
    id: `public-api-lists:${slugify(`${entry.name}-${entry.url}`)}`,
    name: clean(entry.name || ""),
    description: clean(entry.description || ""),
    category: titleCase(entry.category || "Uncategorized"),
    provider: hostFromUrl(entry.url),
    url: firstUrl([entry.url]),
    auth: clean(entry.auth || "Unknown"),
    cors: clean(entry.cors || "Unknown"),
    https: Boolean(entry.https),
    source: sources.publicApiLists.name,
    sources: [sources.publicApiLists.name],
    openApiUrl: "",
    logo: "",
    updatedAt: "",
    tags: cleanList([entry.category, entry.auth, entry.cors])
  }));
}

function fromCuratedPopular(payload) {
  return (payload.entries || []).map((entry) => ({
    id: `curated-popular:${slugify(`${entry.name}-${entry.url}`)}`,
    name: clean(entry.name || ""),
    description: clean(entry.description || ""),
    category: titleCase(entry.category || "Uncategorized"),
    provider: clean(entry.provider || hostFromUrl(entry.url)),
    url: firstUrl([entry.url]),
    auth: clean(entry.auth || "Unknown"),
    cors: clean(entry.cors || "Unknown"),
    https: true,
    source: sources.curatedPopular.name,
    sources: [sources.curatedPopular.name],
    openApiUrl: firstUrl([entry.openApiUrl]),
    logo: "",
    updatedAt: entry.verifiedAt || "",
    tags: cleanList([entry.category, entry.auth, ...(entry.tags || [])])
  }));
}

function applyLinkQuality(api, linkQuality) {
  const next = { ...api };
  next.url = qualityUrl(next.url, next.openApiUrl, linkQuality);
  next.openApiUrl = qualityUrl(next.openApiUrl, "", linkQuality);
  next.https = next.url ? next.url.startsWith("https://") : next.https;
  return next;
}

function qualityUrl(url, fallbackUrl, linkQuality) {
  const replacement = linkQuality.replacements[url];
  if (replacement) {
    return replacement;
  }
  if (linkQuality.deadLinks.has(url)) {
    return fallbackUrl && !linkQuality.deadLinks.has(fallbackUrl) ? fallbackUrl : "";
  }
  return url || "";
}

function dedupe(records) {
  const byKey = new Map();

  for (const record of records) {
    if (!record.name) {
      continue;
    }

    const key = dedupeKey(record);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      continue;
    }

    existing.description = chooseLonger(existing.description, record.description);
    existing.category = existing.category || record.category;
    existing.provider = existing.provider || record.provider;
    existing.url = existing.url || record.url;
    existing.auth = preferKnown(existing.auth, record.auth);
    existing.cors = preferKnown(existing.cors, record.cors);
    existing.https = existing.https || record.https;
    existing.openApiUrl = existing.openApiUrl || record.openApiUrl;
    existing.logo = existing.logo || record.logo;
    existing.updatedAt = latestDate(existing.updatedAt, record.updatedAt);
    existing.sources = cleanList([...(existing.sources || []), ...(record.sources || [])]);
    existing.source = existing.sources[0] || existing.source || record.source;
    existing.tags = cleanList([...(existing.tags || []), ...(record.tags || [])]);
  }

  return [...byKey.values()];
}

function dedupeKey(record) {
  if (record.openApiUrl) {
    return `openapi:${record.openApiUrl}`;
  }

  const host = hostFromUrl(record.url);
  if (host) {
    return `url:${host}:${normalizePath(record.url)}:${slugify(record.name)}`;
  }

  return `name:${slugify(`${record.name}-${record.provider}`)}`;
}

function normalizePath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

function providerFromApiGuruId(id) {
  return id.split(":")[0];
}

function hostFromUrl(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostFromProvider(provider = "") {
  const value = String(provider).split(":")[0].toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value : "";
}

// Drop non-public placeholder hosts (e.g. vtex.local, google.home, bare "localhost").
// These come from OpenAPI specs that ship internal/example server URLs and are never reachable.
const RESERVED_TLDS = new Set([
  "local", "home", "lan", "internal", "localhost", "example", "invalid", "test", "corp", "intranet"
]);
function isReservedHost(host = "") {
  if (!host) return false;            // keep records that simply have no link
  if (host === "localhost") return true;
  if (!host.includes(".")) return true; // bare hostname, not a public domain
  return RESERVED_TLDS.has(host.split(".").pop().toLowerCase());
}

function firstUrl(values) {
  for (const value of values) {
    const cleaned = clean(value);
    if (!cleaned) {
      continue;
    }

    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.href;
      }
    } catch {
      // Skip malformed source links.
    }
  }
  return "";
}

function isApiInfoUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path && host === "googleapis.com") {
      return false;
    }
    if (!path && !/(?:^api\.|developer|developers|docs|documentation|portal|platform)/.test(host)) {
      return false;
    }
    const text = `${parsed.hostname} ${parsed.pathname}`.toLowerCase();
    return /(?:api|apis|developer|developers|dev|docs|documentation|reference|openapi|swagger|redoc|postman|graphql|sdk|portal|platform|products|pricing|purchase|plans)/.test(text);
  } catch {
    return false;
  }
}

function isDeadEndishUrl(url = "") {
  try {
    const parsed = new URL(url);
    const text = `${parsed.hostname} ${parsed.pathname}`.toLowerCase();
    return /(?:terms|privacy|legal|support|contact|contactus|help|about|blog|careers|status)/.test(text);
  } catch {
    return true;
  }
}

function clean(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanList(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function titleCase(value = "") {
  return clean(value)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugify(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function preferKnown(current, next) {
  const unknown = new Set(["", "unknown", "n/a"]);
  return unknown.has(String(current || "").toLowerCase()) ? next : current;
}

function chooseLonger(current = "", next = "") {
  return next.length > current.length ? next : current;
}

function latestDate(current = "", next = "") {
  const currentTime = Date.parse(current);
  const nextTime = Date.parse(next);
  if (!Number.isFinite(currentTime)) {
    return next || current;
  }
  if (!Number.isFinite(nextTime)) {
    return current;
  }
  return nextTime > currentTime ? next : current;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
