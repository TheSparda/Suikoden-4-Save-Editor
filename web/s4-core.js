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
  const STAT_MAX = 999;      // the editor's own per-stat input bound

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

  // ---- per-field restore (#4) ----------------------------------------------

  // Drop one staged field from the overlays, restoring what the file holds.
  //
  // It *removes* the staged value rather than writing the file's value over it, and that
  // distinction is the whole correctness argument. Level is a display of EXP: writing back
  // expFromLv(lvFromExp(fileExp)) would floor an EXP of 4567 to 4000 and silently lose 567 points.
  // Dropping the overlay cannot be approximate — whatever the file holds is what comes back.
  //
  // Emptied containers are deleted on the way out so the overlay never holds a `{}` that makes
  // countEffective() look non-zero while buildDiff() reports nothing.
  //
  //   what  "potch" | "gameTime" | "worldMapFull" | "name:<key>"      (ri omitted)
  //         "recruit" | "k:<field>" | "stat:<n>" | "rune:<slot>"
  //         | "equip:<slot>" | "unite:<slot>"                          (ri required)
  //
  // Mutates in place and returns the same object, so the caller's snapshot/journal wrapper sees
  // the change exactly as it sees a normal edit.
  function revertStaged({ saveEdits = {}, names = {}, charEdits = {} }, what, ri) {
    const i = what.indexOf(":");
    const kind = i < 0 ? what : what.slice(0, i);
    const arg = i < 0 ? null : what.slice(i + 1);

    if (ri === null || ri === undefined) {
      if (kind === "name") delete names[arg];
      else delete saveEdits[kind];                 // potch / gameTime / worldMapFull
      return { saveEdits, names, charEdits };
    }

    const e = charEdits[ri];
    if (!e) return { saveEdits, names, charEdits };

    const nested = { stat: "stats", rune: "runes", equip: "equip", unite: "unites" }[kind];
    if (what === "recruit") delete e.recruited;
    else if (kind === "k") delete e[arg];
    else if (nested && e[nested]) {
      delete e[nested][arg];
      if (!Object.keys(e[nested]).length) delete e[nested];
    }
    if (!Object.keys(e).length) delete charEdits[ri];
    return { saveEdits, names, charEdits };
  }

  // ---- equipment slot categories (#16) -------------------------------------

  // Which item ids actually appear in a given equipment slot, across the loaded save.
  //
  // The picker opens the full 519-item list for every slot, so choosing boots means scrolling
  // past every sword in the game. A category table would fix that properly, but S4 doesn't have
  // one: item categories live in FILEDATA (#31), and the "category purity" analysis that located
  // the slots is expressed in a record frame issue #48 has called into question.
  //
  // So this derives the shortlist from the save in front of the user rather than inventing a
  // taxonomy: these are ids the game itself has placed in this slot on this file. That claim is
  // verifiable and small; "this is the list of boots" would not be. The caller always keeps a
  // "show all" escape, and a slot with too few observations returns null so the picker falls back
  // to the full list rather than hiding real choices behind a shortlist of one (rule 1).
  const SLOT_SHORTLIST_MIN = 3;

  function slotItemIds(save, slot, { min = SLOT_SHORTLIST_MIN } = {}) {
    const ids = new Set();
    for (const c of (save && save.characters) || []) {
      const v = (c.equip || {})[slot];
      if (v) ids.add(v);
    }
    return ids.size >= min ? ids : null;
  }

  // ---- save health lint (#12) ----------------------------------------------

  // A lint over the save PLUS the staged edits, so it catches both damage already in the file and
  // damage you are about to write. That second half is the point: s4save.py's _clamp() silently
  // reduces an out-of-range value, so today you can type 99999 HP, see it accepted, and get 9999
  // with no notice. Every clamp finding quotes the value that will ACTUALLY land.
  //
  // House rule 1 throughout: a check whose lookup the caller didn't supply simply doesn't run,
  // and no finding claims a consequence that isn't derivable from the write path.
  //
  //   sev  "problem" — will be written wrong, or is already wrong
  //        "warning" — will be silently altered on write, or is a reachable bad state
  //        "note"    — worth knowing; never used for anything actionable
  //
  // A finding with `fix` carries ops the caller applies through its normal staging path. Fixes
  // STAGE, they never write — the review sheet is not optional for them either (rule 2).
  function auditSave(save, { charEdits = {}, saveEdits = {}, runeIds = null, itemIds = null } = {}) {
    if (!save) return [];
    const out = [];
    const add = (f) => out.push(f);
    const chars = save.characters || [];
    // Effective value = staged if present, else the file's. Every check runs on this, which is
    // what makes the lint see edits you haven't applied yet.
    const eff = (c, k) => {
      const e = charEdits[c.rosterIndex];
      return e && k in e ? e[k] : c[k];
    };
    const effStat = (c, n) => {
      const e = charEdits[c.rosterIndex];
      return e && e.stats && n in e.stats ? e.stats[n] : (c.stats || {})[n];
    };
    const effRune = (c, i) => {
      const e = charEdits[c.rosterIndex];
      return e && e.runes && i in e.runes ? e.runes[i] : ((c.runes || [])[i] || 0);
    };

    // --- values the engine will silently reduce on write ---------------------
    const clampers = [
      ["exp", CHAR_CAP.exp, "EXP"],
      ["weaponLvl", CHAR_CAP.weaponLvl, "Weapon level"],
      ["maxHP", CHAR_CAP.maxHP, "Max HP"],
    ];
    for (const c of chars) {
      for (const [key, cap, label] of clampers) {
        const v = eff(c, key);
        if (Number.isFinite(v) && v > cap) {
          add({ id: `clamp-${key}-${c.rosterIndex}`, sev: "warning", group: c.name,
            title: `${label} ${v} will be written as ${cap}`,
            detail: `The engine clamps ${label.toLowerCase()} to ${cap} on write. The value you typed is not what will land.`,
            fix: { label: `Set ${cap}`, ops: [{ kind: "char", ri: c.rosterIndex, key, value: cap }] } });
        }
      }
      for (const [st, v] of Object.entries(c.stats || {})) {
        const ev = effStat(c, st);
        if (Number.isFinite(ev) && ev > STAT_MAX) {
          add({ id: `clamp-stat-${c.rosterIndex}-${st}`, sev: "warning", group: c.name,
            title: `${st} ${ev} will be written as ${STAT_MAX}`,
            detail: `Stats are stored in one byte pair capped at ${STAT_MAX}.`,
            fix: { label: `Set ${STAT_MAX}`, ops: [{ kind: "stat", ri: c.rosterIndex, key: st, value: STAT_MAX }] } });
        }
      }
    }
    const potch = "potch" in saveEdits ? saveEdits.potch : save.potch;
    if (Number.isFinite(potch) && potch > POTCH_MAX) {
      add({ id: "clamp-potch", sev: "warning", group: "Save",
        title: `Potch ${potch} will be written as ${POTCH_MAX}`,
        detail: "The engine clamps potch on write.",
        fix: { label: `Set ${POTCH_MAX}`, ops: [{ kind: "save", key: "potch", value: POTCH_MAX }] } });
    }

    // --- the recruitment enum, and the party it implies ----------------------
    const badEnum = chars.filter((c) => !REC_STATES.some(([v]) => v === eff(c, "recruited")));
    if (badEnum.length) {
      add({ id: "recruit-enum", sev: "problem", group: "Recruitment",
        title: `${badEnum.length} character${badEnum.length === 1 ? " has" : "s have"} an unknown recruitment value`,
        detail: badEnum.map((c) => `${c.name}: ${eff(c, "recruited")}`).join(", ")
          + `. Known values are ${REC_STATES.map(([v, l]) => `${v} (${l})`).join(", ")}.` });
    }
    const party = chars.filter((c) => IN_PARTY.includes(eff(c, "recruited")));
    if (party.length > PARTY_MAX) {
      add({ id: "party-overfull", sev: "warning", group: "Party",
        title: `${party.length} characters are in the party; the game fields ${PARTY_MAX}`,
        detail: party.map((c) => c.name).join(", ") + ". The extras may be ignored." });
    }

    // --- id membership. Only runs when the caller supplied the table. --------
    if (runeIds) {
      for (const c of chars) {
        for (let i = 0; i < 3; i++) {
          const v = effRune(c, i);
          if (v && !runeIds.has(v)) {
            add({ id: `rune-id-${c.rosterIndex}-${i}`, sev: "problem", group: c.name,
              title: `Rune ${i + 1} is id ${v}, which is not a known rune`,
              detail: "Either the reference table is missing this rune, or the value is not a rune id.",
              fix: { label: "Clear the slot", ops: [{ kind: "rune", ri: c.rosterIndex, key: i, value: 0 }] } });
          }
        }
      }
    }
    if (itemIds) {
      for (const c of chars) {
        const e = charEdits[c.rosterIndex];
        for (const [slot, base] of Object.entries(c.equip || {})) {
          const v = e && e.equip && slot in e.equip ? e.equip[slot] : base;
          if (v && !itemIds.has(v)) {
            add({ id: `item-id-${c.rosterIndex}-${slot}`, sev: "problem", group: c.name,
              title: `${GEAR_LABELS[slot] || slot} is id ${v}, which is not a known item`,
              detail: "Either the reference table is missing this item, or the value is not an item id.",
              fix: { label: "Clear the slot", ops: [{ kind: "equip", ri: c.rosterIndex, key: slot, value: 0 }] } });
          }
        }
      }
    }

    // --- a level shown that the stored EXP doesn't support -------------------
    for (const c of chars) {
      const exp = eff(c, "exp");
      if (!Number.isFinite(exp)) continue;
      if (exp < 0) {
        add({ id: `exp-negative-${c.rosterIndex}`, sev: "problem", group: c.name,
          title: `EXP is negative (${exp})`, detail: "This cannot be written as an unsigned value.",
          fix: { label: "Set 0", ops: [{ kind: "char", ri: c.rosterIndex, key: "exp", value: 0 }] } });
      }
    }
    return out;
  }

  // Apply a finding's fix to the three overlays. Mutates in place and returns them, exactly like
  // revertStaged, so the caller's journal wrapper records it as one ordinary staged edit.
  function applyFix(overlays, fix) {
    const { saveEdits = {}, charEdits = {} } = overlays;
    for (const op of (fix && fix.ops) || []) {
      if (op.kind === "save") { saveEdits[op.key] = op.value; continue; }
      const e = (charEdits[op.ri] = charEdits[op.ri] || {});
      if (op.kind === "char") e[op.key] = op.value;
      else if (op.kind === "stat") (e.stats = e.stats || {})[op.key] = op.value;
      else if (op.kind === "rune") (e.runes = e.runes || {})[op.key] = op.value;
      else if (op.kind === "equip") (e.equip = e.equip || {})[op.key] = op.value;
    }
    return overlays;
  }

  // ---- party (#11) ---------------------------------------------------------

  // Suikoden IV fields four on land. The game's own flag is the recruitment byte — 11 "In Party"
  // and 15 "Permanently In Party" — so the roster can be read without locating a slot array.
  const PARTY_MAX = 4;
  const IN_PARTY = [11, 15];

  // Derive the active party from the recruitment enum.
  //
  // Read-only by nature: this is the membership flag, not the slot order. The order shown is
  // roster order, which is NOT necessarily the in-game formation — that lives in an array not
  // yet located, and claiming an order we haven't verified would be inventing data (rule 1).
  // `ordered: false` says so to the caller rather than leaving it to be assumed.
  function derivePartyState(save) {
    const chars = (save && save.characters) || [];
    const members = chars.filter((c) => IN_PARTY.includes(c.recruited))
      .map((c) => ({ rosterIndex: c.rosterIndex, name: c.name, recruited: c.recruited,
                     locked: c.recruited === 15 }));
    const problems = [];
    if (members.length > PARTY_MAX) {
      problems.push({
        id: "party-overfull", sev: "warn",
        title: `${members.length} characters are marked as in the party (the game fields ${PARTY_MAX})`,
        detail: "The game may ignore the extras, or behave unpredictably. Set the ones you don't "
              + "want to " + recName(10) + ".",
      });
    }
    // 11/15 on someone the game doesn't consider recruited is a contradiction the enum allows
    // but the game shouldn't see.
    const ghost = members.filter((m) => !chars.some((c) => c.rosterIndex === m.rosterIndex && c.recruited >= 10));
    if (ghost.length) {
      problems.push({ id: "party-unrecruited", sev: "error",
        title: "In the party but not recruited",
        detail: ghost.map((g) => g.name).join(", ") });
    }
    return { members, max: PARTY_MAX, ordered: false, problems };
  }

  // Removing someone from the party means "Recruited", not "Not Recruited" — dropping them to 0
  // would un-recruit a character the player actually has, which is a different and much worse
  // edit than the one they asked for.
  const PARTY_REMOVE_TO = 10;

  // ---- JSON snapshots (#14) ------------------------------------------------

  const SNAPSHOT_FORMAT = "s4save-snapshot";
  const SNAPSHOT_VERSION = 1;

  // A whole save as human-readable JSON. Deliberately the decoded *values*, not the bytes: it
  // carries no copyrighted game data, so it can be pasted into a bug report, and it survives a
  // change of container format because it never mentions one.
  function snapshotFromSave(save, { app = null } = {}) {
    if (!save) return null;
    return {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      game: "Suikoden IV",
      app: app || undefined,
      region: save.region || undefined,
      exported: new Date().toISOString(),
      save: {
        potch: save.potch,
        gameTimeSec: save.gameTimeSec,
        names: Object.fromEntries((save.names || []).map((n) => [n.key, n.value])),
      },
      characters: (save.characters || []).map((c) => ({
        rosterIndex: c.rosterIndex,
        name: c.name,
        recruited: c.recruited,
        exp: c.exp,
        weaponLvl: c.weaponLvl,
        maxHP: c.maxHP,
        stats: { ...(c.stats || {}) },
        runes: [...(c.runes || [])],
        equip: { ...(c.equip || {}) },
        unites: [...(c.unites || [])],
      })),
    };
  }

  // Turn a snapshot into staged edits against the loaded save.
  //
  // Returns { error } for a snapshot that must not be applied, or { saveEdits, names, charEdits,
  // skipped } to hand to the normal review-and-Apply path. It never writes: an imported snapshot
  // is exactly as reviewable as a hand edit (CLAUDE.md rule 2).
  //
  // Matching is by rosterIndex, not by name or array position — a snapshot taken before a
  // rename, or from a save with a different number of decoded characters, still lands on the
  // right records. A character the loaded save doesn't have is reported in `skipped` rather than
  // silently dropped, because "nothing happened and I don't know why" is the worst outcome here.
  function diffSnapshot(save, snap) {
    if (!save) return { error: "No save is loaded." };
    if (!snap || typeof snap !== "object") return { error: "That file isn't a snapshot." };
    if (snap.format !== SNAPSHOT_FORMAT)
      return { error: `That file is ${snap.format ? `a "${snap.format}"` : "not a snapshot"}, not a Suikoden IV save snapshot.` };
    if (typeof snap.version !== "number" || snap.version > SNAPSHOT_VERSION)
      return { error: `That snapshot was written by a newer version of this editor (format v${snap.version}); this build understands v${SNAPSHOT_VERSION}.` };

    const saveEdits = {}, names = {}, charEdits = {}, skipped = [];
    const s = snap.save || {};

    if (Number.isFinite(s.potch) && s.potch !== save.potch) saveEdits.potch = s.potch;
    if (Number.isFinite(s.gameTimeSec) && s.gameTimeSec !== save.gameTimeSec) saveEdits.gameTime = s.gameTimeSec;
    for (const [k, v] of Object.entries(s.names || {})) {
      const cur = (save.names || []).find((n) => n.key === k);
      if (!cur) { skipped.push(`name "${k}"`); continue; }
      if (typeof v === "string" && v !== cur.value) names[k] = v;
    }

    const byRi = new Map((save.characters || []).map((c) => [c.rosterIndex, c]));
    for (const sc of snap.characters || []) {
      const c = byRi.get(sc.rosterIndex);
      if (!c) { skipped.push(`character #${sc.rosterIndex}${sc.name ? ` (${sc.name})` : ""}`); continue; }
      const e = {};
      for (const k of ["recruited", "exp", "weaponLvl", "maxHP"]) {
        if (Number.isFinite(sc[k]) && sc[k] !== c[k]) e[k] = sc[k];
      }
      for (const [st, v] of Object.entries(sc.stats || {})) {
        if (Number.isFinite(v) && v !== (c.stats || {})[st]) (e.stats = e.stats || {})[st] = v;
      }
      (sc.runes || []).forEach((v, i) => {
        if (Number.isFinite(v) && v !== ((c.runes || [])[i] || 0)) (e.runes = e.runes || {})[i] = v;
      });
      for (const [slot, v] of Object.entries(sc.equip || {})) {
        if (Number.isFinite(v) && v !== ((c.equip || {})[slot] || 0)) (e.equip = e.equip || {})[slot] = v;
      }
      (sc.unites || []).forEach((v, i) => {
        if (Number.isFinite(v) && v !== ((c.unites || [])[i] || 0)) (e.unites = e.unites || {})[i] = v;
      });
      if (Object.keys(e).length) charEdits[sc.rosterIndex] = e;
    }
    return { saveEdits, names, charEdits, skipped };
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
    lvFromExp, expFromLv, gtLabel, recName, affFor, buildDiff, createJournal, revertStaged,
    snapshotFromSave, diffSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_VERSION,
    derivePartyState, PARTY_MAX, PARTY_REMOVE_TO, IN_PARTY,
    auditSave, applyFix, STAT_MAX,
    slotItemIds, SLOT_SHORTLIST_MIN,
  };
  Object.assign(root, API);
  root.S4Core = API;
})(typeof module !== "undefined" && module.exports ? module.exports : window);
