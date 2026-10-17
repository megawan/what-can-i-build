// What Can I Build? — matches a collection of loose parts against every set.
// Matching runs in memory on data/match.bin.gz (every set's parts, downloaded
// once); search and set details query a static SQLite database through
// sql.js-httpvfs (HTTP range requests).

const IMG = "https://cdn.rebrickable.com/media/";
const STORE_KEY = "wcib.collection.v1";
// Resolved collection rows, valid only for the database build they came from.
const RESOLVED_KEY = "wcib.resolved.v1";
const FILTERS_KEY = "wcib.filters.v1";
const PLAN_KEY = "wcib.plan.v1";
// Ticked-off pick list lines, per list.
const PICKED_KEY = "wcib.picked.v1";
// The list of collections and which one is open. The first collection keeps
// the storage keys above, so pieces saved before collections existed stay.
const COLLECTIONS_KEY = "wcib.collections.v1";
// Set numbers seen on the previous visit, and the sets new since then.
const SEEN_KEY = "wcib.seen.v1";
const NEW_KEY = "wcib.newsets.v1";
const ALL = "all";
const MAX_RESULTS = 60;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => n.toLocaleString("en-US");
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

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
    for (const c of await query("SELECT id, name, rgb, is_trans, bl_id FROM colors")) colors.set(c.id, c);
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

  for (const id of ["set-filter", "export-btn", "plan-suggest", "collection-select", "col-new", "col-rename", "col-delete", "share-btn", "sort-btn"]) $(id).disabled = false;
  restoreFilters();
  loadCollections();
  await restore();
  renderCollections();
  renderPieces();
  matchData.then(trackNewSets).catch(() => {});
  await refreshResults();
  offerSharedLink();
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

// Fetches a .gz data file, unzipping it unless the server already did.
async function fetchGzip(url, cache = "default") {
  const res = await fetch(url, { cache });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const magic = new Uint8Array(buf, 0, 2);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

// Decodes match.bin.gz (format documented in scripts/build_db.py, write_match).
async function loadMatchData(url, cache = "default") {
  const buf = await fetchGzip(url, cache);
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

// For every set, how many of its pieces the given pieces (by default the whole
// collection) cover. mode is "exact" (part and color), "color" (all colors of
// a part pool together) or "similar" (all colors of a whole family of similar
// parts pool together).
function coverage(m, mode, items = [...collection.values()]) {
  const got = new Int32Array(m.sets.length + 1);
  if (mode === "exact") {
    for (const p of items) {
      const g = lowerBound(m.keys, matchKey(p.pid, p.color_id));
      if (m.keys[g] !== matchKey(p.pid, p.color_id)) continue;
      for (let e = m.starts[g]; e < m.starts[g + 1]; e++) got[m.sids[e]] += Math.min(m.qtys[e], p.qty);
    }
    return got;
  }
  const poolOf = (pid) => (mode === "similar" && m.familyOf.get(pid)) || pid;
  const have = new Map();
  for (const p of items) have.set(poolOf(p.pid), (have.get(poolOf(p.pid)) || 0) + p.qty);
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

// ---------- collections ----------

let collections = { active: "main", list: [{ id: "main", name: "My pieces" }] };

const combined = () => collections.active === ALL;
const keysFor = (id) => (id === "main"
  ? { rows: STORE_KEY, resolved: RESOLVED_KEY, plan: PLAN_KEY }
  : { rows: `wcib.collection.${id}.v1`, resolved: `wcib.resolved.${id}.v1`, plan: `wcib.plan.${id}.v1` });
const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
};
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};

function loadCollections() {
  const saved = readJson(COLLECTIONS_KEY, null);
  if (saved?.list?.length) collections = saved;
  if (collections.active !== ALL && !collections.list.some((c) => c.id === collections.active)) collections.active = collections.list[0].id;
}

function renderCollections() {
  const sel = $("collection-select");
  sel.innerHTML = collections.list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")
    + (collections.list.length > 1 ? `<option value="${ALL}">All collections combined</option>` : "");
  sel.value = collections.active;
  const all = combined();
  $("col-rename").hidden = all;
  $("col-delete").hidden = all || collections.list.length < 2;
  $("combined-note").hidden = !all;
  // The combined view is for matching only.
  for (const id of ["part-search", "finder-btn", "set-search", "set-qty", "set-add-btn", "sample-btn", "clear-btn", "import-file"]) $(id).disabled = all;
}

function save() {
  if (combined()) return;
  const keys = keysFor(collections.active);
  const items = [...collection.values()];
  writeJson(keys.rows, items.map((p) => [p.part_num, p.color_id, p.qty]));
  writeJson(keys.resolved, { built_at: builtAt, items });
}

// A collection's pieces. Resolved rows are reused for the same database
// build; otherwise the part numbers are looked up again.
async function loadItems(id) {
  const keys = keysFor(id);
  const rows = readJson(keys.rows, []);
  const resolved = readJson(keys.resolved, null);
  if (resolved?.built_at === builtAt && resolved.items?.length === rows.length) return resolved.items;
  const items = rows.length ? await resolveRows(rows) : [];
  writeJson(keys.resolved, { built_at: builtAt, items });
  return items;
}

async function restore() {
  collection.clear();
  const ids = combined() ? collections.list.map((c) => c.id) : [collections.active];
  for (const id of ids) {
    for (const p of await loadItems(id)) {
      const k = keyOf(p.pid, p.color_id);
      const prev = collection.get(k);
      if (prev) prev.qty += p.qty;
      else collection.set(k, { ...p });
    }
  }
  planNums = readJson(combined() ? "wcib.plan.all.v1" : keysFor(collections.active).plan, []);
}

async function switchCollection(id) {
  collections.active = id;
  writeJson(COLLECTIONS_KEY, collections);
  await restore();
  renderCollections();
  renderPieces();
  resultsLimit = MAX_RESULTS;
  await refreshResults();
}

function uniqueName(name) {
  let n = name, i = 2;
  while (collections.list.some((c) => c.name === n)) n = `${name} (${i++})`;
  return n;
}

// Adds a collection, optionally with pieces ([[part_num, color_id, qty], ...])
// and a build plan, and opens it.
async function newCollection(name, rows = [], plan = []) {
  const id = Date.now().toString(36);
  collections.list.push({ id, name: uniqueName(name) });
  writeJson(keysFor(id).rows, rows);
  writeJson(keysFor(id).plan, plan);
  await switchCollection(id);
}

function editable() {
  if (!combined()) return true;
  setStatus("Switch to one collection to change its pieces.", true);
  return false;
}

// Resolve [[part_num, color_id, qty], ...] (any part number, including mold
// variants) to canonical parts; unknown part numbers are dropped.
function resolveRows(rows) {
  return query(
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
}

// Resolve rows and merge them into the open collection.
async function addRows(rows, { replace = false } = {}) {
  const resolved = await resolveRows(rows);
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
    `SELECT sp.pid, p.part_num, p.name, p.cat_id, sp.color_id, sp.qty,
            coalesce(i.img, (SELECT img FROM part_imgs j WHERE j.pid = sp.pid LIMIT 1)) AS img
     FROM set_parts sp
     CROSS JOIN parts p ON p.pid = sp.pid
     LEFT JOIN part_imgs i ON i.pid = sp.pid AND i.color_id = sp.color_id
     WHERE sp.sid = ?`, [sid]);
}

async function addSet(s, copies = 1) {
  if (!editable()) return;
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

// ---------- part finder ----------

// Everyday and Indonesian words for shapes and features, mapped to the words
// Rebrickable uses in part names. The word itself is always tried too.
const SYNONYMS = {
  flat: ["tile"], smooth: ["tile"], thin: ["plate"], slanted: ["slope"], sloped: ["slope"], ramp: ["slope"], roof: ["slope"],
  circle: ["round"], circular: ["round"], cylinder: ["round", "cylinder"], tube: ["round", "tube"], curve: ["curved"],
  holes: ["hole"], stick: ["bar"], rod: ["bar"], pole: ["bar"], tire: ["tyre", "tire"], tires: ["tyre", "tire"],
  triangle: ["wedge", "triangle"], triangular: ["wedge"], corner: ["corner"], person: ["minifig"], figure: ["minifig"],
  bata: ["brick"], balok: ["brick", "beam"], pelat: ["plate"], plat: ["plate"], tipis: ["plate"], datar: ["tile"], rata: ["tile"],
  licin: ["tile"], halus: ["tile"], miring: ["slope"], atap: ["slope", "roof"], bulat: ["round"], bundar: ["round"],
  lingkaran: ["round"], tabung: ["round", "cylinder"], lengkung: ["curved", "arch"], melengkung: ["curved"],
  lengkungan: ["arch"], lubang: ["hole"], berlubang: ["hole"], roda: ["wheel"], ban: ["tyre", "tire"], jendela: ["window"],
  pintu: ["door"], kaca: ["glass", "windscreen"], engsel: ["hinge"], kepala: ["head"], badan: ["torso"], kaki: ["legs"],
  tangan: ["arm", "hand"], lengan: ["arm"], rambut: ["hair"], topi: ["hat", "cap"], helm: ["helmet"], pohon: ["tree"],
  daun: ["leaf", "plant"], bunga: ["flower"], pagar: ["fence"], tangga: ["ladder", "stairs"], sudut: ["corner"],
  pojok: ["corner"], segitiga: ["wedge", "triangle"], baji: ["wedge"], kerucut: ["cone"], kubah: ["dome"], poros: ["axle"],
  gir: ["gear"], roda_gigi: ["gear"], sambungan: ["connector"], penghubung: ["connector"], pasak: ["pin"], tongkat: ["bar"],
  batang: ["bar", "beam"], piring: ["dish"], parabola: ["dish"], kotak: ["box", "container"], senjata: ["weapon"],
  pedang: ["sword"], tameng: ["shield"], perisai: ["shield"], hewan: ["animal"], binatang: ["animal"], stiker: ["sticker"],
  setir: ["steering"], kemudi: ["steering"], baling: ["propeller"], sayap: ["wing"], ekor: ["tail"], panel: ["panel"],
  pegangan: ["handle", "bar"], klip: ["clip"], penjepit: ["clip"], tonjolan: ["stud"], dasar: ["baseplate"],
};
const STOP_WORDS = new Set(("a an the with and of on in for piece pieces part parts lego bit small big large long short " +
  "dengan dan yang di pada ada untuk sebuah buah keping kepingan potong bagian kecil besar panjang pendek seperti").split(" "));
// Indonesian and everyday color words, mapped to Rebrickable color names.
const COLOR_WORDS = {
  merah: "Red", biru: "Blue", kuning: "Yellow", hijau: "Green", hitam: "Black", putih: "White", gray: "Light Bluish Gray",
  grey: "Light Bluish Gray", abu: "Light Bluish Gray", "abu-abu": "Light Bluish Gray", "dark gray": "Dark Bluish Gray",
  "dark grey": "Dark Bluish Gray", "abu tua": "Dark Bluish Gray", "abu-abu tua": "Dark Bluish Gray", brown: "Reddish Brown",
  coklat: "Reddish Brown", cokelat: "Reddish Brown", "coklat tua": "Dark Brown", "cokelat tua": "Dark Brown", oranye: "Orange",
  jingga: "Orange", krem: "Tan", beige: "Tan", emas: "Pearl Gold", gold: "Pearl Gold", perak: "Flat Silver",
  silver: "Flat Silver", ungu: "Dark Purple", purple: "Dark Purple", pink: "Bright Pink", "merah muda": "Bright Pink",
  bening: "Trans-Clear", transparan: "Trans-Clear", clear: "Trans-Clear", transparent: "Trans-Clear", "biru tua": "Dark Blue",
  "biru muda": "Medium Azure", "hijau tua": "Dark Green", "hijau muda": "Lime", "merah tua": "Dark Red",
  "kuning muda": "Bright Light Yellow", "light gray": "Light Bluish Gray", "light grey": "Light Bluish Gray",
};
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(?:x|×|by|kali)\s*(\d+(?:[.,]\d+)?)(?:\s*(?:x|×|by|kali)\s*(\d+(?:[.,]\d+)?))?/;
const STUDS_RE = /(\d+)\s*(?:studs?|tonjolan|bintil|titik|dots?)\b/;
const HOLES_RE = /(\d+)\s*(?:holes?|lubang)\b/;
const NAME_SIZE_RE = /(\d+(?:\.\d+)?) x (\d+(?:\.\d+)?)(?: x (\d+(?:\.\d+)?))?/;

let catalog;
let finderLimit = 48;

// "2 x 4" or "4 x 2 x 3" -> footprint [2, 4] (smaller side first), then height if given.
function sizeOf(m) {
  const [a, b, h] = m.slice(1, 4).map((n) => (n == null ? null : Number(n.replace(",", "."))));
  return h == null ? [Math.min(a, b), Math.max(a, b)] : [Math.min(a, b), Math.max(a, b), h];
}

function loadCatalog() {
  catalog ??= fetchGzip(new URL("data/parts.json.gz", location.href).href).then((buf) => {
    const data = JSON.parse(new TextDecoder().decode(buf));
    const categories = new Map(data.categories);
    const parts = data.parts.map(([pid, part_num, name, cat_id, in_sets, img]) => {
      const size = name.match(NAME_SIZE_RE);
      return { pid, part_num, name, cat_id, in_sets, img, lower: name.toLowerCase(), size: size ? sizeOf(size) : null };
    });
    const sel = $("finder-cat");
    const counts = new Map();
    for (const p of parts) counts.set(p.cat_id, (counts.get(p.cat_id) || 0) + 1);
    sel.innerHTML = `<option value="">All categories</option>` + [...counts]
      .map(([id, n]) => [categories.get(id) ?? "Other", id, n])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, id, n]) => `<option value="${id}">${esc(name)} (${fmt(n)})</option>`).join("");
    return { parts, categories, byNum: new Map(parts.map((p) => [p.part_num, p])) };
  });
  return catalog;
}

// Color phrases, longest first so "dark blue" wins over "blue".
let colorPhrases;
function findColor(text) {
  colorPhrases ??= [
    ...[...colors.values()].flatMap((c) => [[c.name.toLowerCase(), c.id], [c.name.toLowerCase().replace(/-/g, " "), c.id]]),
    ...Object.entries(COLOR_WORDS).map(([w, name]) => [w, [...colors.values()].find((c) => c.name === name)?.id]),
  ].filter(([w, id]) => id != null && !w.startsWith("[")).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, id] of colorPhrases) {
    const re = new RegExp(`(^|[^\\p{L}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u");
    if (re.test(text)) return { id, rest: text.replace(re, "$1 ") };
  }
  return { id: null, rest: text };
}

// Splits a description into color, size, stud count and word groups; each
// group is a list of alternatives, any of which may appear in a part name.
function parseDescription(text) {
  let rest = ` ${text.toLowerCase()} `;
  const color = findColor(rest);
  rest = color.rest;
  let size = null, studs = null;
  const sm = rest.match(SIZE_RE);
  if (sm) { size = sizeOf(sm); rest = rest.replace(sm[0], " "); }
  const st = rest.match(STUDS_RE);
  if (st) { studs = Number(st[1]); rest = rest.replace(st[0], " "); }
  // Technic beams are named by length: "7 holes" means 1 x 7.
  let holes = null;
  const ho = rest.match(HOLES_RE);
  if (ho && !size && Number(ho[1]) > 1) { holes = Number(ho[1]); rest = rest.replace(ho[0], " "); }
  rest = rest.replace(/roda gigi/g, "roda_gigi");
  const words = rest.split(/[^\p{L}\p{N}_°]+/u).filter((w) => w && !STOP_WORDS.has(w));
  const groups = words.map((w) => {
    const alts = new Set([w, ...(SYNONYMS[w] || [])]);
    if (w.length > 3 && w.endsWith("s")) alts.add(w.slice(0, -1));
    return { word: w, alts: [...alts] };
  });
  return { color: color.id, size, studs, holes, groups };
}

const colorAvailable = (m, pid, color) => m.keys[lowerBound(m.keys, matchKey(pid, color))] === matchKey(pid, color);

// Shapes for the "pick what it looks like" steps, as groups of Rebrickable
// part categories; each chip shows the most-used part of its group.
const SHAPES = [
  ["brick", "Brick", [11, 5]],
  ["plate", "Plate", [14, 9]],
  ["tile", "Tile (smooth top)", [19, 15]],
  ["slope", "Slope", [3]],
  ["curved", "Curved", [37]],
  ["round", "Round", [20, 21, 67]],
  ["wedge", "Wedge", [6, 49]],
  ["technic", "Technic", [8, 12, 22, 25, 26, 40, 44, 46, 51, 52, 53, 54, 55]],
  ["wheel", "Wheel or tyre", [29]],
  ["window", "Window or door", [16, 47]],
  ["hinge", "Hinge or turntable", [18]],
  ["bar", "Bar, ladder or fence", [32]],
  ["panel", "Panel", [23]],
  ["minifig", "Minifig part", [13, 27, 59, 60, 61, 65, 70, 71, 72, 73]],
  ["nature", "Plant, animal or rock", [28, 33, 74, 75, 76]],
  ["duplo", "Duplo", [4]],
];
const OTHER_SHAPE = ["other", "Something else", null];
// Name words that don't describe the shape, left out of the detail choices.
const NOT_DETAILS = new Set("print printed pattern patterned sticker type old new version sized without".split(" "));
// The most-used colors, offered as swatches.
const TOP_COLORS = [0, 15, 71, 72, 4, 14, 70, 1, 19, 2, 7, 25, 28, 297, 272, 47, 27, 320, 84, 322, 191, 41, 179, 10, 484, 36, 308, 288, 3, 29, 85, 378];

let finderMode = "pick";
const pickState = { shape: null, size: null, details: [], color: null };
let photoResults = [];

const shapeCats = (key) => {
  if (key === "other") {
    const used = new Set(SHAPES.flatMap((sh) => sh[2]));
    return { has: (c) => !used.has(c) };
  }
  return key ? new Set(SHAPES.find((sh) => sh[0] === key)[2]) : null;
};

// Parts that fit a query, best first. Words no part name contains (e.g.
// untranslated ones) are ignored rather than ruling everything out.
function searchCatalog(parts, m, q, cats) {
  const known = q.groups.filter((g) => parts.some((p) => g.alts.some((a) => p.lower.includes(a))));
  const ignored = q.groups.filter((g) => !known.includes(g));
  const scored = [];
  for (const p of parts) {
    if (cats && !cats.has(p.cat_id)) continue;
    // Two numbers match the footprint, so "1 x 2" also finds "Brick 1 x 2 x 3".
    if (q.size && (!p.size || q.size.some((n, i) => n !== p.size[i]))) continue;
    if (q.studs && (!p.size || p.size[0] * p.size[1] !== q.studs)) continue;
    if (q.holes && (!p.size || !p.size.slice(0, 2).includes(q.holes))) continue;
    if (q.color != null && !colorAvailable(m, p.pid, q.color)) continue;
    let score = 0, weight = p.in_sets;
    for (const g of known) {
      if (g.alts.some((a) => p.lower.includes(a))) score++;
      // A part named after the word ("Wheel …" for "wheel") counts double.
      if (g.alts.some((a) => p.lower.startsWith(a))) weight = p.in_sets * 2;
    }
    if (known.length && !score) continue;
    scored.push({ p, score, weight });
  }
  scored.sort((a, b) => b.score - a.score || b.weight - a.weight);
  const exact = scored.filter((r) => r.score === known.length);
  return { list: (exact.length ? exact : scored).map((r) => r.p), exact: exact.length > 0, known, ignored };
}

function pickQuery() {
  return {
    color: pickState.color,
    size: pickState.size,
    studs: null,
    holes: null,
    groups: pickState.details.map((w) => ({ word: w, alts: [w] })),
  };
}

const chip = (attrs, pressed, inner, cls = "chip") => `<button type="button" class="${cls}" ${attrs} aria-pressed="${pressed}">${inner}</button>`;

// Shape chips, then the sizes and details that occur among the parts still
// in play, so each step only offers choices that lead somewhere.
function renderPickChips(parts, m, list) {
  $("pick-shapes").innerHTML = [...SHAPES, OTHER_SHAPE].map(([key, label]) => {
    const cats = shapeCats(key);
    const top = parts.find((p) => cats.has(p.cat_id));
    const pic = top?.img ? `<img src="${IMG + esc(top.img)}" alt="" loading="lazy">` : "";
    return chip(`data-shape="${key}"`, pickState.shape === key, `${pic}${esc(label)}`, "chip shape");
  }).join("");

  const sized = searchCatalog(parts, m, { ...pickQuery(), size: null }, shapeCats(pickState.shape)).list;
  const sizes = new Map();
  for (const p of sized) {
    if (!p.size) continue;
    const k = p.size.slice(0, 2).join("x");
    sizes.set(k, (sizes.get(k) || 0) + p.in_sets);
  }
  const current = pickState.size?.join("x");
  const topSizes = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k]) => k);
  if (current && !topSizes.includes(current)) topSizes.unshift(current);
  $("pick-sizes").innerHTML = topSizes
    .sort((a, b) => a.split("x")[0] - b.split("x")[0] || a.split("x")[1] - b.split("x")[1])
    .map((k) => chip(`data-size="${k}"`, k === current, k.replace("x", " × "))).join("")
    || `<span class="step-label">No sizes in studs for these parts.</span>`;

  // Words that split the remaining parts: in at least two of them (one-off
  // print descriptions aren't useful) but not in nearly all of them.
  const colorWords = new Set([...colors.values()].flatMap((c) => c.name.toLowerCase().split(/[^a-z]+/)));
  const counts = new Map();
  const sample = list.slice(0, 3000);
  for (const p of sample) {
    for (const w of new Set(p.lower.split(/[^a-z°]+/))) {
      if (w.length < 3 || STOP_WORDS.has(w) || NOT_DETAILS.has(w) || colorWords.has(w) || pickState.details.includes(w)) continue;
      const c = counts.get(w) || { parts: 0, weight: 0 };
      c.parts++;
      c.weight += p.in_sets;
      counts.set(w, c);
    }
  }
  const total = sample.reduce((n, p) => n + p.in_sets, 0);
  const details = [...counts].filter(([, c]) => c.parts > 1 && c.weight < total * 0.85)
    .sort((a, b) => b[1].weight - a[1].weight).slice(0, 14).map(([w]) => w);
  $("pick-details").innerHTML = [...pickState.details.map((w) => chip(`data-detail="${esc(w)}"`, true, esc(w))),
    ...details.map((w) => chip(`data-detail="${esc(w)}"`, false, esc(w)))].join("")
    || `<span class="step-label">Pick a shape first.</span>`;

  $("pick-colors").innerHTML = TOP_COLORS.filter((id) => colors.has(id)).map((id) => {
    const c = colors.get(id);
    return chip(`data-color="${id}" title="${esc(c.name)}" aria-label="${esc(c.name)}"`, pickState.color === id, swatch(c), "chip color");
  }).join("");
}

function renderFinderGrid(cards, emptyText) {
  const shown = cards.slice(0, finderLimit);
  $("finder-grid").innerHTML = shown.map((c, i) => `<li><button type="button" data-i="${i}"${c.part ? "" : ' class="unknown"'}>
      ${c.img ? `<img src="${esc(c.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="noimg"></span>`}
      <strong>${esc(c.title)}</strong><span>${esc(c.name)}</span>
      <span class="meta">${c.meta}</span></button></li>`).join("")
    || `<li class="empty">${emptyText}</li>`;
  $("finder-grid")._items = shown;
  $("finder-more-row").hidden = !cards.length;
  $("finder-count").textContent = `Showing ${fmt(shown.length)} of ${fmt(cards.length)}`;
  $("finder-more").hidden = shown.length >= cards.length;
}

const partCard = (p, categories, color) => ({
  part: { ...p, color_id: color ?? undefined },
  img: p.img ? IMG + p.img : null,
  title: p.part_num,
  name: p.name,
  meta: `${esc(categories.get(p.cat_id) ?? "")} · in ${fmt(p.in_sets)} sets`,
});

async function runFinder() {
  if (finderMode === "photo") return renderPhotoResults();
  const { parts, categories } = await loadCatalog();
  const m = await matchData;
  let q, cats;
  if (finderMode === "pick") {
    q = pickQuery();
    cats = shapeCats(pickState.shape);
  } else {
    q = parseDescription($("finder-text").value);
    cats = $("finder-cat").value === "" ? null : new Set([Number($("finder-cat").value)]);
  }
  const { list, exact, known, ignored } = searchCatalog(parts, m, q, cats);

  const bits = [];
  if (finderMode === "pick" && pickState.shape) bits.push(`<b>${esc([...SHAPES, OTHER_SHAPE].find((sh) => sh[0] === pickState.shape)[1])}</b>`);
  if (q.color != null) bits.push(`color <b>${esc(colors.get(q.color)?.name)}</b>`);
  if (q.size) bits.push(`size <b>${q.size.join(" × ")}</b>`);
  if (q.studs) bits.push(`<b>${q.studs}</b> studs`);
  if (q.holes) bits.push(`<b>${q.holes}</b> holes long`);
  for (const g of known) bits.push(`<b>${esc(g.word)}</b>${g.alts.length > 1 ? ` (${esc(g.alts.filter((a) => a !== g.word).join(" / "))})` : ""}`);
  let parsed = bits.length ? `Looking for ${bits.join(" · ")}` : "Showing the most common parts.";
  if (ignored.length) parsed += ` · ignored ${ignored.map((g) => `“${esc(g.word)}”`).join(", ")}`;
  if (!exact && known.length > 1 && list.length) parsed += " · no part matches every word, so these are the closest";
  $("finder-parsed").innerHTML = parsed;

  if (finderMode === "pick") renderPickChips(parts, m, list);
  renderFinderGrid(list.map((p) => partCard(p, categories, q.color)),
    "No parts match. Try fewer or different words, or another category.");
}

// ---------- photo identification ----------

// Scales a photo down to at most 1024 px, which is plenty for recognition and
// much quicker to upload. Formats the browser can't decode are sent as is.
async function shrinkPhoto(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const canvas = Object.assign(document.createElement("canvas"), {
      width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85)) || file;
  } catch {
    return file;
  }
}

// Brickognize answers with BrickLink part numbers. Most are Rebrickable numbers
// too; others differ by a mold letter (BrickLink 3040, Rebrickable 3040a).
async function toRebrickable(ids) {
  const { byNum } = await loadCatalog();
  const variants = (id) => [id, `${id}a`, `${id}b`, `${id}c`, id.replace(/[a-z]$/, "")];
  const found = new Map();
  const missing = [];
  for (const id of ids) {
    const hit = variants(id).map((v) => byNum.get(v)).find(Boolean);
    if (hit) found.set(id, hit);
    else missing.push(id);
  }
  if (missing.length) {
    const rows = await query(
      `WITH q(id, num) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
       SELECT q.id, p.pid, p.part_num, p.name, p.cat_id, p.in_sets,
              (SELECT img FROM part_imgs i WHERE i.pid = p.pid LIMIT 1) AS img
       FROM q LEFT JOIN part_aliases a ON a.part_num = q.num
       CROSS JOIN parts p ON p.pid = coalesce(a.pid, (SELECT pid FROM parts x WHERE x.part_num = q.num))`,
      [JSON.stringify(missing.flatMap((id) => variants(id).map((v) => [id, v])))]);
    for (const r of rows) if (!found.has(r.id)) found.set(r.id, { ...r, size: null, lower: r.name.toLowerCase() });
  }
  return found;
}

async function identifyPhoto(file) {
  if (!file) return;
  const preview = $("photo-preview");
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  photoResults = [];
  $("finder-grid").innerHTML = "";
  $("finder-more-row").hidden = true;
  $("finder-parsed").textContent = "Identifying the piece…";
  try {
    const form = new FormData();
    form.append("query_image", await shrinkPhoto(file), "photo.jpg");
    const res = await fetch("https://api.brickognize.com/predict/parts/", { method: "POST", body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = ((await res.json()).items || []).slice(0, 12);
    const found = await toRebrickable(items.map((it) => it.id));
    const seen = new Set();
    for (const it of items) {
      const p = found.get(it.id);
      if (p && seen.has(p.pid)) continue;
      if (p) seen.add(p.pid);
      photoResults.push({ it, part: p });
    }
  } catch (err) {
    console.error(err);
    $("finder-parsed").textContent = "Could not reach the recognition service. Check your connection and try again.";
    return;
  }
  renderPhotoResults();
}

async function renderPhotoResults() {
  if (!photoResults.length) {
    $("finder-parsed").textContent = $("photo-preview").hidden ? "" : "No piece recognized. Try a closer photo on a plain background.";
    $("finder-grid").innerHTML = "";
    $("finder-more-row").hidden = true;
    return;
  }
  const { categories } = await loadCatalog();
  $("finder-parsed").textContent = "Best guesses first. Pick yours, then choose its color.";
  renderFinderGrid(photoResults.map(({ it, part }) => part
    ? { ...partCard(part, categories), img: it.img_url, meta: `<span class="score">${Math.round(it.score * 100)}% match</span> · in ${fmt(part.in_sets)} sets` }
    : { part: null, describe: it.name, img: it.img_url, title: it.id, name: it.name,
        meta: `<span class="score">${Math.round(it.score * 100)}% match</span> · not in any set inventory; search by name` }), "");
}

function setFinderMode(mode) {
  finderMode = mode;
  for (const t of document.querySelectorAll("#finder-dialog .tab")) t.setAttribute("aria-selected", String(t.dataset.mode === mode));
  for (const pane of document.querySelectorAll("#finder-dialog .finder-pane")) pane.hidden = pane.dataset.pane !== mode;
  finderLimit = 48;
  if (mode === "describe") $("finder-text").focus();
  runFinder();
}

function onPickChip(e) {
  const c = e.target.closest(".chip");
  if (!c) return;
  const d = c.dataset;
  if (d.shape) {
    pickState.shape = pickState.shape === d.shape ? null : d.shape;
    pickState.size = null;
    pickState.details = [];
  } else if (d.size) {
    pickState.size = pickState.size?.join("x") === d.size ? null : d.size.split("x").map(Number);
  } else if (d.detail) {
    pickState.details = pickState.details.includes(d.detail)
      ? pickState.details.filter((w) => w !== d.detail) : [...pickState.details, d.detail];
  } else if (d.color) {
    pickState.color = pickState.color === Number(d.color) ? null : Number(d.color);
  }
  finderLimit = 48;
  runFinder();
}

let finderTimer;
function scheduleFinder() {
  clearTimeout(finderTimer);
  finderTimer = setTimeout(() => {
    finderLimit = 48;
    runFinder();
  }, 150);
}

function openFinder() {
  const text = $("part-search").value.trim();
  if (text) $("finder-text").value = text;
  $("finder-dialog").showModal();
  $("finder-parsed").textContent = "Loading the part list…";
  setFinderMode(text ? "describe" : finderMode);
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
      <input type="number" min="0" value="${p.qty}" aria-label="Quantity"${combined() ? " disabled" : ""}>
      ${combined() ? "" : `<button type="button" class="icon-btn" aria-label="Remove">×</button>`}</li>`;
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

const FILTER_IDS = ["match-mode", "min-size", "max-size", "theme-filter", "year-from", "year-to", "max-missing"];

function readFilters() {
  const num = (id) => ($(id).value === "" ? null : Number($(id).value));
  return {
    minSize: Number($("min-size").value) || 0,
    maxSize: num("max-size"),
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
  if (!collection.size && !text && !$("new-only")?.checked) {
    lastResults = allResults = [];
    renderResults();
    renderNewSets(null);
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
  // With a build plan, sets are ranked on the pieces the plan leaves free.
  const plan = computePlan(m, mode);
  renderPlan(plan);
  const planned = new Set(plan.entries.map((e) => e.set.sid));
  const pool = plan.entries.length ? plan.left : undefined;
  $("plan-note").hidden = !pool;
  $("plan-note").textContent = pool ? `Ranked with the ${fmt(pool.reduce((n, p) => n + p.qty, 0))} pieces your build plan leaves free.` : "";
  const got = coverage(m, mode, pool);
  // What other colors and similar parts would add, shown as a hint.
  const flex = mode === "similar" ? got : coverage(m, "similar", pool);
  const f = readFilters();
  const newOnly = $("new-only")?.checked && newSets.size > 0;
  const rows = [];
  for (const s of m.sets) {
    const g = got[s.sid];
    // With search text, or when listing new sets, sets you have nothing for are listed too.
    const rank = text ? setTextRank(s, text) : 0;
    if (newOnly && !newSets.has(s.set_num)) continue;
    if (rank < 0 || (!g && !text && !newOnly) || planned.has(s.sid) || !passesFilters(s, g, f)) continue;
    rows.push({ ...s, got: g, ratio: g / s.total, more: flex[s.sid] - g, rank, pool,
      poolNote: pool ? "Counting only the pieces your build plan leaves free." : "" });
  }
  rows.sort((a, b) => b.ratio - a.ratio || a.rank - b.rank || b.total - a.total);
  allResults = rows;
  lastResults = rows.slice(0, resultsLimit);
  renderNewSets(newOnly ? rows.length : null);
  renderResults();
  setStatus(`${fmt(totalSets)} sets checked in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
}

function passesFilters(s, got, f) {
  if (s.total < f.minSize || (f.maxSize != null && s.total > f.maxSize)) return false;
  if (f.theme != null && s.root_theme !== f.theme) return false;
  if ((f.yearFrom != null && s.year < f.yearFrom) || (f.yearTo != null && s.year > f.yearTo)) return false;
  return f.maxMissing == null || s.total - got <= f.maxMissing;
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
        <div class="title">${esc(r.name)}${newSets.has(r.set_num) ? `<span class="badge">New</span>` : ""}</div>
        <div class="sub">${esc(r.set_num)} · ${r.year} · ${esc(themeName(r.theme_id))}</div>
        <div class="sub">${fmt(r.got)} of ${fmt(r.total)} pieces${r.more > 0 ? ` <span class="hint">· +${fmt(r.more)} with ${moreWith}</span>` : ""}</div>
        <div class="bar"><span class="${pct >= 100 ? "full" : ""}" style="width:${Math.min(100, pct)}%"></span></div>
      </div>
      <div class="pct">${pct}%</div></button>
      <button type="button" class="plan-add" data-set="${esc(r.set_num)}" title="Add to build plan" aria-label="Add ${esc(r.name)} to build plan">+</button></li>`;
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
  // Results ranked against a build plan carry the pieces the plan leaves free.
  const items = r.pool ?? [...collection.values()];
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
        ${r.poolNote ? `<div class="sub">${esc(r.poolNote)}</div>` : ""}
        <div class="sub">You have ${fmt(r.got)} of ${fmt(r.total)} pieces (${Math.floor(r.ratio * 1000) / 10}%)${missingCount ? ` · ${fmt(missingCount)} missing` : ""}${possible ? ` · <span class="hint">${fmt(possible)} could come from substitutes</span>` : ""}</div>
        <div class="links">
          <a href="https://www.lego.com/service/buildinginstructions/${encodeURIComponent(instr)}" target="_blank" rel="noopener">Instructions</a>
          <a href="https://rebrickable.com/sets/${encodeURIComponent(r.set_num)}/" target="_blank" rel="noopener">Rebrickable</a>
          <a href="https://www.bricklink.com/v2/catalog/catalogitem.page?S=${encodeURIComponent(r.set_num)}" target="_blank" rel="noopener">BrickLink</a>
          ${missing.length ? `<a href="#" id="dl-missing">Download missing (CSV)</a>
            <button type="button" class="ghost" id="bl-wanted">BrickLink wanted list</button>` : ""}
          <button type="button" class="ghost" id="pick-set">Pick list</button>
          <button type="button" class="ghost" id="own-set">I own this set</button>
          <button type="button" class="ghost" id="plan-toggle">${planNums.includes(r.set_num) ? "Remove from build plan" : "Add to build plan"}</button>
        </div>
      </div>
    </div>
    <div class="bl-panel" id="bl-panel" hidden></div>
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
  const bl = $("bl-wanted");
  if (bl) bl.onclick = () => showWantedList(missing, `For ${r.set_num} ${r.name}`, r.set_num, $("bl-panel"));
  $("pick-set").onclick = () => openPickList(`${r.set_num} ${r.name}`, [{ set_num: r.set_num, title: "", lines: parts }]);
  $("plan-toggle").onclick = () => {
    $("set-dialog").close();
    togglePlan(r.set_num);
  };
}

// ---------- BrickLink wanted list ----------

// BrickLink's wanted list XML for the missing pieces, in BrickLink part and
// color numbers. Parts without a known BrickLink number keep their Rebrickable
// number, which BrickLink flags on upload so it can be fixed there.
async function wantedListXml(lines, remark) {
  const rows = await query(
    "SELECT b.pid, b.bl_id FROM json_each(?) j CROSS JOIN bl_parts b ON b.pid = j.value",
    [JSON.stringify([...new Set(lines.map((p) => p.pid))])]);
  const blPart = new Map(rows.map((r) => [r.pid, r.bl_id]));
  const items = new Map();
  const unmapped = [];
  for (const p of lines) {
    const id = blPart.get(p.pid);
    const color = colors.get(p.color_id)?.bl_id;
    if (!id || color == null) unmapped.push(p);
    // Without a BrickLink color, lines stay apart and name their color.
    const k = `${id ?? p.part_num}|${color ?? `rb${p.color_id}`}`;
    const note = color == null ? ` · Rebrickable color ${colors.get(p.color_id)?.name ?? p.color_id}` : "";
    const item = items.get(k) || { id: id ?? p.part_num, color, qty: 0, remark: remark + note };
    item.qty += p.qty - p.have;
    items.set(k, item);
  }
  const xml = [...items.values()].map((it) => `  <ITEM>
    <ITEMTYPE>P</ITEMTYPE>
    <ITEMID>${esc(it.id)}</ITEMID>
${it.color != null ? `    <COLOR>${it.color}</COLOR>\n` : ""}    <MINQTY>${it.qty}</MINQTY>
    <REMARKS>${esc(it.remark)}</REMARKS>
  </ITEM>`).join("\n");
  return { xml: `<INVENTORY>\n${xml}\n</INVENTORY>\n`, count: items.size, unmapped };
}

async function showWantedList(missing, remark, fileBase, panel) {
  panel.hidden = false;
  if ([...colors.values()].every((c) => c.bl_id == null)) {
    panel.innerHTML = `<p>This copy of the database has no BrickLink numbers, so a wanted list can't be made. Use the CSV instead.</p>`;
    return;
  }
  panel.innerHTML = `<p>Preparing the wanted list…</p>`;
  const { xml, count, unmapped } = await wantedListXml(missing, remark);
  const pieces = missing.reduce((n, p) => n + p.qty - p.have, 0);
  panel.innerHTML = `
    <p><b>Wanted list ready:</b> ${fmt(count)} lot${count === 1 ? "" : "s"}, ${fmt(pieces)} piece${pieces === 1 ? "" : "s"}.
      ${unmapped.length ? `<span class="missing">${fmt(unmapped.length)} with no BrickLink number or color
        (${[...new Set(unmapped.map((p) => p.part_num))].slice(0, 5).map(esc).join(", ")}${new Set(unmapped.map((p) => p.part_num)).size > 5 ? ", …" : ""}); BrickLink will ask you to fix those.</span>` : ""}</p>
    <div class="links">
      <button type="button" data-bl="copy">Copy XML</button>
      <button type="button" class="ghost" data-bl="download">Download XML</button>
      <a href="https://www.bricklink.com/v2/wanted/upload.page" target="_blank" rel="noopener">Open BrickLink upload page</a>
    </div>
    <p class="finder-help">On BrickLink's upload page, paste the XML (or choose the downloaded file), pick the wanted list to add to, and upload.
      Then use the list to find shops that sell these pieces.</p>`;
  const copy = panel.querySelector('[data-bl="copy"]');
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(xml);
      copy.textContent = "Copied";
    } catch {
      download(`${fileBase}-wanted.xml`, xml, "application/xml");
    }
  };
  panel.querySelector('[data-bl="download"]').onclick = () => download(`${fileBase}-wanted.xml`, xml, "application/xml");
}

// ---------- build plan ----------

// Set numbers in plan order; pieces go to earlier sets first.
let planNums = [];
let lastPlan = { entries: [], left: [] };

function savePlan() {
  writeJson(combined() ? "wcib.plan.all.v1" : keysFor(collections.active).plan, planNums);
}

function togglePlan(setNum) {
  planNums = planNums.includes(setNum) ? planNums.filter((n) => n !== setNum) : [...planNums, setNum];
  savePlan();
  refreshResults();
}

// A set's part lines from the match data, which is grouped by part; the
// per-set index is built the first time it's needed.
function setLines(m, sid) {
  if (!m.bySet) {
    const E = m.sids.length;
    const start = new Uint32Array(m.sets.length + 2);
    const group = new Int32Array(E);
    for (let g = 0; g < m.keys.length; g++) {
      for (let e = m.starts[g]; e < m.starts[g + 1]; e++) {
        group[e] = g;
        start[m.sids[e] + 1]++;
      }
    }
    for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
    const order = new Uint32Array(E);
    const fill = start.slice();
    for (let e = 0; e < E; e++) order[fill[m.sids[e]]++] = e;
    m.bySet = { start, order, group };
  }
  const { start, order, group } = m.bySet;
  const lines = [];
  for (let i = start[sid]; i < start[sid + 1]; i++) {
    const e = order[i];
    const key = m.keys[group[e]];
    lines.push({ pid: Math.floor(key / 16384), color_id: (key % 16384) - 1, qty: m.qtys[e], have: 0 });
  }
  return lines;
}

// Takes a set's pieces out of pool (key -> piece, quantities are used up):
// exact matches first, then, as the match mode allows, the same part in other
// colors or similar parts. Returns how many pieces it covered.
function allocate(m, pool, lines, mode) {
  const take = (l, k) => {
    const p = pool.get(k);
    if (!p) return;
    const n = Math.min(p.qty, l.qty - l.have);
    l.have += n;
    p.qty -= n;
    if (!p.qty) pool.delete(k);
  };
  for (const l of lines) take(l, keyOf(l.pid, l.color_id));
  if (mode !== "exact") {
    const poolOf = (pid) => (mode === "similar" && m.familyOf.get(pid)) || pid;
    const byPool = new Map();
    for (const [k, p] of pool) {
      if (!byPool.has(poolOf(p.pid))) byPool.set(poolOf(p.pid), []);
      // The same part in another color goes before a similar part.
      byPool.get(poolOf(p.pid)).push([p.pid, k]);
    }
    for (const l of lines) {
      const ks = (byPool.get(poolOf(l.pid)) || []).sort((a, b) => (b[0] === l.pid) - (a[0] === l.pid));
      for (const [, k] of ks) {
        if (l.have >= l.qty) break;
        take(l, k);
      }
    }
  }
  return lines.reduce((n, l) => n + l.have, 0);
}

function computePlan(m, mode) {
  m.setByNum ??= new Map(m.sets.map((s) => [s.set_num, s]));
  const pool = new Map([...collection].map(([k, p]) => [k, { ...p }]));
  const entries = [];
  for (const num of planNums) {
    const s = m.setByNum.get(num);
    if (!s) continue;
    const before = [...pool.values()].map((p) => ({ ...p }));
    const lines = setLines(m, s.sid);
    const got = allocate(m, pool, lines, mode);
    entries.push({ set: s, got, before, lines, missing: lines.filter((l) => l.have < l.qty) });
  }
  lastPlan = { entries, left: [...pool.values()] };
  return lastPlan;
}

function renderPlan(plan) {
  const { entries, left } = plan;
  $("plan-count").textContent = entries.length;
  $("plan-empty").hidden = entries.length > 0;
  $("plan-clear").hidden = !entries.length;
  $("plan-total").hidden = !entries.length;
  if (!entries.length) $("plan-bl").hidden = true;
  $("plan-list").innerHTML = entries.map((e, i) => {
    const s = e.set;
    const pct = Math.floor((e.got / s.total) * 1000) / 10;
    return `<li><span class="order">${i + 1}.</span><button type="button" class="result" data-plan="${i}">
      <img src="${esc(setImg(s.set_num))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <div class="body">
        <div class="title">${esc(s.name)}</div>
        <div class="sub">${esc(s.set_num)} · ${fmt(e.got)} of ${fmt(s.total)} pieces${e.got < s.total ? ` · <span class="missing">${fmt(s.total - e.got)} missing</span>` : ""}</div>
        <div class="bar"><span class="${pct >= 100 ? "full" : ""}" style="width:${Math.min(100, pct)}%"></span></div>
      </div>
      <div class="pct">${pct}%</div></button>
      <button type="button" class="icon-btn" data-remove="${esc(s.set_num)}" aria-label="Remove ${esc(s.name)} from the plan">×</button></li>`;
  }).join("");
  if (!entries.length) return;
  const used = entries.reduce((n, e) => n + e.got, 0);
  const missing = entries.reduce((n, e) => n + e.set.total - e.got, 0);
  const owned = [...collection.values()].reduce((n, p) => n + p.qty, 0);
  $("plan-total").innerHTML = `Uses <b>${fmt(used)}</b> of your ${fmt(owned)} pieces
    (${fmt(left.reduce((n, p) => n + p.qty, 0))} left over)${missing ? ` · <span class="missing">${fmt(missing)} pieces missing</span>` : " · nothing missing"}
    <div class="links"><button type="button" class="ghost" data-plan-export="pick">Pick list</button>
    ${missing ? `<a href="#" data-plan-export="csv">Download missing (CSV)</a>
      <button type="button" class="ghost" data-plan-export="bricklink">BrickLink wanted list</button>` : ""}</div>`;
}

// The missing pieces of every set in the plan, with part numbers.
async function planMissing() {
  const lines = new Map();
  for (const e of lastPlan.entries) {
    for (const l of e.missing) {
      const k = keyOf(l.pid, l.color_id);
      const line = lines.get(k) || { pid: l.pid, color_id: l.color_id, qty: 0, have: 0 };
      line.qty += l.qty - l.have;
      lines.set(k, line);
    }
  }
  const nums = new Map((await query("SELECT p.pid, p.part_num FROM json_each(?) j CROSS JOIN parts p ON p.pid = j.value",
    [JSON.stringify([...new Set([...lines.values()].map((l) => l.pid))])])).map((r) => [r.pid, r.part_num]));
  return [...lines.values()].map((l) => ({ ...l, part_num: nums.get(l.pid) ?? String(l.pid) }));
}

async function exportPlan(kind) {
  if (kind === "pick") return planPickList();
  const missing = await planMissing();
  const names = lastPlan.entries.map((e) => e.set.set_num);
  if (kind === "csv") return download("build-plan-missing.csv", toCsv(missing.map((p) => [p.part_num, p.color_id, p.qty])));
  const remark = `For build plan: ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}`;
  showWantedList(missing, remark, "build-plan", $("plan-bl"));
}

// Adds sets one at a time: each round takes the set that would use the most
// of the pieces still free, among those at least as complete as asked and
// within the result filters, until none qualifies (at most 10 per click).
async function suggestPlan() {
  const m = await matchData;
  const mode = matchMode();
  const threshold = Number($("plan-threshold").value);
  const f = readFilters();
  let added = 0;
  for (let round = 0; round < 10; round++) {
    const got = coverage(m, mode, computePlan(m, mode).left);
    const inPlan = new Set(planNums);
    let best = null;
    for (const s of m.sets) {
      const g = got[s.sid];
      if (!g || g < s.total * threshold || inPlan.has(s.set_num) || !passesFilters(s, g, f)) continue;
      if (!best || g > best.g || (g === best.g && s.total < best.s.total)) best = { s, g };
    }
    if (!best) break;
    planNums.push(best.s.set_num);
    added++;
  }
  savePlan();
  await refreshResults();
  setStatus(added
    ? `Added ${fmt(added)} set${added > 1 ? "s" : ""} to the build plan.`
    : `No more sets reach ${Math.round(threshold * 100)}% with the pieces left. Try a lower level or looser filters.`);
}

// ---------- pick list ----------

let categoryNames;
function loadCategories() {
  categoryNames ??= query("SELECT id, name FROM part_categories").then((rows) => new Map(rows.map((r) => [r.id, r.name])));
  return categoryNames;
}

// Pick lists for every set in the build plan, in plan order, with the pieces
// the plan gives each set.
async function planPickList() {
  const entries = lastPlan.entries;
  if (!entries.length) return;
  setStatus("Preparing the pick list…");
  const pairs = [...new Map(entries.flatMap((e) => e.lines).map((l) => [keyOf(l.pid, l.color_id), [l.pid, l.color_id]])).values()];
  const info = new Map((await query(
    `WITH q(pid, color_id) AS (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
     SELECT q.pid, q.color_id, p.part_num, p.name, p.cat_id,
            coalesce(i.img, (SELECT img FROM part_imgs j WHERE j.pid = q.pid LIMIT 1)) AS img
     FROM q CROSS JOIN parts p ON p.pid = q.pid
     LEFT JOIN part_imgs i ON i.pid = q.pid AND i.color_id = q.color_id`, [JSON.stringify(pairs)]))
    .map((r) => [keyOf(r.pid, r.color_id), r]));
  setStatus(`${fmt(totalSets)} sets`);
  openPickList("Build plan", entries.map((e, i) => ({
    set_num: e.set.set_num,
    title: `${i + 1}. ${e.set.set_num} ${e.set.name}`,
    lines: e.lines.map((l) => ({ ...info.get(keyOf(l.pid, l.color_id)), ...l })),
  })));
}

// Lines grouped by color (most pieces first), then by category and name, so
// pieces can be taken out of storage one color at a time.
async function pickGroups(lines) {
  const cats = await loadCategories();
  const byColor = new Map();
  for (const l of lines) {
    if (!byColor.has(l.color_id)) byColor.set(l.color_id, []);
    byColor.get(l.color_id).push({ ...l, cat: cats.get(l.cat_id) ?? "" });
  }
  return [...byColor].map(([color_id, ls]) => ({
    color: colors.get(color_id) ?? { id: color_id, name: `Color ${color_id}` },
    pieces: ls.reduce((n, l) => n + l.qty, 0),
    lines: ls.sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name, "en", { numeric: true })),
  })).sort((a, b) => b.pieces - a.pieces || a.color.name.localeCompare(b.color.name));
}

function loadPicked() {
  try { return JSON.parse(localStorage.getItem(PICKED_KEY) || "{}"); } catch { return {}; }
}

async function openPickList(title, sections) {
  const listId = sections.map((sec) => sec.set_num).join(",");
  const picked = new Set(loadPicked()[listId] || []);
  const groups = await Promise.all(sections.map((sec) => pickGroups(sec.lines)));
  const lineKey = (sec, l) => `${sec.set_num}:${l.pid}:${l.color_id}`;
  const total = sections.reduce((n, sec) => n + sec.lines.length, 0);
  const lack = (l) => (l.have != null && l.have < l.qty ? l.qty - l.have : 0);

  const rowHtml = (sec, l) => `<li data-k="${esc(lineKey(sec, l))}"${picked.has(lineKey(sec, l)) ? ' class="done"' : ""}><label>
      <input type="checkbox"${picked.has(lineKey(sec, l)) ? " checked" : ""}>
      ${img(l.img, "thumb")}<span class="qty">${l.qty}×</span>
      <span class="what"><b>${esc(l.part_num)}</b> ${esc(l.name)}<small>${esc(l.cat)}</small></span>
      ${lack(l) ? `<span class="missing">missing ${lack(l)}</span>` : ""}</label></li>`;
  $("pick-body").innerHTML = `
    <h3 id="pick-h">Pick list: ${esc(title)}</h3>
    <p class="finder-help">Tick pieces off as you take them out. Each color is together, largest groups first. Ticks are saved in this browser.</p>
    <div class="pick-controls">
      <span class="pick-progress" id="pick-progress"></span>
      <label><input type="checkbox" id="pick-hide"> Hide ticked</label>
      <button type="button" class="ghost" id="pick-print">Print</button>
      <button type="button" class="ghost" id="pick-reset">Untick all</button>
    </div>
    <div id="pick-sections">${sections.map((sec, i) => `
      ${sec.title ? `<h4 class="pick-set">${esc(sec.title)}</h4>` : ""}
      ${groups[i].map((g) => `<h5 class="pick-color">${swatch(g.color)}${esc(g.color.name)} <span class="n">${fmt(g.pieces)} pieces</span></h5>
        <ul class="pick-list">${g.lines.map((l) => rowHtml(sec, l)).join("")}</ul>`).join("")}`).join("")}
    </div>`;

  const progress = () => {
    $("pick-progress").textContent = `${fmt(picked.size)} of ${fmt(total)} lines ticked`;
    const all = loadPicked();
    if (picked.size) all[listId] = [...picked];
    else delete all[listId];
    try { localStorage.setItem(PICKED_KEY, JSON.stringify(all)); } catch {}
  };
  progress();
  $("pick-sections").onchange = (e) => {
    const li = e.target.closest("li[data-k]");
    if (!li) return;
    if (e.target.checked) picked.add(li.dataset.k);
    else picked.delete(li.dataset.k);
    li.classList.toggle("done", e.target.checked);
    progress();
  };
  $("pick-hide").onchange = (e) => $("pick-sections").classList.toggle("hide-picked", e.target.checked);
  $("pick-reset").onclick = () => {
    picked.clear();
    for (const li of $("pick-sections").querySelectorAll("li.done")) {
      li.classList.remove("done");
      li.querySelector("input").checked = false;
    }
    progress();
  };
  $("pick-print").onclick = () => {
    $("print-area").innerHTML = `<h1>Pick list: ${esc(title)}</h1>${sections.map((sec, i) => `
      ${sec.title ? `<h2>${esc(sec.title)}</h2>` : ""}
      ${groups[i].map((g) => `<h3>${esc(g.color.name)} (${fmt(g.pieces)} pieces)</h3><table>${g.lines.map((l) => `<tr>
        <td class="box">${picked.has(lineKey(sec, l)) ? "☑" : "☐"}</td>
        <td>${l.img ? `<img src="${IMG + esc(l.img)}" alt="">` : ""}</td>
        <td class="qty">${l.qty}×</td>
        <td><b>${esc(l.part_num)}</b> ${esc(l.name)}${lack(l) ? ` <span class="missing">(missing ${lack(l)})</span>` : ""}</td>
        <td>${esc(l.cat)}</td></tr>`).join("")}</table>`).join("")}`).join("")}`;
    window.print();
  };
  if (!$("pick-dialog").open) $("pick-dialog").showModal();
}

// ---------- BrickLink XML import ----------

// Items of a BrickLink XML file (wanted list or store inventory): type, item
// number, BrickLink color and quantity (QTY, or MINQTY in wanted lists).
function parseBrickLinkXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return null;
  return [...doc.getElementsByTagName("ITEM")].map((it) => {
    const get = (tag) => it.getElementsByTagName(tag)[0]?.textContent.trim() ?? "";
    return { type: get("ITEMTYPE").toUpperCase(), id: get("ITEMID"), color: get("COLOR"),
      qty: Math.max(1, Math.floor(Number(get("QTY") || get("MINQTY")) || 1)) };
  });
}

// Parts are mapped back to Rebrickable numbers and colors (an unmapped number
// is tried as a Rebrickable number); sets are added whole. Minifigs are left
// out: their BrickLink and Rebrickable numbers don't match.
async function importBrickLink(items) {
  const parts = items.filter((it) => it.type === "P" && it.id);
  const sets = items.filter((it) => it.type === "S" && it.id);
  const other = items.length - parts.length - sets.length;
  const toRb = new Map();
  for (const r of await query(
    `SELECT b.bl_id, p.part_num FROM bl_parts b CROSS JOIN parts p ON p.pid = b.pid
     WHERE b.bl_id IN (SELECT value FROM json_each(?)) ORDER BY b.pid`,
    [JSON.stringify([...new Set(parts.map((it) => it.id))])])) {
    if (!toRb.has(r.bl_id)) toRb.set(r.bl_id, r.part_num);
  }
  const rbColor = new Map([...colors.values()].filter((c) => c.bl_id != null).map((c) => [String(c.bl_id), c.id]));
  const rows = [];
  let noColor = 0;
  for (const it of parts) {
    const color = rbColor.get(it.color);
    if (color == null) noColor++;
    else rows.push([toRb.get(it.id) ?? it.id, color, it.qty]);
  }
  const { added, skipped } = rows.length ? await addRows(rows) : { added: 0, skipped: 0 };
  const m = await matchData;
  m.setByNum ??= new Map(m.sets.map((s) => [s.set_num, s]));
  let setsAdded = 0, setsUnknown = 0;
  for (const it of sets) {
    const s = m.setByNum.get(it.id) ?? m.setByNum.get(`${it.id}-1`);
    if (!s) { setsUnknown++; continue; }
    await addSet(s, it.qty);
    setsAdded++;
  }
  renderPieces();
  await refreshResults();
  const notes = [
    skipped && plural(skipped, "unknown part"),
    noColor && plural(noColor, "part without a known color", "parts without a known color"),
    setsUnknown && plural(setsUnknown, "unknown set"),
    other && plural(other, "minifig or other item", "minifigs or other items"),
  ].filter(Boolean);
  setStatus(`Imported ${plural(added, "part lot")}${setsAdded ? ` and ${plural(setsAdded, "set")}` : ""} from BrickLink XML.`
    + (notes.length ? ` Skipped ${notes.join(", ")}.` : ""));
}

// ---------- share by link ----------

// Collections travel in the URL fragment (never sent to the server):
// "#c=" + base64url(deflate(JSON {n: name, r: "part,color,qty;...", p: "set,set"})).
async function deflate(text, decompress = false) {
  const stream = new Blob([text]).stream().pipeThrough(decompress ? new DecompressionStream("deflate-raw") : new CompressionStream("deflate-raw"));
  return decompress ? new Response(stream).text() : new Uint8Array(await new Response(stream).arrayBuffer());
}
function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const fromBase64Url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function shareLink() {
  if (!collection.size) return setStatus("Add some pieces first; there is nothing to share yet.", true);
  const name = combined() ? "All collections" : collections.list.find((c) => c.id === collections.active)?.name ?? "Shared pieces";
  const payload = JSON.stringify({
    n: name,
    r: [...collection.values()].map((p) => `${p.part_num},${p.color_id},${p.qty}`).join(";"),
    p: planNums.join(","),
  });
  const url = `${location.origin}${location.pathname}#c=${toBase64Url(await deflate(payload))}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`Link copied: ${plural(collection.size, "lot")}${planNums.length ? ` and a build plan of ${plural(planNums.length, "set")}` : ""}. Anyone who opens it can add them as a new collection.`);
  } catch {
    prompt("Copy this link:", url);
  }
}

// A shared link adds nothing by itself: it offers to add the pieces as a new
// collection, then clears the fragment.
async function offerSharedLink() {
  const m = location.hash.match(/^#c=([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  let data;
  try {
    data = JSON.parse(await deflate(fromBase64Url(m[1]), true));
  } catch {
    return setStatus("That share link is damaged or incomplete.", true);
  }
  const rows = (data.r || "").split(";").filter(Boolean).map((r) => r.split(",")).map(([p, c, q]) => [p, Number(c), Number(q)]);
  const plan = (data.p || "").split(",").filter(Boolean);
  const pieces = rows.reduce((n, r) => n + r[2], 0);
  const banner = $("share-banner");
  banner.innerHTML = `<p>A shared collection, <b>${esc(data.n || "Shared pieces")}</b>: ${plural(pieces, "piece")} in ${plural(rows.length, "lot")}${plan.length ? `, with a build plan of ${plural(plan.length, "set")}` : ""}.</p>
    <button type="button" id="share-accept">Add as a new collection</button>
    <button type="button" class="ghost" id="share-dismiss">Dismiss</button>`;
  banner.hidden = false;
  $("share-dismiss").onclick = () => (banner.hidden = true);
  $("share-accept").onclick = async () => {
    banner.hidden = true;
    await newCollection(data.n || "Shared pieces", rows, plan);
    setStatus(`Added “${collections.list.at(-1).name}” with ${plural(collection.size, "lot")}.`);
  };
}

// ---------- sorting into bins ----------

// Spreads items ({pieces, ...}) over n bins as evenly as possible, largest
// first into the emptiest bin.
function spread(items, n) {
  const bins = Array.from({ length: n }, () => ({ pieces: 0, items: [] }));
  for (const it of [...items].sort((a, b) => b.pieces - a.pieces)) {
    const bin = bins.reduce((a, b) => (b.pieces < a.pieces ? b : a));
    bin.pieces += it.pieces;
    bin.items.push(it);
  }
  return bins.filter((b) => b.items.length);
}

// Storage bins: one per kind of piece (the finder's shape groups). A kind
// with more pieces than a bin holds is split by color: big colors get their
// own bins, the other colors share evenly filled mixed bins. Kinds too small
// for a bin of their own (under a quarter of one) share bins with each other.
function planBins(groups, capacity) {
  const bins = [];
  const small = [];
  for (const g of groups) {
    if (g.pieces < capacity / 4) {
      small.push(g);
    } else if (g.pieces <= capacity) {
      bins.push({ name: g.label, pieces: g.pieces, kinds: g.kinds, colors: g.colors.map((c) => c.id) });
    } else {
      const rest = [];
      for (const c of g.colors) {
        if (c.pieces < capacity / 3) {
          rest.push(c);
          continue;
        }
        const n = Math.ceil(c.pieces / capacity);
        for (let i = 0; i < n; i++) {
          bins.push({ name: `${g.label}: ${colors.get(c.id)?.name ?? c.id}${n > 1 ? ` (${i + 1} of ${n})` : ""}`,
            pieces: Math.round(c.pieces / n), kinds: c.kinds, colors: [c.id] });
        }
      }
      const mixed = spread(rest, Math.ceil(rest.reduce((n, c) => n + c.pieces, 0) / capacity));
      mixed.forEach((b, i) => bins.push({
        name: `${g.label}: mixed colors${mixed.length > 1 ? ` ${i + 1}` : ""}`,
        pieces: b.pieces, kinds: b.items.reduce((n, c) => n + c.kinds, 0), colors: b.items.map((c) => c.id),
      }));
    }
  }
  for (const b of spread(small, Math.ceil(small.reduce((n, g) => n + g.pieces, 0) / capacity))) {
    bins.push({ name: b.items.map((g) => g.label).join(", "), pieces: b.pieces,
      kinds: b.items.reduce((n, g) => n + g.kinds, 0), colors: [...new Set(b.items.flatMap((g) => g.colors.map((c) => c.id)))] });
  }
  return bins;
}

async function sortGroups() {
  const items = [...collection.values()];
  const { byNum } = await loadCatalog();
  const catOf = new Map(items.map((p) => [p.pid, byNum.get(p.part_num)?.cat_id]));
  const unknown = items.filter((p) => catOf.get(p.pid) == null).map((p) => p.pid);
  if (unknown.length) {
    for (const r of await query("SELECT p.pid, p.cat_id FROM json_each(?) j CROSS JOIN parts p ON p.pid = j.value", [JSON.stringify(unknown)])) {
      catOf.set(r.pid, r.cat_id);
    }
  }
  const shapeOf = new Map();
  for (const [, label, cats] of SHAPES) for (const c of cats) shapeOf.set(c, label);
  const groups = new Map();
  for (const p of items) {
    const label = shapeOf.get(catOf.get(p.pid)) ?? "Other pieces";
    const g = groups.get(label) || { label, pieces: 0, kinds: 0, byColor: new Map() };
    g.pieces += p.qty;
    g.kinds++;
    const c = g.byColor.get(p.color_id) || { id: p.color_id, pieces: 0, kinds: 0 };
    c.pieces += p.qty;
    c.kinds++;
    g.byColor.set(p.color_id, c);
    groups.set(label, g);
  }
  return [...groups.values()].map((g) => ({ ...g, colors: [...g.byColor.values()].sort((a, b) => b.pieces - a.pieces) }))
    .sort((a, b) => b.pieces - a.pieces);
}

async function openSorter() {
  if (!collection.size) return setStatus("Add some pieces first; there is nothing to sort yet.", true);
  $("sort-body").innerHTML = `<p class="empty">Sorting your pieces…</p>`;
  $("sort-dialog").showModal();
  const groups = await sortGroups();
  const total = groups.reduce((n, g) => n + g.pieces, 0);
  const render = () => {
    const capacity = Number($("bin-size")?.value || 250);
    const bins = planBins(groups, capacity);
    $("sort-bins").innerHTML = bins.map((b) => `<li><b>${esc(b.name)}</b>
      <span class="meta">${plural(b.pieces, "piece")} · ${plural(b.kinds, "kind")}</span>
      <div class="swatches">${b.colors.slice(0, 16).map((id) => swatch(colors.get(id))).join("")}${b.colors.length > 16 ? "…" : ""}</div></li>`).join("");
    $("sort-count").textContent = `${plural(bins.length, "bin")} of up to ${fmt(capacity)} pieces`;
    $("sort-print").onclick = () => {
      $("print-area").innerHTML = `<h1>Storage bins</h1><div class="labels">${bins.map((b) => `<div class="label"><b>${esc(b.name)}</b>
        ${b.colors.length <= 6 ? esc(b.colors.map((id) => colors.get(id)?.name ?? id).join(", ")) : `${b.colors.length} colors`}</div>`).join("")}</div>`;
      window.print();
    };
  };
  $("sort-body").innerHTML = `
    <h3 id="sort-h">Sort into bins</h3>
    <p class="finder-help">${plural(total, "piece")} in ${plural(collection.size, "lot")}. Sorting by kind first, then by color only where a kind is too big for one bin, keeps pieces easy to find without needing hundreds of boxes.</p>
    <div class="sort-summary">${groups.map((g) => `<div class="row"><span>${esc(g.label)}</span>
      <div class="bar"><span style="width:${(g.pieces / groups[0].pieces) * 100}%"></span></div><span>${fmt(g.pieces)}</span></div>`).join("")}</div>
    <div class="pick-controls">
      <label>Pieces per bin <select id="bin-size">
        <option value="100">100</option><option value="250" selected>250</option><option value="500">500</option><option value="1000">1,000</option>
      </select></label>
      <span class="pick-progress" id="sort-count"></span>
      <button type="button" class="ghost" id="sort-print">Print bin labels</button>
    </div>
    <ul class="bins" id="sort-bins"></ul>`;
  $("bin-size").onchange = render;
  render();
}

// ---------- new sets ----------

let newSets = new Set();
let newSince = "";

// Compares the set list with the one seen on the previous visit. Sets added
// by a newer database build stay marked as new until the next build.
function trackNewSets(m) {
  const nums = m.sets.map((s) => s.set_num);
  const seen = readJson(SEEN_KEY, null);
  if (seen && seen.built_at !== m.builtAt) {
    const old = new Set(seen.sets.split(","));
    writeJson(NEW_KEY, { built_at: m.builtAt, since: seen.built_at, sets: nums.filter((n) => !old.has(n)) });
  }
  if (!seen || seen.built_at !== m.builtAt) writeJson(SEEN_KEY, { built_at: m.builtAt, sets: nums.join(",") });
  const fresh = readJson(NEW_KEY, null);
  newSets = new Set(fresh?.built_at === m.builtAt ? fresh.sets : []);
  newSince = fresh?.since ?? "";
}

function renderNewSets(rows) {
  const el = $("new-sets");
  el.hidden = !newSets.size;
  if (!newSets.size) return;
  const only = $("new-only")?.checked ?? false;
  el.innerHTML = `<span><span class="badge">New</span> ${plural(newSets.size, "set")} added since your last visit (data of ${esc(newSince.slice(0, 10))})${rows != null ? `; ${plural(rows, "match", "match")} your filters` : ""}.</span>
    <label><input type="checkbox" id="new-only"${only ? " checked" : ""}> Show only new sets</label>`;
  $("new-only").onchange = () => {
    resultsLimit = MAX_RESULTS;
    refreshResults();
  };
}

// ---------- import / export ----------

function toCsv(rows) {
  return "Part,Color,Quantity\n" + rows.map((r) => r.join(",")).join("\n") + "\n";
}

function download(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
  const file = db && editable() && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  if (text.trimStart().startsWith("<")) {
    const items = parseBrickLinkXml(text);
    if (!items?.length) return setStatus("That XML file has no BrickLink items.", true);
    return importBrickLink(items);
  }
  const rows = parseCsv(text);
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
$("finder-btn").addEventListener("click", openFinder);
$("finder-text").addEventListener("input", scheduleFinder);
$("finder-cat").addEventListener("change", scheduleFinder);
$("finder-more").addEventListener("click", () => {
  finderLimit += 48;
  runFinder();
});
$("finder-grid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-i]");
  if (!btn) return;
  const card = $("finder-grid")._items[Number(btn.dataset.i)];
  if (!card.part) {
    // A photo match we have no inventory part for: search its name instead.
    $("finder-text").value = card.describe;
    setFinderMode("describe");
    return;
  }
  $("finder-dialog").close();
  pick(card.part);
});
$("finder-dialog").querySelector(".tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) setFinderMode(tab.dataset.mode);
});
$("finder-dialog").querySelector('[data-pane="pick"]').addEventListener("click", onPickChip);
for (const id of ["photo-camera", "photo-file"]) {
  $(id).addEventListener("change", (e) => {
    identifyPhoto(e.target.files[0]);
    e.target.value = "";
  });
}
$("finder-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("add-form").addEventListener("submit", addPicked);
$("pieces").addEventListener("change", onPiecesInput);
$("pieces").addEventListener("click", onPiecesClick);
$("plan-suggest").addEventListener("click", suggestPlan);
$("plan-clear").addEventListener("click", () => {
  if (!confirm("Remove every set from the build plan?")) return;
  planNums = [];
  savePlan();
  refreshResults();
});
$("plan-list").addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove]");
  if (remove) return togglePlan(remove.dataset.remove);
  const btn = e.target.closest("[data-plan]");
  if (!btn) return;
  const entry = lastPlan.entries[Number(btn.dataset.plan)];
  const i = Number(btn.dataset.plan);
  openSet({ ...entry.set, got: entry.got, ratio: entry.got / entry.set.total, pool: entry.before,
    poolNote: i ? `Counting only the pieces left after set${i > 1 ? "s" : ""} 1${i > 1 ? `–${i}` : ""} of your build plan.` : "" });
});
$("plan-total").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-plan-export]");
  if (!btn) return;
  e.preventDefault();
  exportPlan(btn.dataset.planExport);
});
$("results").addEventListener("click", (e) => {
  const add = e.target.closest(".plan-add");
  if (add) return togglePlan(add.dataset.set);
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
// Number fields apply while typing, not only when they lose focus.
let numberTimer;
for (const id of ["min-size", "max-size", "year-from", "year-to"]) {
  $(id).addEventListener("input", () => {
    clearTimeout(numberTimer);
    numberTimer = setTimeout(() => $(id).dispatchEvent(new Event("change")), 400);
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
$("collection-select").addEventListener("change", (e) => switchCollection(e.target.value));
$("col-new").addEventListener("click", () => {
  const name = prompt("Name for the new collection:", uniqueName("Collection"));
  if (name?.trim()) newCollection(name.trim());
});
$("col-rename").addEventListener("click", () => {
  const c = collections.list.find((x) => x.id === collections.active);
  const name = c && prompt("New name for this collection:", c.name);
  if (!name?.trim()) return;
  c.name = name.trim();
  writeJson(COLLECTIONS_KEY, collections);
  renderCollections();
});
$("col-delete").addEventListener("click", () => {
  const c = collections.list.find((x) => x.id === collections.active);
  if (!c || collections.list.length < 2 || !confirm(`Delete the collection “${c.name}” and its pieces and build plan?`)) return;
  collections.list = collections.list.filter((x) => x !== c);
  for (const key of Object.values(keysFor(c.id))) {
    try { localStorage.removeItem(key); } catch {}
  }
  switchCollection(collections.list[0].id);
});
$("share-btn").addEventListener("click", shareLink);
$("sort-btn").addEventListener("click", openSorter);
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
$("pick-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$("set-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

init();
