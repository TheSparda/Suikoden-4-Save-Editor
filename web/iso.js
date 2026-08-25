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

  const ISO_ELF_START = 367 * 2048;          // boot ELF SLUS_209.79;1 at LBA 367 (0xB7800)

  // ---- editable fields (absolute ISO byte offsets; verified on the USA disc) ----
  // percent: rate = 100/N of default; N=round(10000/percent) is the rand range immediate.
  // bool:    a code patch — onBytes when checked, offBytes (the stock instruction) when not.
  const FIELDS = [
    {
      key: "encounterRate", group: "Random encounters", type: "percent",
      label: "Encounter rate", off: 0x10E43C, len: 4, def: 100, min: 1, max: 1000,
      unit: "% of normal",
      hint: "100 = normal · 50 = half · 200 = double. The game draws the encounter threshold as " +
            "rand(0..N-1); this sets N = round(10000 / percent).",
      sig: (b) => b[2] === 0x04 && b[3] === 0x24,     // addiu a0, zero, imm
      read: (dv) => { const N = dv.getUint16(0, true); return N ? Math.round(10000 / N) : 100; },
      write: (dv, pct) => {
        const N = Math.max(1, Math.min(0x7FFF, Math.round(10000 / Math.max(1, pct))));
        dv.setUint32(0, (0x24040000 | N) >>> 0, true);
      },
    },
    {
      key: "noBattles", group: "Random encounters", type: "bool",
      label: "Disable ALL random battles",
      sub: "Forces the Champion's Rune effect on globally — no random encounters anywhere.",
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
  let inited = false, saveNudged = false;

  const win = (k) => WINDOWS[k];
  const fmtSize = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
  const fmtDur = (ms) => ms >= 60000 ? `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}s` : `${(ms / 1000).toFixed(1)}s`;
  const setStatus = (m, k) => { const el = $("#isoStatus"); if (el) { el.textContent = m; el.className = "status" + (k ? " " + k : ""); } };
  const setBoot = (m, err) => { const el = $("#isoBoot"); if (el) el.innerHTML = (err ? "⚠ " : "") + esc(m); };

  function fieldValue(f, from) { return f.read(new DataView(from.buffer, from.byteOffset, from.length)); }
  function isDirty(k) { const w = win(k); return w && w.buf.some((b, i) => b !== w.orig[i]); }
  function anyDirty() { return Object.keys(WINDOWS).some(isDirty); }
  // absolute-offset changed runs across all windows
  function allRuns() {
    const out = [];
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

  async function commitIso(file, handle) {
    setStatus("Reading disc region…", "");
    const maxOff = FIELDS.reduce((a, f) => Math.max(a, f.off + f.len), 0);
    if (file.size < maxOff) return setStatus(`That file is only ${fmtSize(file.size)} — not a full Suikoden IV ISO.`, "err");
    const wins = {};
    for (const f of FIELDS) {
      let bytes;
      try { bytes = new Uint8Array(await file.slice(f.off, f.off + f.len).arrayBuffer()); }
      catch (e) { return setStatus("Read failed: " + e.message, "err"); }
      if (bytes.length !== f.len) return setStatus("Could not read the disc region (file too short).", "err");
      if (f.sig && !f.sig(bytes)) {
        return setStatus(`This doesn't look like the NTSC-U (SLUS-209.79) Suikoden IV ISO ` +
          `(unexpected bytes at 0x${f.off.toString(16).toUpperCase()}). PAL/other builds aren't supported here.`, "err");
      }
      wins[f.key] = { off: f.off, len: f.len, buf: bytes, orig: bytes.slice(), dv: new DataView(bytes.buffer), odv: new DataView(bytes.slice().buffer) };
    }
    WINDOWS = wins; isoHandle = handle; isoFile = file; isoName = file.name || "Suikoden IV.iso";
    saveNudged = false;
    if (handle) idbSet("lastIso", { name: isoName, handle, at: Date.now() }).catch(() => {});
    render();
    setStatus(`Loaded ${isoName} — NTSC-U verified.`, "ok");
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

  function render() {
    if (!Object.keys(WINDOWS).length) return;
    const groups = {};
    FIELDS.forEach((f) => (groups[f.group] = groups[f.group] || []).push(f));
    const mode = saveMode();
    const modeNote = mode === "inplace" ? "edits write in place to your ISO"
      : mode === "stream" ? "saving streams a patched copy to your downloads"
      : "this browser can't write the ISO — copy the pnach line instead";

    const groupHtml = Object.entries(groups).map(([g, fs]) => `
      <div class="card"><h3 class="sec">${esc(g)}</h3>
        <div class="grid">${fs.map(fieldHtml).join("")}</div>
      </div>`).join("");

    $("#isoEditor").innerHTML = groupHtml + `
      <div class="card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <button class="chip" id="isoPnach">⧉ Copy pnach line</button>
          <span class="muted">${esc(isoName)} · ${esc(modeNote)}</span>
        </div>
        <div class="toolbar">
          ${mode === "none"
            ? `<span class="status warn">Open on desktop Chromium or Android Chrome to write the ISO. Meanwhile, use “Copy pnach line”.</span>`
            : `<button class="primary" id="isoSave">${mode === "stream" ? "Save patched copy" : "Save to ISO"}</button>
               <button id="isoReset">Reset</button>
               <span class="status" id="isoStatus"></span>`}
        </div>
      </div>`;

    FIELDS.forEach(wireField);
    const sv = $("#isoSave"); if (sv) sv.onclick = save;
    const rs = $("#isoReset"); if (rs) rs.onclick = () => { for (const k in WINDOWS) WINDOWS[k].buf.set(WINDOWS[k].orig); render(); };
    $("#isoPnach").onclick = copyPnach;
  }

  function fieldHtml(f) {
    const w = win(f.key); const cur = f.read(w.dv);
    if (f.type === "bool") {
      return `<div class="field"><label class="row" style="gap:8px;cursor:pointer;min-height:40px">
          <input type="checkbox" data-iso="${f.key}" ${cur ? "checked" : ""}> <b>${esc(f.label)}</b></label>
        ${f.sub ? `<div class="fnote">${esc(f.sub)}</div>` : ""}</div>`;
    }
    return `<div class="field"><span>${esc(f.label)} <span class="muted">(${esc(f.unit || "")})</span></span>
        <input type="number" min="${f.min || 0}" max="${f.max || 999999}" value="${cur}" data-iso="${f.key}" data-def="${cur}">
        ${f.hint ? `<div class="fnote">${esc(f.hint)}</div>` : ""}</div>`;
  }

  function wireField(f) {
    const el = document.querySelector(`[data-iso="${f.key}"]`); if (!el) return;
    const w = win(f.key);
    el.onchange = el.oninput = () => {
      if (f.type === "bool") f.write(w.dv, el.checked ? 1 : 0);
      else f.write(w.dv, +el.value || f.def);
      if (el.classList) el.classList.toggle("dirty", isDirty(f.key));
    };
  }

  // ---- review + save ----------------------------------------------------------
  // ISO file offset → EE RAM virtual address (for pnach codes): the boot ELF's PT_LOAD segment
  // maps file 0x1000 → vaddr 0x280000, so vaddr = 0x280000 + (isoOff - ELF_START - 0x1000).
  const isoToVaddr = (off) => 0x280000 + (off - ISO_ELF_START - 0x1000);

  function reviewRows() {
    const rows = [];
    for (const f of FIELDS) {
      if (!isDirty(f.key)) continue;
      const w = win(f.key);
      const ov = f.read(new DataView(w.orig.buffer)), nv = f.read(w.dv);
      const fmt = (x) => f.type === "bool" ? (x ? "on" : "off") : `${x}${f.type === "percent" ? "%" : ""}`;
      rows.push({ g: f.group, t: `${f.label}: ${fmt(ov)} → ${fmt(nv)}` });
    }
    return rows;
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

  // exposed for app.js's mode switcher
  window.ISO = { init };
})();
