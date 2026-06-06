const PAGE_SIZES = {
  desktop: 12,
  tablet: 8,
  phone: 4
};

const state = {
  apis: [],
  filtered: [],
  mapPins: [],
  pagesShown: 1,
  query: "",
  terms: [],
  termRe: null,
  category: "all",
  auth: "all",
  source: "all",
  sort: "name"
};

const els = {
  html: document.documentElement,
  generatedAt: document.querySelector("#generatedAt"),
  themeOptions: [...document.querySelectorAll("[data-theme-choice]")],
  searchInput: document.querySelector("#searchInput"),
  clearSearch: document.querySelector("#clearSearch"),
  categoryFilter: document.querySelector("#categoryFilter"),
  authFilter: document.querySelector("#authFilter"),
  sourceFilter: document.querySelector("#sourceFilter"),
  sortSelect: document.querySelector("#sortSelect"),
  resetButton: document.querySelector("#resetButton"),
  totalCount: document.querySelector("#totalCount"),
  visibleCount: document.querySelector("#visibleCount"),
  categoryCount: document.querySelector("#categoryCount"),
  openApiCount: document.querySelector("#openApiCount"),
  resultCaption: document.querySelector("#resultCaption"),
  mapStatus: document.querySelector("#mapStatus"),
  grid: document.querySelector("#apiGrid"),
  showMoreButton: document.querySelector("#showMoreButton"),
  pageSummary: document.querySelector("#pageSummary"),
  copyrightYear: document.querySelector("#copyrightYear")
};

const THEME_KEY = "api-atlas-theme-mode";
const THEME_MODES = new Set(["system", "light", "dark"]);
const systemThemeQuery = matchMedia("(prefers-color-scheme: dark)");
const fmt = new Intl.NumberFormat();
const fmtDate = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

const ARROW = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>`;
const SPEC_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;

/* ---------------- Data loading ---------------- */
async function loadCatalog() {
  try {
    const catalogResponse = await fetch("data/apis.json");
    if (!catalogResponse.ok) throw new Error(`Catalog request failed: ${catalogResponse.status}`);

    const catalog = await catalogResponse.json();

    const apis = Array.isArray(catalog.apis) ? catalog.apis : [];
    for (const api of apis) {
      api._s = searchText(api);          // lowercase search blob (kept off the wire)
      api._host = hostFromUrl(api.url || api.openApiUrl); // for favicons
    }
    state.apis = apis;

    els.generatedAt.textContent = catalog.generatedAt
      ? `Charted ${fmtDate.format(new Date(catalog.generatedAt))}`
      : "Catalog loaded";
    if (els.copyrightYear) {
      els.copyrightYear.textContent = String(new Date().getFullYear());
    }

    hydrateFilters();
    wireMapPins();
    applyFilters();
  } catch (error) {
    els.grid.replaceChildren();
    els.grid.setAttribute("aria-busy", "false");
    els.generatedAt.textContent = "Catalog unavailable";
    els.resultCaption.textContent = "Unable to load data/apis.json";
    console.error(error);
  }
}

function searchText(api) {
  return [
    api.name, api.description, api.category, api.provider, api.auth,
    ...(api.sources || []), ...(api.tags || [])
  ].join(" ").toLowerCase();
}

function hydrateFilters() {
  const categories = uniqueSorted(state.apis.map((a) => a.category));
  const auths = uniqueSorted(state.apis.map((a) => a.auth || "Unknown"));
  const sources = uniqueSorted(state.apis.flatMap((a) => a.sources || [a.source]).filter(Boolean));

  fillSelect(els.categoryFilter, categories, "All regions");
  fillSelect(els.authFilter, auths, "All access");
  fillSelect(els.sourceFilter, sources, "All sources");

  els.totalCount.textContent = fmt.format(state.apis.length);
  els.categoryCount.textContent = fmt.format(categories.length);
  els.openApiCount.textContent = fmt.format(state.apis.filter((a) => a.openApiUrl).length);
}

function fillSelect(select, values, label) {
  select.replaceChildren(new Option(label, "all"));
  for (const value of values) select.append(new Option(value, value));
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/* ---------------- Interactive map pins ---------------- */
// Each hero pin becomes a clickable region: hover shows a tooltip, click filters
// the catalog to that region and scrolls to the results.
function wireMapPins() {
  const hero = document.querySelector(".hero");
  const pins = [...document.querySelectorAll(".hero-map .m-pins .pin")];
  if (!hero || !pins.length) return;

  let tip = hero.querySelector(".map-tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "map-tip"; tip.hidden = true; hero.appendChild(tip); }

  const counts = {};
  for (const a of state.apis) if (a.category) counts[a.category] = (counts[a.category] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, pins.length);

  state.mapPins = [];

  pins.forEach((pin, i) => {
    const entry = top[i];
    if (!entry) { pin.style.display = "none"; return; }
    const [cat, n] = entry;
    const dot = pin.querySelector(".pin-dot");
    const x = Number(dot?.getAttribute("cx") || 0);
    const y = Number(dot?.getAttribute("cy") || 0);
    pin.dataset.category = cat;
    pin.dataset.total = String(n);
    ensurePinHitArea(pin, x, y);
    ensurePinLabel(pin, x, y, cat);
    ensurePinPopover(pin, x, y, cat, n);

    pin.setAttribute("role", "button");
    pin.setAttribute("tabindex", "0");
    pin.setAttribute("aria-label", `Explore ${cat} — ${fmt.format(n)} APIs`);

    const show = () => {
      const r = pin.getBoundingClientRect();
      const h = hero.getBoundingClientRect();
      tip.textContent = `${cat} · ${fmt.format(n)}`;
      tip.style.left = `${r.left - h.left + r.width / 2}px`;
      tip.style.top = `${r.top - h.top - 6}px`;
      tip.hidden = false;
    };
    const hide = () => { tip.hidden = true; };
    const go = () => {
      hide();
      Object.assign(state, { query: "", category: cat, auth: "all", source: "all" });
      els.searchInput.value = ""; els.clearSearch.hidden = true;
      els.categoryFilter.value = cat; els.authFilter.value = "all"; els.sourceFilter.value = "all";
      applyFilters();
      document.querySelector(".content")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    };

    pin.addEventListener("mouseenter", show);
    pin.addEventListener("mouseleave", hide);
    pin.addEventListener("focus", show);
    pin.addEventListener("blur", hide);
    pin.addEventListener("click", go);
    pin.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });

    state.mapPins.push({ pin, category: cat, total: n });
  });

  updateMapPins(state.apis);
}

function ensurePinHitArea(pin, x, y) {
  if (pin.querySelector(".pin-hit")) return;
  const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hit.setAttribute("class", "pin-hit");
  hit.setAttribute("cx", x);
  hit.setAttribute("cy", y);
  hit.setAttribute("r", "18");
  pin.prepend(hit);
}

function ensurePinLabel(pin, x, y, category) {
  if (pin.querySelector(".pin-label")) return;
  const labelX = svgNumber(pin.dataset.labelX, x);
  const labelY = svgNumber(pin.dataset.labelY, Math.max(24, y - 24));
  const labelAnchor = pin.dataset.labelAnchor || "middle";
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", "pin-label");
  label.setAttribute("x", labelX);
  label.setAttribute("y", labelY);
  label.setAttribute("text-anchor", labelAnchor);
  label.textContent = shortPinLabel(category);
  pin.append(label);
}

function ensurePinPopover(pin, x, y, category, total) {
  if (pin.querySelector(".pin-popover")) return;

  const width = 128;
  const height = 46;
  const labelX = svgNumber(pin.dataset.labelX, x);
  const labelY = svgNumber(pin.dataset.labelY, Math.max(24, y - 24));
  const popupX = Math.min(Math.max(labelX - width / 2, 352), 1088 - width);
  const popupY = Math.max(40, labelY - 52);
  const stemX = Math.min(Math.max(x, popupX + 18), popupX + width - 18);

  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "pin-popover");
  group.setAttribute("aria-hidden", "true");

  const stem = document.createElementNS("http://www.w3.org/2000/svg", "line");
  stem.setAttribute("class", "pin-popover-stem");
  stem.setAttribute("x1", x);
  stem.setAttribute("y1", y - 11);
  stem.setAttribute("x2", stemX);
  stem.setAttribute("y2", popupY + height);

  const card = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  card.setAttribute("class", "pin-popover-card");
  card.setAttribute("x", popupX);
  card.setAttribute("y", popupY);
  card.setAttribute("width", width);
  card.setAttribute("height", height);
  card.setAttribute("rx", "14");

  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("class", "pin-popover-title");
  title.setAttribute("x", popupX + width / 2);
  title.setAttribute("y", popupY + 20);
  title.setAttribute("text-anchor", "middle");
  title.textContent = shortPinLabel(category);

  const count = document.createElementNS("http://www.w3.org/2000/svg", "text");
  count.setAttribute("class", "pin-popover-count");
  count.setAttribute("x", popupX + width / 2);
  count.setAttribute("y", popupY + 35);
  count.setAttribute("text-anchor", "middle");
  count.textContent = `${fmt.format(total)} APIs`;

  group.append(stem, card, title, count);
  pin.append(group);
}

function svgNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function updateMapPins(baseApis = state.apis) {
  if (!state.mapPins.length) return;
  const selected = state.category !== "all";
  document.querySelector(".hero-map")?.classList.toggle("has-active-route", selected);

  const counts = new Map();
  for (const api of baseApis) {
    counts.set(api.category, (counts.get(api.category) || 0) + 1);
  }

  const max = Math.max(1, ...state.mapPins.map(({ category }) => counts.get(category) || 0));
  for (const item of state.mapPins) {
    const count = counts.get(item.category) || 0;
    const intensity = 0.8 + (count / max) * 0.55;
    item.pin.style.setProperty("--pin-scale", intensity.toFixed(2));
    item.pin.classList.toggle("is-active", state.category === item.category);
    item.pin.classList.toggle("is-muted", count === 0);
    item.pin.setAttribute("aria-label", `Explore ${item.category} — ${fmt.format(count)} matching APIs, ${fmt.format(item.total)} total`);
    const popoverCount = item.pin.querySelector(".pin-popover-count");
    if (popoverCount) popoverCount.textContent = `${fmt.format(count || item.total)} APIs`;
  }

  if (els.mapStatus) {
    const hasActiveFilter = Boolean(state.query || selected || state.auth !== "all" || state.source !== "all");
    const statusCount = state.filtered.length || (hasActiveFilter ? 0 : state.apis.length);
    els.mapStatus.lastChild.textContent = selected
      ? `${state.category} route · ${fmt.format(statusCount)} APIs`
      : `Global catalog · ${fmt.format(statusCount)} APIs`;
  }
}

function shortPinLabel(category = "") {
  const replacements = {
    "Artificial Intelligence": "AI",
    "Customer Relation": "CRM",
    "Developer Tools": "Dev Tools",
    "Development": "Dev",
    "Science & Math": "Science",
    "Documents & Productivity": "Docs",
    "Cryptocurrency": "Crypto"
  };
  return replacements[category] || category.replace(/\s*&\s*/g, " & ").split(/\s+/).slice(0, 2).join(" ");
}

/* ---------------- Filtering + ranking ---------------- */
function applyFilters() {
  state.terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  state.termRe = state.terms.length
    ? new RegExp(`(${state.terms.map(escapeRe).join("|")})`, "gi")
    : null;

  const baseForMap = state.apis.filter((api) => {
    for (const t of state.terms) if (!api._s.includes(t)) return false; // multi-term AND
    if (state.auth !== "all" && (api.auth || "Unknown") !== state.auth) return false;
    if (state.source !== "all") {
      const list = api.sources || [api.source];
      if (!list.includes(state.source)) return false;
    }
    return true;
  });

  let matched = baseForMap.filter((api) => {
    if (state.category !== "all" && api.category !== state.category) return false;
    return true;
  });

  if (state.terms.length) {
    // Rank by relevance, computing each score once.
    matched = matched
      .map((api) => ({ api, score: relevance(api, state.terms) }))
      .sort((a, b) => b.score - a.score || cmp(a.api.name, b.api.name))
      .map((x) => x.api);
  } else {
    matched.sort(sortApis);
  }
  state.filtered = matched;

  els.resultCaption.textContent = state.filtered.length
    ? `${fmt.format(state.filtered.length)} APIs found${state.category === "all" ? "" : ` in ${state.category}`}`
    : "0 APIs found";
  updateMapPins(baseForMap);

  state.pagesShown = 1;
  els.grid.setAttribute("aria-busy", "false");
  renderVisibleCards();
}

// Weighted relevance: name matches beat provider beat category/description.
function relevance(api, terms) {
  const name = (api.name || "").toLowerCase();
  const provider = (api.provider || "").toLowerCase();
  const category = (api.category || "").toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (name === t) score += 100;
    else if (name.startsWith(t)) score += 60;
    else if (new RegExp(`\\b${escapeRe(t)}`).test(name)) score += 40;
    else if (name.includes(t)) score += 22;

    if (provider.startsWith(t)) score += 16;
    else if (provider.includes(t)) score += 8;

    if (category.includes(t)) score += 5;
    score += 1; // base credit for matching at all
  }
  if (api.openApiUrl) score += 1; // gentle tie-breaker toward documented APIs
  return score;
}

function sortApis(a, b) {
  if (state.sort === "category") return cmp(a.category, b.category) || cmp(a.name, b.name);
  if (state.sort === "source") return cmp(primarySource(a), primarySource(b)) || cmp(a.name, b.name);
  if (state.sort === "updated") return dateValue(b.updatedAt) - dateValue(a.updatedAt) || cmp(a.name, b.name);
  return cmp(a.name, b.name);
}

/* ---------------- Responsive card paging ---------------- */
function pageSize() {
  if (matchMedia("(max-width: 640px)").matches) return PAGE_SIZES.phone;
  if (matchMedia("(max-width: 1024px)").matches) return PAGE_SIZES.tablet;
  return PAGE_SIZES.desktop;
}

function renderVisibleCards() {
  const limit = Math.min(state.filtered.length, state.pagesShown * pageSize());
  const slice = state.filtered.slice(0, limit);
  const frag = document.createDocumentFragment();
  for (const api of slice) frag.append(card(api));
  els.grid.replaceChildren(frag);
  updateShowMore(limit);
}

function updateShowMore(renderedCount) {
  const remaining = state.filtered.length - renderedCount;
  const nextCount = Math.min(pageSize(), Math.max(remaining, 0));
  const hasResults = state.filtered.length > 0;

  els.visibleCount.textContent = fmt.format(renderedCount);

  if (els.showMoreButton) {
    els.showMoreButton.hidden = !hasResults || remaining <= 0;
    els.showMoreButton.textContent = nextCount > 0
      ? `Show ${fmt.format(nextCount)} more APIs`
      : "Show more APIs";
  }

  if (els.pageSummary) {
    els.pageSummary.hidden = !hasResults;
    els.pageSummary.textContent = hasResults
      ? `Showing ${fmt.format(renderedCount)} of ${fmt.format(state.filtered.length)} cards`
      : "";
  }
}

/* ---------------- Logos (real logo -> favicon -> initials) ---------------- */
function buildLogo(api, cls) {
  const box = document.createElement("span");
  box.className = cls;

  const sources = [];
  if (api.logo) sources.push(api.logo);
  if (api._host) sources.push(`https://icons.duckduckgo.com/ip3/${api._host}.ico`);

  if (!sources.length) { box.textContent = initials(api.name); return box; }

  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  let i = 0;
  img.src = sources[0];
  img.addEventListener("error", () => {
    i += 1;
    if (i < sources.length) img.src = sources[i];
    else { img.remove(); box.textContent = initials(api.name); }
  });
  box.append(img);
  return box;
}

/* ---------------- Card builder ---------------- */
function card(api) {
  const primary = api.url || api.openApiUrl || "";

  const el = document.createElement("article");
  el.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";

  const titles = document.createElement("div");
  titles.className = "card-titles";

  const titleEl = document.createElement("span");
  titleEl.className = "card-title";
  setText(titleEl, api.name || "Untitled API");

  if (primary) {
    const link = document.createElement("a");
    link.className = "card-title-link";
    link.href = primary;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.title = `Open ${api.name}`;
    link.append(titleEl);
    titles.append(link);
  } else {
    titles.append(titleEl);
  }

  const provider = document.createElement("span");
  provider.className = "card-provider";
  setText(provider, api.provider || api.category || "");
  titles.append(provider);

  head.append(buildLogo(api, "card-logo"), titles);

  const desc = document.createElement("p");
  desc.className = "card-desc";
  setText(desc, api.description || "No description available.");

  const badges = document.createElement("div");
  badges.className = "badges";
  badges.append(badge(api.category, "category"));
  if (api.auth && api.auth !== "Unknown") badges.append(badge(api.auth, "auth"));
  badges.append(badge(primarySource(api), "source"));
  if (api.https) badges.append(badge("HTTPS", "https"));

  const foot = document.createElement("div");
  foot.className = "card-foot";
  if (primary) {
    const cta = document.createElement("span");
    cta.className = "card-cta";
    cta.innerHTML = `Open API info ${ARROW}`;
    foot.append(cta);
  }
  if (api.openApiUrl && api.openApiUrl !== primary) {
    const spec = document.createElement("a");
    spec.className = "spec-link";
    spec.href = api.openApiUrl;
    spec.target = "_blank";
    spec.rel = "noreferrer noopener";
    spec.innerHTML = `${SPEC_ICON} OpenAPI`;
    foot.append(spec);
  }

  el.append(head, desc, badges);
  if (foot.childElementCount) el.append(foot);
  return el;
}

function badge(value, kind) {
  const span = document.createElement("span");
  span.className = `badge ${kind}`;
  span.textContent = value || "Unknown";
  span.title = value || "Unknown";
  return span;
}

// Write text into a node, wrapping active search terms in <mark> (XSS-safe: no innerHTML).
function setText(node, text) {
  const value = text || "";
  if (!state.termRe) { node.textContent = value; return; }
  state.termRe.lastIndex = 0;
  if (!state.termRe.test(value)) { node.textContent = value; return; }

  state.termRe.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  while ((m = state.termRe.exec(value))) {
    if (m.index > last) frag.append(document.createTextNode(value.slice(last, m.index)));
    const mark = document.createElement("mark");
    mark.textContent = m[0];
    frag.append(mark);
    last = m.index + m[0].length;
    if (m.index === state.termRe.lastIndex) state.termRe.lastIndex += 1;
  }
  if (last < value.length) frag.append(document.createTextNode(value.slice(last)));
  node.replaceChildren(frag);
}

/* ---------------- Helpers ---------------- */
function primarySource(api) { return (api.sources && api.sources[0]) || api.source || "Unknown"; }
function cmp(a = "", b = "") { return String(a).localeCompare(String(b), undefined, { sensitivity: "base" }); }
function dateValue(v) { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : 0; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function hostFromUrl(url = "") {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
function initials(v = "") {
  return v.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "API";
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------------- Theme ---------------- */
function systemTheme() {
  return systemThemeQuery.matches ? "dark" : "light";
}

function savedThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return THEME_MODES.has(saved) ? saved : "system";
  } catch (_) {
    return "system";
  }
}

function applyThemeMode(mode = savedThemeMode()) {
  const resolved = mode === "system" ? systemTheme() : mode;
  els.html.dataset.themeMode = mode;
  els.html.dataset.theme = resolved;
  els.html.style.colorScheme = resolved;

  for (const option of els.themeOptions) {
    const isActive = option.dataset.themeChoice === mode;
    option.setAttribute("aria-pressed", String(isActive));
  }
}

function setThemeMode(mode) {
  if (!THEME_MODES.has(mode)) return;
  try { localStorage.setItem(THEME_KEY, mode); } catch (_) {}
  applyThemeMode(mode);
}

for (const option of els.themeOptions) {
  option.addEventListener("click", () => setThemeMode(option.dataset.themeChoice));
}

systemThemeQuery.addEventListener("change", () => {
  if (savedThemeMode() === "system") applyThemeMode("system");
});

applyThemeMode();

/* ---------------- Events ---------------- */
const onSearch = debounce(() => applyFilters(), 110);
els.searchInput.addEventListener("input", (e) => {
  state.query = e.target.value;
  els.clearSearch.hidden = !state.query;
  onSearch();
});
els.clearSearch.addEventListener("click", () => {
  state.query = "";
  els.searchInput.value = "";
  els.clearSearch.hidden = true;
  els.searchInput.focus();
  applyFilters();
});

els.categoryFilter.addEventListener("change", (e) => { state.category = e.target.value; applyFilters(); });
els.authFilter.addEventListener("change", (e) => { state.auth = e.target.value; applyFilters(); });
els.sourceFilter.addEventListener("change", (e) => { state.source = e.target.value; applyFilters(); });
els.sortSelect.addEventListener("change", (e) => { state.sort = e.target.value; applyFilters(); });

function showNextPage() {
  state.pagesShown += 1;
  renderVisibleCards();
}

document.addEventListener("click", (event) => {
  if (event.target?.closest?.("#showMoreButton")) {
    showNextPage();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target?.closest?.("#showMoreButton") && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    showNextPage();
  }
});

els.resetButton.addEventListener("click", () => {
  Object.assign(state, { query: "", category: "all", auth: "all", source: "all", sort: "name" });
  els.searchInput.value = "";
  els.clearSearch.hidden = true;
  els.categoryFilter.value = "all";
  els.authFilter.value = "all";
  els.sourceFilter.value = "all";
  els.sortSelect.value = "name";
  applyFilters();
  window.scrollTo?.({ top: 0, behavior: "smooth" });
});

// Keyboard: "/" focuses search, Esc clears it.
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if (e.key === "/" && !typing) { e.preventDefault(); els.searchInput.focus(); }
  else if (e.key === "Escape" && document.activeElement === els.searchInput && state.query) {
    state.query = ""; els.searchInput.value = ""; els.clearSearch.hidden = true; applyFilters();
  }
});

let lastPageSize = pageSize();
window.addEventListener("resize", debounce(() => {
  const nextPageSize = pageSize();
  if (nextPageSize === lastPageSize) return;
  lastPageSize = nextPageSize;
  if (state.filtered.length) renderVisibleCards();
}, 150));

loadCatalog();
