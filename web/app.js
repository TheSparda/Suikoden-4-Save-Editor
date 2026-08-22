/* Suikoden IV Save Editor (Web)
 * Runs the repo's real stdlib-only Python save module (Editor/s4save.py) unchanged inside
 * Pyodide. The picked save is written into Pyodide's in-memory FS, decoded/edited by the
 * Python module, and the edited bytes are read straight back out for download.
 * The save file never leaves the device. See web/README.md and the porting guide.
 */
"use strict";

const SAVE_PATH = "/save.bin";
const EDITOR_DIR = "../Editor";          // served from the repo root (see .nojekyll / Pages)

let pyReady = null;                       // resolves to the pyodide instance
let REF = {};                             // {runes, items, equipSlots, chars}
let saves = [];                           // decoded saves currently loaded
let origName = "save.bin";                // name of the picked file (for the download name)

// prebuilt option strings, made once from the reference tables
let RUNE_LIST = [], ITEM_LIST = [], EQUIP_SLOTS = [], ITEM_OPTS = "";

// ---------- tiny helpers ----------
const $ = (s, e = document) => e.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const spinner = msg => `<div class="loading"><span class="helm"></span><span>${esc(msg || "loading…")}</span></div>`;
const skelCards = (n = 3) => `<div class="skelgrid">${'<div class="skel"></div>'.repeat(n)}</div>`;
async function withBusy(btn, fn) { if (btn) btn.classList.add("busy"); try { return await fn(); } finally { if (btn) btn.classList.remove("busy"); } }

// ---------- theme + tabs ----------
function toggleTheme() {
  const d = document.documentElement;
  const n = d.getAttribute("data-theme") === "light" ? "" : "light";
  n ? d.setAttribute("data-theme", n) : d.removeAttribute("data-theme");
  try { localStorage.setItem("s4editor-theme", n); } catch (e) {}
}
try { const t = localStorage.getItem("s4editor-theme"); if (t) document.documentElement.setAttribute("data-theme", t); } catch (e) {}

let refRendered = false;
function tab(t) {
  for (const el of document.querySelectorAll(".tab")) el.classList.toggle("on", el.dataset.t === t);
  $("#t-save").hidden = t !== "save";
  $("#t-ref").hidden = t !== "ref";
  if (t === "ref" && !refRendered) renderReference();
}

// ---------- engine boot ----------
async function bootPyodide() {
  const py = await loadPyodide();
  const grab = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} (${r.status})`);
    return r;
  };
  // 1) the real save modules — unchanged — into Pyodide's FS
  for (const mod of ["s4lzari.py", "s4files.py", "s4save.py"]) {
    py.FS.writeFile(mod, await (await grab(`${EDITOR_DIR}/${mod}`)).text());
  }
  // 2) reference/name tables the module loads at import time (same dir as the module)
  for (const j of ["s4_item_names.json", "s4_rune_names.json", "s4_char_offsets.json", "s4_unites.json"]) {
    py.FS.writeFile(j, await (await grab(`${EDITOR_DIR}/${j}`)).text());
  }
  // 3) thin JSON-in / JSON-out glue — all byte work stays inside the trusted module
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
    # JSON object keys are strings; the writer keys characters by integer roster index.
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
  return py;
}

function setEngineStatus(msg, isErr) {
  const el = $("#engineStatus");
  if (el) el.innerHTML = isErr ? `<span class="err">${esc(msg)}</span>` : esc(msg);
}

// ---------- load a picked/dropped file ----------
async function handleFile(file) {
  const py = await pyReady;
  origName = file.name || "save.bin";
  $("#saveout").innerHTML = spinner("reading save…") + skelCards(3);
  try {
    py.FS.writeFile(SAVE_PATH, new Uint8Array(await file.arrayBuffer()));
    const out = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
    if (out.error) { $("#saveout").innerHTML = `<p class="err">${esc(out.error)}</p>`; return; }
    saves = out.saves || [];
    if (!saves.length) { $("#saveout").innerHTML = '<p class="mut">No Suikoden IV save found in that file.</p>'; return; }
    renderSaves();
  } catch (e) {
    $("#saveout").innerHTML = `<p class="err">Failed to read save: ${esc(e.message)}</p>`;
  }
}

// ---------- download helpers ----------
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

// ---------- render the loaded saves ----------
const GEAR_LABELS = { head: "Head", body: "Body", hands: "Hands", feet: "Feet", acc1: "Accessory 1", acc2: "Accessory 2", acc3: "Accessory 3" };
const STATS = ["STR", "SKL", "MAG", "EVA", "PDF", "MDF", "SPD", "LUK"];
const REC_STATES = [[0, "Not Recruited"], [1, "In Your Company"], [10, "Recruited"], [11, "In Party"], [15, "Permanently In Party"]];

function charCard(sv, c) {
  const st = c.stats, cid = esc(sv.folder) + "|" + c.rosterIndex;
  const cell = (f, v, mx) => `<input type="number" min="0" max="${mx}" value="${v}" data-def="${v}" data-ch="${cid}|${f}">`;
  // Level is derived: lvl = EXP//1000 + 1. The Lv input just drives the EXP field; only EXP is written.
  const lv = Math.min(99, Math.floor((c.exp || 0) / 1000) + 1);
  const statTable = `<div class="tablewrap"><table class="savetbl"><thead><tr>` +
    `<th>Lv</th><th>EXP</th><th>Wpn Lv</th><th>Max HP</th>${STATS.map(k => `<th>${k}</th>`).join("")}</tr></thead><tbody><tr>` +
    `<td><input type="number" min="1" max="99" value="${lv}" title="Level (writes EXP = (Lv−1)×1000)"
       oninput="const e=this.closest('tr').querySelector('[data-ch$=&quot;|exp&quot;]');if(e&&this.value){e.value=(Math.min(99,Math.max(1,+this.value))-1)*1000;e.dispatchEvent(new Event('input',{bubbles:true}));}"></td>` +
    `<td>${cell("exp", c.exp || 0, 98999)}</td>` +
    `<td>${cell("weaponLvl", c.weaponLvl || 0, 15)}</td>` +
    `<td>${cell("maxHP", c.maxHP, 9999)}</td>` +
    STATS.map(k => `<td>${cell("stat:" + k, st[k], 999)}</td>`).join("") + `</tr></tbody></table></div>`;

  const rune = (slot, label) => {
    const cur = c.runes[slot];
    const opts = RUNE_LIST.map(r => `<option value="${r.id}"${r.id === cur ? " selected" : ""}>${esc(r.name)}</option>`).join("");
    return `<div class="fld"><label>${label}</label><select data-def="${cur}" data-ch="${cid}|rune:${slot}">${opts}</select></div>`;
  };
  const gear = (key, label) => {
    const cur = (c.equip || {})[key] || 0;
    const opts = ITEM_OPTS.replace(`value="${cur}">`, `value="${cur}" selected>`);
    return `<div class="fld"><label>${label}</label><select data-def="${cur}" data-ch="${cid}|equip:${key}">${opts}</select></div>`;
  };

  const rcur = (c.recruited === undefined) ? null : c.recruited;
  const unrec = rcur !== null && rcur === 0;
  const recSel = rcur === null ? "" : `<select class="recsel" data-def="${rcur}" data-ch="${cid}|recruited" onclick="event.stopPropagation()" title="Recruitment status — the flag the game itself checks">${
    REC_STATES.map(([v, l]) => `<option value="${v}"${v === rcur ? " selected" : ""}>${l}</option>`).join("")
  }${REC_STATES.some(([v]) => v === rcur) ? "" : `<option value="${rcur}" selected>? (${rcur})</option>`}</select>`;

  const unites = Object.keys(c.uniteNames || {}).length
    ? `<div class="seclabel">Unite Attacks <span class="mut" style="font-weight:400;text-transform:none;letter-spacing:0">(level 0–3)</span></div>
       <div class="unites">${Object.entries(c.uniteNames).map(([s, u]) =>
        `<label class="ufld" title="${esc(u.with || "")}"><input type="number" class="unite" min="0" max="3" value="${(c.unites || [])[+s] || 0}" data-def="${(c.unites || [])[+s] || 0}" data-ch="${cid}|unite:${s}"> ${esc(u.name)}</label>`).join("")}
       </div>` : "";

  return `<div class="charcard${unrec ? " unrec" : ""}" data-name="${esc(c.name.toLowerCase())}" data-ri="${c.rosterIndex}" data-data="${c.hasData ? 1 : 0}">
    <div class="charhead"><span>${esc(c.name)}</span><span class="lvl">#${c.rosterIndex}</span>${recSel}</div>
    ${statTable}
    <div class="seclabel">Runes</div>
    <div class="grid g3">${rune(0, "Rune 1")}${rune(1, "Rune 2")}${rune(2, "Rune 3")}</div>
    ${unites}
    <div class="seclabel">Equipment</div>
    <div class="grid g4">${EQUIP_SLOTS.map(([k]) => gear(k, GEAR_LABELS[k] || k)).join("")}</div>
  </div>`;
}

function renderSaves() {
  const many = saves.length > 1;   // collapse each save when there are several
  $("#saveout").innerHTML = saves.map(sv => {
    const cksum = sv.checksumValid ? '<span class="badge ok">checksum ok</span>' : '<span class="badge ro">checksum off</span>';
    const nameRows = (sv.names || []).map(n => `<tr><td class="mut">${esc(n.label)}</td>
      <td><input type="text" class="mono" data-def="${esc(n.value)}" data-name="${esc(n.folder)}|${esc(n.key)}" value="${esc(n.value)}" maxlength="${n.max}" size="18"></td></tr>`).join("");
    const chars = (sv.characters || []).map(c => charCard(sv, c)).join("");
    const f = esc(sv.folder);
    const nrec = (sv.characters || []).filter(c => (c.recruited || 0) >= 10).length;
    const gt = sv.gameTimeSec || 0;
    return `<div class="card savecard${many ? " collapsed" : ""}">
      <div class="savebar" onclick="toggleSave('${f}')" title="click to expand / collapse">
        <span class="caret">▸</span>
        <b>${esc(sv.label)}</b>${sv.region ? ` <span class="rgn">${esc(sv.region)}</span>` : ""} ${cksum}
        <span class="mono mut">${esc((sv.meta && sv.meta.title) || "")}</span>
        <span class="mut" style="font-size:12px">${nrec} recruited</span>
        ${sv.container && sv.container !== "memcard" ? `<span class="rgn" style="background:var(--acc)">${esc(sv.container.toUpperCase())}</span>` : ""}
        <span class="sp"></span>
        ${sv.writable === false
          ? `<span class="badge ro" title="${esc(sv.note || "read-only container — convert to .ps2/.cbs/.psu to edit")}">read-only</span>`
          : `<button class="pri" onclick="event.stopPropagation();writeSave('${f}',this)">Apply &amp; download</button>`}
      </div>
      <div class="savebody">
        <div class="seclabel">Names &amp; Money</div>
        <table class="nametbl"><tbody>${nameRows}
          <tr><td class="mut">Potch</td><td><input type="number" class="mono" min="0" max="99999999" value="${sv.potch || 0}" data-def="${sv.potch || 0}" data-save="${f}|potch" style="width:120px"></td></tr>
          <tr><td class="mut">Game time</td><td><input type="number" class="mono" min="0" max="3596400" value="${gt}" data-def="${gt}" data-save="${f}|gameTime" style="width:120px"> <span class="mut">seconds = ${Math.floor(gt / 3600)}h${String(Math.floor((gt % 3600) / 60)).padStart(2, "0")}m</span></td></tr>
          <tr><td class="mut">World map</td><td>${sv.worldMapPct !== undefined ? sv.worldMapPct + "% explored" : ""}
            <label class="mut" style="margin-left:10px"><input type="checkbox" data-save="${f}|worldMapFull"> mark fully explored on write</label></td></tr>
        </tbody></table>
        <div class="seclabel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Characters
          <input type="search" placeholder="filter by name or #…" oninput="filterChars('${f}',this.value)" style="width:200px;font-weight:400">
          <label class="mut" style="font-weight:400"><input type="checkbox" onchange="withdataChars('${f}',this.checked)"> only non-default</label>
        </div>
        <div id="chars-${f}" class="chars">${chars}</div>
      </div>
    </div>`;
  }).join("");
  applyCharFilters();
}

// expand / collapse one save card
function toggleSave(folder) {
  const card = document.querySelector(`#chars-${CSS.escape(folder)}`)?.closest(".savecard");
  if (card) card.classList.toggle("collapsed");
}

// per-folder character filter state
const CHARFILT = {};
function filterChars(folder, q) { (CHARFILT[folder] = CHARFILT[folder] || {}).q = q.toLowerCase(); applyCharFilters(); }
function withdataChars(folder, on) { (CHARFILT[folder] = CHARFILT[folder] || {}).data = on; applyCharFilters(); }
function applyCharFilters() {
  document.querySelectorAll(".chars").forEach(box => {
    const folder = box.id.slice("chars-".length);
    const st = CHARFILT[folder] || {}; const q = st.q || ""; const dataOnly = !!st.data;
    box.querySelectorAll(".charcard").forEach(card => {
      const okQ = !q || card.dataset.name.includes(q) || card.dataset.ri === q;
      const okD = !dataOnly || card.dataset.data === "1";
      card.style.display = (okQ && okD) ? "" : "none";
    });
  });
}

// dirty-field highlight: compare each edited control to its loaded default
document.addEventListener("input", e => {
  const el = e.target;
  if (!(el.dataset && (el.dataset.ch || el.dataset.name || el.dataset.save))) return;
  if (el.type === "checkbox") return;
  if ("def" in el.dataset) el.classList.toggle("dirty", String(el.value) !== String(el.dataset.def));
});

// ---------- write + download ----------
async function writeSave(folder, btn) {
  const py = await pyReady;
  const charEdits = {}, nameEdits = {}, saveEdits = {};
  for (const el of document.querySelectorAll(`[data-ch^="${folder}|"]`)) {
    const [, ridx, field] = el.dataset.ch.split("|");
    charEdits[ridx] = charEdits[ridx] || {};
    if (field.startsWith("stat:")) { charEdits[ridx].stats = charEdits[ridx].stats || {}; charEdits[ridx].stats[field.slice(5)] = +el.value; }
    else if (field.startsWith("rune:")) { charEdits[ridx].runes = charEdits[ridx].runes || {}; charEdits[ridx].runes[field.slice(5)] = +el.value; }
    else if (field.startsWith("equip:")) { charEdits[ridx].equip = charEdits[ridx].equip || {}; charEdits[ridx].equip[field.slice(6)] = +el.value; }
    else if (field.startsWith("unite:")) { charEdits[ridx].unites = charEdits[ridx].unites || {}; charEdits[ridx].unites[field.slice(6)] = +el.value; }
    else charEdits[ridx][field] = +el.value;
  }
  for (const el of document.querySelectorAll(`[data-name^="${folder}|"]`)) {
    nameEdits[el.dataset.name.split("|")[1]] = el.value;
  }
  for (const el of document.querySelectorAll(`[data-save^="${folder}|"]`)) {
    const key = el.dataset.save.split("|")[1];
    const v = el.type === "checkbox" ? (el.checked ? 1 : 0) : +el.value;
    if (el.type !== "checkbox" || v) saveEdits[key] = v;   // only send checkbox actions when ticked
  }
  const payload = { charEdits, nameEdits, saveEdits };
  const res = await withBusy(btn, async () => {
    const out = py.runPython(
      `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(folder)}, ${JSON.stringify(JSON.stringify(payload))})`);
    return JSON.parse(out);
  });
  if (res.error) { setStatus(folder, "Write failed: " + res.error, "err"); return; }
  // pull the edited bytes straight out of MEMFS and hand them to the browser
  downloadBytes(py.FS.readFile(SAVE_PATH), downloadName());
  if (res.saves) { saves = res.saves; renderSaves(); }
  setStatus(folder, `Downloaded ${downloadName()} — ${res.changed} field(s) changed, checksum recomputed. Copy it back into your emulator's memory-card location.`, "ok");
}

function setStatus(folder, msg, kind) {
  const bar = document.querySelector(`#chars-${CSS.escape(folder)}`)?.closest(".savecard")?.querySelector(".savebody");
  if (!bar) { alert(msg); return; }
  let s = bar.querySelector(".status");
  if (!s) { s = document.createElement("div"); bar.prepend(s); }
  s.className = "status " + (kind || "");
  s.textContent = msg;
}

// ---------- reference tab ----------
function renderReference() {
  refRendered = true;
  const s = $("#t-ref");
  s.innerHTML = `<div class="card"><div class="row">
    <b>Reference</b><span class="mut">${REF.chars.length} characters · ${REF.items.length} items · ${REF.runes.length} runes</span>
    <span class="sp"></span><input type="search" id="rq" placeholder="filter…" oninput="renderRefTable()"></div>
    <div class="row" style="margin-top:8px">
     <select id="rkind" onchange="renderRefTable()">
      <option value="chars">Characters</option><option value="items">Items</option>
      <option value="runes">Runes</option></select></div>
    <div id="reftbl" class="scroll" style="margin-top:10px"></div></div>`;
  renderRefTable();
}
function renderRefTable() {
  const kind = $("#rkind").value, q = ($("#rq").value || "").toLowerCase();
  const rows = REF[kind].filter(x => !q || JSON.stringify(x).toLowerCase().includes(q));
  const cols = kind === "chars" ? ["index", "name"] : ["id", "name"];
  const html = `<table><thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>`
    + rows.slice(0, 600).map(x => `<tr>${cols.map(c => `<td class="${c === "id" || c === "index" ? "mono" : ""}">${esc(c === "id" ? "0x" + x[c].toString(16).toUpperCase().padStart(4, "0") : x[c])}</td>`).join("")}</tr>`).join("")
    + `</tbody></table>` + (rows.length > 600 ? `<p class="mut" style="padding:8px">showing 600 of ${rows.length}</p>` : "");
  $("#reftbl").innerHTML = html;
}

// ---------- PWA ----------
function registerPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(e => console.warn("SW register failed", e));
  }
  const installBtn = $("#installBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let deferredPrompt = null;
  if (!standalone) {
    window.addEventListener("beforeinstallprompt", e => {
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
}

// ---------- boot wiring ----------
window.addEventListener("DOMContentLoaded", () => {
  const drop = $("#drop");
  const fileInput = $("#file");
  const pickBtn = $("#pickBtn");
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  pyReady = bootPyodide().then(py => {
    REF = JSON.parse(py.runPython("load_reference()"));
    RUNE_LIST = REF.runes || [];
    ITEM_LIST = REF.items || [];
    EQUIP_SLOTS = REF.equipSlots || [];
    ITEM_OPTS = ITEM_LIST.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join("");
    setEngineStatus("Python engine ready — drop or choose a save file.", false);
    pickBtn.disabled = false;
    return py;
  }).catch(e => { setEngineStatus("Engine failed to start: " + e.message, true); throw e; });

  registerPWA();
});
