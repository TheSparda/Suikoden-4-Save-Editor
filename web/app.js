// Suikoden IV Save Editor — web front-end (full parity with the desktop save editor).
//
// We do NOT reimplement save logic in JS. The real Editor/s4save.py (+ s4files.py, s4lzari.py)
// runs in Pyodide (CPython/WASM). The uploaded save is written to Pyodide's in-memory FS and
// the existing path-based read_all_s4_saves()/write_save_edits() are called unchanged, so the
// gamedata checksum (CRC32 + reversed MD5) and memory-card ECC come from the tried module.
// Nothing is uploaded — everything happens on-device.

"use strict";

const SAVE_PATH = "/save.bin";
const EDITOR_DIR = "../Editor";
// recruitment status enum — the exact byte the game checks (s4save.RECRUIT_STATES)
const REC_STATES = [[0, "Not Recruited"], [1, "In Your Company"], [10, "Recruited"],
                    [11, "In Party"], [15, "Permanently In Party"]];
const STAT_NAMES = ["STR", "SKL", "MAG", "EVA", "PDF", "MDF", "SPD", "LUK"];
const GEAR_LABELS = { head: "Head", body: "Body", hands: "Hands", feet: "Feet",
                      acc1: "Accessory 1", acc2: "Accessory 2", acc3: "Accessory 3" };
const CHAR_CAP = { maxHP: 9999, exp: 98999, weaponLvl: 15 };

let pyReady = null, PY = null;      // PY = resolved pyodide (sync access keeps share() in-gesture)
let REF = { runes: [], items: [], equipSlots: [], chars: [] };
let ITEM_BY_ID = {}, RUNE_BY_ID = {}, EQUIP_SLOTS = [];
let saves = [], curSlot = 0, origName = "save.bin";

// File System Access API (desktop Chromium): overwrite the original file in place instead of
// downloading a copy. Absent on Android/Firefox/Safari → fall back to download.
let fileHandle = null;
const SUPPORTS_FS = typeof window !== "undefined" && "showOpenFilePicker" in window;
// Web Share with files (Android Chrome): send the edited save straight to another app.
const CAN_SHARE_FILES = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob([1])], "t.bin")] })); }
  catch (e) { return false; }
})();
const SHARE_CACHE = "s4editor-share";   // must match sw.js (share-target hand-off)

// ---- tiny IndexedDB kv (remembers the last opened save across sessions) ----
const IDB_DB = "s4editor", IDB_STORE = "kv";
function _idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readonly"); const q = t.objectStore(IDB_STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbDel(k) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const hx = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w, "0");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lvFromExp = (exp) => Math.min(99, Math.floor((exp || 0) / 1000) + 1);
const expFromLv = (lv) => (Math.min(99, Math.max(1, lv)) - 1) * 1000;
const gtLabel = (sec) => `${Math.floor((sec || 0) / 3600)}h${String(Math.floor(((sec || 0) % 3600) / 60)).padStart(2, "0")}m`;

// ---- Pyodide bootstrap -----------------------------------------------------
async function bootPyodide() {
  bootProgress(10, "Downloading Python runtime…");
  const py = await loadPyodide();
  bootProgress(55, "Loading save module…");
  const grab = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} (${r.status})`);
    return r;
  };
  for (const mod of ["s4lzari.py", "s4files.py", "s4save.py"]) {
    py.FS.writeFile(mod, await (await grab(`${EDITOR_DIR}/${mod}`)).text());
  }
  for (const j of ["s4_item_names.json", "s4_rune_names.json", "s4_char_offsets.json", "s4_unites.json"]) {
    py.FS.writeFile(j, await (await grab(`${EDITOR_DIR}/${j}`)).text());
  }
  bootProgress(80, "Parsing reference tables…");

  py.runPython(`
import json, os, sys
sys.path.insert(0, os.getcwd())
import s4save as SV

def load_saves(path):
    res = SV.read_all_s4_saves(path)
    if isinstance(res, dict) and res.get("error"):
        return json.dumps({"error": res["error"]})
    return json.dumps({"ok": True, "saves": res})

def apply_edits(path, folder, payload_json):
    p = json.loads(payload_json)
    char_edits = {int(k): v for k, v in (p.get("charEdits") or {}).items()}
    res = SV.write_save_edits(
        path, folder,
        char_edits=char_edits,
        name_edits=(p.get("nameEdits") or {}),
        save_edits=(p.get("saveEdits") or {}),
        make_backup=False,                # never litter MEMFS; the original is untouched
    )
    if res.get("ok"):
        again = SV.read_all_s4_saves(path)
        if not (isinstance(again, dict) and again.get("error")):
            res["saves"] = again
    return json.dumps(res)

def load_reference():
    runes = sorted(({"id": k, "name": v} for k, v in SV.RUNE_NAMES.items()), key=lambda r: r["id"])
    items = sorted(({"id": k, "name": v} for k, v in SV.ITEM_NAMES.items()), key=lambda r: r["id"])
    chars = sorted(({"index": k, "name": v} for k, v in SV.CHAR_NAMES.items()), key=lambda r: r["index"])
    return json.dumps({"runes": runes, "items": items,
                       "equipSlots": SV.EQUIP_SLOTS, "chars": chars})
`);
  REF = JSON.parse(py.runPython("load_reference()"));
  REF.items.forEach((i) => (ITEM_BY_ID[i.id] = i));
  REF.runes.forEach((r) => (RUNE_BY_ID[r.id] = r));
  EQUIP_SLOTS = REF.equipSlots || [];
  PY = py;
  bootProgress(100, "Ready");
  return py;
}

// ---- label helpers ---------------------------------------------------------
function itemLabel(id) { return id ? (ITEM_BY_ID[id]?.name || "#" + id) : "— empty —"; }
function runeLabel(id) { return id ? (RUNE_BY_ID[id]?.name || "#" + id) : "— none —"; }
function charRefLabel(idx) { const c = REF.chars.find((x) => x.index === idx); return c ? c.name : "#" + idx; }

// ---- shared modal a11y (focus trap + Esc + focus restore) ------------------
function modalA11y(ov, closeFn, initial) {
  const prev = document.activeElement;
  const SEL = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const focusables = () => $$(SEL, ov).filter((el) => !el.disabled && el.offsetParent !== null);
  const close = () => { document.removeEventListener("keydown", onKey, true); closeFn(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} };
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => { const t = initial || focusables()[0]; if (t && t.focus) t.focus(); }, 30);
  return close;
}

// ---- searchable picker (replaces long native <select>s — the big mobile win) ----
// list = [{id,name}]; onPick(id) fires on choose; idFmt formats the id prefix per domain.
function openPicker(title, list, current, onPick, idFmt) {
  idFmt = idFmt || ((id) => hx(id, 4));
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal picker-modal" role="dialog" aria-label="${esc(title)}">
      <div class="modal-h"><b>${esc(title)}</b><button class="modal-x" aria-label="close">✕</button></div>
      <input class="picker-search" placeholder="type to filter by name or id…" autocomplete="off">
      <div class="picker-list"></div></div>`;
  document.body.appendChild(ov);
  const listEl = $(".picker-list", ov), search = $(".picker-search", ov);
  let close = () => ov.remove();

  function render(f) {
    const q = (f || "").toLowerCase();
    const rows = list.filter((o) => !q || o.name.toLowerCase().includes(q) ||
      (o.id && (hx(o.id, 2).toLowerCase().includes(q) || hx(o.id, 4).toLowerCase().includes(q) || String(o.id) === q)));
    listEl.innerHTML = rows.slice(0, 300).map((o) =>
      `<button class="picker-row${o.id === current ? " cur" : ""}" data-id="${o.id}">
         <span class="pr-name">${o.id ? idFmt(o.id) + " · " : ""}${esc(o.name)}</span></button>`).join("") ||
      `<div class="muted" style="padding:12px">no matches</div>`;
    if (rows.length > 300) listEl.insertAdjacentHTML("beforeend",
      `<div class="muted" style="padding:8px 12px">…${rows.length - 300} more — keep typing</div>`);
    $$(".picker-row", listEl).forEach((b) => (b.onclick = () => { onPick(+b.dataset.id); close(); }));
  }
  render("");
  search.oninput = () => render(search.value);
  close = modalA11y(ov, () => ov.remove(), search);
  $(".modal-x", ov).onclick = () => close();
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

// ---- File loading ----------------------------------------------------------
async function openViaPicker() {
  try {
    const [h] = await window.showOpenFilePicker({ multiple: false });
    fileHandle = h;
    await handleFile(await h.getFile(), h);
  } catch (e) {
    if (e && e.name !== "AbortError") setDropMsg("Could not open file: " + e.message, true);
  }
}
async function ensureWritable(h) {
  const opts = { mode: "readwrite" };
  if ((await h.queryPermission(opts)) === "granted") return true;
  return (await h.requestPermission(opts)) === "granted";
}

async function handleFile(file, handle) {
  const py = await pyReady;
  fileHandle = handle || null;              // plain <input>/drag-drop have no handle
  origName = file.name || "save.bin";
  const bytes = new Uint8Array(await file.arrayBuffer());
  py.FS.writeFile(SAVE_PATH, bytes);
  let out;
  try {
    out = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
  } catch (e) { return setDropMsg("Failed to read save: " + e.message, true); }
  if (out.error) { $("#editor").innerHTML = ""; return setDropMsg(out.error, true); }
  saves = out.saves || [];
  if (!saves.length) { $("#editor").innerHTML = ""; return setDropMsg("No Suikoden IV save found in that file.", true); }
  curSlot = 0;
  setDropMsg("Python engine ready — load a save file.", false);   // clear any prior error
  rememberSave(origName, bytes, fileHandle);
  renderEditor();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- remember last opened save --------------------------------------------
function rememberSave(name, bytes, handle) {
  idbSet("lastSave", { name, bytes, handle: handle || null, at: Date.now() }).catch(() => {});
}
async function showRecent() {
  const el = $("#recent"); if (!el) return;
  let rec; try { rec = await idbGet("lastSave"); } catch (e) { return; }
  if (!rec) { el.innerHTML = ""; return; }
  const kb = Math.round((rec.bytes?.length || 0) / 1024);
  el.innerHTML = `<div class="recent">Last opened:
      <button class="chip" id="reopenBtn">↻ ${esc(rec.name)} <span class="muted">(${kb} KB)</span></button>
      <button class="chip mini" id="forgetBtn" title="forget">✕</button></div>`;
  $("#reopenBtn").onclick = () => reopenLast(rec);
  $("#forgetBtn").onclick = async () => { await idbDel("lastSave").catch(() => {}); el.innerHTML = ""; };
}
async function reopenLast(rec) {
  if (SUPPORTS_FS && rec.handle) {
    try {
      if (await ensureWritable(rec.handle)) return handleFile(await rec.handle.getFile(), rec.handle);
    } catch (e) { /* handle stale/denied → fall back to stored bytes */ }
  }
  handleFile(new File([rec.bytes], rec.name));
}

// ---- Web Share Target: a save shared INTO the installed PWA ----------------
async function pickupSharedFile() {
  if (!new URLSearchParams(location.search).has("shared")) return false;
  history.replaceState({}, "", location.pathname);
  try {
    const c = await caches.open(SHARE_CACHE);
    const res = await c.match("shared-save");
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get("X-Filename") || "shared.bin");
      await c.delete("shared-save");
      await handleFile(new File([blob], name));
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ---- top-level editor render ----------------------------------------------
// Per-slot staged edits (reset when switching slots). Only *touched* fields are staged,
// so the review list and the write are minimal.
let CE, NAMES, SAVEDITS, SEARCH, RECRUITED_ONLY;

function renderEditor() {
  const ed = $("#editor");
  const slotBar = saves.length > 1
    ? `<div class="card"><div class="slotbar"><b>Save slot:</b>${saves.map((s, i) =>
        `<button class="chip${i === curSlot ? " on" : ""}" data-slot="${i}">${esc(s.label)}${s.region ? " · " + esc(s.region) : ""}</button>`).join("")}
        <span class="muted" id="slotmeta" style="margin-left:auto"></span></div></div>`
    : "";
  ed.innerHTML = slotBar + `<div id="slotbody"></div>`;
  $$("[data-slot]", ed).forEach((b) => (b.onclick = () => { curSlot = +b.dataset.slot; drawSlot(); }));
  drawSlot();
}

function drawSlot() {
  const s = saves[curSlot];
  CE = {}; NAMES = {}; SAVEDITS = {}; SEARCH = ""; RECRUITED_ONLY = false;

  const cksum = s.checksumValid ? `<span class="pill on">checksum ok</span>` : `<span class="pill">checksum off</span>`;
  const metaBits = [
    s.region ? `Region ${esc(s.region)}` : null,
    (s.meta && s.meta.title) ? esc(s.meta.title) : null,
    `${(s.characters || []).filter((c) => (c.recruited || 0) >= 10).length} recruited`,
    s.container && s.container !== "memcard" ? `${esc(s.container.toUpperCase())} container` : null,
  ].filter(Boolean).join(" · ");

  const names = (s.names || []).map((n) =>
    `<label class="field"><span>${esc(n.label)}</span>
       <input type="text" maxlength="${n.max}" value="${esc(n.value || "")}"
              data-name="${esc(n.key)}" data-def="${esc(n.value || "")}"></label>`).join("");

  if (saves.length > 1) {
    const sm = $("#slotmeta");
    if (sm) sm.textContent = `${s.folder}${s.checksumValid ? "" : " · checksum off"}`;
  }

  const ro = s.writable === false;
  const roNote = ro ? `<div class="warnbox">${esc(s.note || "This container is read-only")} — convert it to a .ps2/.cbs/.psu to edit and save.</div>` : "";

  $("#slotbody").innerHTML = `
    <div class="card">
      <div class="muted" style="margin:-2px 0 8px">${metaBits}${s.checksumValid ? "" : " · "}</div>
      <div class="row" style="margin-bottom:6px">${cksum}</div>
      ${roNote}
      <h3 class="sec">Names</h3>
      <div class="grid">${names}</div>
      <h3 class="sec">Money &amp; time</h3>
      <div class="grid">
        <label class="field"><span>Potch</span>
          <input type="number" min="0" max="99999999" id="potchfld"
                 value="${s.potch || 0}" data-def="${s.potch || 0}"></label>
        <label class="field"><span>Game time (seconds) — <span id="gtlabel">${gtLabel(s.gameTimeSec)}</span></span>
          <input type="number" min="0" max="3596400" id="gtfld"
                 value="${s.gameTimeSec || 0}" data-def="${s.gameTimeSec || 0}"></label>
        <div class="field"><span>World map (${s.worldMapPct != null ? s.worldMapPct + "% explored" : "—"})</span>
          <label class="row" style="gap:6px;cursor:pointer;min-height:38px">
            <input type="checkbox" id="wmfull"> mark fully explored on write</label></div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <h3 class="sec" style="margin:0">Characters</h3>
        <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" id="reconly"> recruited only</label>
      </div>
      <input class="search" id="sq" placeholder="filter by name or #…">
      <div id="charbox"></div>
      <div class="toolbar">
        ${ro
          ? `<span class="status warn">Read-only container — editing disabled. Convert to .ps2/.cbs/.psu first.</span>`
          : (SUPPORTS_FS && fileHandle
              ? `<button class="primary" id="saveFileBtn">Apply &amp; save to file</button>
                 <button id="saveBtn">Download copy</button>`
              : `<button class="primary" id="saveBtn">Apply &amp; download</button>`) +
            (CAN_SHARE_FILES ? `<button id="shareBtn">Apply &amp; share…</button>` : "") +
            `<button id="resetBtn">Reset</button>
             <span class="badge hidden" id="dirtyBadge">0 unsaved</span>
             <span class="status" id="status"></span>`}
      </div>
    </div>`;

  // wire names + money/time
  $$("input[data-name]").forEach((inp) => (inp.oninput = () => {
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    NAMES[inp.dataset.name] = inp.value; refreshDirty();
  }));
  const potch = $("#potchfld"); if (potch) potch.oninput = () => {
    potch.classList.toggle("dirty", potch.value !== potch.dataset.def);
    SAVEDITS.potch = +potch.value; refreshDirty();
  };
  const gt = $("#gtfld"); if (gt) gt.oninput = () => {
    gt.classList.toggle("dirty", gt.value !== gt.dataset.def);
    SAVEDITS.gameTime = +gt.value; $("#gtlabel").textContent = gtLabel(+gt.value); refreshDirty();
  };
  const wm = $("#wmfull"); if (wm) wm.onchange = () => {
    if (wm.checked) SAVEDITS.worldMapFull = 1; else delete SAVEDITS.worldMapFull;
    wm.closest(".field")?.classList.toggle("dirty-soft", wm.checked); refreshDirty();
  };

  const rc = $("#reconly"); if (rc) rc.onchange = () => { RECRUITED_ONLY = rc.checked; drawChars(); };
  const sq = $("#sq"); if (sq) sq.oninput = () => { SEARCH = sq.value.toLowerCase(); drawChars(); };
  const sb = $("#saveBtn"); if (sb) sb.onclick = () => applyEdits("download");
  const sfb = $("#saveFileBtn"); if (sfb) sfb.onclick = () => applyEdits("file");
  const shb = $("#shareBtn"); if (shb) shb.onclick = () => applyEdits("share");
  const rb = $("#resetBtn"); if (rb) rb.onclick = drawSlot;
  drawChars();
}

// ---- Characters ------------------------------------------------------------
function charByRoster(ri) { return saves[curSlot].characters.find((c) => c.rosterIndex === ri); }

function drawChars() {
  const s = saves[curSlot];
  let pool = s.characters || [];
  if (RECRUITED_ONLY) pool = pool.filter((c) => (c.recruited || 0) >= 10);
  const shown = pool.filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);
  const box = $("#charbox");
  box.innerHTML = shown.map(charCard).join("") || `<div class="muted" style="padding:6px 2px">no matching characters</div>`;
  shown.forEach(wireChar);
}

function charCard(c) {
  const ri = c.rosterIndex;
  const unrec = (c.recruited || 0) === 0;
  const num = (k, val, max) =>
    `<input type="number" min="0" max="${max}" value="${val}" data-ri="${ri}" data-k="${k}" data-def="${val}" title="0–${max}">`;
  const stat = (n) =>
    `<label class="field"><span>${n}</span><input type="number" min="0" max="999" value="${c.stats[n]}" data-ri="${ri}" data-stat="${n}" data-def="${c.stats[n]}"></label>`;

  const lv = lvFromExp(c.exp);
  const core = `
    <label class="field"><span>Level</span>
      <input type="number" min="1" max="99" value="${lv}" data-lv="${ri}" data-def="${lv}" title="writes EXP = (Lv−1)×1000"></label>
    <label class="field"><span>EXP</span>${num("exp", c.exp || 0, CHAR_CAP.exp)}</label>
    <label class="field"><span>Weapon Lv</span>${num("weaponLvl", c.weaponLvl || 0, CHAR_CAP.weaponLvl)}</label>
    <label class="field"><span>Max HP</span>${num("maxHP", c.maxHP, CHAR_CAP.maxHP)}</label>`;

  const stats = STAT_NAMES.map(stat).join("");

  const runes = [0, 1, 2].map((slot) => {
    const cur = c.runes[slot] || 0;
    return `<label class="field"><span>Rune ${slot + 1}</span>
      <button type="button" class="picker" data-runeri="${ri}" data-slot="${slot}" data-val="${cur}" data-def="${cur}">${esc(runeLabel(cur))}</button></label>`;
  }).join("");

  const equip = EQUIP_SLOTS.map(([key]) => {
    const cur = (c.equip || {})[key] || 0;
    return `<label class="field"><span>${GEAR_LABELS[key] || key}</span>
      <button type="button" class="picker" data-eqri="${ri}" data-eq="${key}" data-val="${cur}" data-def="${cur}">${esc(itemLabel(cur))}</button></label>`;
  }).join("");

  const uNames = c.uniteNames || {};
  const unites = Object.keys(uNames).length
    ? `<h4>Unite attacks <span class="muted" style="text-transform:none;letter-spacing:0">(level 0–3)</span></h4>
       <div class="grid sk">${Object.entries(uNames).map(([slot, u]) =>
        `<label class="field" title="${esc(u.with || "")}"><span>${esc(u.name)}</span>
          <input type="number" min="0" max="3" value="${(c.unites || [])[+slot] || 0}" data-uri="${ri}" data-uslot="${slot}" data-def="${(c.unites || [])[+slot] || 0}"></label>`).join("")}</div>`
    : "";

  const recOpts = REC_STATES.map(([v, l]) => `<option value="${v}"${v === c.recruited ? " selected" : ""}>${l}</option>`).join("") +
    (REC_STATES.some(([v]) => v === c.recruited) ? "" : `<option value="${c.recruited}" selected>? (${c.recruited})</option>`);

  return `<details class="char${unrec ? " unrec" : ""}"><summary>
      <span class="chev">▸</span><span class="nm">${esc(c.name)}</span>
      <span class="muted">#${ri}</span>
      <span class="pill${(c.recruited || 0) >= 10 ? " on" : ""}">${esc(c.recruitedName || "")}</span>
      <span class="lv">Lv ${lv} · HP ${c.maxHP}</span></summary>
    <div class="char-body" data-roster="${ri}">
      <div class="row" style="gap:8px;margin:6px 0 2px"><span class="muted">Recruitment</span>
        <select data-recruit="${ri}" style="max-width:220px">${recOpts}</select></div>
      <h4>Core</h4><div class="grid">${core}</div>
      <h4>Stats</h4><div class="grid">${stats}</div>
      <h4>Runes</h4><div class="grid eq">${runes}</div>
      ${unites}
      <h4>Equipment</h4><div class="grid eq">${equip}</div>
    </div></details>`;
}

function ce(ri) { return (CE[ri] = CE[ri] || {}); }

function wireChar(c) {
  const ri = c.rosterIndex;
  const body = $(`.char-body[data-roster="${ri}"]`);
  if (!body) return;
  // numeric core + stats
  $$("input[data-k]", body).forEach((inp) => (inp.onchange = () => {
    ce(ri)[inp.dataset.k] = +inp.value;
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    if (inp.dataset.k === "exp") { const lvIn = $(`input[data-lv="${ri}"]`, body); if (lvIn) lvIn.value = lvFromExp(+inp.value); }
    refreshDirty();
  }));
  $$("input[data-stat]", body).forEach((inp) => (inp.onchange = () => {
    (ce(ri).stats = ce(ri).stats || {})[inp.dataset.stat] = +inp.value;
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def); refreshDirty();
  }));
  // level → drives EXP
  const lvIn = $(`input[data-lv="${ri}"]`, body);
  if (lvIn) lvIn.oninput = () => {
    const exp = expFromLv(+lvIn.value);
    const expIn = $(`input[data-k="exp"]`, body);
    if (expIn) { expIn.value = exp; expIn.classList.toggle("dirty", String(exp) !== expIn.dataset.def); }
    ce(ri).exp = exp;
    lvIn.classList.toggle("dirty", lvIn.value !== lvIn.dataset.def); refreshDirty();
  };
  // runes
  $$("button.picker[data-runeri]", body).forEach((btn) => (btn.onclick = () => {
    const slot = +btn.dataset.slot, cur = +btn.dataset.val;
    openPicker(`Rune ${slot + 1}`, REF.runes, cur, (id) => {
      btn.dataset.val = id; btn.textContent = runeLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      (ce(ri).runes = ce(ri).runes || {})[slot] = id; refreshDirty();
    }, (id) => hx(id, 2));
  }));
  // equipment
  $$("button.picker[data-eq]", body).forEach((btn) => (btn.onclick = () => {
    const key = btn.dataset.eq, cur = +btn.dataset.val;
    openPicker(`Equip — ${GEAR_LABELS[key] || key}`, REF.items, cur, (id) => {
      btn.dataset.val = id; btn.textContent = itemLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      (ce(ri).equip = ce(ri).equip || {})[key] = id; refreshDirty();
    });
  }));
  // unites
  $$("input[data-uri]", body).forEach((inp) => (inp.onchange = () => {
    (ce(ri).unites = ce(ri).unites || {})[inp.dataset.uslot] = +inp.value;
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def); refreshDirty();
  }));
  // recruitment
  $$("select[data-recruit]", body).forEach((se) => (se.onchange = () => {
    ce(ri).recruited = +se.value;
    se.classList.toggle("dirty", +se.value !== c.recruited); refreshDirty();
  }));
}

// ---- dirty tracking / unsaved badge ----------------------------------------
let _badgeRAF = 0;
function refreshDirty() {
  if (_badgeRAF) return;
  _badgeRAF = requestAnimationFrame(() => {
    _badgeRAF = 0;
    const el = $("#dirtyBadge"); if (!el) return;
    const n = countEffective();
    el.textContent = `${n} unsaved`;
    el.classList.toggle("hidden", n === 0);
  });
}

// ---- build review + apply --------------------------------------------------
function countEffective() { return buildDiff().length; }

function buildDiff() {
  const s = saves[curSlot];
  const rows = [];
  const byRi = {}; (s.characters || []).forEach((c) => (byRi[c.rosterIndex] = c));

  if ("potch" in SAVEDITS && SAVEDITS.potch !== s.potch) rows.push({ g: "Save", t: `Potch: ${s.potch} → ${SAVEDITS.potch}` });
  if ("gameTime" in SAVEDITS && SAVEDITS.gameTime !== s.gameTimeSec) rows.push({ g: "Save", t: `Game time: ${gtLabel(s.gameTimeSec)} → ${gtLabel(SAVEDITS.gameTime)}` });
  if (SAVEDITS.worldMapFull) rows.push({ g: "Save", t: `World map → mark fully explored` });

  Object.entries(NAMES).forEach(([k, v]) => {
    const n = (s.names || []).find((x) => x.key === k);
    if (n && v !== n.value) rows.push({ g: "Names", t: `${n.label}: "${n.value}" → "${v}"` });
  });

  Object.entries(CE).forEach(([ri, f]) => {
    const c = byRi[ri] || byRi[+ri] || {}; const who = c.name || `#${ri}`;
    Object.entries(f).forEach(([k, v]) => {
      if (k === "stats") Object.entries(v).forEach(([st, nv]) => { if (nv !== c.stats?.[st]) rows.push({ g: who, t: `${st}: ${c.stats?.[st]} → ${nv}` }); });
      else if (k === "runes") Object.entries(v).forEach(([slot, nv]) => { if (nv !== (c.runes?.[+slot] || 0)) rows.push({ g: who, t: `Rune ${+slot + 1}: ${runeLabel(c.runes?.[+slot] || 0)} → ${runeLabel(nv)}` }); });
      else if (k === "equip") Object.entries(v).forEach(([slot, nv]) => { if (nv !== (c.equip?.[slot] || 0)) rows.push({ g: who, t: `${GEAR_LABELS[slot] || slot}: ${itemLabel(c.equip?.[slot] || 0)} → ${itemLabel(nv)}` }); });
      else if (k === "unites") Object.entries(v).forEach(([slot, nv]) => { const old = (c.unites || [])[+slot] || 0; if (nv !== old) { const un = (c.uniteNames || {})[slot]; rows.push({ g: who, t: `Unite ${un ? un.name : "#" + slot}: ${old} → ${nv}` }); } });
      else if (k === "exp") { if (v !== c.exp) rows.push({ g: who, t: `Level ${lvFromExp(c.exp)} → ${lvFromExp(v)} (EXP ${c.exp} → ${v})` }); }
      else if (k === "weaponLvl") { if (v !== c.weaponLvl) rows.push({ g: who, t: `Weapon Lv: ${c.weaponLvl} → ${v}` }); }
      else if (k === "maxHP") { if (v !== c.maxHP) rows.push({ g: who, t: `Max HP: ${c.maxHP} → ${v}` }); }
      else if (k === "recruited") { if (v !== c.recruited) rows.push({ g: who, t: `Recruitment: ${recName(c.recruited)} → ${recName(v)}` }); }
    });
  });
  return rows;
}
function recName(v) { const r = REC_STATES.find((x) => x[0] === v); return r ? r[1] : `? (${v})`; }

function openConfirm(rows, onConfirm, okLabel) {
  const groups = {}; rows.forEach((r) => (groups[r.g] = groups[r.g] || []).push(r.t));
  const body = Object.entries(groups).map(([g, ts]) =>
    `<div class="cf-group"><div class="cf-g">${esc(g)}</div>${ts.map((t) => `<div class="cf-row">${esc(t)}</div>`).join("")}</div>`).join("");
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Review changes">
      <div class="modal-h"><b>Review changes (${rows.length})</b><button class="modal-x" aria-label="close">✕</button></div>
      <div class="cf-list">${body}</div>
      <div class="modal-f"><button id="cfCancel">Cancel</button>
        <button class="primary" id="cfOk">${esc(okLabel || "Apply & download")}</button></div></div>`;
  document.body.appendChild(ov);
  const close = modalA11y(ov, () => ov.remove(), $("#cfOk", ov));
  $(".modal-x", ov).onclick = () => close(); $("#cfCancel", ov).onclick = () => close();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#cfOk", ov).onclick = () => { close(); onConfirm(); };
}

function applyEdits(mode) {   // mode: "download" | "file" | "share"
  const diff = buildDiff();
  if (!diff.length) return setStatus("No changes to apply.", "warn");
  const okLabel = mode === "file" ? `Apply & save to ${origName}`
    : mode === "share" ? "Apply & share…" : "Apply & download";
  openConfirm(diff, () => doApply(mode), okLabel);
}

// Runs synchronously up to the first await, so navigator.share() (mode "share") still sees the
// confirm-button's user activation. Uses the resolved PY (no await pyReady).
async function doApply(mode) {
  const py = PY; if (!py) return setStatus("Engine not ready.", "err");
  const s = saves[curSlot];
  const payload = { charEdits: CE, nameEdits: NAMES, saveEdits: SAVEDITS };
  setStatus("Applying…", "");
  let res;
  try {
    res = JSON.parse(py.runPython(
      `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(s.folder)}, ${JSON.stringify(JSON.stringify(payload))})`));
  } catch (e) { return setStatus("Write failed: " + e.message, "err"); }
  if (res.error) return setStatus("Write failed: " + res.error, "err");
  const bytes = py.FS.readFile(SAVE_PATH);

  let msg;
  if (mode === "share") {
    const file = new File([bytes], downloadName(), { type: "application/octet-stream" });
    try {
      await navigator.share({ files: [file], title: origName, text: `${origName} (edited)` });
      msg = `Applied ${res.changed} field(s) — shared ${downloadName()}.`;
    } catch (e) {
      if (e && e.name === "AbortError") { setStatus("Share cancelled — nothing left the device.", "warn"); return refreshAfterApply(py); }
      downloadBytes(bytes, downloadName());
      msg = `Applied ${res.changed} field(s). Share failed, downloaded ${downloadName()}.`;
    }
  } else if (mode === "file" && fileHandle) {
    try {
      if (!(await ensureWritable(fileHandle))) return setStatus("Save cancelled — write permission denied.", "warn");
      const w = await fileHandle.createWritable();
      await w.write(bytes); await w.close();
      msg = `Saved — ${res.changed} field(s) changed, written to ${fileHandle.name}.`;
    } catch (e) { return setStatus("Could not write file: " + e.message, "err"); }
  } else {
    downloadBytes(bytes, downloadName());
    msg = `Saved — ${res.changed} field(s) changed. Downloaded ${downloadName()}. Copy it back into your emulator's memory-card location.`;
  }
  refreshAfterApply(py);
  setStatus(msg, "ok");
}

function refreshAfterApply(py) {
  const out = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
  if (out.saves) saves = out.saves;
  const bytes = py.FS.readFile(SAVE_PATH);
  rememberSave(origName, bytes, fileHandle);
  drawSlot();
}

function downloadName() {
  const dot = origName.lastIndexOf(".");
  const stem = dot > 0 ? origName.slice(0, dot) : origName;
  const ext = dot > 0 ? origName.slice(dot) : "";
  return `${stem}.edited${ext}`;
}
function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- Reference tab ---------------------------------------------------------
let refRendered = false;
function renderReference() {
  refRendered = true;
  const s = $("#refRoot");
  s.innerHTML = `<div class="card"><div class="row">
    <b class="acc2">Reference</b><span class="muted">${REF.chars.length} characters · ${REF.items.length} items · ${REF.runes.length} runes</span>
    <span style="flex:1"></span><input class="search" id="rq" placeholder="filter…" style="max-width:220px"></div>
    <div class="row" style="margin-top:8px">
      <select id="rkind" style="max-width:200px">
       <option value="chars">Characters</option><option value="items">Items</option>
       <option value="runes">Runes</option></select></div>
    <div id="reftbl" style="margin-top:10px;max-height:60vh;overflow:auto"></div></div>`;
  $("#rkind").onchange = renderRefTable;
  $("#rq").oninput = renderRefTable;
  renderRefTable();
}
function renderRefTable() {
  const kind = $("#rkind").value, q = ($("#rq").value || "").toLowerCase();
  const src = kind === "chars" ? REF.chars.map((c) => ({ id: c.index, name: c.name })) : REF[kind];
  const rows = src.filter((x) => !q || x.name.toLowerCase().includes(q) || hx(x.id, 4).toLowerCase().includes(q) || String(x.id) === q);
  const idLabel = kind === "chars" ? (id) => "#" + id : (id) => "0x" + hx(id, kind === "runes" ? 2 : 4);
  $("#reftbl").innerHTML = `<table class="invtbl"><thead><tr><th>${kind === "chars" ? "Index" : "ID"}</th><th>Name</th></tr></thead><tbody>`
    + rows.slice(0, 600).map((x) => `<tr><td class="sl">${idLabel(x.id)}</td><td>${esc(x.name)}</td></tr>`).join("")
    + `</tbody></table>` + (rows.length > 600 ? `<div class="muted" style="padding:8px">showing 600 of ${rows.length}</div>` : "");
}

// ---- misc ------------------------------------------------------------------
function setStatus(msg, kind) { const el = $("#status"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } }
function setDropMsg(msg, isErr) { const el = $("#engineStatus"); if (el) el.innerHTML = (isErr ? "⚠ " : "") + esc(msg); }
function bootProgress(pct, msg) {
  const el = $("#engineStatus"); if (!el) return;
  el.innerHTML = `<div class="bootmsg">${pct < 100 ? '<span class="spinner"></span>' : ""}${esc(msg)}</div>` +
    `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;
}
function dirtyNow() { try { return typeof CE !== "undefined" && buildDiff().length > 0; } catch (e) { return false; } }

// ---- theme -----------------------------------------------------------------
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "");
  $$("footer .tb").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#eaf4f7" : "#0a141e";
  try { localStorage.setItem("s4editor-theme", t); } catch (e) {}
}

// ---- mode tabs -------------------------------------------------------------
function setMode(mode) {
  $$(".modebar .mtab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#mode-save").classList.toggle("hidden", mode !== "save");
  $("#mode-ref").classList.toggle("hidden", mode !== "ref");
  if (mode === "ref" && !refRendered && PY) renderReference();
}

// ---- wire up ---------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  let theme = "ocean";
  try { theme = localStorage.getItem("s4editor-theme") || "ocean"; } catch (e) {}
  applyTheme(theme);
  $$("footer .tb").forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)));
  $$(".modebar .mtab").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  const drop = $("#drop"), fileInput = $("#file"), pickBtn = $("#pickBtn");
  pickBtn.onclick = () => (SUPPORTS_FS ? openViaPicker() : fileInput.click());
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", async (e) => {
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (SUPPORTS_FS && item && item.getAsFileSystemHandle) {
      try {
        const h = await item.getAsFileSystemHandle();
        if (h && h.kind === "file") return handleFile(await h.getFile(), h);
      } catch (err) { /* fall through */ }
    }
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });

  window.addEventListener("beforeunload", (e) => { if (dirtyNow()) { e.preventDefault(); e.returnValue = ""; } });

  pyReady = bootPyodide();
  pyReady.then(() => {
    setDropMsg("Python engine ready — load a save file.", false);
    pickBtn.disabled = false;
    if (!$("#mode-ref").classList.contains("hidden") && !refRendered) renderReference();
  }).catch((e) => { setDropMsg("Engine failed to start: " + e.message, true); });
  pyReady.then(async () => {
    const shared = await pickupSharedFile();
    if (!shared) showRecent();
  }).catch(() => {});

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));
  }

  const installBtn = $("#installBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let deferredPrompt = null;
  if (!standalone) {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.remove("hidden");
    });
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add("hidden");
    };
    window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
  }
});
