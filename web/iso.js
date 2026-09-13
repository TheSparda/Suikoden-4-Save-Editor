// Suikoden IV ISO Editor — client-side, in-place, no upload.
//
// The save editor edits a tiny save wholesale in Pyodide; the ISO is ~4.36 GB and can't live
// in memory. But the only edits we expose are a handful of 4-byte code patches in the boot ELF.
// So we read just those tiny windows via ranged Blob.slice(), edit in memory, and on save either
//   • overwrite the changed bytes in place via the File System Access API (desktop Chromium), or
//   • stream a patched copy of the whole disc to downloads through our own service worker
//     (Android/Firefox — no in-place API for a 4 GB file, nothing uploaded).
//
// Reuses app.js's shared helpers ($, $$, esc, openConfirm, modalA11y, idbGet/idbSet/idbDel).
// Extend by adding entries to FIELDS — each is either a "percent"/"num" value or a "bool" code
// patch (on/off byte runs). Every offset here was verified against the real USA ISO.
(function () {
  "use strict";

  // ---- regions (#18) -------------------------------------------------------
  //
  // SYSTEM.CNF at LBA 366 names the boot ELF, which identifies the release. Reading it means a
  // PAL disc can be recognised and SAID SO, instead of being rejected as "not Suikoden IV" —
  // which is what every PAL user hit, having just had their save edited successfully.
  //
  // Per-field offsets are keyed by region. A field with no offset for the loaded region is
  // HIDDEN WITH A REASON rather than guessed at: the patch shapes are known, so PAL offsets are
  // a pattern search away, but a wrong offset writes into unrelated code (rule 1).
  const SYSTEM_CNF_LBA = 366;
  const REGIONS = {
    "SLUS-209.79": { label: "NTSC-U", elfLba: 367, elfLen: 3214528 },
    "SLES-529.13": { label: "PAL", elfLba: null, elfLen: null },
  };
  let REGION = "SLUS-209.79";                  // set from the disc on load

  // A field's offset for the loaded region, or null when it hasn't been located there.
  // `off` may be a number (NTSC-U only, the historical form) or a per-region map.
  const offFor = (f, region) =>
    (typeof f.off === "number" ? (region === "SLUS-209.79" ? f.off : null)
                               : (f.off[region] != null ? f.off[region] : null));
  const availableFields = (region) => FIELDS.filter((f) => offFor(f, region || REGION) != null);
  const unavailableFields = (region) => FIELDS.filter((f) => offFor(f, region || REGION) == null);

  const ISO_ELF_START = 367 * 2048;          // boot ELF SLUS_209.79;1 at LBA 367 (0xB7800)

  // ---- editable fields (absolute ISO byte offsets; verified on the USA disc) ----
  // percent: rate = 100/N of default; N=round(10000/percent) is the rand range immediate.
  // bool:    a code patch — onBytes when checked, offBytes (the stock instruction) when not.
  const FIELDS = [
    {
      key: "encounterRate", view: "encounter", group: "Random encounters", type: "percent",
      label: "Encounter rate", off: 0x10E43C, len: 4, def: 100, min: 1, max: 1000,
      unit: "% of normal",
      presets: [["¼", 25], ["Half", 50], ["Stock", 100], ["Double", 200], ["Triple", 300]],
      slider: [5, 300, 5],
      hint: "How often random battles happen, as a percent of the stock rate. The game rolls the " +
            "encounter threshold as rand(0..N-1); this sets N = round(10000 / percent). Lower = fewer.",
      hintSum: "How often random battles happen, as a percent of the stock rate. Lower = fewer.",
      sig: (b) => b[2] === 0x04 && b[3] === 0x24,     // addiu a0, zero, imm
      read: (dv) => { const N = dv.getUint16(0, true); return N ? Math.round(10000 / N) : 100; },
      write: (dv, pct) => {
        const N = Math.max(1, Math.min(0x7FFF, Math.round(10000 / Math.max(1, pct))));
        dv.setUint32(0, (0x24040000 | N) >>> 0, true);
      },
    },
    {
      key: "championAlways", view: "encounter", group: "Random encounters", type: "bool",
      label: "Champion's Rune effect — always on",
      sub: "Skip battles against enemies weaker than your party, for the whole party, without " +
           "equipping the rune. Strong parties get near-total peace; weaker parties still fight. " +
           "This is the game's own Champion's Rune behaviour — softer than turning battles off.",
      subSum: "Skip battles against enemies weaker than your party, without equipping the rune.",
      off: 0x10E610, len: 4,
      onBytes: [0x00, 0x00, 0x00, 0x00],             // nop the "does anyone have the Champion's Rune?" branch
      offBytes: [0x09, 0x00, 0x80, 0x12],            // beqz s4, 0x2D5E38 (stock)
      sig: (b) => (b[0] === 0x09 && b[1] === 0x00 && b[2] === 0x80 && b[3] === 0x12) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00),
      read: (dv) => dv.getUint32(0, true) === 0 ? 1 : 0,
      write: (dv, on) => { (on ? [0, 0, 0, 0] : [0x09, 0x00, 0x80, 0x12]).forEach((v, i) => dv.setUint8(i, v)); },
    },
    {
      key: "noBattles", view: "encounter", group: "Random encounters", type: "bool",
      label: "Turn off random battles completely",
      sub: "No random encounters anywhere — stronger than the Champion's Rune, which only stops " +
           "battles with weaker enemies. For fewer (not zero) battles, lower the rate instead; for " +
           "the Champion's Rune's selective effect, equip it in the Save Editor. Scripted story " +
           "fights still happen.",
      subSum: "No random encounters anywhere — stronger than the Champion's Rune. Story fights still happen.",
      off: 0x10E484, len: 4,
      onBytes: [0x00, 0x00, 0x02, 0x24],              // li v0, 0  (force gate = no encounter)
      offBytes: [0x5C, 0x57, 0x0B, 0x0C],             // jal 0x2D5D70 (stock)
      sig: (b) => (b[0] === 0x5C && b[1] === 0x57 && b[2] === 0x0B && b[3] === 0x0C) ||
                  (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x02 && b[3] === 0x24),
      read: (dv) => dv.getUint8(3) === 0x24 && dv.getUint8(0) === 0x00 ? 1 : 0,
      write: (dv, on) => { (on ? [0x00, 0x00, 0x02, 0x24] : [0x5C, 0x57, 0x0B, 0x0C]).forEach((v, i) => dv.setUint8(i, v)); },
    },
  ];

  // ---- capability detection ---------------------------------------------------
  const SUPPORTS_FS = typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
  const CAN_TRANSFER_STREAM = (() => {
    try { const rs = new ReadableStream(); new MessageChannel().port1.postMessage(rs, [rs]); return true; }
    catch (e) { return false; }
  })();
  const CAN_STREAM_SAVE = typeof navigator !== "undefined" && "serviceWorker" in navigator && CAN_TRANSFER_STREAM;

  // ---- state ------------------------------------------------------------------
  let isoHandle = null, isoName = "", isoFile = null;
  let WINDOWS = {};        // key -> {off, len, buf, orig, dv, odv}
  // Undo journal (#3). Entries carry the affected window's bytes before and after the write, so
  // undo is a byte restore rather than a recomputation — exact even for derived displays like the
  // encounter-rate percentage, which is a division of the stored threshold.
  const JOURNAL = S4Core.createJournal({ onChange: () => refreshUndoButtons() });
  let inited = false, saveNudged = false;

  const win = (k) => WINDOWS[k];
  const fmtSize = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
  const fmtDur = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
  const setStatus = (m, k) => { const el = $("#isoStatus"); if (el) { el.textContent = m; el.className = "status" + (k ? " " + k : ""); } };
  const setBoot = (m, err) => { const el = $("#isoBoot"); if (el) el.innerHTML = (err ? "⚠ " : "") + esc(m); };

  function fieldValue(f, from) { return f.read(new DataView(from.buffer, from.byteOffset, from.length)); }
  function isDirty(k) { const w = win(k); return w && w.buf.some((b, i) => b !== w.orig[i]); }
  function anyDirty() { return Object.keys(WINDOWS).some(isDirty) || Object.keys(TEXT_EDITS).length > 0; }
  // absolute-offset changed runs across all windows
  // Byte runs from the in-ELF text editor (#21). These do NOT live in WINDOWS — the ELF is a
  // separate 3.2 MB read — so they have to be folded in here explicitly, or an edit made on the
  // Text tab would be collected and then silently dropped on save.
  //
  // A shorter replacement is NUL-terminated rather than space-padded: the engine reads these as
  // C strings, so the terminator is what actually shortens it, and the bytes past it are left
  // alone rather than blanked (nothing reads them, and rewriting them would enlarge the diff).
  function textRuns() {
    const out = [];
    if (!ELF || !TEXTS) return out;
    for (const [offStr, val] of Object.entries(TEXT_EDITS)) {
      const off = +offStr;
      const t = TEXTS.find((x) => x.off === off);
      if (!t) continue;
      const at = off - ELF_OFF;
      const bytes = new Uint8Array(t.max);
      bytes.set(ELF.subarray(at, at + t.max));
      const enc = [...val].map((c) => c.charCodeAt(0) & 0x7F).slice(0, t.max);
      bytes.set(enc, 0);
      if (enc.length < t.max) bytes[enc.length] = 0;
      // Emit only the bytes that actually differ, same as every other run.
      let i = 0;
      while (i < t.max) {
        if (bytes[i] !== ELF[at + i]) {
          const st = i;
          while (i < t.max && bytes[i] !== ELF[at + i]) i++;
          out.push({ off: off + st, bytes: bytes.slice(st, i) });
        } else i++;
      }
    }
    return out;
  }

  function allRuns() {
    const out = textRuns();
    for (const k in WINDOWS) {
      const w = WINDOWS[k]; let i = 0;
      while (i < w.len) {
        if (w.buf[i] !== w.orig[i]) { const s = i; while (i < w.len && w.buf[i] !== w.orig[i]) i++; out.push({ off: w.off + s, bytes: w.buf.slice(s, i) }); }
        else i++;
      }
    }
    return out;
  }

  // ---- load -------------------------------------------------------------------
  async function openViaPicker() {
    let handle;
    try { [handle] = await window.showOpenFilePicker({ multiple: false }); }
    catch (e) { if (e && e.name !== "AbortError") setStatus("Could not open ISO: " + e.message, "err"); return; }
    try { await commitIso(await handle.getFile(), handle); }
    catch (e) { setStatus("Could not read that file: " + e.message, "err"); }
  }
  async function loadInput(file) { return commitIso(file, null); }

  async function detectRegion(file) {
    try {
      const cnf = new TextDecoder().decode(await file.slice(SYSTEM_CNF_LBA * 2048, SYSTEM_CNF_LBA * 2048 + 128).arrayBuffer());
      const m = /BOOT2\s*=\s*cdrom0:\\([A-Z]{4})_(\d{3})\.(\d{2})/i.exec(cnf);
      if (!m) return null;
      return `${m[1].toUpperCase()}-${m[2]}.${m[3]}`;
    } catch (e) { return null; }
  }

  // Any path that declines to load must also clear what the PREVIOUS disc left on screen —
  // otherwise the old disc's fields stay visible and editable under a message saying this one
  // can't be edited, which is the worst of both.
  // #isoStatus lives inside #isoEditor, so a message printed after clearIso() would have nowhere
  // to render. Anything explaining why a disc was declined goes to the loader message instead,
  // which sits in the (always-present) loader card.
  const declineMsg = (m) => { setBoot(m, true); setStatus(m, "err"); };

  function clearIso() {
    WINDOWS = {}; isoHandle = null; isoFile = null;
    ELF = null; TEXTS = null; TEXT_EDITS = {};
    JOURNAL.reset();
    const ed = $("#isoEditor"); if (ed) ed.innerHTML = "";
  }

  async function commitIso(file, handle) {
    setStatus("Reading disc region…", "");
    const serial = await detectRegion(file);
    if (serial && !REGIONS[serial]) {
      clearIso();
      return declineMsg(`That disc is ${serial}, which isn't a Suikoden IV release this editor knows. ` +
        `Supported: ${Object.entries(REGIONS).map(([k, v]) => `${k} (${v.label})`).join(", ")}.`);
    }
    REGION = serial || "SLUS-209.79";
    const usable = availableFields(REGION);
    if (!usable.length) {
      clearIso();
      return declineMsg(`This is the ${REGIONS[REGION].label} release (${REGION}). Its save files are ` +
        `fully supported — but no disc offsets have been located for it yet, so there is nothing ` +
        `to edit here. See issue #18.`);
    }
    const maxOff = usable.reduce((a, f) => Math.max(a, offFor(f, REGION) + f.len), 0);
    if (file.size < maxOff) { clearIso(); return declineMsg(`That file is only ${fmtSize(file.size)} — not a full Suikoden IV ISO.`); }
    const wins = {};
    for (const f of usable) {
      const fo = offFor(f, REGION);
      let bytes;
      try { bytes = new Uint8Array(await file.slice(fo, fo + f.len).arrayBuffer()); }
      catch (e) { return setStatus("Read failed: " + e.message, "err"); }
      if (bytes.length !== f.len) return setStatus("Could not read the disc region (file too short).", "err");
      if (f.sig && !f.sig(bytes)) {
        clearIso();
        return declineMsg(`This doesn't look like the ${REGIONS[REGION].label} (${REGION}) Suikoden IV ISO ` +
          `— unexpected bytes at 0x${fo.toString(16).toUpperCase()}. It may be a different revision.`);
      }
      wins[f.key] = { off: fo, len: f.len, buf: bytes, orig: bytes.slice(), dv: new DataView(bytes.buffer), odv: new DataView(bytes.slice().buffer) };
    }
    WINDOWS = wins; isoHandle = handle; isoFile = file; isoName = file.name || "Suikoden IV.iso";
    JOURNAL.reset();                      // a newly opened disc has no history to unwind
    ELF = null; TEXTS = null; TEXT_EDITS = {};   // …and no text read from the previous one
    saveNudged = false;
    if (handle) idbSet("lastIso", { name: isoName, handle, at: Date.now() }).catch(() => {});
    render();
    const hidden = unavailableFields(REGION);
    setStatus(`Loaded ${isoName} — ${REGIONS[REGION].label} (${REGION}) verified.`
      + (hidden.length ? ` ${hidden.length} field${hidden.length === 1 ? "" : " is"} unavailable on this release.` : ""), "ok");
  }

  function saveMode() {
    if (SUPPORTS_FS && isoHandle) return "inplace";
    if (CAN_STREAM_SAVE && isoFile) return "stream";
    return "none";
  }

  // ---- last-opened (persist the HANDLE only; never the 4 GB bytes) ------------
  async function showRecent() {
    const el = $("#isoRecent"); if (!el) return;
    let rec; try { rec = await idbGet("lastIso"); } catch (e) { return; }
    if (!rec || !rec.handle) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="recent">Last opened:
        <button class="chip" id="isoReopen">↻ ${esc(rec.name)}</button>
        <button class="chip mini" id="isoForget" title="forget">✕</button></div>`;
    $("#isoReopen").onclick = async () => {
      try {
        const opts = { mode: "readwrite" };
        if ((await rec.handle.queryPermission(opts)) !== "granted" && (await rec.handle.requestPermission(opts)) !== "granted")
          return setStatus("Reopen cancelled — permission denied.", "warn");
        await commitIso(await rec.handle.getFile(), rec.handle);
      } catch (e) { setStatus("Could not reopen — pick the file again.", "err"); }
    };
    $("#isoForget").onclick = async () => { await idbDel("lastIso").catch(() => {}); el.innerHTML = ""; };
  }

  // ---- render -----------------------------------------------------------------
  function init() {
    if (inited) return;
    inited = true;
    const root = $("#isoRoot");
    root.innerHTML = `
      <div class="card" id="isoLoader">
        <h2>1 · Open ISO</h2>
        ${SUPPORTS_FS || CAN_STREAM_SAVE ? "" :
          `<div class="warnbox">This browser can't write a 4 GB ISO. Use desktop Chrome/Edge/Brave/Opera
            (edit in place) or Android Chrome/Firefox (streams a patched copy). You can still open an ISO
            here to read values, and copy the pnach line below.</div>`}
        <div class="drop" id="isoDrop">
          <div><b>Drop your Suikoden IV ISO here</b> or</div>
          <label class="file"><button type="button" id="isoPick">Choose ISO…</button>
            <input type="file" id="isoFileInput"></label>
          <div class="muted" id="isoBoot" style="margin-top:8px">NTSC-U (SLUS-209.79) only. Nothing is uploaded — the disc is read on your device.</div>
        </div>
        <div id="isoRecent"></div>
      </div>
      <div id="isoEditor"></div>`;
    $("#isoPick").onclick = () => (SUPPORTS_FS ? openViaPicker() : $("#isoFileInput").click());
    $("#isoFileInput").onchange = (e) => { if (e.target.files[0]) loadInput(e.target.files[0]); };
    const drop = $("#isoDrop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
    drop.addEventListener("drop", async (e) => {
      const item = e.dataTransfer.items && e.dataTransfer.items[0];
      if (SUPPORTS_FS && item && item.getAsFileSystemHandle) {
        try { const h = await item.getAsFileSystemHandle(); if (h && h.kind === "file") return commitIso(await h.getFile(), h); } catch (err) {}
      }
      const f = e.dataTransfer.files[0]; if (f) loadInput(f);
    });
    showRecent();
  }

  // ---- tab shell -----------------------------------------------------------
  // Adding an editor surface is one VIEWS entry plus one draw(host) function — the shell is
  // deliberately trivial so the cost of a new tab is the editor, not the plumbing. Eight issues
  // (#19 #20 #21 #23–#30) are queued behind this, so it exists before the first of them rather
  // than being retrofitted after the third.
  //
  // The save/apply toolbar lives OUTSIDE the tab host on purpose: edits staged across several
  // tabs belong to one disc, so they review and apply together as a single change set.
  const VIEWS = [
    ["encounter", "Encounters", drawEncounters],
    ["changes", "Changes", drawChanges],
    ["text", "Text", drawText],
    ["files", "Files", drawFiles],
  ];
  const VIEW_KEY = "s4editor-iso-view";
  let VIEW = (() => { try { return localStorage.getItem(VIEW_KEY) || VIEWS[0][0]; } catch (e) { return VIEWS[0][0]; } })();
  if (!VIEWS.some(([k]) => k === VIEW)) VIEW = VIEWS[0][0];   // a tab removed since last visit

  function render() {
    if (!Object.keys(WINDOWS).length) return;
    const mode = saveMode();
    const modeNote = mode === "inplace" ? "edits write in place to your ISO"
      : mode === "stream" ? "saving streams a patched copy to your downloads"
      : "this browser can't write the ISO — copy the pnach line instead";

    $("#isoEditor").innerHTML = `
      <div class="card"><div class="subtabs" id="isoViews"></div></div>
      <div id="isoViewHost"></div>
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <button class="chip" id="isoPnach">⧉ Copy pnach line</button>
          <button class="chip" id="isoModOut" title="A tiny, reversible, version-checked recipe of exactly these byte changes">⬇ .s4mod</button>
          <button class="chip" id="isoXdOut" title="A standard VCDIFF patch — xdelta3 -d -s &lt;pristine&gt; &lt;patch&gt; &lt;out&gt;">⬇ .xdelta</button>
          <label class="chip" id="isoModInLabel" style="cursor:pointer" title="Apply a .s4mod or .xdelta — staged for review, never written directly">⬆ Apply patch…
            <input type="file" id="isoModIn" accept=".s4mod,.xdelta,.json,application/json" style="display:none"></label>
          <span class="muted">${esc(isoName)} · ${esc(modeNote)}</span>
        </div>
        <div class="toolbar">
          ${mode === "none"
            ? `<span class="status warn">Open on desktop Chromium or Android Chrome to write the ISO. Meanwhile, use “Copy pnach line”.</span>`
            : `<button class="primary" id="isoSave">${mode === "stream" ? "Save patched copy" : "Save to ISO"}</button>
               <button id="isoUndo" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo">↶</button>
               <button id="isoRedo" title="Redo (Shift+Ctrl/Cmd+Z)" aria-label="Redo">↷</button>
               <button id="isoReset" title="Drop every staged edit — undoable">Revert all</button>
               <span class="status" id="isoStatus"></span>`}
        </div>
      </div>`;

    const sv = $("#isoSave"); if (sv) sv.onclick = save;
    const rs = $("#isoReset"); if (rs) rs.onclick = () => {
      // Reset is itself undoable — it is the single most destructive button here.
      const before = {}, after = {};
      for (const k in WINDOWS) { before[k] = WINDOWS[k].buf.slice(); after[k] = WINDOWS[k].orig.slice(); }
      if (!anyDirty()) return;
      for (const k in WINDOWS) WINDOWS[k].buf.set(WINDOWS[k].orig);
      JOURNAL.record({
        label: "Revert all",
        undo: () => { for (const k in before) WINDOWS[k].buf.set(before[k]); drawView(); },
        redo: () => { for (const k in after) WINDOWS[k].buf.set(after[k]); drawView(); },
      });
      drawView();
    };
    const uu = $("#isoUndo"); if (uu) uu.onclick = () => JOURNAL.undo();
    const ur = $("#isoRedo"); if (ur) ur.onclick = () => JOURNAL.redo();
    refreshUndoButtons();
    $("#isoPnach").onclick = copyPnach;
    $("#isoModOut").onclick = exportRecipe;
    $("#isoXdOut").onclick = exportXdelta;
    $("#isoModIn").onchange = (e) => { const f = e.target.files[0]; if (f) importPatch(f); e.target.value = ""; };
    drawView();
  }

  // Re-renders the tab strip and the active tab only. Staged edits live in WINDOWS[].buf, which
  // this never touches, so switching tabs cannot lose one — and because fieldHtml reads from the
  // buffer and re-applies .dirty, a staged edit still *looks* staged when you come back to it.
  function drawView() {
    const v = VIEWS.find(([k]) => k === VIEW) || VIEWS[0];

    refreshViewTabs();

    const host = $("#isoViewHost");
    host.innerHTML = "";
    v[2](host);
    availableFields().forEach(wireField);   // no-ops for fields the active tab didn't render
    $$("[data-isorevert]").forEach((b) => (b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();   // the ↺ sits inside a <label> — don't toggle it
      revertField(b.dataset.isorevert);
    }));
    syncEnable();
    refreshUndoButtons();
    refreshReverts();
  }

  // The per-tab count of staged edits. Redrawn on every commit as well as on a tab switch —
  // a badge that only refreshed when you changed tabs would under-report the tab you are on,
  // which is the one you are most likely to be looking at.
  function refreshViewTabs() {
    const host = $("#isoViews"); if (!host) return;
    host.innerHTML = VIEWS.map(([k, label]) => {
      const n = availableFields().filter((f) => f.view === k && isDirty(f.key)).length;
      return `<button class="chip${k === VIEW ? " on" : ""}" data-view="${k}" aria-pressed="${k === VIEW}"`
        + `>${esc(label)}${n ? ` <span class="pill on" title="${n} staged edit${n === 1 ? "" : "s"}">${n}</span>` : ""}</button>`;
    }).join("");
    $$("[data-view]").forEach((b) => (b.onclick = () => {
      VIEW = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, VIEW); } catch (e) {}
      drawView();
    }));
  }

  // ---- packed sub-file browser (#32) ---------------------------------------
  //
  // The first user-visible deliverable of the FILEDATA work (#44). S4 has 62,308 packed
  // sub-files across 1,325 archives; a browser turns that from a wall into a worklist, which is
  // what makes further reverse engineering something other people can help with.
  //
  // The index is built from the user's own disc on demand rather than shipped: the archives tile
  // their file exactly, so walking the chain is ~1,325 small reads instead of a 1.1 GB scan, and
  // nothing about the disc has to live in this repo (CLAUDE.md rule 3).
  //
  // DELIBERATELY READ-ONLY, and the tab says so. Everything editable inside these files has (or
  // will have) its own tab; a raw byte editor over tens of thousands of unidentified blobs would
  // be a footgun rather than a feature.
  const FILEDATA = {
    BI1: { lba: 1510597, size: 1074509824 },
    BI2: { lba: 2035260, size: 60162048 },
  };
  let SUBINDEX = null;

  async function buildSubIndex() {
    if (SUBINDEX || !isoFile) return SUBINDEX;
    const out = {};
    for (const [name, meta] of Object.entries(FILEDATA)) {
      const base = meta.lba * 2048;
      const archives = [];
      let cur = 0;
      while (cur < meta.size - 16) {
        const head = new Uint8Array(await isoFile.slice(base + cur, base + cur + FiledataCore.HEADER_LEN).arrayBuffer());
        const h = FiledataCore.parseHeader(head);
        if (!h) break;
        archives.push({ off: cur, total: h.total });
        cur += h.step;
      }
      out[name] = { ...meta, archives };
    }
    SUBINDEX = out;
    return out;
  }

  // Entries are only read when an archive is opened — 62,308 rows at once would be a wall of its
  // own, and the table is on the disc anyway.
  async function archiveEntries(fileName, arc) {
    const base = FILEDATA[fileName].lba * 2048 + arc.off;
    const first = new Uint8Array(await isoFile.slice(base + 0x10, base + 0x20).arrayBuffer());
    const head = FiledataCore.parseEntries(first);
    if (!head || !head.count) return [];              // 0 = a legitimately empty archive
    const tbl = new Uint8Array(await isoFile.slice(base + 0x10, base + 0x10 + FiledataCore.ROW_LEN * head.count).arrayBuffer());
    const parsed = FiledataCore.parseEntries(tbl);
    return parsed ? parsed.entries : [];
  }

  let FILES_SEL = null;      // { file, arcIndex }

  function drawFiles(host) {
    host.innerHTML = `<div class="card"><h3 class="sec">Packed files</h3><p class="muted">Reading the archive index…</p></div>`;
    buildSubIndex().then(() => renderFiles(host)).catch((e) =>
      (host.innerHTML = `<div class="card"><div class="warnbox">Couldn't read the archives: ${esc(e.message)}</div></div>`));
  }

  function renderFiles(host) {
    const tot = Object.values(SUBINDEX).reduce((n, f) => n + f.archives.length, 0);
    host.innerHTML = `<div class="card">
      <h3 class="sec">Packed files</h3>
      <p class="muted" data-sum="A read-only browser over the disc's packed archives. Everything editable inside them has its own tab; a raw byte editor over thousands of unidentified blobs would be a footgun.">
        <b>Read-only, on purpose.</b> Everything editable inside these archives has, or will have,
        its own tab — a raw byte editor over tens of thousands of unidentified blobs would be a
        footgun rather than a feature. This is here so the contents can be <i>looked at</i>:
        anyone can open a blob, peek at it, and report what they find.
        The index is built from your own disc; this app ships none of it.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${Object.entries(SUBINDEX).map(([n, f]) =>
          `<button class="chip${FILES_SEL && FILES_SEL.file === n ? " on" : ""}" data-fdfile="${n}">FILEDATA.${n}
             <span class="pill">${f.archives.length}</span></button>`).join("")}
        <span class="muted">${tot} archives</span>
      </div>
      <div id="fdBody" style="margin-top:10px"></div></div>`;
    $$("[data-fdfile]").forEach((b) => (b.onclick = () => {
      FILES_SEL = { file: b.dataset.fdfile, arcIndex: null };
      renderFiles(host);
    }));
    if (FILES_SEL) renderArchiveList(host);
  }

  function renderArchiveList(host) {
    const f = SUBINDEX[FILES_SEL.file];
    const body = $("#fdBody");
    body.innerHTML = `<div style="max-height:50vh;overflow:auto">
      <table class="invtbl"><thead><tr><th>#</th><th>Offset in file</th><th>Size</th><th></th></tr></thead><tbody>
      ${f.archives.slice(0, 600).map((a, i) => `<tr>
        <td class="sl">${i}</td>
        <td class="sl">0x${a.off.toString(16).toUpperCase()}</td>
        <td class="sl">${fmtSize(a.total)}</td>
        <td><button type="button" class="chip mini" data-fdarc="${i}">open</button></td></tr>`).join("")}
      </tbody></table></div>
      ${f.archives.length > 600 ? `<div class="muted" style="padding:8px">showing 600 of ${f.archives.length}</div>` : ""}`;
    $$("[data-fdarc]").forEach((b) => (b.onclick = async () => {
      const i = +b.dataset.fdarc;
      const rows = await archiveEntries(FILES_SEL.file, f.archives[i]);
      renderEntries(host, i, rows);
    }));
  }

  function renderEntries(host, arcIndex, rows) {
    const f = SUBINDEX[FILES_SEL.file];
    const arc = f.archives[arcIndex];
    const body = $("#fdBody");
    // `flags` is shown raw. It is NOT understood (#45/#46) and labelling it "compressed" would be
    // asserting something the evidence doesn't support.
    body.innerHTML = `<div class="row" style="gap:8px;margin-bottom:8px">
        <button class="chip mini" id="fdBack">← archives</button>
        <span class="muted">FILEDATA.${esc(FILES_SEL.file)} archive ${arcIndex} @ 0x${arc.off.toString(16).toUpperCase()} — ${rows.length} entries</span></div>
      ${rows.length ? "" : `<div class="muted">This archive is empty — a header sector and nothing else. 15 of BI1's are like this.</div>`}
      <div style="max-height:45vh;overflow:auto">
      <table class="invtbl"><thead><tr><th>id</th><th>flags</th><th>Offset</th><th>Size</th><th></th></tr></thead><tbody>
      ${rows.slice(0, 500).map((r, i) => `<tr>
        <td class="sl">0x${r.id.toString(16).toUpperCase().padStart(4, "0")}</td>
        <td class="sl">${r.flags}</td>
        <td class="sl">0x${r.off.toString(16).toUpperCase()}</td>
        <td class="sl">${fmtSize(r.size)}</td>
        <td><button type="button" class="chip mini" data-fdpeek="${i}">peek</button></td></tr>`).join("")}
      </tbody></table></div>
      <div id="fdPeek"></div>`;
    $("#fdBack").onclick = () => renderArchiveList(host);
    $$("[data-fdpeek]").forEach((b) => (b.onclick = async () => {
      const r = rows[+b.dataset.fdpeek];
      const at = f.lba * 2048 + arc.off + r.off;
      const buf = new Uint8Array(await isoFile.slice(at, at + 256).arrayBuffer());
      $("#fdPeek").innerHTML = `<div class="card" style="margin-top:10px">
        <h4>id 0x${r.id.toString(16).toUpperCase()} — first ${buf.length} bytes</h4>
        <pre class="hexdump">${esc(hexdump(buf, r.off))}</pre></div>`;
    }));
  }

  function hexdump(bytes, base) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = [...bytes.slice(i, i + 16)];
      const hex = row.map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
      const asc = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      out.push(`${(base + i).toString(16).toUpperCase().padStart(8, "0")}  ${hex}  ${asc}`);
    }
    return out.join("\n");
  }

  // ---- in-ELF text (#21) ---------------------------------------------------
  //
  // Scope, measured rather than assumed (see text-core.js): the boot ELF holds the engine's own
  // memory-card and save/load messages as printable ASCII, alongside a lot of developer strings.
  // Item, character and rune names are NOT here — they are packed in FILEDATA (#31).
  //
  // Every edit is capped to the run's original byte length. Growing a string would mean
  // repointing every reference to it, which this editor cannot do, so a longer value is refused
  // rather than truncated.
  let ELF = null, TEXTS = null, TEXT_EDITS = {};   // off -> string
  // The boot ELF's position is part of the release, so it comes from the region table.
  const elfOff = () => (REGIONS[REGION].elfLba || 0) * 2048;
  const elfLen = () => REGIONS[REGION].elfLen || 0;
  let ELF_OFF = 367 * 2048;

  async function loadElf() {
    if (ELF || !isoFile) return ELF;
    if (!elfLen()) throw new Error(`The boot ELF hasn't been located for ${REGIONS[REGION].label} (${REGION}) — see issue #18.`);
    ELF_OFF = elfOff();
    ELF = new Uint8Array(await isoFile.slice(ELF_OFF, ELF_OFF + elfLen()).arrayBuffer());
    TEXTS = TextCore.scanStrings(ELF, ELF_OFF);
    return ELF;
  }

  const readText = (t) => {
    if (t.off in TEXT_EDITS) return TEXT_EDITS[t.off];
    let s = "";
    for (let i = 0; i < t.max; i++) s += String.fromCharCode(ELF[t.off - ELF_OFF + i]);
    return s;
  };

  function drawText(host) {
    host.innerHTML = `<div class="card"><h3 class="sec">Text in the boot ELF</h3>
      <p class="muted">Reading the executable…</p></div>`;
    loadElf().then(() => renderTextList(host)).catch((e) =>
      (host.innerHTML = `<div class="card"><div class="warnbox">Couldn't read the executable: ${esc(e.message)}</div></div>`));
  }

  function renderTextList(host, filter) {
    const q = (filter || "").toLowerCase();
    const rows = TEXTS.map((t) => ({ t, s: readText(t) }))
                      .filter((r) => !q || r.s.toLowerCase().includes(q));
    host.innerHTML = `<div class="card">
      <h3 class="sec">Text in the boot ELF</h3>
      <p class="muted" data-sum="The engine's own memory-card and save/load messages. Item, character and rune names are not here — they are packed in FILEDATA.">
        These are strings stored as printable ASCII in the boot executable: the engine's own
        memory-card and save/load messages, plus a lot of developer and error text. <b>Item,
        character and rune names are not here</b> — those are packed inside FILEDATA (issue #31),
        which is why the reference tables had to be extracted from a cheat table. Each edit is
        capped to the original byte length, because growing a string would mean repointing every
        reference to it.</p>
      <input class="search" id="txq" placeholder="filter ${TEXTS.length} strings…" value="${esc(filter || "")}">
      <div style="max-height:60vh;overflow:auto">
      <table class="invtbl"><thead><tr><th>Address</th><th>Text</th><th>Max</th></tr></thead><tbody>
      ${rows.slice(0, 400).map(({ t, s }) => `<tr${t.off in TEXT_EDITS ? ' class="dirtyrow"' : ""}>
        <td class="sl">0x${t.off.toString(16).toUpperCase()}</td>
        <td><input type="text" data-txt="${t.off}" maxlength="${t.max}" value="${esc(s)}" style="width:100%"></td>
        <td class="sl">${t.max}</td></tr>`).join("")}
      </tbody></table></div>
      ${rows.length > 400 ? `<div class="muted" style="padding:8px">showing 400 of ${rows.length} — keep typing</div>` : ""}
      <div class="muted" style="padding:8px 0 0">${TEXTS.length} strings found${q ? `, ${rows.length} matching` : ""}.</div>
    </div>`;
    const sq = $("#txq");
    sq.oninput = () => { const v = sq.value; renderTextList(host, v); const n = $("#txq"); n.focus(); n.setSelectionRange(v.length, v.length); };
    $$("[data-txt]").forEach((el) => (el.onchange = () => {
      const off = +el.dataset.txt;
      const t = TEXTS.find((x) => x.off === off);
      if (el.value.length > t.max) { el.value = el.value.slice(0, t.max); }
      TEXT_EDITS[off] = el.value;
      el.classList.add("dirty");
      setStatus(`Staged "${el.value}" at 0x${off.toString(16).toUpperCase()} (max ${t.max} bytes).`, "");
    }));
  }

  // ---- Changes (#20 Half B) ------------------------------------------------
  //
  // Every other view reports what YOU staged this session — the review list is built as you edit,
  // so it is a history, not a map. Open a disc somebody patched last month and the editor has
  // nothing to say about it. This answers that instead.
  //
  // Half B only, and it needs no second file: every code patch this editor makes replaces a
  // DOCUMENTED word, so `offBytes` already records what stock looked like. Half A (diffing
  // against a pristine copy, decoded field by field) waits for #31 and a field map worth joining
  // against.
  //
  // A field with no documented stock bytes is reported as "can't tell" rather than assumed
  // stock — the encounter rate is a value, not a code patch, so there is no single stock word
  // to compare it to and saying otherwise would be inventing a verdict (rule 1).
  function discState(f) {
    const w = win(f.key);
    if (!w) return { state: "unknown" };
    if (!f.offBytes) return { state: "notcode" };
    const isStock = f.offBytes.every((b, i) => b === w.orig[i]);
    const isPatched = f.onBytes && f.onBytes.every((b, i) => b === w.orig[i]);
    return { state: isStock ? "stock" : isPatched ? "patched" : "unrecognised", w };
  }

  function drawChanges(host) {
    const rows = availableFields().map((f) => ({ f, ...discState(f) }));
    const nonStock = rows.filter((r) => r.state === "patched" || r.state === "unrecognised");
    const hexOf = (a) => [...a].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

    host.innerHTML = `<div class="card">
      <h3 class="sec">What is on this disc</h3>
      <p class="muted" data-sum="Compares the disc you opened against the stock bytes this editor documents — so a disc patched months ago can still be read, with no pristine copy needed.">
        This compares the disc you opened against the stock instruction words recorded for each
        patch site, so a disc somebody patched months ago can be read back with no pristine copy
        involved. It describes the disc as loaded, not the edits staged in this session.</p>
      ${nonStock.length
        ? `<div class="warnbox"><b>${nonStock.length} site${nonStock.length === 1 ? " is" : "s are"} not stock.</b>
             This disc has been modified.</div>`
        : `<div class="muted">Every documented patch site on this disc reads stock.</div>`}
      <table class="invtbl"><thead><tr><th>Site</th><th>Address</th><th>On this disc</th><th></th></tr></thead><tbody>
      ${rows.map((r) => {
        const label = { stock: "stock", patched: "patched by this editor",
                        unrecognised: "modified — not a shape this editor makes",
                        notcode: "value field — no single stock word to compare",
                        unknown: "not loaded" }[r.state];
        const cls = r.state === "stock" ? "" : r.state === "notcode" ? "muted" : "dirtyrow";
        // This column describes the disc AS LOADED, deliberately — it is a map, not a history.
        // But a staged restore has to be visible here or clicking "Restore all to stock" looks
        // like it did nothing, so the pending change is shown alongside rather than replacing it.
        const staging = isDirty(r.f.key)
          ? `<div class="muted" style="font-size:11px">staged: → ${hexOf(r.w.buf)}</div>` : "";
        return `<tr class="${cls}">
          <td>${esc(r.f.label)}</td>
          <td class="sl">0x${r.f.off.toString(16).toUpperCase()}</td>
          <td>${esc(label)}${r.w && r.state !== "notcode" ? `<div class="muted" style="font-size:11px">${hexOf(r.w.orig)}</div>` : ""}${staging}</td>
          <td>${(r.state === "patched" || r.state === "unrecognised")
                ? `<button type="button" class="chip mini" data-stock="${r.f.key}"${isDirty(r.f.key) ? " disabled" : ""}>${isDirty(r.f.key) ? "restore staged" : "↺ restore stock"}</button>` : ""}</td>
        </tr>`;
      }).join("")}
      </tbody></table>
      ${nonStock.length ? `<div class="toolbar" style="position:static;border:0;box-shadow:none;padding:10px 0 0">
          <button id="isoStockAll">Restore all to stock</button></div>` : ""}
    </div>`;

    $$("[data-stock]").forEach((b) => (b.onclick = () => restoreStock([b.dataset.stock])));
    const all = $("#isoStockAll");
    if (all) all.onclick = () => restoreStock(nonStock.map((r) => r.f.key));
  }

  // Restoring STAGES, like everything else — the review sheet is not optional here either.
  function restoreStock(keys) {
    const before = {}, touched = [];
    for (const k in WINDOWS) before[k] = WINDOWS[k].buf.slice();
    for (const key of keys) {
      const f = FIELDS.find((x) => x.key === key);
      const w = win(key);
      if (!f || !w || !f.offBytes) continue;
      w.buf.set(f.offBytes, 0);
      touched.push(f.label);
    }
    if (!touched.length) return setStatus("Nothing to restore.", "warn");
    const after = {};
    for (const k in WINDOWS) after[k] = WINDOWS[k].buf.slice();
    JOURNAL.record({
      label: `Restore ${touched.length} site${touched.length === 1 ? "" : "s"} to stock`,
      undo: () => { for (const k in before) WINDOWS[k].buf.set(before[k]); drawView(); },
      redo: () => { for (const k in after) WINDOWS[k].buf.set(after[k]); drawView(); },
    });
    drawView();
    setStatus(`Staged a restore of ${touched.join(", ")} — review and save.`, "ok");
  }

  function refreshUndoButtons() {
    const u = $("#isoUndo"), r = $("#isoRedo");
    if (u) { u.disabled = !JOURNAL.canUndo(); u.title = JOURNAL.canUndo() ? `Undo ${JOURNAL.undoLabel()} (Ctrl/Cmd+Z)` : "Nothing to undo"; }
    if (r) { r.disabled = !JOURNAL.canRedo(); r.title = JOURNAL.canRedo() ? `Redo ${JOURNAL.redoLabel()} (Shift+Ctrl/Cmd+Z)` : "Nothing to redo"; }
  }

  function drawEncounters(host) {
    const groups = {};
    availableFields().filter((f) => f.view === "encounter").forEach((f) => (groups[f.group] = groups[f.group] || []).push(f));
    const hidden = unavailableFields().filter((f) => f.view === "encounter");
    host.innerHTML = Object.entries(groups).map(([g, fs]) => {
      const vals = fs.filter((f) => f.type !== "bool"), bools = fs.filter((f) => f.type === "bool");
      return `<div class="card"><h3 class="sec">${esc(g)}</h3>
        ${vals.length ? `<div class="isovals">${vals.map(fieldHtml).join("")}</div>` : ""}
        ${bools.length ? `<div class="isotoggles">${bools.map(fieldHtml).join("")}</div>` : ""}
      </div>`;
    }).join("")
    // Hidden, with the reason — not silently missing. A user on a release we haven't mapped
    // should be told that, and told it is a gap rather than a decision.
    + (hidden.length ? `<div class="card"><h3 class="sec">Not available on this release</h3>
        <p class="muted">${hidden.map((f) => esc(f.label)).join(", ")} — the offsets for
        ${esc(REGIONS[REGION].label)} (${esc(REGION)}) haven't been located yet. The patch shapes are
        known, so this is a pattern search rather than fresh reverse engineering; see issue #18.</p></div>` : "");
  }

  const revBtn = (f) =>
    `<button type="button" class="revert" data-isorevert="${f.key}" title="Restore this field to the bytes on the disc" aria-label="Restore this field">↺</button>`;

  // Restore one field to the bytes the disc was loaded with. A byte copy from the window's own
  // `orig`, not a recomputation — so a derived display like the encounter-rate percentage comes
  // back exactly, including a stock value that doesn't divide cleanly into 10000.
  function revertField(key) {
    const w = win(key); if (!w || !isDirty(key)) return;
    const before = w.buf.slice(), after = w.orig.slice();
    w.buf.set(w.orig);
    JOURNAL.record({
      label: `Restore ${(FIELDS.find((f) => f.key === key) || {}).label || key}`,
      undo: () => { w.buf.set(before); drawView(); },
      redo: () => { w.buf.set(after); drawView(); },
    });
    drawView();
  }

  // Keeps every ↺ in step with its field after an edit, without a full repaint.
  function refreshReverts() {
    FIELDS.forEach((f) => {
      const wrap = document.querySelector(`[data-fieldwrap="${f.key}"]`) ||
                   document.querySelector(`[data-iso="${f.key}"]`)?.closest(".isotoggle");
      if (wrap) wrap.classList.toggle("has-dirty", isDirty(f.key));
    });
  }

  function fieldHtml(f) {
    const w = win(f.key); const cur = f.read(w.dv);
    if (f.type === "bool") {
      return `<label class="isotoggle${isDirty(f.key) ? " has-dirty" : ""}"><input type="checkbox" data-iso="${f.key}" ${cur ? "checked" : ""}${isDirty(f.key) ? ' class="dirty"' : ""}>
          <span class="isotxt"><b>${esc(f.label)}</b>${revBtn(f)}${f.sub ? `<span class="isosub" data-sum="${esc(f.subSum || "")}">${esc(f.sub)}</span>` : ""}</span></label>`;
    }
    const presets = (f.presets || []).map(([lbl, v]) =>
      `<button type="button" class="chip mini" data-preset="${f.key}" data-pv="${v}"${v === cur ? ' aria-pressed="true"' : ""}>${esc(lbl)}</button>`).join("");
    const sl = f.slider;
    const sliderHtml = sl
      ? `<input type="range" class="rateslider" data-rateslider="${f.key}" min="${sl[0]}" max="${sl[1]}" step="${sl[2] || 1}" value="${Math.min(sl[1], Math.max(sl[0], cur))}" aria-label="${esc(f.label)}">` : "";
    return `<div class="field ratefield${isDirty(f.key) ? " has-dirty" : ""}" data-fieldwrap="${f.key}"><span>${esc(f.label)} <span class="muted">(${esc(f.unit || "")})</span>${revBtn(f)}</span>
        ${presets ? `<div class="presetrow">${presets}</div>` : ""}
        <div class="raterow">
          ${sliderHtml}
          <input type="number" min="${f.min || 0}" max="${f.max || 999999}" value="${cur}" data-iso="${f.key}" data-def="${cur}" class="rateinput${isDirty(f.key) ? " dirty" : ""}">
          <span class="ratetag" data-ratetag="${f.key}">${esc(rateTag(cur))}</span>
        </div>
        ${f.hint ? `<div class="fnote ratefnote" data-sum="${esc(f.hintSum || "")}">${esc(f.hint)}</div>` : ""}</div>`;
  }
  // friendly readout of a percent, e.g. 50 -> "≈ ½× the battles", 200 -> "≈ 2× the battles"
  function rateTag(p) {
    p = +p || 0; if (!p) return "";
    if (p === 100) return "= the game's normal rate";
    const FR = { 50: "½", 25: "¼", 20: "⅕", 10: "1/10" };
    const s = p < 100 ? (FR[p] || "1/" + Math.round(100 / p)) : (Number.isInteger(p / 100) ? p / 100 : (p / 100).toFixed(1)) + "×";
    return `≈ ${s} the battles`;
  }

  function wireField(f) {
    const el = document.querySelector(`[data-iso="${f.key}"]`); if (!el) return;
    const w = win(f.key);
    const sliders = () => document.querySelectorAll(`[data-rateslider="${f.key}"]`);
    // light up the preset chip that matches the current value (if any)
    const highlight = () => document.querySelectorAll(`[data-preset="${f.key}"]`).forEach((b) => {
      if (+b.dataset.pv === (+el.value || 0)) b.setAttribute("aria-pressed", "true"); else b.removeAttribute("aria-pressed");
    });
    // slider, number box, and presets all funnel through this one commit
    const commit = () => {
      const before = w.buf.slice();
      if (f.type === "bool") f.write(w.dv, el.checked ? 1 : 0);
      else f.write(w.dv, +el.value || f.def);
      if (before.some((b, i) => b !== w.buf[i])) {
        const after = w.buf.slice();
        JOURNAL.record({
          key: f.key, label: f.label,
          undo: () => { w.buf.set(before); drawView(); },
          redo: () => { w.buf.set(after); drawView(); },
        });
      }
      el.classList && el.classList.toggle("dirty", isDirty(f.key));
      const tag = document.querySelector(`[data-ratetag="${f.key}"]`);
      if (tag) tag.textContent = rateTag(el.value);
      sliders().forEach((sl) => { const v = Math.min(+sl.max, Math.max(+sl.min, +el.value || 0)); if (+sl.value !== v) sl.value = v; });
      if (f.type !== "bool") highlight();
      syncEnable();
      refreshViewTabs();
      refreshReverts();
    };
    el.onchange = el.oninput = commit;
    el.onblur = () => JOURNAL.seal();     // two visits to one box are two edits, however fast
    sliders().forEach((sl) => (sl.oninput = () => { el.value = sl.value; commit(); }));
    document.querySelectorAll(`[data-preset="${f.key}"]`).forEach((b) => (b.onclick = () => { el.value = b.dataset.pv; commit(); }));
  }

  // When "turn off random battles" is on, the rate and the Champion toggle are moot — grey them.
  function syncEnable() {
    const cb = document.querySelector('[data-iso="noBattles"]');
    const off = !!(cb && cb.checked);
    const wrap = document.querySelector('[data-fieldwrap="encounterRate"]');
    if (wrap) {
      wrap.classList.toggle("disabled", off);
      wrap.querySelectorAll("input,button").forEach((el) => (el.disabled = off));
      let note = wrap.querySelector(".isonote");
      if (off && !note) { note = document.createElement("div"); note.className = "fnote isonote"; note.textContent = "Ignored — all random battles are off."; wrap.appendChild(note); }
      else if (!off && note) note.remove();
    }
    const champ = document.querySelector('[data-iso="championAlways"]');
    if (champ) { const row = champ.closest(".isotoggle"); if (row) row.classList.toggle("disabled", off); champ.disabled = off; }
  }

  // ---- review + save ----------------------------------------------------------
  // ISO file offset → EE RAM virtual address (for pnach codes): the boot ELF's PT_LOAD segment
  // maps file 0x1000 → vaddr 0x280000, so vaddr = 0x280000 + (isoOff - ELF_START - 0x1000).
  const isoToVaddr = (off) => 0x280000 + (off - ISO_ELF_START - 0x1000);

  function textReviewRows() {
    if (!ELF || !TEXTS) return [];
    const rows = [];
    for (const [offStr, val] of Object.entries(TEXT_EDITS)) {
      const off = +offStr;
      const t = TEXTS.find((x) => x.off === off); if (!t) continue;
      let was = "";
      for (let i = 0; i < t.max; i++) was += String.fromCharCode(ELF[off - ELF_OFF + i]);
      if (was !== val) rows.push({ g: "Text", t: `0x${off.toString(16).toUpperCase()}: "${was.trim()}" → "${val.trim()}"` });
    }
    return rows;
  }

  function reviewRows() {
    const rows = [];
    for (const f of availableFields()) {
      if (!isDirty(f.key)) continue;
      const w = win(f.key);
      const ov = f.read(new DataView(w.orig.buffer)), nv = f.read(w.dv);
      const fmt = (x) => f.type === "bool" ? (x ? "on" : "off") : `${x}${f.type === "percent" ? "%" : ""}`;
      rows.push({ g: f.group, t: `${f.label}: ${fmt(ov)} → ${fmt(nv)}` });
    }
    return rows.concat(textReviewRows());
  }

  function save() {
    if (!anyDirty()) return setStatus("No changes to save.", "warn");
    if (saveMode() === "none") return setStatus("This browser can't write the ISO — use “Copy pnach line”.", "warn");
    const rows = reviewRows();
    const label = saveMode() === "stream" ? `Save patched copy (~${fmtSize(isoFile.size)} download)` : `Write to ${isoName}`;
    openConfirm(rows, () => (saveMode() === "stream" ? doStreamSave() : doInPlace()), label);
  }

  async function doInPlace() {
    const runs = allRuns();
    const pg = progressModal();
    try {
      pg.phase("Preparing", `Making a safe copy of ${isoName} before writing… nothing is uploaded, and the original stays intact until this finishes.`, { indet: true });
      const w = await isoHandle.createWritable({ keepExistingData: true });
      let done = 0;
      pg.phase("Writing", `Applying ${runs.length} change(s) in place…`, { pct: 0 });
      for (const r of runs) {
        await w.write({ type: "write", position: r.off, data: r.bytes });
        done++; pg.phase("Writing", `Applying change ${done} of ${runs.length}…`, { pct: (done / runs.length) * 100 });
      }
      pg.phase("Finalizing", "Committing changes to the disc…", { indet: true });
      await w.close();
      markSaved(); render();
      pg.done(`Wrote ${runs.reduce((a, r) => a + r.bytes.length, 0)} byte(s) in place to ${isoName}.`, false);
      setStatus(`Saved — written in place to ${isoName}.`, "ok");
    } catch (e) {
      pg.done("Write failed: " + e.message + ". Your edits are still staged.", true);
      setStatus("Write failed: " + e.message, "err");
    }
  }

  async function doStreamSave() {
    if (!isoFile) return setStatus("The original ISO isn't available — reopen it and try again.", "err");
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller)
      return setStatus("Saving needs the offline helper active — reload the page once, then reopen the ISO and save.", "warn");
    const m = isoName.match(/\.[^.]+$/);
    const outName = (m ? isoName.slice(0, -m[0].length) : isoName) + ".patched" + (m ? m[0] : ".iso");
    const total = isoFile.size;
    const snap = allRuns();      // snapshot so mid-save edits can't corrupt the copy
    const pg = progressModal();
    try {
      pg.phase("Preparing", `Building a patched copy of ${isoName} (~${fmtSize(total)}). This can take a few minutes — keep this tab open and the screen awake. It streams straight to your downloads; nothing is uploaded.`, { indet: true });
      let pos = 0, finished, failed;
      const done = new Promise((res, rej) => { finished = res; failed = rej; });
      const reader = isoFile.stream().getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          let r; try { r = await reader.read(); } catch (e) { controller.error(e); failed(e); return; }
          if (r.done) { controller.close(); finished(); return; }
          let chunk = r.value; const start = pos, end = pos + chunk.length;
          for (const run of snap) {
            const re = run.off + run.bytes.length;
            if (re > start && run.off < end) {
              chunk = chunk.slice();
              const a = Math.max(start, run.off), b = Math.min(end, re);
              for (let i = a; i < b; i++) chunk[i - start] = run.bytes[i - run.off];
            }
          }
          controller.enqueue(chunk); pos = end;
          pg.phase("Writing", `Streaming patched ISO to your downloads… ${fmtSize(pos)} / ${fmtSize(total)}`, { pct: total ? (pos / total) * 100 : 0 });
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} failed(new Error("download cancelled")); },
      });
      const id = "iso-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const sw = navigator.serviceWorker.controller;
      await new Promise((res, rej) => {
        const ch = new MessageChannel();
        const to = setTimeout(() => rej(new Error("the offline helper didn't respond")), 5000);
        ch.port1.onmessage = () => { clearTimeout(to); res(); };
        try { sw.postMessage({ type: "dl-register", id, filename: outName, size: total, stream }, [stream, ch.port2]); }
        catch (e) { clearTimeout(to); rej(e); }
      });
      const ifr = document.createElement("iframe"); ifr.style.display = "none"; ifr.src = "_dl/" + id;
      document.body.appendChild(ifr);
      await done;
      markSaved(); render(); setTimeout(() => ifr.remove(), 1000);
      pg.done(`Streamed a patched copy — check your downloads for “${outName}”. Replace your ISO with it to play the edits.`, false, { bytes: total });
      setStatus(`Saved a patched copy (${fmtSize(total)}): ${outName}.`, "ok");
    } catch (e) {
      pg.done("Save failed: " + e.message + ". Your edits are still staged.", true);
      setStatus("Save failed: " + e.message, "err");
    }
  }

  function markSaved() { for (const k in WINDOWS) { WINDOWS[k].orig = WINDOWS[k].buf.slice(); } }

  // ---- pnach export (universal fallback — works even where the ISO can't be written) ----
  // ---- mod recipes and patches (#19) ---------------------------------------
  //
  // Two export formats, both built from the staged runs, so neither needs the 4 GB disc written
  // first. S4's edits are three 4-byte code patches today, which makes a recipe about 300 bytes —
  // the difference between "describe your change in a forum post" and "here is the change".
  //
  // A recipe is REVERSIBLE and VERSION-CHECKED: it carries the stock bytes as well as the new
  // ones, so importing onto a disc that doesn't match stock can be refused rather than silently
  // producing a half-patched image.
  const MOD_FORMAT = "s4mod", MOD_VERSION = 1, MOD_GAME = "SLUS-209.79";

  function buildRecipe() {
    const runs = allRuns();
    return {
      format: MOD_FORMAT,
      version: MOD_VERSION,
      game: MOD_GAME,                       // refuse another game or region on import
      created: new Date().toISOString(),
      patches: runs.map((r) => {
        // `from` is what this disc held before the edit, which is the stock value when the disc
        // was stock. Carrying it is what makes an import verifiable instead of hopeful.
        const w = Object.values(WINDOWS).find((x) => r.off >= x.off && r.off < x.off + x.len);
        const at = r.off - w.off;
        return { off: r.off, from: [...w.orig.slice(at, at + r.bytes.length)], to: [...r.bytes] };
      }),
    };
  }

  function exportRecipe() {
    if (!anyDirty()) return setStatus("No changes to export.", "warn");
    const rec = buildRecipe();
    dl(new TextEncoder().encode(JSON.stringify(rec, null, 2)),
       (isoName.replace(/\.[^.]+$/, "") || "suikoden4") + ".s4mod");
    setStatus(`Exported ${rec.patches.length} patch${rec.patches.length === 1 ? "" : "es"} as .s4mod.`, "ok");
  }

  function exportXdelta() {
    if (!anyDirty()) return setStatus("No changes to export.", "warn");
    if (!isoFile) return setStatus("Open the disc first — an .xdelta needs its size.", "warn");
    const edits = allRuns().map((r) => ({ off: r.off, data: r.bytes }));
    const patch = Vcdiff.buildXdelta(isoFile.size, edits);
    dl(patch, (isoName.replace(/\.[^.]+$/, "") || "suikoden4") + ".xdelta");
    setStatus(`Exported ${edits.length} edit${edits.length === 1 ? "" : "s"} as .xdelta ` +
              `(${fmtSize(patch.length)}) — apply with: xdelta3 -d -s <pristine> <patch> <out>`, "ok");
  }

  function dl(bytes, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // Import detects the format from the CONTENT, not the extension — a recipe renamed .txt is
  // still a recipe, and an .xdelta is identified by its VCDIFF magic.
  async function importPatch(file) {
    if (!Object.keys(WINDOWS).length) return setStatus("Open your ISO first.", "warn");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isVcdiff = bytes.length > 4 && bytes[0] === 0xD6 && bytes[1] === 0xC3 && bytes[2] === 0xC4;
    const res = isVcdiff ? patchesFromXdelta(bytes) : patchesFromRecipe(bytes);
    if (res.error) return setStatus(res.error, "err");
    stagePatches(res.patches, res.label);
  }

  function patchesFromRecipe(bytes) {
    let rec;
    try { rec = JSON.parse(new TextDecoder().decode(bytes)); }
    catch (e) { return { error: "That file is neither a .s4mod recipe nor an .xdelta patch." }; }
    if (rec.format !== MOD_FORMAT)
      return { error: `That recipe is "${rec.format || "unknown"}", not a Suikoden IV ${MOD_FORMAT}.` };
    if (rec.game !== MOD_GAME)
      return { error: `That recipe is for ${rec.game || "an unknown release"}; this disc is ${MOD_GAME}.` };
    if (typeof rec.version !== "number" || rec.version > MOD_VERSION)
      return { error: `That recipe is format v${rec.version}; this build understands v${MOD_VERSION}.` };
    const patches = (rec.patches || []).map((p) => ({ off: p.off, to: Uint8Array.from(p.to || []),
                                                      from: p.from ? Uint8Array.from(p.from) : null }));
    return { patches, label: `${patches.length} patch${patches.length === 1 ? "" : "es"} from ${MOD_FORMAT}` };
  }

  // An .xdelta is a patch for the whole 4 GB disc, so it can't be decoded wholesale here. What
  // makes it tractable is Vcdiff's plan(): it walks the instructions WITHOUT any source bytes and
  // reports the target spans that don't provably come from the same position of the same file —
  // narrowing "what might have changed" from gigabytes to a handful of ranges.
  //
  // plan() deliberately over-reports (a COPY fetching equal bytes from a different offset still
  // counts), so every candidate span is decoded and compared against the disc before it becomes
  // an edit. A span that turns out to be identical is dropped rather than staged as a no-op.
  function patchesFromXdelta(bytes) {
    const patches = [];
    try {
      Vcdiff.eachWindow(bytes, (w) => {
        for (const [from, to] of w.plan()) {
          const absFrom = w.targetStart + from, absTo = w.targetStart + to;
          const win = Object.values(WINDOWS).find((x) => absFrom < x.off + x.len && absTo > x.off);
          if (!win) {
            throw new Error(`This patch changes bytes at 0x${absFrom.toString(16).toUpperCase()}, ` +
              `outside every region this editor knows how to edit. Nothing was applied.`);
          }
          // Decode this window against the disc bytes it claims to source from. Only whole
          // windows that sit inside a region we hold can be reproduced.
          if (w.sourceStart < win.off || w.sourceStart + w.sourceLen > win.off + win.len) {
            throw new Error(`This patch reproduces 0x${absFrom.toString(16).toUpperCase()} from disc ` +
              `bytes outside the editable region, which this editor can't read. Nothing was applied.`);
          }
          const src = win.orig.subarray(w.sourceStart - win.off, w.sourceStart - win.off + w.sourceLen);
          const out = w.decode(src);
          const slice = out.subarray(from, to);
          const at = absFrom - win.off;
          if (slice.some((b, i) => b !== win.orig[at + i])) {
            patches.push({ off: absFrom, to: slice.slice(), from: win.orig.slice(at, at + slice.length) });
          }
        }
      });
    } catch (e) {
      return { error: e.message };      // includes the "-S none" guidance for LZMA patches
    }
    return { patches, label: `${patches.length} edit${patches.length === 1 ? "" : "s"} from .xdelta` };
  }

  // Staging an imported patch is the same path as any other edit: reviewable, undoable,
  // revertible. Refusals are WHOLE-FILE — a patch that touches a byte this editor doesn't own is
  // rejected outright rather than half-applied, because a half-applied disc is worse than none.
  function stagePatches(patches, label) {
    if (!patches.length) return setStatus("That patch contains no changes.", "warn");
    const plan = [];
    for (const p of patches) {
      const w = Object.values(WINDOWS).find((x) => p.off >= x.off && p.off + p.to.length <= x.off + x.len);
      if (!w) {
        return setStatus(`Refused: this patch changes bytes at 0x${p.off.toString(16).toUpperCase()}, ` +
          `which is outside every region this editor knows how to edit. Nothing was applied.`, "err");
      }
      const at = p.off - w.off;
      if (p.from && p.from.some((b, i) => b !== w.orig[at + i])) {
        return setStatus(`Refused: the disc does not match what this patch expects at ` +
          `0x${p.off.toString(16).toUpperCase()} — it was built against a different or ` +
          `already-modified disc. Nothing was applied.`, "err");
      }
      plan.push({ w, at, bytes: p.to });
    }
    const before = {};
    for (const k in WINDOWS) before[k] = WINDOWS[k].buf.slice();
    for (const { w, at, bytes } of plan) w.buf.set(bytes, at);
    const after = {};
    for (const k in WINDOWS) after[k] = WINDOWS[k].buf.slice();
    JOURNAL.record({
      label: `Apply ${label}`,
      undo: () => { for (const k in before) WINDOWS[k].buf.set(before[k]); drawView(); },
      redo: () => { for (const k in after) WINDOWS[k].buf.set(after[k]); drawView(); },
    });
    drawView();
    const rows = reviewRows();
    if (!rows.length) return setStatus("That patch matches this disc already — nothing to change.", "ok");
    openConfirm(rows, () => {}, "Close");
    setStatus(`Staged ${label} — review and save when ready.`, "ok");
  }

  function copyPnach() {
    const lines = ["// Suikoden IV (NTSC-U) — from the web ISO editor"];
    let n = 0;
    for (const f of FIELDS) {
      if (!isDirty(f.key)) continue;
      const w = win(f.key);
      // emit a constant 32-bit EE write for each changed 4-byte word (EE RAM address, not ISO offset)
      for (let i = 0; i + 4 <= f.len; i += 4) {
        const word = w.dv.getUint32(i, true);
        const addr = (0x20000000 | (isoToVaddr(f.off + i) & 0x0FFFFFFF)) >>> 0;
        lines.push(`patch=1,EE,${addr.toString(16).toUpperCase().padStart(8, "0")},extended,${word.toString(16).toUpperCase().padStart(8, "0")}   // ${f.label}`);
        n++;
      }
    }
    if (!n) return setStatus("No changes to copy — edit a value first.", "warn");
    const text = lines.join("\n");
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => setStatus("Copied a pnach snippet for your current values to the clipboard.", "ok"))
      .catch(() => { prompt("Copy these pnach lines:", text); });
  }

  // ---- progress modal (ported from the S3 ISO editor) -------------------------
  function progressModal() {
    const ov = document.createElement("div"); ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Saving to ISO" style="max-width:460px">
        <div class="modal-h"><b id="pgTitle">Saving to ISO</b></div>
        <div class="pg-body" aria-live="polite">
          <div class="muted" id="pgMsg" style="margin-bottom:12px"></div>
          <div class="bar indet"><div class="bar-fill" id="pgFill" style="width:35%"></div></div>
          <div class="muted pg-meta" id="pgMeta" style="margin-top:8px"></div>
        </div>
        <div class="modal-f" id="pgFoot" style="display:none"><button class="primary" id="pgClose">Done</button></div>
      </div>`;
    document.body.appendChild(ov);
    const el = (id) => ov.querySelector("#" + id), bar = ov.querySelector(".bar"), fill = el("pgFill");
    const t0 = performance.now(); const tick = () => (el("pgMeta").textContent = `elapsed ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    const timer = setInterval(tick, 100); tick();
    return {
      phase(title, msg, { indet = false, pct = null } = {}) {
        el("pgTitle").textContent = title; el("pgMsg").textContent = msg;
        bar.classList.toggle("indet", indet);
        if (!indet) fill.style.width = Math.max(2, Math.min(100, pct == null ? 100 : pct)) + "%";
      },
      done(msg, isErr, extra) {
        clearInterval(timer); const ms = performance.now() - t0;
        el("pgTitle").textContent = isErr ? "Save failed" : "Done"; el("pgMsg").textContent = msg;
        bar.classList.remove("indet"); fill.style.width = "100%"; fill.classList.toggle("err", !!isErr);
        const parts = [`⏱ ${fmtDur(ms)}`];
        if (!isErr && extra && extra.bytes) { parts.push(fmtSize(extra.bytes)); const s = ms / 1000; if (s > 0.2) parts.push(`${fmtSize(extra.bytes / s)}/s`); }
        el("pgMeta").textContent = parts.join("  ·  ");
        el("pgFoot").style.display = "flex"; el("pgClose").onclick = () => ov.remove();
        setTimeout(() => el("pgClose").focus(), 20);
      },
    };
  }

  // exposed for app.js's mode switcher. FIELDS rides along read-only so the test fixture can be
  // generated from the editor's own table rather than a second copy of the offsets (#9): a
  // fixture built from duplicated constants proves the duplicate, not the code under test.
  window.ISO = { init, undo: () => JOURNAL.undo(), redo: () => JOURNAL.redo(),
                 loaded: () => !!Object.keys(WINDOWS).length, FIELDS };
})();
