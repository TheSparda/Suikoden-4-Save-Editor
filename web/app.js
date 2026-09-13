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
// REC_STATES, STAT_NAMES, GEAR_LABELS, CHAR_CAP and POTCH_MAX live in s4-core.js, which
// index.html loads first — they are read here as globals.
const APP_VERSION = "1.6.5";        // keep in lockstep with the footer in index.html
// Elemental rune affinity reference — AFF_ELEMS / AFF_RATE / AFF_ALIAS are in s4-core.js.
let AFF = {};                        // character name → [5] affinity ratings (s4_affinities.json)

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

// ---- Pyodide bootstrap -----------------------------------------------------
async function bootPyodide() {
  bootProgress(10, "Downloading Python runtime…", "rt");
  const py = await loadPyodide();
  bootProgress(55, "Loading save module…", "mod");
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
  bootProgress(80, "Parsing reference tables…", "ref");

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
  // Reference-data enrichment (defensive: a missing file just hides the notes).
  try { const a = await (await fetch(`${EDITOR_DIR}/s4_affinities.json`)).json(); delete a._note; AFF = a; }
  catch (e) { AFF = {}; }
  PY = py;
  bootProgress(100, "Ready", "done");
  return py;
}
// character name → affinity ratings, or null — the rule is in s4-core.js; app.js owns the table.
function affForName(name) { return S4Core.affFor(AFF, name); }

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
let CE, NAMES, SAVEDITS, SEARCH, RECRUITED_ONLY, SUB;

// Undo journal (#3). Every staged mutation is wrapped by staged(), which snapshots the three
// overlays either side of the change and records the pair.
//
// Snapshots rather than hand-written inverse operations, deliberately: the overlays are small
// plain objects, and there are a dozen mutation sites today with many more coming in Phases 3
// and 6. Writing a correct inverse per site is how undo rots — miss one and the stack desyncs
// silently. This way "undo back to zero leaves nothing staged" holds by construction, which is
// exactly what the acceptance criterion asks for.
const JOURNAL = S4Core.createJournal({ onChange: () => { refreshDirty(); refreshUndoButtons(); } });
const snapStaged = () => JSON.stringify({ c: CE, n: NAMES, s: SAVEDITS });
function restoreStaged(snap) {
  const o = JSON.parse(snap);
  CE = o.c; NAMES = o.n; SAVEDITS = o.s;
  drawSlot(true);
}
// Run a mutation and record it. A mutation that changes nothing records nothing, so undo never
// has a step that appears to do nothing.
function staged(label, key, fn) {
  const before = snapStaged();
  fn();
  const after = snapStaged();
  if (before !== after) {
    JOURNAL.record({ label, key, undo: () => restoreStaged(before), redo: () => restoreStaged(after) });
  }
  refreshDirty(); refreshReverts();
}
// Restore one field to the value the file was loaded with — the rule (and why dropping the
// overlay beats writing a recomputed value back) lives in s4-core.js's revertStaged().
function revertField(what, ri) {
  staged(`Restore ${what.replace(/^\w+:/, "")}`, null,
    () => S4Core.revertStaged({ saveEdits: SAVEDITS, names: NAMES, charEdits: CE }, what, ri));
  drawSlot(true);
}

// One delegated listener for every ↺ on the page — the buttons are re-rendered constantly, so
// per-button wiring would have to be redone on each repaint.
function bindReverts() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".revert[data-revert]");
    if (!b || !document.querySelector("#slotbody")?.contains(b)) return;
    e.preventDefault(); e.stopPropagation();
    revertField(b.dataset.revert, b.dataset.rri == null ? null : +b.dataset.rri);
  });
}

function refreshUndoButtons() {
  const u = $("#undoBtn"), r = $("#redoBtn");
  if (u) { u.disabled = !JOURNAL.canUndo(); u.title = JOURNAL.canUndo() ? `Undo ${JOURNAL.undoLabel()} (Ctrl/Cmd+Z)` : "Nothing to undo"; }
  if (r) { r.disabled = !JOURNAL.canRedo(); r.title = JOURNAL.canRedo() ? `Redo ${JOURNAL.redoLabel()} (Shift+Ctrl/Cmd+Z)` : "Nothing to redo"; }
}

function renderEditor() {
  const ed = $("#editor");
  const slotBar = saves.length > 1
    ? `<div class="card"><div class="slotbar"><b>Save slot:</b>${saves.map((s, i) =>
        `<button class="chip${i === curSlot ? " on" : ""}" data-slot="${i}">${esc(s.label)}${s.region ? " · " + esc(s.region) : ""}</button>`).join("")}
        <span class="muted" id="slotmeta" style="margin-left:auto"></span></div></div>`
    : "";
  ed.innerHTML = slotBar + `<div id="slotbody"></div>`;
  $$(".slotbar [data-slot]", ed).forEach((b) => (b.onclick = () => { curSlot = +b.dataset.slot; drawSlot(); }));
  drawSlot();
}

// keepStaged: repaint from the current overlay instead of resetting it. Undo/redo and #4's
// restore need a repaint that preserves staged state; loading a slot needs one that clears it.
function drawSlot(keepStaged) {
  const s = saves[curSlot];
  if (!keepStaged) {
    CE = {}; NAMES = {}; SAVEDITS = {}; SEARCH = ""; RECRUITED_ONLY = false; SUB = "chars";
    OPEN_CHARS.clear();
    JOURNAL.reset();
  }

  const cksum = s.checksumValid ? `<span class="pill on">checksum ok</span>` : `<span class="pill">checksum off</span>`;
  const metaBits = [
    s.region ? `Region ${esc(s.region)}` : null,
    (s.meta && s.meta.title) ? esc(s.meta.title) : null,
    `${(s.characters || []).filter((c) => (c.recruited || 0) >= 10).length} recruited`,
    s.container && s.container !== "memcard" ? `${esc(s.container.toUpperCase())} container` : null,
  ].filter(Boolean).join(" · ");

  const names = (s.names || []).map((n) => {
    const val = n.key in NAMES ? NAMES[n.key] : (n.value || "");
    return `<label class="field"><span>${esc(n.label)}${rev(`name:${esc(n.key)}`)}</span>
       <input type="text" maxlength="${n.max}" value="${esc(val)}" class="${dz(val, n.value || "").trim()}"
              data-name="${esc(n.key)}" data-def="${esc(n.value || "")}"></label>`;
  }).join("");

  if (saves.length > 1) {
    const sm = $("#slotmeta");
    if (sm) sm.textContent = `${s.folder}${s.checksumValid ? "" : " · checksum off"}`;
  }

  const ro = s.writable === false;
  const roNote = ro ? `<div class="warnbox">${esc(s.note || "This container is read-only")} — convert it to a .ps2/.cbs/.psu to edit and save.</div>` : "";

  const live = (s.characters || []).filter((c) => (c.recruited || 0) >= 10).length;
  const total = (s.characters || []).length;

  $("#slotbody").innerHTML = `
    ${findingsHtml(s.findings || [])}
    <div class="card">
      <div class="muted" style="margin:-2px 0 8px">${metaBits}</div>
      <div class="row" style="margin-bottom:6px">${cksum}</div>
      ${roNote}
      <div class="row" style="gap:8px;margin:2px 0 10px">
        <button type="button" class="chip mini" id="snapExport" title="Save every decoded value as JSON — no game data, safe to attach to a bug report">⬇ Export JSON</button>
        <label class="chip mini" id="snapImportLabel" style="cursor:pointer" title="Load a snapshot; its differences are staged for review, never written directly">⬆ Import JSON
          <input type="file" id="snapImport" accept=".json,application/json" style="display:none"></label>
      </div>
      <h3 class="sec">Names</h3>
      <div class="grid">${names}</div>
      <h3 class="sec">Money &amp; time</h3>
      <div class="grid">
        <label class="field"><span>Potch <button type="button" class="chip mini" id="maxPotch">max</button>${rev("potch")}</span>
          <input type="number" min="0" max="99999999" id="potchfld"
                 value="${"potch" in SAVEDITS ? SAVEDITS.potch : (s.potch || 0)}" data-def="${s.potch || 0}"
                 class="${dz("potch" in SAVEDITS ? SAVEDITS.potch : (s.potch || 0), s.potch || 0).trim()}"></label>
        <label class="field"><span>Game time (seconds) — <span id="gtlabel">${gtLabel("gameTime" in SAVEDITS ? SAVEDITS.gameTime : s.gameTimeSec)}</span>${rev("gameTime")}</span>
          <input type="number" min="0" max="3596400" id="gtfld"
                 value="${"gameTime" in SAVEDITS ? SAVEDITS.gameTime : (s.gameTimeSec || 0)}" data-def="${s.gameTimeSec || 0}"
                 class="${dz("gameTime" in SAVEDITS ? SAVEDITS.gameTime : (s.gameTimeSec || 0), s.gameTimeSec || 0).trim()}"></label>
        <div class="field${SAVEDITS.worldMapFull ? " dirty-soft" : ""}"><span>World map (${s.worldMapPct != null ? s.worldMapPct + "% explored" : "—"})${rev("worldMapFull")}</span>
          <label class="row" style="gap:6px;cursor:pointer;min-height:38px">
            <input type="checkbox" id="wmfull"${SAVEDITS.worldMapFull ? " checked" : ""}> mark fully explored on write</label></div>
      </div>
    </div>
    <div class="card">
      <div class="subtabs">
        <button class="chip" data-sub="chars">Characters (${total})</button>
        <button class="chip" data-sub="recruit">Recruit (${live})</button>
      </div>
      <input class="search" id="sq" placeholder="filter by name or #…">
      <div class="muted" id="subhint" style="margin:2px 0 10px"></div>
      <div id="subview"></div>
      <div class="toolbar">
        ${ro
          ? `<span class="status warn">Read-only container — editing disabled. Convert to .ps2/.cbs/.psu first.</span>`
          : (SUPPORTS_FS && fileHandle
              ? `<button class="primary" id="saveFileBtn">Apply &amp; save to file</button>
                 <button id="saveBtn">Download copy</button>`
              : `<button class="primary" id="saveBtn">Apply &amp; download</button>`) +
            (CAN_SHARE_FILES ? `<button id="shareBtn">Apply &amp; share…</button>` : "") +
            `<button id="undoBtn" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">↶</button>
             <button id="redoBtn" title="Redo (Shift+Ctrl/Cmd+Z)" aria-label="Redo">↷</button>
             <button id="resetBtn" title="Drop every staged edit — undoable">Revert all</button>
             <span class="badge hidden" id="dirtyBadge">0 unsaved</span>
             <span class="status" id="status"></span>`}
      </div>
    </div>`;

  // wire names + money/time (Overview card is always visible)
  $$("input[data-name]").forEach((inp) => {
    inp.oninput = () => staged(inp.previousElementSibling?.textContent || "Name", `name:${inp.dataset.name}`, () => {
      inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
      NAMES[inp.dataset.name] = inp.value;
    });
    inp.onblur = () => JOURNAL.seal();
  });
  const potch = $("#potchfld"); if (potch) {
    potch.oninput = () => staged("Potch", "potch", () => {
      potch.classList.toggle("dirty", potch.value !== potch.dataset.def);
      SAVEDITS.potch = +potch.value;
    });
    potch.onblur = () => JOURNAL.seal();
  }
  const maxP = $("#maxPotch"); if (maxP && potch) maxP.onclick = () => staged("Potch → max", null, () => {
    potch.value = POTCH_MAX; potch.classList.toggle("dirty", String(POTCH_MAX) !== potch.dataset.def);
    SAVEDITS.potch = POTCH_MAX;
  });
  const gt = $("#gtfld"); if (gt) {
    gt.oninput = () => staged("Game time", "gameTime", () => {
      gt.classList.toggle("dirty", gt.value !== gt.dataset.def);
      SAVEDITS.gameTime = +gt.value; $("#gtlabel").textContent = gtLabel(+gt.value);
    });
    gt.onblur = () => JOURNAL.seal();
  }
  const wm = $("#wmfull"); if (wm) wm.onchange = () => staged("World map fully explored", null, () => {
    if (wm.checked) SAVEDITS.worldMapFull = 1; else delete SAVEDITS.worldMapFull;
    wm.closest(".field")?.classList.toggle("dirty-soft", wm.checked);
  });

  // subtabs + search + toolbar
  $$("[data-sub]").forEach((b) => (b.onclick = () => { SUB = b.dataset.sub; SEARCH = ""; const q = $("#sq"); if (q) q.value = ""; showSub(); }));
  const sq = $("#sq"); if (sq) sq.oninput = () => { SEARCH = sq.value.toLowerCase(); showSub(); };
  const sb = $("#saveBtn"); if (sb) sb.onclick = () => applyEdits("download");
  const sfb = $("#saveFileBtn"); if (sfb) sfb.onclick = () => applyEdits("file");
  const shb = $("#shareBtn"); if (shb) shb.onclick = () => applyEdits("share");
  // Revert all drops every staged edit but stays undoable — it is the most destructive control
  // in the editor, and before #3/#4 it silently discarded the lot.
  const se = $("#snapExport"); if (se) se.onclick = exportSnapshot;
  const si = $("#snapImport"); if (si) si.onchange = (e) => { const f = e.target.files[0]; if (f) importSnapshot(f); e.target.value = ""; };
  const rb = $("#resetBtn"); if (rb) rb.onclick = () => {
    if (!countEffective()) return;
    staged("Revert all", null, () => { CE = {}; NAMES = {}; SAVEDITS = {}; });
    drawSlot(true);
  };
  const ub = $("#undoBtn"); if (ub) ub.onclick = () => JOURNAL.undo();
  const rdb = $("#redoBtn"); if (rdb) rdb.onclick = () => JOURNAL.redo();
  refreshUndoButtons();
  showSub();
  refreshReverts();
}

// ---- subtab switch ---------------------------------------------------------
function showSub() {
  $$("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === SUB));
  const hint = $("#subhint");
  if (SUB === "recruit") {
    if (hint) hint.innerHTML = `Set each character's recruitment status in one place — the exact per-character flag the game checks. ` +
      `<b>Recruiting a character the story hasn't unlocked yet can soft-lock an early save</b> — keep a backup. Changes are staged until you Apply.`;
    drawRecruit();
  } else {
    if (hint) hint.innerHTML = `Stats, level/EXP, weapon Lv, runes, unite attacks and equipment per character. ` +
      `Tap a card to expand. <label style="cursor:pointer;margin-left:6px"><input type="checkbox" id="reconly" ${RECRUITED_ONLY ? "checked" : ""}> recruited only</label>`;
    drawChars();
    const rc = $("#reconly"); if (rc) rc.onchange = (e) => { RECRUITED_ONLY = e.target.checked; drawChars(); };
  }
}

// ---- Characters ------------------------------------------------------------
// Decode-time invariants (#15). An error means the save did not decode cleanly and editing is
// unsafe; a warning is real but has a known benign explanation. The split is a documented list in
// s4save.check_invariants, not a severity guess here — and the loud case stays loud precisely
// because the quiet cases are not dressed up as it.
function findingsHtml(findings) {
  if (!findings.length) return "";
  const errs = findings.filter((f) => f.sev === "error");
  const rest = findings.filter((f) => f.sev !== "error");
  const row = (f) => `<div class="fnd-row"><b>${esc(f.title)}</b><div class="muted">${esc(f.detail)}</div></div>`;
  return (errs.length ? `<div class="warnbox fnd-err" role="alert">
      <b>This save did not decode cleanly (${errs.length})</b>
      <div class="muted" style="margin:4px 0 8px">Editing it may write to the wrong bytes. Back up before saving.</div>
      ${errs.map(row).join("")}</div>` : "")
    + (rest.length ? `<details class="card fnd-note"><summary>${rest.length} decode note${rest.length === 1 ? "" : "s"}</summary>
      ${rest.map(row).join("")}</details>` : "");
}

function charByRoster(ri) { return saves[curSlot].characters.find((c) => c.rosterIndex === ri); }
// staged recruitment value for a character (falls back to the loaded value)
function recOf(c) { const e = CE[c.rosterIndex]; return (e && "recruited" in e) ? e.recruited : c.recruited; }

// Which character cards are expanded. Keyed by roster index rather than element identity so a
// re-render can't collapse them — undo/redo repaints the whole list, and having the card you are
// working in snap shut on every undo makes the feature unusable. (Same trap #6 records for
// blurb cards: key open state by something that outlives the element.)
const OPEN_CHARS = new Set();

function drawChars() {
  const s = saves[curSlot];
  let pool = s.characters || [];
  if (RECRUITED_ONLY) pool = pool.filter((c) => (recOf(c) || 0) >= 10);
  const shown = pool.filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);
  const box = $("#subview");
  box.innerHTML = shown.map(charCard).join("") || `<div class="muted" style="padding:6px 2px">no matching characters</div>`;
  shown.forEach(wireChar);
}

// ---- Recruit (bulk, per-row) -----------------------------------------------
function drawRecruit() {
  const s = saves[curSlot];
  const shown = (s.characters || []).filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);
  const rows = shown.map((c) => {
    const cur = recOf(c);
    const isStaged = CE[c.rosterIndex] && "recruited" in CE[c.rosterIndex] && CE[c.rosterIndex].recruited !== c.recruited;
    const unrec = (cur || 0) === 0;
    const opts = REC_STATES.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("") +
      (REC_STATES.some(([v]) => v === cur) ? "" : `<option value="${cur}" selected>? (${cur})</option>`);
    return `<tr class="${isStaged ? "dirtyrow" : ""}${unrec ? " unrec" : ""}">
        <td>${esc(c.name)}</td><td class="sl">#${c.rosterIndex}</td>
        <td><select data-recrow="${c.rosterIndex}" style="max-width:210px">${opts}</select></td></tr>`;
  }).join("") || `<tr><td colspan="3" class="muted">no matching characters</td></tr>`;
  $("#subview").innerHTML =
    `<div class="warnbox">Story-gated characters can soft-lock an early save if forced in — recruit optional units, and keep a backup.</div>
     <table class="invtbl"><thead><tr><th>Character</th><th>#</th><th>Recruitment</th></tr></thead><tbody>${rows}</tbody></table>`;
  $$("select[data-recrow]").forEach((se) => (se.onchange = () => {
    const c = charByRoster(+se.dataset.recrow); if (!c) return;
    staged(`${c.name} · Recruitment`, null, () => {
      ce(c.rosterIndex).recruited = +se.value;
      const tr = se.closest("tr");
      if (tr) { tr.classList.toggle("dirtyrow", +se.value !== c.recruited); tr.classList.toggle("unrec", +se.value === 0); }
    });
  }));
}

function charCard(c) {
  const ri = c.rosterIndex;
  const rcur = recOf(c);
  const unrec = (rcur || 0) === 0;
  // value = staged-or-file, data-def = always the file's, so dirty/restore stay honest.
  const num = (k, max) => {
    const file = c[k] || 0, val = curK(c, k) || 0;
    return `<input type="number" min="0" max="${max}" value="${val}" data-ri="${ri}" data-k="${k}" data-def="${file}" class="${dz(val, file).trim()}" title="0–${max}">`;
  };
  const stat = (n) => {
    const file = c.stats[n], val = curStat(c, n);
    return `<label class="field"><span>${n}${rev(`stat:${n}`, ri)}</span><input type="number" min="0" max="999" value="${val}" data-ri="${ri}" data-stat="${n}" data-def="${file}" class="${dz(val, file).trim()}"></label>`;
  };

  const lv = lvFromExp(curK(c, "exp")), lvFile = lvFromExp(c.exp);
  // Level and EXP are one stored field; ↺ on either drops the staged EXP, so the file's exact
  // value comes back rather than expFromLv(lvFromExp(exp)), which would floor it.
  const core = `
    <label class="field"><span>Level${rev("k:exp", ri)}</span>
      <input type="number" min="1" max="99" value="${lv}" data-lv="${ri}" data-def="${lvFile}" class="${dz(lv, lvFile).trim()}" title="writes EXP = (Lv−1)×1000"></label>
    <label class="field"><span>EXP${rev("k:exp", ri)}</span>${num("exp", CHAR_CAP.exp)}</label>
    <label class="field"><span>Weapon Lv${rev("k:weaponLvl", ri)}</span>${num("weaponLvl", CHAR_CAP.weaponLvl)}</label>
    <label class="field"><span>Max HP${rev("k:maxHP", ri)}</span>${num("maxHP", CHAR_CAP.maxHP)}</label>`;

  const stats = STAT_NAMES.map(stat).join("");

  const runes = [0, 1, 2].map((slot) => {
    const file = c.runes[slot] || 0, cur = curRune(c, slot);
    return `<label class="field"><span>Rune ${slot + 1}${rev(`rune:${slot}`, ri)}</span>
      <button type="button" class="picker${dz(cur, file)}" data-runeri="${ri}" data-runeslot="${slot}" data-val="${cur}" data-def="${file}">${esc(runeLabel(cur))}</button></label>`;
  }).join("");

  const equip = EQUIP_SLOTS.map(([key]) => {
    const file = (c.equip || {})[key] || 0, cur = curEquip(c, key);
    return `<label class="field"><span>${GEAR_LABELS[key] || key}${rev(`equip:${key}`, ri)}</span>
      <button type="button" class="picker${dz(cur, file)}" data-eqri="${ri}" data-eq="${key}" data-val="${cur}" data-def="${file}">${esc(itemLabel(cur))}</button></label>`;
  }).join("");

  const uNames = c.uniteNames || {};
  const unites = Object.keys(uNames).length
    ? `<h4>Unite attacks <span class="muted" style="text-transform:none;letter-spacing:0">(level 0–3)</span></h4>
       <div class="grid sk">${Object.entries(uNames).map(([slot, u]) =>
        `<label class="field" title="${esc(u.with || "")}"><span>${esc(u.name)}${rev(`unite:${slot}`, ri)}</span>
          <input type="number" min="0" max="3" value="${curUnite(c, slot)}" data-uri="${ri}" data-uslot="${slot}" data-def="${(c.unites || [])[+slot] || 0}" class="${dz(curUnite(c, slot), (c.unites || [])[+slot] || 0).trim()}"></label>`).join("")}</div>`
    : "";

  const recOpts = REC_STATES.map(([v, l]) => `<option value="${v}"${v === rcur ? " selected" : ""}>${l}</option>`).join("") +
    (REC_STATES.some(([v]) => v === rcur) ? "" : `<option value="${rcur}" selected>? (${rcur})</option>`);

  // B13 reference enrichment: elemental rune affinity (which runes suit this unit)
  const aff = affForName(c.name);
  const affNote = aff ? `<div class="fnote">Rune affinity: ${aff.map((v, i) =>
      `<span class="aff a${v}" title="${AFF_ELEMS[i]} — ${AFF_RATE[v]}">${AFF_ELEMS[i]} ${v}</span>`).join(" · ")}
      <span class="muted">(1 poor–4 excellent · GameFAQs affinity FAQ)</span></div>` : "";

  return `<details class="char${unrec ? " unrec" : ""}"${OPEN_CHARS.has(ri) ? " open" : ""}><summary>
      <span class="chev">▸</span><span class="nm">${esc(c.name)}</span>
      <span class="muted">#${ri}</span>
      <span class="pill${(rcur || 0) >= 10 ? " on" : ""}">${esc(recName(rcur))}</span>
      <span class="lv">Lv ${lv} · HP ${curK(c, "maxHP")}</span></summary>
    <div class="char-body" data-roster="${ri}">
      <div class="row revrow" style="gap:8px;margin:6px 0 2px"><span class="muted">Recruitment</span>${rev("recruit", ri)}
        <select data-recruit="${ri}" class="${dz(rcur, c.recruited).trim()}" style="max-width:220px">${recOpts}</select></div>
      <div class="row presets" style="gap:6px;margin:6px 0 2px"><span class="muted">Preset</span>
        <button type="button" class="chip mini" data-preset="${ri}" title="stage max stats, HP, level, weapon Lv and all unites for review">★ Max out</button></div>
      <h4>Core</h4><div class="grid">${core}</div>
      <h4>Stats</h4><div class="grid">${stats}</div>
      <h4>Runes</h4><div class="grid eq">${runes}</div>
      ${affNote}
      ${unites}
      <h4>Equipment</h4><div class="grid eq">${equip}</div>
    </div></details>`;
}

function ce(ri) { return (CE[ri] = CE[ri] || {}); }

// What a field should *display*: the staged value when one exists, otherwise the file's.
// data-def always keeps the file's value, so the dirty comparison — and #4's per-field restore —
// stay honest. Before #3 the cards rendered straight from the file and the staged value lived
// only in the DOM, which meant any re-render silently discarded what you had typed.
function curK(c, k)      { const e = CE[c.rosterIndex]; return e && k in e ? e[k] : c[k]; }
function curStat(c, n)   { const e = CE[c.rosterIndex]; return e && e.stats && n in e.stats ? e.stats[n] : c.stats[n]; }
function curRune(c, sl)  { const e = CE[c.rosterIndex]; return e && e.runes && sl in e.runes ? e.runes[sl] : (c.runes[sl] || 0); }
function curEquip(c, k)  { const e = CE[c.rosterIndex]; return e && e.equip && k in e.equip ? e.equip[k] : ((c.equip || {})[k] || 0); }
function curUnite(c, sl) { const e = CE[c.rosterIndex]; return e && e.unites && sl in e.unites ? e.unites[sl] : ((c.unites || [])[+sl] || 0); }
const dz = (a, b) => (String(a) !== String(b) ? " dirty" : "");   // dirty class when staged ≠ file

// Per-field restore (#4). Rendered always, revealed by refreshReverts() when the field is dirty.
const rev = (what, ri) =>
  `<button type="button" class="revert" data-revert="${what}"${ri == null ? "" : ` data-rri="${ri}"`}` +
  ` title="Restore this field to the value in the file" aria-label="Restore this field">↺</button>`;

// Sync every ↺ with its control's dirty state. Driven from one place rather than from each commit
// handler, so it covers both "the user just edited" and "undo/redo just repainted".
function refreshReverts(root) {
  $$(".field, .row.revrow, .isotoggle, .ratefield", root || document).forEach((f) => {
    const d = f.querySelector("input.dirty, select.dirty, button.picker.dirty") ||
              (f.classList.contains("dirty-soft") ? f : null);
    f.classList.toggle("has-dirty", !!d);
  });
}

function wireChar(c) {
  const ri = c.rosterIndex;
  const body = $(`.char-body[data-roster="${ri}"]`);
  if (!body) return;
  const card = body.closest("details.char");
  if (card) card.ontoggle = () => (card.open ? OPEN_CHARS.add(ri) : OPEN_CHARS.delete(ri));
  // numeric core + stats
  $$("input[data-k]", body).forEach((inp) => {
    inp.onchange = () => staged(`${c.name} · ${inp.dataset.k}`, `ce:${ri}:${inp.dataset.k}`, () => {
      ce(ri)[inp.dataset.k] = +inp.value;
      inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
      if (inp.dataset.k === "exp") { const lvIn = $(`input[data-lv="${ri}"]`, body); if (lvIn) lvIn.value = lvFromExp(+inp.value); }
    });
    inp.onblur = () => JOURNAL.seal();
  });
  $$("input[data-stat]", body).forEach((inp) => {
    inp.onchange = () => staged(`${c.name} · ${inp.dataset.stat}`, `ce:${ri}:stat:${inp.dataset.stat}`, () => {
      (ce(ri).stats = ce(ri).stats || {})[inp.dataset.stat] = +inp.value;
      inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    });
    inp.onblur = () => JOURNAL.seal();
  });
  // level → drives EXP
  const lvIn = $(`input[data-lv="${ri}"]`, body);
  if (lvIn) {
    lvIn.oninput = () => staged(`${c.name} · Level`, `ce:${ri}:exp`, () => {
      const exp = expFromLv(+lvIn.value);
      const expIn = $(`input[data-k="exp"]`, body);
      if (expIn) { expIn.value = exp; expIn.classList.toggle("dirty", String(exp) !== expIn.dataset.def); }
      ce(ri).exp = exp;
      lvIn.classList.toggle("dirty", lvIn.value !== lvIn.dataset.def);
    });
    lvIn.onblur = () => JOURNAL.seal();
  }
  // runes
  $$("button.picker[data-runeri]", body).forEach((btn) => (btn.onclick = () => {
    const slot = +btn.dataset.runeslot, cur = +btn.dataset.val;
    openPicker(`Rune ${slot + 1}`, REF.runes, cur, (id) => {
      staged(`${c.name} · Rune ${slot + 1}`, null, () => {
        btn.dataset.val = id; btn.textContent = runeLabel(id);
        btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
        (ce(ri).runes = ce(ri).runes || {})[slot] = id;
      });
    }, (id) => hx(id, 2));
  }));
  // equipment
  $$("button.picker[data-eq]", body).forEach((btn) => (btn.onclick = () => {
    const key = btn.dataset.eq, cur = +btn.dataset.val;
    openPicker(`Equip — ${GEAR_LABELS[key] || key}`, REF.items, cur, (id) => {
      staged(`${c.name} · ${GEAR_LABELS[key] || key}`, null, () => {
        btn.dataset.val = id; btn.textContent = itemLabel(id);
        btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
        (ce(ri).equip = ce(ri).equip || {})[key] = id;
      });
    });
  }));
  // unites
  $$("input[data-uri]", body).forEach((inp) => {
    inp.onchange = () => staged(`${c.name} · Unite`, `ce:${ri}:unite:${inp.dataset.uslot}`, () => {
      (ce(ri).unites = ce(ri).unites || {})[inp.dataset.uslot] = +inp.value;
      inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    });
    inp.onblur = () => JOURNAL.seal();
  });
  // recruitment
  $$("select[data-recruit]", body).forEach((se) => (se.onchange = () => staged(`${c.name} · Recruitment`, null, () => {
    ce(ri).recruited = +se.value;
    se.classList.toggle("dirty", +se.value !== c.recruited);
  })));
  // preset
  $$("button[data-preset]", body).forEach((b) => (b.onclick = () => applyPreset(ri)));
}

// B18 preset — stage a full "max out" for one character (reviewable, revertible, per apply).
function applyPreset(ri) {
  const body = $(`.char-body[data-roster="${ri}"]`);
  if (!body) return;
  // One undo step for the whole preset — unwinding "Max out" field by field would be useless.
  staged(`Max out · ${charByRoster(ri)?.name || "#" + ri}`, null, () => applyPresetInner(ri, body));
}
function applyPresetInner(ri, body) {
  const e = ce(ri);
  const mark = (inp, v) => { inp.value = v; inp.classList.toggle("dirty", String(v) !== inp.dataset.def); };
  e.stats = e.stats || {};
  $$('input[data-stat]', body).forEach((inp) => { mark(inp, 999); e.stats[inp.dataset.stat] = 999; });
  const setK = (k, v) => { const inp = $(`input[data-k="${k}"]`, body); if (inp) mark(inp, v); e[k] = v; };
  setK("maxHP", CHAR_CAP.maxHP); setK("weaponLvl", CHAR_CAP.weaponLvl); setK("exp", CHAR_CAP.exp);
  const lvIn = $(`input[data-lv="${ri}"]`, body); if (lvIn) mark(lvIn, 99);
  const us = $$('input[data-uri]', body);
  if (us.length) { e.unites = e.unites || {}; us.forEach((inp) => { mark(inp, 3); e.unites[inp.dataset.uslot] = 3; }); }
  setStatus(`Staged "Max out" for ${charByRoster(ri)?.name || "#" + ri} — review before applying.`, "");
}

// ---- JSON snapshots (#14) --------------------------------------------------
// Export is the whole decoded save as readable JSON. It contains no copyrighted game data — only
// values the user's own save already held — so it is safe to paste into an issue, which makes it
// the best bug-report format this project can have.
function exportSnapshot() {
  const s = saves[curSlot];
  if (!s) return;
  const snap = S4Core.snapshotFromSave(s, { app: APP_VERSION });
  const name = (downloadName().replace(/\.[^.]+$/, "") || "suikoden4") + ".snapshot.json";
  downloadBytes(new TextEncoder().encode(JSON.stringify(snap, null, 2)), name);
  setStatus(`Exported ${snap.characters.length} characters to ${name}.`, "ok");
}

// Import stages the differences through the normal review path — it never writes. An imported
// snapshot is exactly as reviewable, undoable and revertible as a hand edit.
async function importSnapshot(file) {
  const s = saves[curSlot];
  if (!s) return;
  let snap;
  try { snap = JSON.parse(await file.text()); }
  catch (e) { return setStatus("That file isn't valid JSON: " + e.message, "err"); }

  const d = S4Core.diffSnapshot(s, snap);
  if (d.error) return setStatus(d.error, "err");

  const rows = S4Core.buildDiff({ save: s, saveEdits: d.saveEdits, names: d.names,
    charEdits: d.charEdits, labels: { item: itemLabel, rune: runeLabel } });
  if (!rows.length) {
    return setStatus(d.skipped.length
      ? `Snapshot matches this save — nothing to change. Skipped: ${d.skipped.join(", ")}.`
      : "Snapshot matches this save exactly — nothing to change.", "ok");
  }
  if (d.skipped.length) rows.push({ g: "Not applied", t: d.skipped.join(", ") + " — not in this save" });

  openConfirm(rows, () => {
    staged(`Import snapshot (${rows.length})`, null, () => {
      Object.assign(SAVEDITS, d.saveEdits);
      Object.assign(NAMES, d.names);
      for (const [ri, e] of Object.entries(d.charEdits)) {
        const t = ce(ri);
        for (const [k, v] of Object.entries(e)) {
          if (v && typeof v === "object") Object.assign(t[k] = t[k] || {}, v); else t[k] = v;
        }
      }
    });
    drawSlot(true);
    setStatus(`Staged ${rows.length} change${rows.length === 1 ? "" : "s"} from the snapshot — review and apply.`, "ok");
  }, "Stage these changes");
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

// Thin wrapper over the core's pure transform: app.js owns the staged-edit globals and the
// reference tables, s4-core.js owns the rule for what counts as a change.
function buildDiff() {
  return S4Core.buildDiff({
    save: saves[curSlot],
    saveEdits: SAVEDITS, names: NAMES, charEdits: CE,
    labels: { item: itemLabel, rune: runeLabel },
  });
}

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
       <option value="runes">Runes</option><option value="aff">Rune affinities</option></select></div>
    <div id="reftbl" style="margin-top:10px;max-height:60vh;overflow:auto"></div></div>`;
  $("#rkind").onchange = renderRefTable;
  $("#rq").oninput = renderRefTable;
  renderRefTable();
}
function renderRefTable() {
  const kind = $("#rkind").value, q = ($("#rq").value || "").toLowerCase();
  if (kind === "aff") {
    const names = Object.keys(AFF).filter((n) => !q || n.toLowerCase().includes(q)).sort();
    $("#reftbl").innerHTML = `<table class="invtbl"><thead><tr><th>Character</th>${AFF_ELEMS.map((e) => `<th>${e}</th>`).join("")}</tr></thead><tbody>`
      + (names.map((n) => `<tr><td>${esc(n)}</td>${(AFF[n] || []).map((v) => `<td><span class="aff a${v}" title="${AFF_RATE[v]}">${v}</span></td>`).join("")}</tr>`).join(""))
      + `</tbody></table><div class="muted" style="padding:8px">1 poor – 4 excellent · order Fire · Lightning · Water · Wind · Earth · source: GameFAQs Rune Affinity FAQ (OmegaDL50)</div>`;
    return;
  }
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
function bootProgress(pct, msg, step) {
  bootGate.step(pct, msg, step);
  const el = $("#engineStatus"); if (!el) return;
  el.innerHTML = `<div class="bootmsg">${pct < 100 ? '<span class="spinner"></span>' : ""}${esc(msg)}</div>` +
    `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;
}

// Boot gate (#7). The overlay itself is in index.html so it paints on the first frame; this only
// drives it. It covers #loaderCard alone — Python gates loading a save and nothing else, so the
// ISO editor (a completely Pyodide-free code path) stays usable during the ~10 MB download, and
// the gate says so with a button rather than leaving the working half of the app looking broken.
const bootGate = (() => {
  const STEPS = ["rt", "mod", "ref"];
  let closed = false, failed = false;
  const ov = () => document.getElementById("bootOv");
  return {
    // pct/msg mirror bootProgress; step is the STEPS key now running ("done" = all finished).
    step(pct, msg, step) {
      // Sticky once failed: a late progress call overwriting the error with "Ready" would tell
      // the user the engine started when it didn't.
      const o = ov(); if (!o || closed || failed) return;
      const fill = o.querySelector("#bootFill"), m = o.querySelector("#bootMsg");
      if (fill) fill.style.width = Math.max(2, Math.min(100, pct)) + "%";
      if (m) { m.className = "boot-msg"; m.innerHTML = `<span class="spinner"></span>${esc(msg)}`; }
      if (!step) return;
      const at = STEPS.indexOf(step);   // -1 for "done" → everything ticks
      STEPS.forEach((k, i) => {
        const li = o.querySelector(`.boot-steps li[data-step="${k}"]`); if (!li) return;
        li.classList.toggle("on", i === at);
        li.classList.toggle("done", at < 0 || i < at);
      });
    },
    // Engine failed: keep the gate up (the loader under it can't do anything anyway) but swap the
    // spinner for the reason and the two things that actually help — a retry and a cache clear,
    // since a half-written service-worker cache is the usual culprit.
    fail(msg) {
      const o = ov(); if (!o || closed) return;
      failed = true;
      const m = o.querySelector("#bootMsg"), bar = o.querySelector(".bar"), acts = o.querySelector("#bootActs");
      const t = o.querySelector("#bootTitle");
      if (t) t.textContent = "The Python engine didn’t start";
      if (m) { m.className = "boot-msg err"; m.textContent = "⚠ " + msg; }
      if (bar) bar.querySelector(".bar-fill").classList.add("err");
      // The step that was mid-flight is the one that failed — a spinning glyph next to
      // "didn't start" reads as still-working, which is the opposite of the truth.
      const at = o.querySelector(".boot-steps li.on");
      if (at) { at.classList.remove("on"); at.classList.add("bad"); }
      m?.setAttribute("aria-busy", "false");
      if (acts && !document.getElementById("bootRetry")) {
        acts.insertAdjacentHTML("afterbegin",
          '<button type="button" class="chip" id="bootRetry">↻ Retry</button>' +
          '<button type="button" class="chip" id="bootNuke">Clear cache &amp; reload</button>');
        document.getElementById("bootRetry").onclick = () => location.reload();
        document.getElementById("bootNuke").onclick = () => forceRefresh();
      }
      const hide = document.getElementById("bootHide");
      if (hide) hide.textContent = "Dismiss anyway";
    },
    close() {
      const o = ov(); if (!o || closed) return;
      closed = true;
      o.classList.add("gone");
      // Removed rather than left as an invisible layer over the loader — and so the phone
      // min-height that keeps the card gate-sized goes with it.
      setTimeout(() => o.remove(), 260);
    },
    get closed() { return closed; },
    get failed() { return failed; },
  };
})();
function dirtyNow() { try { return typeof CE !== "undefined" && buildDiff().length > 0; } catch (e) { return false; } }

// ---- PWA staleness escape hatch (B17) --------------------------------------
// Force refresh: unregister the SW, drop every cache, reload. The reliable escape hatch
// when a stuck service worker keeps serving an old shell.
async function forceRefresh() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
  } catch (e) { /* best-effort */ }
  location.reload();
}
// Version-behind check: cache-busted fetch of index.html bypasses HTTP + SW caches; if the
// deployed footer version differs from the running one, offer an update.
async function checkVersionBehind() {
  try {
    const r = await fetch(`index.html?cb=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return;
    const m = /·\s*v(\d+\.\d+\.\d+)/.exec(await r.text());
    if (m && m[1] !== APP_VERSION) showUpdatePrompt(m[1]);
  } catch (e) { /* offline / blocked — ignore */ }
}
function showUpdatePrompt(latest) {
  const el = $("#updateBanner"); if (!el) return;
  el.innerHTML = `A newer version (v${esc(latest)}) is available — you're on v${APP_VERSION}.
    <button class="chip mini" id="ubUpdate">↻ Update now</button>`;
  el.classList.remove("hidden");
  $("#ubUpdate").onclick = forceRefresh;
}

// ---- theme -----------------------------------------------------------------
// Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z, routed to the editor the user is actually looking at.
// Skipped while a text field has focus so the browser's own per-field undo still works, and
// while a modal is open so Esc/Enter keep their meaning.
function bindUndoKeys() {
  document.addEventListener("keydown", (e) => {
    const z = (e.key === "z" || e.key === "Z") && (e.metaKey || e.ctrlKey) && !e.altKey;
    if (!z) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.querySelector(".modal-ov")) return;
    const iso = MODE === "iso";
    if (iso && !(window.ISO && window.ISO.loaded && window.ISO.loaded())) return;
    e.preventDefault();
    const back = !e.shiftKey;
    if (iso) (back ? window.ISO.undo : window.ISO.redo)();
    else (back ? JOURNAL.undo : JOURNAL.redo)();
  });
}

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "");
  $$("footer .tb").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#eaf4f7" : "#0a141e";
  try { localStorage.setItem("s4editor-theme", t); } catch (e) {}
}

// ---- mode tabs -------------------------------------------------------------
let MODE = "save";              // which editor is showing — the undo keys route on this
function setMode(mode) {
  MODE = mode;
  $$(".modebar .mtab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  $("#mode-save").classList.toggle("hidden", mode !== "save");
  $("#mode-iso").classList.toggle("hidden", mode !== "iso");
  $("#mode-ref").classList.toggle("hidden", mode !== "ref");
  if (mode === "ref" && !refRendered && PY) renderReference();
  if (mode === "iso" && window.ISO) window.ISO.init();   // ISO editor is independent of Pyodide
}

// ---- wire up ---------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  let theme = "ocean";
  try { theme = localStorage.getItem("s4editor-theme") || "ocean"; } catch (e) {}
  applyTheme(theme);
  bindUndoKeys();
  bindReverts();
  // The gate's whole point: the ISO editor needs no Python, so offer it instead of making the
  // user wait, and let them dismiss the gate to read the loader underneath.
  const bootIso = $("#bootIso"); if (bootIso) bootIso.onclick = () => { bootGate.close(); setMode("iso"); };
  const bootHide = $("#bootHide"); if (bootHide) bootHide.onclick = () => bootGate.close();
  // Show the version of the *running* code (app.js), not whatever index.html shipped — so a
  // transient cache desync can never make the footer disagree with the update banner.
  const cr = $("footer .credit"); if (cr) cr.innerHTML = cr.innerHTML.replace(/·\s*v[\d.]+/, "· v" + APP_VERSION);
  $$("footer .tb[data-theme]").forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)));
  $$(".modebar .mtab").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  const fr = $("#forceRefresh"); if (fr) fr.onclick = forceRefresh;
  checkVersionBehind();

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
    bootGate.close();
    if (!$("#mode-ref").classList.contains("hidden") && !refRendered) renderReference();
  }).catch((e) => { setDropMsg("Engine failed to start: " + e.message, true); bootGate.fail(e.message); });
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
