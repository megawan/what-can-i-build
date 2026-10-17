// What Can I Build? — matches a collection of loose parts against every set.
// Matching runs in memory on data/match.bin.gz (every set's parts, downloaded
// once); search and set details query a static SQLite database through
// sql.js-httpvfs (HTTP range requests).

const IMG = "https://cdn.rebrickable.com/media/";
const STORE_KEY = "wcib.collection.v1";
// Resolved collection rows, valid only for the database build they came from.
const RESOLVED_KEY = "wcib.resolved.v1";
const FILTERS_KEY = "wcib.filters.v1";
const MAX_RESULTS = 60;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");

let db;
let api;
let totalSets = 0;
let builtAt = "";
// Set until match.bin.gz is loaded; resolves to the decoded match data.
let matchData;
const colors = new Map();
const themes = new Map();
// key "pid:color" -> { pid, part_num, name, color_id, qty, img }
const collection = new Map();

const query = (sql, params = []) => db.query(sql, params);
const keyOf = (pid, color) => `${pid}:${color}`;

// ---------- startup ----------

async function init() {
  const base = new URL(".", location.href);
  const matchUrl = new URL("data/match.bin.gz", base).href;
  matchData = loadMatchData(matchUrl);
  try {
    const worker = await createDbWorker(
      [{ from: "jsonconfig", configUrl: new URL("data/config.json", base).href }],
      new URL("vendor/sql.js-httpvfs/sqlite.worker.js", base).href,
      new URL("vendor/sql.js-httpvfs/sql-wasm.wasm", base).href,
    );
    db = worker.db;
    api = worker.worker;
    for (const c of await query("SELECT id, name, rgb, is_trans FROM colors")) colors.set(c.id, c);
    for (const t of await query("SELECT id, name, parent_id FROM themes")) themes.set(t.id, t);
    const meta = Object.fromEntries((await query("SELECT key, value FROM meta")).map((r) => [r.key, r.value]));
    totalSets = Number(meta.sets || 0);
    builtAt = meta.built_at || "";
    // A cached match file from an older build would point at the wrong ids.
    matchData = matchData.then((m) => (m.builtAt === builtAt ? m : loadMatchData(matchUrl, "reload")));
    matchData.then(fillThemes).catch(console.error);
    if (meta.built_at) $("built-at").textContent = `, updated ${meta.built_at.slice(0, 10)}`;
  } catch (err) {
    console.error(err);
    setStatus("Could not load the database. Run scripts/build_db.py first, then serve web/ over HTTP.", true);
    return;
  }

  for (const id of ["part-search", "set-search", "set-filter", "set-qty", "set-add-btn", "sample-btn", "export-btn", "clear-btn"]) $(id).disabled = false;
  restoreFilters();
  await restore();
  renderPieces();
  await refreshResults();
}

async function setStatus(text, isError = false) {
  const el = $("status");
  el.classList.toggle("error", isError);
  if (isError || !api) {
    el.textContent = text;
    return;
  }
  let fetched = "";
  try {
    const stats = await api.getStats();
    if (stats) fetched = ` · ${(stats.totalFetchedBytes / 1e6).toFixed(1)} MB of ${(stats.totalBytes / 1e6).toFixed(0)} MB fetched`;
  } catch {}
  el.textContent = text + fetched;
}

// ---------- match data ----------

// Decodes match.bin.gz (format documented in scripts/build_db.py, write_match).
async function loadMatchData(url, cache = "default") {
  const res = await fetch(url, { cache });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let buf = await res.arrayBuffer();
  const magic = new Uint8Array(buf, 0, 2);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  const view = new DataView(buf);
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "WCIB") throw new Error(`${url}: not a match file`);
  const headLen = view.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headLen)));
  const G = head.groups, E = head.entries;
  let off = 8 + headLen;
  const keys = new Uint32Array(buf, off, G); off += 4 * G;
  const counts = new Uint16Array(buf, off, G); off += 2 * G;
  const sids = new Uint16Array(buf, off, E); off += 2 * E;
  const qtys = new Uint16Array(buf, off, E);
  const starts = new Uint32Array(G + 1);
  for (let g = 0, key = 0, e = 0; g < G; g++) {
    keys[g] = key += keys[g];
    starts[g] = e;
    for (let end = e + counts[g], sid = 0; e < end; e++) sids[e] = sid += sids[e];
    starts[g + 1] = e;
  }
  const sets = head.sets.map(([set_num, name, year, theme_id, total], i) => ({ sid: i + 1, set_num, name, year, theme_id, total }));
  const sample = head.sample.map(([pid, part_num, name, color_id, qty, img]) => ({ pid, part_num, name, color_id, qty, img }));
  // Families of similar parts, keyed by their first (most-used) pid.
  const families = new Map();
  const familyOf = new Map();
  for (const pids of head.similar || []) {
    families.set(pids[0], pids);
    for (const pid of pids) familyOf.set(pid, pids[0]);
  }
  return { builtAt: head.built_at, keys, starts, sids, qtys, sets, sample, families, familyOf };
}

// match.bin keys are pid << 14 | (color_id + 1).
const matchKey = (pid, color) => pid * 16384 + color + 1;

// Index of the first group whose key is >= key.
function lowerBound(keys, key) {
  let lo = 0, hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Calls fn(group, color_id) for every color the part comes in.
function forEachColor(m, pid, fn) {
  const end = matchKey(pid + 1, -1);
  for (let g = lowerBound(m.keys, matchKey(pid, -1)); g < m.keys.length && m.keys[g] < end; g++) fn(g, (m.keys[g] & 16383) - 1);
}

// For every set, how many of its pieces the collection covers. mode is
// "exact" (part and color), "color" (all colors of a part pool together) or
// "similar" (all colors of a whole family of similar parts pool together).
function coverage(m, mode) {
  const got = new Int32Array(m.sets.length + 1);
  if (mode === "exact") {
    for (const p of collection.values()) {
      const g = lowerBound(m.keys, matchKey(p.pid, p.color_id));
      if (m.keys[g] !== matchKey(p.pid, p.color_id)) continue;
      for (let e = m.starts[g]; e < m.starts[g + 1]; e++) got[m.sids[e]] += Math.min(m.qtys[e], p.qty);
    }
    return got;
  }
  const poolOf = (pid) => (mode === "similar" && m.familyOf.get(pid)) || pid;
  const have = new Map();
  for (const p of collection.values()) have.set(poolOf(p.pid), (have.get(poolOf(p.pid)) || 0) + p.qty);
  const need = new Int32Array(m.sets.length + 1);
  const touched = [];
  for (const [pool, qty] of have) {
    for (const pid of (mode === "similar" && m.families.get(pool)) || [pool]) {
      forEachColor(m, pid, (g) => {
        for (let e = m.starts[g]; e < m.starts[g + 1]; e++) {
          const sid = m.sids[e];
          if (!need[sid]) touched.push(sid);
          need[sid] += m.qtys[e];
        }
      });
    }
    for (const sid of touched) {
      got[sid] += Math.min(need[sid], qty);
      need[sid] = 0;
    }
    touched.length = 0;
  }
  return got;
}

// ---------- collection persistence ----------

function save() {
  const items = [...collection.values()];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.map((p) => [p.part_num, p.color_id, p.qty])));
    localStorage.setItem(RESOLVED_KEY, JSON.stringify({ built_at: builtAt, items }));
  } catch {}
}

async function restore() {
  let rows = [];
  let resolved;
  try {
    rows = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    resolved = JSON.parse(localStorage.getItem(RESOLVED_KEY) || "null");
  } catch {}
  // Same build: reuse the resolved rows instead of looking every part up again.
  if (resolved?.built_at === builtAt && resolved.items?.length === rows.length) {
    for (const p of resolved.items) collection.set(keyOf(p.pid, p.color_id), p);
  } else if (rows.length) {
    await addRows(rows, { replace: true });
  }
}

// Resolve [[part_num, color_id, qty], ...] (any part number, including mold
// variants) to canonical parts and merge them into the collection.
async function addRows(rows, { replace = false } = {}) {
  const resolved = await query(
    `WITH h(part_num, color_id, qty) AS (
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))
     SELECT p.pid, p.part_num, p.name, h.color_id, h.qty,
            coalesce((SELECT img FROM part_imgs i WHERE i.pid = p.pid AND i.color_id = h.color_id),
                     (SELECT img FROM part_imgs i WHERE i.pid = p.pid LIMIT 1)) AS img
     FROM h
     LEFT JOIN part_aliases a ON a.part_num = h.part_num
     LEFT JOIN parts x ON x.part_num = h.part_num
     CROSS JOIN parts p ON p.pid = coalesce(a.pid, x.pid)`,
    [JSON.stringify(rows.map(([p, c, q]) => [String(p), Number(c), Number(q)]))],
  );
  if (replace) collection.clear();
  for (const r of resolved) {
    if (!(r.qty > 0)) continue;
    const k = keyOf(r.pid, r.color_id);
    const prev = collection.get(k);
    if (prev) prev.qty += r.qty;
    else collection.set(k, { ...r });
  }
  save();
  return { added: resolved.length, skipped: rows.length - resolved.length };
}

// ---------- part search ----------

let picked = null;
let searchSeq = 0;

// Fills a suggestion list; onPick runs on click or Enter (see wireSuggestions).
function fillSuggestions(ul, items, render, onPick) {
  ul._active = -1;
  ul._items = items;
  ul._onPick = onPick;
  ul.innerHTML = items.map((r, i) => `<li role="option" data-i="${i}">${render(r)}</li>`).join("");
  ul.hidden = !items.length;
}

function wireSuggestions(input, ul) {
  ul.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) { e.preventDefault(); ul._onPick(ul._items[Number(li.dataset.i)]); }
  });
  input.addEventListener("keydown", (e) => {
    const items = ul._items || [];
    if (ul.hidden || !items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ul._active = (ul._active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      [...ul.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === ul._active)));
      ul.children[ul._active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      ul._onPick(items[Math.max(0, ul._active)]);
    } else if (e.key === "Escape") {
      ul.hidden = true;
    }
  });
  input.addEventListener("blur", () => setTimeout(() => (ul.hidden = true), 150));
}

// "plate 2x4" -> name : ("plate" "2" "x" "4"*). Only the last token is a prefix,
// so "2 x 4" doesn't also match "2 x 4x..." part numbers; a single token is
// tried against part numbers too.
function ftsQuery(text) {
  const norm = text.replace(/(\d)\s*x\s*(\d)/gi, "$1 x $2");
  const tokens = norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return "";
  const terms = tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" ");
  return tokens.length === 1 ? `{part_num name} : ${terms}` : `name : (${terms})`;
}

async function search(text) {
  const seq = ++searchSeq;
  const trimmed = text.trim();
  if (!trimmed) return showSuggestions([]);
  const results = [];
  const seen = new Set();
  const push = (r) => {
    const k = `${r.pid}:${r.color_id ?? ""}`;
    if (!seen.has(k)) { seen.add(k); results.push(r); }
  };

  if (/^\d{5,8}$/.test(trimmed)) {
    for (const r of await query(
      `SELECT e.pid, p.part_num, p.name, e.color_id, p.in_sets,
              coalesce((SELECT img FROM part_imgs i WHERE i.pid = e.pid AND i.color_id = e.color_id),
                       (SELECT img FROM part_imgs i WHERE i.pid = e.pid LIMIT 1)) AS img
       FROM elements e CROSS JOIN parts p ON p.pid = e.pid WHERE e.element_id = ?`, [trimmed])) push({ ...r, element: trimmed });
  }
  for (const r of await query(
    `SELECT p.pid, p.part_num, p.name, p.in_sets, (SELECT img FROM part_imgs i WHERE i.pid = p.pid LIMIT 1) AS img
     FROM parts p WHERE p.pid IN (SELECT pid FROM parts WHERE part_num = ?1 UNION SELECT pid FROM part_aliases WHERE part_num = ?1)`,
    [trimmed])) push(r);
  const match = ftsQuery(trimmed);
  if (match) {
    try {
      for (const r of await query(
        `SELECT p.pid, p.part_num, p.name, p.in_sets, (SELECT img FROM part_imgs i WHERE i.pid = p.pid LIMIT 1) AS img
         FROM parts_fts f CROSS JOIN parts p ON p.pid = f.rowid
         WHERE parts_fts MATCH ? AND p.in_sets > 0 LIMIT 20`, [match])) push(r);
    } catch (err) { console.warn("search", err); }
  }
  if (seq !== searchSeq) return;
  showSuggestions(results.slice(0, 20));
  setStatus(`${fmt(totalSets)} sets`);
}

function showSuggestions(items) {
  fillSuggestions($("suggestions"), items, (r) => {
    const color = r.color_id != null ? colors.get(r.color_id) : null;
    const extra = r.element ? `Element ${esc(r.element)} · ${swatch(color)}${esc(color?.name)}` : `in ${fmt(r.in_sets)} sets`;
    return `${img(r.img, "thumb")}
      <div><strong>${esc(r.part_num)}</strong> ${esc(r.name)}<div class="meta">${extra}</div></div>`;
  }, pick);
}

async function pick(item) {
  picked = item;
  $("suggestions").hidden = true;
  $("part-search").value = "";
  $("picked").hidden = false;
  $("picked-img").src = item.img ? IMG + item.img : "";
  $("picked-num").textContent = item.part_num;
  $("picked-name").textContent = item.name;

  const m = await matchData;
  const used = [];
  forEachColor(m, item.pid, (g, color_id) => used.push({ color_id, n: m.starts[g + 1] - m.starts[g] }));
  used.sort((a, b) => b.n - a.n);
  const sel = $("color-select");
  const options = used.map((u) => u.color_id);
  if (item.color_id != null && !options.includes(item.color_id)) options.unshift(item.color_id);
  sel.innerHTML = options.map((id) => {
    const c = colors.get(id);
    return `<option value="${id}">${esc(c?.name ?? `Color ${id}`)}</option>`;
  }).join("");
  if (item.color_id != null) sel.value = String(item.color_id);
  for (const id of ["color-select", "qty-input", "add-btn"]) $(id).disabled = false;
  $("qty-input").focus();
  $("qty-input").select();
}

async function addPicked(e) {
  e.preventDefault();
  if (!picked) return;
  const color_id = Number($("color-select").value);
  const qty = Math.max(1, Math.floor(Number($("qty-input").value) || 1));
  const k = keyOf(picked.pid, color_id);
  const prev = collection.get(k);
  if (prev) prev.qty += qty;
  else {
    const [row] = await query(
      `SELECT coalesce((SELECT img FROM part_imgs WHERE pid = ?1 AND color_id = ?2),
                       (SELECT img FROM part_imgs WHERE pid = ?1 LIMIT 1)) AS img`, [picked.pid, color_id]);
    collection.set(k, { pid: picked.pid, part_num: picked.part_num, name: picked.name, color_id, qty, img: row?.img });
  }
  save();
  picked = null;
  $("picked").hidden = true;
  for (const id of ["color-select", "qty-input", "add-btn"]) $(id).disabled = true;
  $("qty-input").value = 1;
  $("part-search").focus();
  renderPieces();
  scheduleResults();
}

// ---------- sets you own ----------

let pickedSet = null;

// How well a set matches lowercase search text, best first, or -1: "10696"
// finds 10696-1, then other set numbers starting with it; any other text
// matches sets whose name and theme contain every word.
function setTextRank(s, q) {
  const num = s.set_num.toLowerCase();
  if (num === q || num === `${q}-1`) return 0;
  if (num.startsWith(q)) return 1;
  s.search_text ??= `${s.name} ${themeName(s.theme_id)}`.toLowerCase();
  return q.split(/\s+/).every((w) => s.search_text.includes(w)) ? 2 : -1;
}

async function searchSets(text) {
  const q = text.trim().toLowerCase();
  pickedSet = null;
  if (!q) return fillSuggestions($("set-suggestions"), [], null, null);
  const m = await matchData;
  if ($("set-search").value.trim().toLowerCase() !== q) return;
  const found = [];
  for (const s of m.sets) {
    const rank = setTextRank(s, q);
    if (rank >= 0) found.push([rank, s]);
  }
  found.sort((a, b) => a[0] - b[0] || b[1].total - a[1].total);
  fillSuggestions($("set-suggestions"), found.slice(0, 20).map(([, s]) => s), (s) => `
    <img class="set-thumb" src="${esc(setImg(s.set_num))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div><strong>${esc(s.set_num)}</strong> ${esc(s.name)}
      <div class="meta">${s.year} · ${esc(themeName(s.theme_id))} · ${fmt(s.total)} pieces</div></div>`, pickSet);
}

function pickSet(s) {
  pickedSet = s;
  $("set-search").value = `${s.set_num} ${s.name}`;
  $("set-suggestions").hidden = true;
  $("set-qty").focus();
  $("set-qty").select();
}

// Every part of a set, with names and images, as in the set detail view.
function setParts(sid) {
  return query(
    `SELECT sp.pid, p.part_num, p.name, sp.color_id, sp.qty,
            coalesce(i.img, (SELECT img FROM part_imgs j WHERE j.pid = sp.pid LIMIT 1)) AS img
     FROM set_parts sp
     CROSS JOIN parts p ON p.pid = sp.pid
     LEFT JOIN part_imgs i ON i.pid = sp.pid AND i.color_id = sp.color_id
     WHERE sp.sid = ?`, [sid]);
}

async function addSet(s, copies = 1) {
  setStatus(`Adding the pieces of ${s.set_num} ${s.name}…`);
  const parts = await setParts(s.sid);
  for (const p of parts) {
    const k = keyOf(p.pid, p.color_id);
    const prev = collection.get(k);
    if (prev) prev.qty += p.qty * copies;
    else collection.set(k, { ...p, qty: p.qty * copies });
  }
  save();
  renderPieces();
  await refreshResults();
}

async function onSetSubmit(e) {
  e.preventDefault();
  if (!pickedSet) {
    // Enter on a typed set number without picking from the list.
    await searchSets($("set-search").value);
    const first = $("set-suggestions")._items?.[0];
    if (!first) return;
    pickSet(first);
  }
  const s = pickedSet;
  const copies = Math.max(1, Math.floor(Number($("set-qty").value) || 1));
  pickedSet = null;
  $("set-search").value = "";
  $("set-qty").value = 1;
  await addSet(s, copies);
}

// ---------- collection list ----------

function swatch(c) {
  if (!c?.rgb) return "";
  return `<span class="swatch" style="background:#${esc(c.rgb)}${c.is_trans ? ";opacity:.6" : ""}"></span>`;
}

function img(path, cls) {
  return path
    ? `<img class="${cls}" src="${IMG + esc(path)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<span class="${cls}"></span>`;
}

function renderPieces() {
  const items = [...collection.values()].sort((a, b) => a.part_num.localeCompare(b.part_num, "en", { numeric: true }) || a.color_id - b.color_id);
  const total = items.reduce((s, p) => s + p.qty, 0);
  $("piece-count").textContent = fmt(total);
  $("pieces-empty").hidden = items.length > 0;
  $("pieces").innerHTML = items.map((p) => {
    const c = colors.get(p.color_id);
    return `<li data-k="${keyOf(p.pid, p.color_id)}">
      ${img(p.img, "thumb")}
      <div class="info"><strong>${esc(p.part_num)}</strong> ${swatch(c)}${esc(c?.name)}
        <span class="name">${esc(p.name)}</span></div>
      <input type="number" min="0" value="${p.qty}" aria-label="Quantity">
      <button type="button" class="icon-btn" aria-label="Remove">×</button></li>`;
  }).join("");
}

function onPiecesInput(e) {
  const li = e.target.closest("li");
  if (!li) return;
  const item = collection.get(li.dataset.k);
  const qty = Math.floor(Number(e.target.value));
  if (!item || !(qty >= 0)) return;
  if (qty === 0) collection.delete(li.dataset.k);
  else item.qty = qty;
  save();
  if (qty === 0) renderPieces();
  else $("piece-count").textContent = fmt([...collection.values()].reduce((s, p) => s + p.qty, 0));
  scheduleResults();
}

function onPiecesClick(e) {
  if (!e.target.classList.contains("icon-btn")) return;
  collection.delete(e.target.closest("li").dataset.k);
  save();
  renderPieces();
  scheduleResults();
}

// ---------- matching ----------

let resultsTimer;
let resultsSeq = 0;
let lastResults = [];
let allResults = [];
let resultsLimit = MAX_RESULTS;

function scheduleResults() {
  clearTimeout(resultsTimer);
  resultsTimer = setTimeout(refreshResults, 350);
}

function matchMode() { return $("match-mode").value; }

const FILTER_IDS = ["match-mode", "min-size", "theme-filter", "year-from", "year-to", "max-missing"];

function readFilters() {
  const num = (id) => ($(id).value === "" ? null : Number($(id).value));
  return {
    minSize: Number($("min-size").value),
    theme: num("theme-filter"),
    yearFrom: num("year-from"),
    yearTo: num("year-to"),
    maxMissing: num("max-missing"),
  };
}

function saveFilters() {
  const values = Object.fromEntries(FILTER_IDS.map((id) => [id, $(id).type === "checkbox" ? $(id).checked : $(id).value]));
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(values)); } catch {}
}

let savedFilters = {};

function restoreFilters() {
  try { savedFilters = JSON.parse(localStorage.getItem(FILTERS_KEY) || "{}"); } catch {}
  for (const [id, v] of Object.entries(savedFilters)) {
    if (!FILTER_IDS.includes(id)) continue;
    if ($(id).type === "checkbox") $(id).checked = Boolean(v);
    else $(id).value = v;
  }
}

function rootTheme(id) {
  let t = themes.get(id);
  while (t?.parent_id != null && themes.has(t.parent_id)) t = themes.get(t.parent_id);
  return t?.id ?? id;
}

// Top-level themes that have sets, for the theme filter.
function fillThemes(m) {
  const counts = new Map();
  for (const s of m.sets) {
    s.root_theme = rootTheme(s.theme_id);
    counts.set(s.root_theme, (counts.get(s.root_theme) || 0) + 1);
  }
  const sel = $("theme-filter");
  sel.innerHTML = `<option value="">All</option>` + [...counts]
    .map(([id, n]) => [themes.get(id)?.name ?? `Theme ${id}`, id, n])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, id, n]) => `<option value="${id}">${esc(name)} (${fmt(n)})</option>`).join("");
  sel.value = savedFilters["theme-filter"] ?? "";
  if (sel.selectedIndex < 0) sel.value = "";
}

async function refreshResults() {
  const seq = ++resultsSeq;
  const text = $("set-filter").value.trim().toLowerCase();
  if (!collection.size && !text) {
    lastResults = allResults = [];
    renderResults();
    setStatus(`${fmt(totalSets)} sets`);
    return;
  }
  setStatus("Loading set data…");
  const t0 = performance.now();
  let m;
  try {
    m = await matchData;
  } catch {
    setStatus("Could not load the set data (data/match.bin.gz). Run scripts/build_db.py first.", true);
    return;
  }
  if (seq !== resultsSeq) return;
  const mode = matchMode();
  const got = coverage(m, mode);
  // What other colors and similar parts would add, shown as a hint.
  const flex = mode === "similar" ? got : coverage(m, "similar");
  const f = readFilters();
  const rows = [];
  for (const s of m.sets) {
    const g = got[s.sid];
    // With search text, sets you have nothing for are listed too.
    const rank = text ? setTextRank(s, text) : 0;
    if (rank < 0 || (!g && !text) || s.total < f.minSize) continue;
    if (f.theme != null && s.root_theme !== f.theme) continue;
    if ((f.yearFrom != null && s.year < f.yearFrom) || (f.yearTo != null && s.year > f.yearTo)) continue;
    if (f.maxMissing != null && s.total - g > f.maxMissing) continue;
    rows.push({ ...s, got: g, ratio: g / s.total, more: flex[s.sid] - g, rank });
  }
  rows.sort((a, b) => b.ratio - a.ratio || a.rank - b.rank || b.total - a.total);
  allResults = rows;
  lastResults = rows.slice(0, resultsLimit);
  renderResults();
  setStatus(`${fmt(totalSets)} sets checked in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
}

function themeName(id) {
  const t = themes.get(id);
  if (!t) return "";
  const parent = t.parent_id != null ? themes.get(t.parent_id) : null;
  return parent ? `${parent.name} › ${t.name}` : t.name;
}

function setImg(setNum) {
  return `${IMG}sets/${setNum.toLowerCase()}.jpg`;
}

function renderResults() {
  $("results-empty").hidden = lastResults.length > 0;
  $("results-empty").textContent = $("set-filter").value.trim()
    ? "No sets match this search with these filters."
    : collection.size
      ? "No sets match these pieces with these filters. Try loosening them."
      : "Add some pieces, or search above, to see sets.";
  $("results-more").hidden = !allResults.length;
  $("results-count").textContent = `Showing ${fmt(lastResults.length)} of ${fmt(allResults.length)} sets`;
  $("more-btn").hidden = lastResults.length >= allResults.length;
  const moreWith = matchMode() === "exact" ? "other colors or similar parts" : "similar parts";
  $("results").innerHTML = lastResults.map((r, i) => {
    const pct = Math.floor(r.ratio * 1000) / 10;
    return `<li><button type="button" class="result" data-i="${i}">
      <img src="${esc(setImg(r.set_num))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="body">
        <div class="title">${esc(r.name)}</div>
        <div class="sub">${esc(r.set_num)} · ${r.year} · ${esc(themeName(r.theme_id))}</div>
        <div class="sub">${fmt(r.got)} of ${fmt(r.total)} pieces${r.more > 0 ? ` <span class="hint">· +${fmt(r.more)} with ${moreWith}</span>` : ""}</div>
        <div class="bar"><span class="${pct >= 100 ? "full" : ""}" style="width:${Math.min(100, pct)}%"></span></div>
      </div>
      <div class="pct">${pct}%</div></button></li>`;
  }).join("");
}

// ---------- set detail ----------

async function openSet(r) {
  const dialog = $("set-dialog");
  const body = $("set-detail");
  body.innerHTML = `<p class="empty">Loading parts…</p>`;
  dialog.showModal();

  const [parts, m] = await Promise.all([setParts(r.sid), matchData]);
  const mode = matchMode();

  // How many of each line the collection covers: exact matches first, then the
  // same part in other colors, then similar parts. The match mode decides which
  // of these count; the others are shown as substitutes you could use.
  const items = [...collection.values()];
  const pool = new Map(items.map((p) => [keyOf(p.pid, p.color_id), p.qty]));
  const familyOf = (pid) => m.familyOf.get(pid) ?? pid;
  const groupBy = (key) => {
    const map = new Map();
    for (const p of items) map.set(key(p), [...(map.get(key(p)) || []), p]);
    return map;
  };
  const byPart = groupBy((p) => p.pid);
  const byFamily = groupBy((p) => familyOf(p.pid));
  const take = (p, candidates, kind) => {
    for (const c of candidates || []) {
      const k = keyOf(c.pid, c.color_id);
      const n = Math.min(pool.get(k), p.qty - p.covered);
      if (n <= 0 || k === keyOf(p.pid, p.color_id) || (kind === "similar" && c.pid === p.pid)) continue;
      p.subs.push({ kind, n, part_num: c.part_num, color_id: c.color_id });
      p.covered += n;
      pool.set(k, pool.get(k) - n);
    }
  };
  for (const p of parts) {
    const k = keyOf(p.pid, p.color_id);
    p.covered = Math.min(p.qty, pool.get(k) || 0);
    p.subs = [];
    if (p.covered) pool.set(k, pool.get(k) - p.covered);
  }
  for (const p of parts) take(p, byPart.get(p.pid), "color");
  for (const p of parts) take(p, byFamily.get(familyOf(p.pid)), "similar");
  const counts = (sub) => (sub.kind === "color" ? mode !== "exact" : mode === "similar");
  let possible = 0;
  for (const p of parts) {
    p.have = p.covered - p.subs.filter((sub) => !counts(sub)).reduce((n, sub) => n + sub.n, 0);
    possible += p.covered - p.have;
  }
  const subNote = (p) => {
    const list = (subs) => subs.map((sub) => `${sub.n}× ${esc(sub.part_num)} ${esc(colors.get(sub.color_id)?.name ?? "")}`).join(", ");
    const used = p.subs.filter(counts);
    const could = p.subs.filter((sub) => !counts(sub));
    return (used.length ? `<div class="hint">Using ${list(used)}</div>` : "")
      + (could.length ? `<div class="hint">Could use ${list(could)}</div>` : "");
  };
  const missing = parts.filter((p) => p.have < p.qty).sort((a, b) => (b.qty - b.have) - (a.qty - a.have));
  const owned = parts.filter((p) => p.have >= p.qty);
  const missingCount = missing.reduce((s, p) => s + p.qty - p.have, 0);
  const instr = r.set_num.replace(/-\d+$/, "");

  const rowsHtml = (list) => list.map((p) => {
    const c = colors.get(p.color_id);
    const lack = p.qty - p.have;
    return `<tr class="${lack ? "" : "ok"}">
      <td>${img(p.img, "thumb")}</td>
      <td><a href="https://rebrickable.com/parts/${encodeURIComponent(p.part_num)}/" target="_blank" rel="noopener">${esc(p.part_num)}</a>
        <div class="pname">${esc(p.name)}</div>${subNote(p)}</td>
      <td>${swatch(c)}${esc(c?.name)}</td>
      <td class="num">${p.have} / ${p.qty}</td>
      <td class="num">${lack ? `<span class="missing">−${lack}</span>` : "✓"}</td></tr>`;
  }).join("");
  const table = (list) => `<table class="parts-table"><thead><tr><th></th><th>Part</th><th>Color</th>
    <th class="num">Have</th><th class="num">Missing</th></tr></thead><tbody>${rowsHtml(list)}</tbody></table>`;

  body.innerHTML = `
    <div class="detail-head">
      <img src="${esc(setImg(r.set_num))}" alt="" onerror="this.style.visibility='hidden'">
      <div>
        <h3>${esc(r.name)}</h3>
        <div class="sub">${esc(r.set_num)} · ${r.year} · ${esc(themeName(r.theme_id))}</div>
        <div class="sub">You have ${fmt(r.got)} of ${fmt(r.total)} pieces (${Math.floor(r.ratio * 1000) / 10}%)${missingCount ? ` · ${fmt(missingCount)} missing` : ""}${possible ? ` · <span class="hint">${fmt(possible)} could come from substitutes</span>` : ""}</div>
        <div class="links">
          <a href="https://www.lego.com/service/buildinginstructions/${encodeURIComponent(instr)}" target="_blank" rel="noopener">Instructions</a>
          <a href="https://rebrickable.com/sets/${encodeURIComponent(r.set_num)}/" target="_blank" rel="noopener">Rebrickable</a>
          <a href="https://www.bricklink.com/v2/catalog/catalogitem.page?S=${encodeURIComponent(r.set_num)}" target="_blank" rel="noopener">BrickLink</a>
          ${missing.length ? `<a href="#" id="dl-missing">Download missing (CSV)</a>` : ""}
          <button type="button" class="ghost" id="own-set">I own this set</button>
        </div>
      </div>
    </div>
    ${missing.length ? `<h4 class="section-label">Missing pieces (${fmt(missing.length)} kinds)</h4>${table(missing)}` : `<p>You have every piece for this set.</p>`}
    ${owned.length ? `<details><summary class="section-label">Pieces you have (${fmt(owned.length)} kinds)</summary>${table(owned)}</details>` : ""}`;

  $("own-set").onclick = () => {
    $("set-dialog").close();
    addSet(r);
  };
  const dl = $("dl-missing");
  if (dl) dl.onclick = (e) => {
    e.preventDefault();
    download(`${r.set_num}-missing.csv`, toCsv(missing.map((p) => [p.part_num, p.color_id, p.qty - p.have])));
  };
}

// ---------- import / export ----------

function toCsv(rows) {
  return "Part,Color,Quantity\n" + rows.map((r) => r.join(",")).join("\n") + "\n";
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => l.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]).map((h) => h.toLowerCase());
  let iPart = head.indexOf("part"), iColor = head.indexOf("color"), iQty = head.indexOf("quantity");
  let start = 1;
  if (iPart < 0 || iColor < 0) { iPart = 0; iColor = 1; iQty = 2; start = 0; }
  const iSpare = head.indexOf("is spare");
  const rows = [];
  for (const line of lines.slice(start)) {
    const cols = split(line);
    if (iSpare >= 0 && /^true$/i.test(cols[iSpare] || "")) continue;
    const qty = iQty >= 0 ? Number(cols[iQty]) : 1;
    if (cols[iPart] && cols[iColor] !== "" && !Number.isNaN(Number(cols[iColor]))) rows.push([cols[iPart], Number(cols[iColor]), qty || 1]);
  }
  return rows;
}

async function importFile(e) {
  const file = db && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const rows = parseCsv(await file.text());
  if (!rows.length) return setStatus("That file has no Part,Color,Quantity rows.", true);
  const { added, skipped } = await addRows(rows);
  renderPieces();
  await refreshResults();
  if (skipped) setStatus(`Imported ${fmt(added)} rows; ${fmt(skipped)} unknown part numbers were skipped.`);
}

async function loadSample() {
  const m = await matchData;
  collection.clear();
  for (const p of m.sample) collection.set(keyOf(p.pid, p.color_id), { ...p });
  save();
  renderPieces();
  await refreshResults();
}

// ---------- wiring ----------

let searchTimer;
$("part-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => search(e.target.value), 200);
});
wireSuggestions($("part-search"), $("suggestions"));
wireSuggestions($("set-search"), $("set-suggestions"));
let setSearchTimer;
$("set-search").addEventListener("input", (e) => {
  clearTimeout(setSearchTimer);
  setSearchTimer = setTimeout(() => searchSets(e.target.value), 150);
});
$("set-form").addEventListener("submit", onSetSubmit);
$("add-form").addEventListener("submit", addPicked);
$("pieces").addEventListener("change", onPiecesInput);
$("pieces").addEventListener("click", onPiecesClick);
$("results").addEventListener("click", (e) => {
  const btn = e.target.closest(".result");
  if (btn) openSet(lastResults[Number(btn.dataset.i)]);
});
for (const id of FILTER_IDS) {
  $(id).addEventListener("change", () => {
    saveFilters();
    resultsLimit = MAX_RESULTS;
    refreshResults();
  });
}
let browseTimer;
$("set-filter").addEventListener("input", () => {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(() => {
    resultsLimit = MAX_RESULTS;
    refreshResults();
  }, 200);
});
$("more-btn").addEventListener("click", () => {
  resultsLimit += MAX_RESULTS;
  lastResults = allResults.slice(0, resultsLimit);
  renderResults();
});
$("import-file").addEventListener("change", importFile);
$("export-btn").addEventListener("click", () =>
  download("my-pieces.csv", toCsv([...collection.values()].map((p) => [p.part_num, p.color_id, p.qty]))));
$("clear-btn").addEventListener("click", () => {
  if (!collection.size || !confirm("Remove all pieces from your list?")) return;
  collection.clear();
  save();
  renderPieces();
  refreshResults();
});
$("sample-btn").addEventListener("click", () => {
  if (collection.size && !confirm("Replace your list with the pieces of a Medium Creative Brick Box (10696)?")) return;
  loadSample();
});
$("set-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

init();
