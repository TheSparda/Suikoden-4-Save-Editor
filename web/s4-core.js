// s4-core.js — the editor's rules, with no DOM and no Pyodide (issue #2).
//
// Everything here used to live inline in app.js. Owning it in one place means the save editor,
// the review sheet and (soon) the health lint can never disagree about what a level is, what a
// recruitment byte means, or what counts as a change.
//
// The second reason is testability, and it is the one that actually forced this: the save editor
// needs Pyodide, which headless CI cannot load, so any rule left inside app.js can only be tested
// by asserting that a string appears in the file. That is why S4's suite was a handful of static
// checks — see web/tests/s4-core.mjs for what it looks like when the logic is reachable.
//
// Loaded as a plain <script> before app.js in the browser, and imported directly by the Node
// tests. The wrapper is S3's: one file, both worlds, no build step.
//
// House rule 1 (CLAUDE.md — correct or absent, never wrong) shows up here as the `labels`
// parameter on buildDiff. This module deliberately does not know item or rune names: those come
// from reference tables the caller owns. When a lookup isn't supplied it renders `#id`, which is
// honest, rather than inventing a plausible name.
(function (root) {
  "use strict";

  // ---- enums and caps ------------------------------------------------------

  // Recruitment status — the exact byte the game checks (mirrors s4save.RECRUIT_STATES).
  // Only these five values are writable; anything else is surfaced as unknown rather than
  // silently coerced.
  const REC_STATES = [[0, "Not Recruited"], [1, "In Your Company"], [10, "Recruited"],
                      [11, "In Party"], [15, "Permanently In Party"]];

  const STAT_NAMES = ["STR", "SKL", "MAG", "EVA", "PDF", "MDF", "SPD", "LUK"];

  const GEAR_LABELS = { head: "Head", body: "Body", hands: "Hands", feet: "Feet",
                        acc1: "Accessory 1", acc2: "Accessory 2", acc3: "Accessory 3" };

  // Engine caps. s4save.py's _clamp() enforces these on write, so a value above one of them is
  // not rejected — it is silently reduced. That gap is what #12's health lint exists to close.
  const CHAR_CAP = { maxHP: 9999, exp: 98999, weaponLvl: 15 };
  const POTCH_MAX = 99999999;

  // Elemental rune affinity reference (s4_affinities.json) — teaches which runes suit a unit.
  const AFF_ELEMS = ["Fire", "Lightning", "Water", "Wind", "Earth"];
  const AFF_RATE = { 1: "poor", 2: "average", 3: "good", 4: "excellent" };
  const AFF_ALIAS = { "Frederica": "Fredrica" };   // roster name → affinity-table key

  const LV_MAX = 99;

  // ---- derived values ------------------------------------------------------

  // The game stores EXP, not level; the level shown in-game is derived. 1000 EXP per level,
  // capped at 99 — note CHAR_CAP.exp (98999) is exactly the largest EXP that still reads as 99.
  const lvFromExp = (exp) => Math.min(LV_MAX, Math.floor((exp || 0) / 1000) + 1);

  // The inverse is lossy in one direction only: a level maps to the *lowest* EXP that displays
  // it, so lvFromExp(expFromLv(lv)) === lv round-trips for every level, while
  // expFromLv(lvFromExp(exp)) floors exp to its level boundary. Editing Level writes this value.
  const expFromLv = (lv) => (Math.min(LV_MAX, Math.max(1, lv)) - 1) * 1000;

  const gtLabel = (sec) =>
    `${Math.floor((sec || 0) / 3600)}h${String(Math.floor(((sec || 0) % 3600) / 60)).padStart(2, "0")}m`;

  // An unknown recruitment byte names itself as unknown and keeps the raw value visible, rather
  // than being mapped to the nearest known state.
  function recName(v) { const r = REC_STATES.find((x) => x[0] === v); return r ? r[1] : `? (${v})`; }

  // Character name → affinity ratings, or null. The affinity table is passed in rather than read
  // from a global so this stays pure; `aff` is whatever s4_affinities.json parsed to.
  // One roster/table spelling mismatch is aliased (Frederica/Fredrica).
  function affFor(aff, name) {
    if (!aff) return null;
    return aff[name] || aff[AFF_ALIAS[name]] || null;
  }

  // ---- staged edits → review rows -----------------------------------------

  // Pure transform: the loaded save plus the three staged-edit overlays in, review rows out.
  // Nothing here touches the DOM, so the review sheet's contents are testable without a browser.
  //
  //   save       decoded save object (as s4save.decode_save returns it)
  //   saveEdits  save-wide overlay  — { potch?, gameTime?, worldMapFull? }
  //   names      name overlay       — { key: newValue }
  //   charEdits  per-character overlay, keyed by roster index
  //   labels     { item(id), rune(id) } — optional; falls back to "#id" (house rule 1)
  //
  // A row is only emitted when the staged value actually differs from the file, which is what
  // makes countEffective() honest: staging a field back to its original value is not a change.
  function buildDiff({ save, saveEdits = {}, names = {}, charEdits = {}, labels = {} } = {}) {
    const s = save;
    if (!s) return [];
    const itemLabel = labels.item || ((id) => (id ? "#" + id : "— empty —"));
    const runeLabel = labels.rune || ((id) => (id ? "#" + id : "— none —"));

    const rows = [];
    const byRi = {};
    (s.characters || []).forEach((c) => (byRi[c.rosterIndex] = c));

    if ("potch" in saveEdits && saveEdits.potch !== s.potch)
      rows.push({ g: "Save", t: `Potch: ${s.potch} → ${saveEdits.potch}` });
    if ("gameTime" in saveEdits && saveEdits.gameTime !== s.gameTimeSec)
      rows.push({ g: "Save", t: `Game time: ${gtLabel(s.gameTimeSec)} → ${gtLabel(saveEdits.gameTime)}` });
    if (saveEdits.worldMapFull)
      rows.push({ g: "Save", t: `World map → mark fully explored` });

    Object.entries(names).forEach(([k, v]) => {
      const n = (s.names || []).find((x) => x.key === k);
      if (n && v !== n.value) rows.push({ g: "Names", t: `${n.label}: "${n.value}" → "${v}"` });
    });

    Object.entries(charEdits).forEach(([ri, f]) => {
      const c = byRi[ri] || byRi[+ri] || {};
      const who = c.name || `#${ri}`;
      Object.entries(f).forEach(([k, v]) => {
        if (k === "stats") {
          Object.entries(v).forEach(([st, nv]) => {
            if (nv !== c.stats?.[st]) rows.push({ g: who, t: `${st}: ${c.stats?.[st]} → ${nv}` });
          });
        } else if (k === "runes") {
          Object.entries(v).forEach(([slot, nv]) => {
            const old = c.runes?.[+slot] || 0;
            if (nv !== old) rows.push({ g: who, t: `Rune ${+slot + 1}: ${runeLabel(old)} → ${runeLabel(nv)}` });
          });
        } else if (k === "equip") {
          Object.entries(v).forEach(([slot, nv]) => {
            const old = c.equip?.[slot] || 0;
            if (nv !== old) rows.push({ g: who, t: `${GEAR_LABELS[slot] || slot}: ${itemLabel(old)} → ${itemLabel(nv)}` });
          });
        } else if (k === "unites") {
          Object.entries(v).forEach(([slot, nv]) => {
            const old = (c.unites || [])[+slot] || 0;
            if (nv !== old) {
              const un = (c.uniteNames || {})[slot];
              rows.push({ g: who, t: `Unite ${un ? un.name : "#" + slot}: ${old} → ${nv}` });
            }
          });
        } else if (k === "exp") {
          if (v !== c.exp) rows.push({ g: who, t: `Level ${lvFromExp(c.exp)} → ${lvFromExp(v)} (EXP ${c.exp} → ${v})` });
        } else if (k === "weaponLvl") {
          if (v !== c.weaponLvl) rows.push({ g: who, t: `Weapon Lv: ${c.weaponLvl} → ${v}` });
        } else if (k === "maxHP") {
          if (v !== c.maxHP) rows.push({ g: who, t: `Max HP: ${c.maxHP} → ${v}` });
        } else if (k === "recruited") {
          if (v !== c.recruited) rows.push({ g: who, t: `Recruitment: ${recName(c.recruited)} → ${recName(v)}` });
        }
      });
    });
    return rows;
  }

  // ---- staging journal (undo / redo) ---------------------------------------

  // A generic edit journal. It knows nothing about saves, discs or the DOM — a caller records a
  // label plus the two functions that move state backwards and forwards, and this owns the
  // stacks, the coalescing and the bounds.
  //
  // Both editors drive this with *snapshots* rather than hand-written inverse operations. Writing
  // a correct inverse for every mutation is the classic way undo rots: miss one field and the
  // stack silently desyncs from the data. Snapshotting the staged overlay costs a few KB and
  // makes "undo back to zero leaves nothing staged" true by construction rather than by audit.
  //
  //   coalesceMs  consecutive records sharing a `key` inside this window collapse into one step.
  //               Without it, typing "250" into a number box is three undo steps, and dragging a
  //               slider is dozens. The first entry's undo is kept (it holds the oldest state)
  //               and the latest redo replaces the newer one.
  //   limit       oldest entries are dropped past this depth, so a long session can't grow
  //               without bound.
  function createJournal({ limit = 200, coalesceMs = 600, onChange = null, now = Date.now } = {}) {
    let undoStack = [], redoStack = [];
    const fire = () => { if (onChange) onChange(api); };

    const api = {
      // record({ label, key?, undo, redo }) — `undo`/`redo` restore state; neither is called here.
      record({ label, key = null, undo, redo }) {
        const top = undoStack[undoStack.length - 1];
        if (top && key !== null && top.key === key && now() - top.at <= coalesceMs) {
          top.redo = redo; top.at = now(); top.label = label;   // same field, still typing
        } else {
          undoStack.push({ label, key, undo, redo, at: now() });
          if (undoStack.length > limit) undoStack.shift();
        }
        redoStack = [];          // a new edit forks the timeline; the old redo branch is gone
        fire();
        return api;
      },
      undo() {
        const e = undoStack.pop();
        if (!e) return false;
        e.undo();
        redoStack.push(e);
        fire();
        return true;
      },
      redo() {
        const e = redoStack.pop();
        if (!e) return false;
        e.redo();
        undoStack.push(e);
        fire();
        return true;
      },
      // Seals the current entry so the next record starts a fresh step even within coalesceMs.
      // Used when focus leaves a field: two visits to the same box are two edits, however fast.
      seal() { const top = undoStack[undoStack.length - 1]; if (top) top.key = null; return api; },
      reset() { undoStack = []; redoStack = []; fire(); return api; },
      canUndo: () => undoStack.length > 0,
      canRedo: () => redoStack.length > 0,
      undoLabel: () => (undoStack[undoStack.length - 1] || {}).label || null,
      redoLabel: () => (redoStack[redoStack.length - 1] || {}).label || null,
      depth: () => ({ undo: undoStack.length, redo: redoStack.length }),
    };
    return api;
  }

  // ---- exports -------------------------------------------------------------
  // Names are attached individually so app.js keeps using them bare, and collected under S4Core
  // so the tests (and future modules) have one handle to import.
  const API = {
    REC_STATES, STAT_NAMES, GEAR_LABELS, CHAR_CAP, POTCH_MAX, LV_MAX,
    AFF_ELEMS, AFF_RATE, AFF_ALIAS,
    lvFromExp, expFromLv, gtLabel, recName, affFor, buildDiff, createJournal,
  };
  Object.assign(root, API);
  root.S4Core = API;
})(typeof module !== "undefined" && module.exports ? module.exports : window);
