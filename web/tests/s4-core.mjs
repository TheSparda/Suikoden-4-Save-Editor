// s4-core.mjs — exercises the real rules headlessly (issue #2).
//
// This is the first S4 test that runs logic rather than asserting that a string appears in a
// file. Everything here calls the same code the browser calls; nothing is re-implemented, and a
// copy of a rule living in this file would defeat the point of the module existing.
//
// Fixtures are built from the module's own constants (CLAUDE.md rule 3) — no save, no disc, and
// no hand-written expected values that could drift from the engine.
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const core = createRequire(import.meta.url)(path.resolve(HERE, "..", "s4-core.js"));
const { REC_STATES, CHAR_CAP, POTCH_MAX, LV_MAX, AFF_RATE, AFF_ALIAS,
        lvFromExp, expFromLv, gtLabel, recName, affFor, buildDiff, createJournal, revertStaged,
        snapshotFromSave, diffSnapshot, SNAPSHOT_FORMAT, SNAPSHOT_VERSION,
        derivePartyState, PARTY_MAX, PARTY_REMOVE_TO, IN_PARTY,
        auditSave, applyFix, STAT_MAX } = core;

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const is = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m)
  : bad(`${m}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`));

// ---- level ↔ EXP ----------------------------------------------------------
console.log("Level ↔ EXP:");

// The round-trip only holds in this direction. expFromLv maps a level to the *lowest* EXP that
// displays it, so exp → lv → exp floors to the level boundary and is not an identity: EXP 1500
// reads as Lv 2, and Lv 2 writes 1000. Asserting the identity the other way round would fail for
// every EXP that isn't an exact multiple of 1000, which is nearly all of them.
{
  let allRoundTrip = true, firstBad = null;
  for (let lv = 1; lv <= LV_MAX; lv++) {
    if (lvFromExp(expFromLv(lv)) !== lv) { allRoundTrip = false; firstBad ??= lv; }
  }
  (allRoundTrip ? ok : bad)(`lvFromExp(expFromLv(lv)) === lv for all ${LV_MAX} levels`
    + (firstBad ? ` — first failure at Lv ${firstBad}` : ""));
}

// The lossy direction, stated explicitly so a future change that "fixes" it has to face the test.
is(lvFromExp(1500), 2, "EXP 1500 reads as Lv 2");
is(expFromLv(lvFromExp(1500)), 1000, "exp → lv → exp floors to the level boundary (1500 → 1000)");

is(lvFromExp(0), 1, "EXP 0 is Lv 1 (not Lv 0)");
is(expFromLv(1), 0, "Lv 1 is EXP 0");

// Caps. CHAR_CAP.exp is not an arbitrary number: it is the largest EXP that still reads as Lv 99,
// so the cap and the level formula have to agree or one of them is wrong.
is(lvFromExp(CHAR_CAP.exp), LV_MAX, `CHAR_CAP.exp (${CHAR_CAP.exp}) is exactly Lv ${LV_MAX}`);
is(lvFromExp(CHAR_CAP.exp + 1000000), LV_MAX, "EXP far above the cap still clamps to Lv 99");
is(expFromLv(0), 0, "Lv 0 clamps up to Lv 1's EXP");
is(expFromLv(9999), expFromLv(LV_MAX), "Lv above 99 clamps down to Lv 99's EXP");
is(lvFromExp(null), 1, "null EXP is Lv 1, not NaN");
is(lvFromExp(undefined), 1, "undefined EXP is Lv 1, not NaN");

console.log("Caps:");
is(CHAR_CAP, { maxHP: 9999, exp: 98999, weaponLvl: 15 }, "CHAR_CAP matches the documented caps");
is(POTCH_MAX, 99999999, "POTCH_MAX matches the documented cap");

// ---- recruitment enum -----------------------------------------------------
console.log("Recruitment enum:");
{
  const selfNaming = REC_STATES.every(([v, label]) => recName(v) === label);
  (selfNaming ? ok : bad)(`every REC_STATES value names itself (${REC_STATES.length} states)`);
}
is(REC_STATES.map(([v]) => v), [0, 1, 10, 11, 15], "the five writable bytes are the documented ones");
// House rule 1: an unknown byte is surfaced as unknown with its raw value, never coerced to the
// nearest known state.
is(recName(7), "? (7)", "an unknown byte reports itself as unknown and keeps its value");
is(recName(255), "? (255)", "an out-of-range byte is not mapped to a known state");
{
  const dupes = REC_STATES.length !== new Set(REC_STATES.map(([v]) => v)).size;
  (!dupes ? ok : bad)("no duplicate enum values");
}

// ---- game-time label ------------------------------------------------------
console.log("Game time:");
is(gtLabel(0), "0h00m", "zero renders padded");
is(gtLabel(3600), "1h00m", "exactly one hour");
is(gtLabel(3599), "0h59m", "one second short of an hour does not round up");
is(gtLabel(86400 + 61), "24h01m", "past 24h it keeps counting hours rather than wrapping");
is(gtLabel(null), "0h00m", "null is 0h00m, not NaN");

// ---- affinity resolution --------------------------------------------------
console.log("Affinity resolution:");
{
  const [rosterName, tableKey] = Object.entries(AFF_ALIAS)[0];
  const table = { [tableKey]: [1, 2, 3, 4, 1], Lazlo: [4, 4, 4, 4, 4] };
  is(affFor(table, "Lazlo"), [4, 4, 4, 4, 4], "a direct name hit resolves");
  is(affFor(table, rosterName), [1, 2, 3, 4, 1], `the roster alias resolves (${rosterName} → ${tableKey})`);
  is(affFor(table, "Nobody"), null, "an unknown name resolves to null, not a placeholder");
  is(affFor(null, "Lazlo"), null, "a missing table resolves to null rather than throwing");
  is(Object.keys(AFF_RATE).map(Number), [1, 2, 3, 4], "affinity ratings are 1–4");
}

// ---- buildDiff: the staged-edit → review-row transform ---------------------
console.log("buildDiff — staged edits become review rows:");

const save = {
  potch: 1000,
  gameTimeSec: 3600,
  names: [{ key: "hero", label: "Hero name", value: "Lazlo" }],
  characters: [{
    rosterIndex: 0, name: "Lazlo", exp: 1000, weaponLvl: 3, maxHP: 100,
    recruited: 10, stats: { STR: 50 }, runes: [7, 0, 0],
    equip: { head: 11, body: 0 }, unites: [2], uniteNames: { 0: { name: "Sky Rune" } },
  }],
};
const labels = { item: (id) => (id ? `Item${id}` : "— empty —"), rune: (id) => (id ? `Rune${id}` : "— none —") };
const diff = (o) => buildDiff({ save, labels, ...o });

is(diff({}), [], "no staged edits produce no rows");

// The property that makes the dirty badge honest: staging a value equal to the file's is not a
// change. Every branch is checked, because each one re-implements the comparison.
{
  const noop = diff({
    saveEdits: { potch: 1000, gameTime: 3600 },
    names: { hero: "Lazlo" },
    charEdits: { 0: { exp: 1000, weaponLvl: 3, maxHP: 100, recruited: 10,
                      stats: { STR: 50 }, runes: { 0: 7 }, equip: { head: 11 }, unites: { 0: 2 } } },
  });
  is(noop, [], "staging every field back to its existing value produces no rows");
}

is(diff({ saveEdits: { potch: 5000 } }), [{ g: "Save", t: "Potch: 1000 → 5000" }], "potch change");
is(diff({ saveEdits: { gameTime: 7200 } }),
   [{ g: "Save", t: "Game time: 1h00m → 2h00m" }], "game time renders through gtLabel");
is(diff({ saveEdits: { worldMapFull: true } }),
   [{ g: "Save", t: "World map → mark fully explored" }], "world-map flag");
is(diff({ names: { hero: "Sparda" } }),
   [{ g: "Names", t: 'Hero name: "Lazlo" → "Sparda"' }], "name change uses the field's own label");
is(diff({ names: { nosuch: "x" } }), [], "a name key the save doesn't have is skipped, not invented");

is(diff({ charEdits: { 0: { exp: 5000 } } }),
   [{ g: "Lazlo", t: "Level 2 → 6 (EXP 1000 → 5000)" }], "EXP row shows both level and raw EXP");
is(diff({ charEdits: { 0: { stats: { STR: 99 } } } }),
   [{ g: "Lazlo", t: "STR: 50 → 99" }], "stat change");
is(diff({ charEdits: { 0: { maxHP: 999 } } }), [{ g: "Lazlo", t: "Max HP: 100 → 999" }], "max HP");
is(diff({ charEdits: { 0: { weaponLvl: 9 } } }), [{ g: "Lazlo", t: "Weapon Lv: 3 → 9" }], "weapon level");
is(diff({ charEdits: { 0: { recruited: 11 } } }),
   [{ g: "Lazlo", t: "Recruitment: Recruited → In Party" }], "recruitment renders enum names");
is(diff({ charEdits: { 0: { runes: { 0: 9 } } } }),
   [{ g: "Lazlo", t: "Rune 1: Rune7 → Rune9" }], "rune slot is 1-indexed for display");
is(diff({ charEdits: { 0: { equip: { head: 22 } } } }),
   [{ g: "Lazlo", t: "Head: Item11 → Item22" }], "equipment uses the slot's friendly label");
is(diff({ charEdits: { 0: { equip: { body: 5 } } } }),
   [{ g: "Lazlo", t: "Body: — empty — → Item5" }], "filling an empty slot reads as empty, not #0");
is(diff({ charEdits: { 0: { unites: { 0: 4 } } } }),
   [{ g: "Lazlo", t: "Unite Sky Rune: 2 → 4" }], "unite uses its name when known");

// House rule 1 again: with no label lookups supplied, ids render as #id rather than as a guess.
is(buildDiff({ save, charEdits: { 0: { equip: { head: 22 } } } }),
   [{ g: "Lazlo", t: "Head: #11 → #22" }], "without label lookups, ids render as #id (never invented)");

// A roster index the save doesn't contain still produces a row, labelled by index — an edit is
// never silently dropped just because the character record is missing.
is(diff({ charEdits: { 99: { maxHP: 5 } } }),
   [{ g: "#99", t: "Max HP: undefined → 5" }], "an unknown roster index is labelled, not dropped");

// Object.entries gives string keys; the character lookup has to tolerate both.
is(diff({ charEdits: { "0": { maxHP: 999 } } }),
   [{ g: "Lazlo", t: "Max HP: 100 → 999" }], "string and numeric roster keys both resolve");

is(buildDiff({}), [], "no save loaded produces no rows rather than throwing");
is(buildDiff(), [], "called with no arguments at all, returns no rows");

{
  const many = diff({ saveEdits: { potch: 2 }, charEdits: { 0: { maxHP: 1, weaponLvl: 1 } } });
  is(many.length, 3, "multiple edits across groups all appear");
}

// ---- per-field restore ----------------------------------------------------
console.log("revertStaged — per-field restore:");
{
  const mk = () => ({
    saveEdits: { potch: 500, gameTime: 7200, worldMapFull: 1 },
    names: { hero: "Sparda", ship: "Dauntless" },
    charEdits: { 0: { exp: 6000, maxHP: 999, recruited: 11,
                      stats: { STR: 777, SKL: 5 }, runes: { 0: 9 }, equip: { head: 2 }, unites: { 0: 3 } } },
  });

  let o = mk(); revertStaged(o, "potch");
  is([("potch" in o.saveEdits), o.saveEdits.gameTime], [false, 7200], "potch drops without touching game time");
  o = mk(); revertStaged(o, "worldMapFull");
  is("worldMapFull" in o.saveEdits, false, "world-map flag drops");
  o = mk(); revertStaged(o, "name:hero");
  is(o.names, { ship: "Dauntless" }, "one name drops, the other stays");

  o = mk(); revertStaged(o, "k:maxHP", 0);
  is([("maxHP" in o.charEdits[0]), o.charEdits[0].exp], [false, 6000], "a scalar field drops, siblings stay");
  o = mk(); revertStaged(o, "recruit", 0);
  is("recruited" in o.charEdits[0], false, "recruitment drops");
  o = mk(); revertStaged(o, "stat:STR", 0);
  is(o.charEdits[0].stats, { SKL: 5 }, "one stat drops, the rest of the block survives");
  o = mk(); revertStaged(o, "rune:0", 0);
  is("runes" in o.charEdits[0], false, "emptying the rune block removes the block");
  o = mk(); revertStaged(o, "equip:head", 0);
  is("equip" in o.charEdits[0], false, "emptying the equip block removes the block");
  o = mk(); revertStaged(o, "unite:0", 0);
  is("unites" in o.charEdits[0], false, "emptying the unite block removes the block");

  // Reverting the last staged field for a character removes the character entry entirely, so the
  // overlay never carries an empty {} that makes the editor look dirty when it isn't.
  o = { saveEdits: {}, names: {}, charEdits: { 0: { maxHP: 999 } } };
  revertStaged(o, "k:maxHP", 0);
  is(o.charEdits, {}, "the last field for a character removes the character entry");
  o = { saveEdits: {}, names: {}, charEdits: { 0: { stats: { STR: 1 } } } };
  revertStaged(o, "stat:STR", 0);
  is(o.charEdits, {}, "…including when the last field was inside a nested block");

  // Reverting is a no-op when there is nothing staged — it must never invent an entry.
  o = { saveEdits: {}, names: {}, charEdits: {} };
  revertStaged(o, "k:maxHP", 7);
  is(o.charEdits, {}, "reverting an unstaged character creates nothing");
  revertStaged(o, "stat:STR", 7);
  is(o.charEdits, {}, "…and neither does a nested revert");

  // The property the whole feature rests on: after reverting every staged field, buildDiff sees
  // nothing. Not "sees empty objects" — sees nothing.
  o = mk();
  for (const w of ["potch", "gameTime", "worldMapFull"]) revertStaged(o, w);
  for (const w of ["name:hero", "name:ship"]) revertStaged(o, w);
  for (const w of ["k:exp", "k:maxHP", "recruit", "stat:STR", "stat:SKL", "rune:0", "equip:head", "unite:0"])
    revertStaged(o, w, 0);
  is([o.saveEdits, o.names, o.charEdits], [{}, {}, {}], "reverting every field leaves all three overlays empty");
  is(buildDiff({ save, saveEdits: o.saveEdits, names: o.names, charEdits: o.charEdits }), [],
     "…and buildDiff reports no changes");
}

// ---- health lint ----------------------------------------------------------
console.log("Health lint — the file plus staged edits:");
{
  const mk = (over = {}) => ({
    potch: 1000,
    characters: [{ rosterIndex: 0, name: "Lazlo", exp: 1000, weaponLvl: 3, maxHP: 100,
                   recruited: 10, stats: { STR: 50 }, runes: [7, 0, 0], equip: { head: 11 },
                   ...over }],
  });
  const ids = (n) => new Set([...Array(n).keys()].map((i) => i + 1));
  const audit = (save, opts) => auditSave(save, opts);
  const idsOf = (fs) => fs.map((f) => f.id);

  is(audit(mk()), [], "a clean save with no staged edits reports nothing");
  is(audit(null), [], "no save reports nothing rather than throwing");

  // The headline case: a value the engine will silently reduce, caught BEFORE it is written,
  // quoting what will actually land.
  const clamp = audit(mk(), { charEdits: { 0: { maxHP: 99999 } } });
  is(idsOf(clamp), ["clamp-maxHP-0"], "an over-cap staged Max HP is caught before it is written");
  is(/will be written as 9999/.test(clamp[0].title), true,
     "…and the finding quotes the value that will actually land");
  is(clamp[0].sev, "warning", "a silent clamp is a warning, not a problem");

  // It lints the FILE as well as the edits: damage already present is caught with no staging
  // at all, which is the "catches both" half of the issue.
  is(idsOf(audit(mk({ maxHP: 99999 }))), ["clamp-maxHP-0"],
     "an over-cap value already in the file is caught with nothing staged");
  // ...and a staged edit that FIXES a file problem clears it, proving the overlay really is what
  // gets audited rather than the file being re-read underneath it.
  is(audit(mk({ maxHP: 99999 }), { charEdits: { 0: { maxHP: 500 } } }), [],
     "staging a valid value over a bad file value clears the finding");
  is(idsOf(audit(mk(), { saveEdits: { potch: POTCH_MAX + 1 } })), ["clamp-potch"],
     "an over-cap staged potch is caught");
  is(idsOf(audit(mk(), { charEdits: { 0: { stats: { STR: 5000 } } } })), ["clamp-stat-0-STR"],
     "an over-cap staged stat is caught");
  is(idsOf(audit(mk(), { charEdits: { 0: { exp: CHAR_CAP.exp + 1 } } })), ["clamp-exp-0"],
     "an over-cap staged EXP is caught");

  // Enum purity and the party it implies.
  is(idsOf(audit(mk(), { charEdits: { 0: { recruited: 7 } } })), ["recruit-enum"],
     "an out-of-enum recruitment value is a problem");
  is(audit(mk(), { charEdits: { 0: { recruited: 11 } } }), [],
     "a valid in-party value is not a finding");
  {
    const many = { characters: [0, 1, 2, 3, 4].map((i) => ({ rosterIndex: i, name: "C" + i,
      recruited: 11, stats: {}, runes: [], equip: {} })) };
    is(idsOf(audit(many)), ["party-overfull"], "a fifth party member is reported");
  }

  // Id membership only runs when the table is supplied (rule 1).
  is(audit(mk({ runes: [999, 0, 0] })), [], "with no rune table, an unknown rune id is NOT reported");
  is(idsOf(audit(mk({ runes: [999, 0, 0] }), { runeIds: ids(42) })), ["rune-id-0-0"],
     "with a rune table, an unknown rune id is a problem");
  is(audit(mk({ runes: [7, 0, 0] }), { runeIds: ids(42) }), [],
     "a known rune id is not a finding");
  is(idsOf(audit(mk({ equip: { head: 9999 } }), { itemIds: ids(519) })), ["item-id-0-head"],
     "an unknown equipment id is a problem");
  is(audit(mk({ equip: { head: 0 } }), { itemIds: ids(519) }), [],
     "an empty slot is not an unknown id");

  is(idsOf(audit(mk(), { charEdits: { 0: { exp: -5 } } })), ["exp-negative-0"],
     "a negative EXP is a problem");

  // Fixes STAGE. They must produce overlays, never touch a save.
  {
    const f = audit(mk(), { charEdits: { 0: { maxHP: 99999 } } })[0];
    const overlays = { saveEdits: {}, charEdits: { 0: { maxHP: 99999 } } };
    applyFix(overlays, f.fix);
    is(overlays.charEdits, { 0: { maxHP: CHAR_CAP.maxHP } }, "the fix stages the clamped value");
    is(audit(mk(), overlays), [], "…and re-auditing after the fix is clean");
  }
  {
    const f = audit(mk({ runes: [999, 0, 0] }), { runeIds: ids(42) })[0];
    const o = { saveEdits: {}, charEdits: {} };
    applyFix(o, f.fix);
    is(o.charEdits, { 0: { runes: { 0: 0 } } }, "clearing a bad rune slot stages a rune edit");
  }
  {
    const o = { saveEdits: {}, charEdits: {} };
    applyFix(o, { ops: [{ kind: "save", key: "potch", value: 5 }] });
    is(o.saveEdits, { potch: 5 }, "a save-wide fix stages a save edit");
  }

  // Every finding either carries a fix or says why it can't be auto-fixed — asserted so a future
  // check can't quietly ship as an unactionable complaint.
  {
    const all = [
      ...audit(mk(), { charEdits: { 0: { maxHP: 99999, recruited: 7, exp: -1 } } , itemIds: ids(519) }),
      ...audit(mk({ runes: [999, 0, 0] }), { runeIds: ids(42) }),
    ];
    const noFix = all.filter((f) => !f.fix).map((f) => f.id);
    is(noFix, ["recruit-enum"], "only the finding that needs a human decision lacks a fix");
    is(all.every((f) => f.title && f.sev && (f.fix ? f.fix.label && f.fix.ops.length : true)), true,
       "every finding is fully formed");
  }
}

// ---- party derivation -----------------------------------------------------
console.log("Party — derived from the recruitment enum:");
{
  const mk = (i, name, recruited) => ({ rosterIndex: i, name, recruited, stats: {}, runes: [], equip: {} });
  const of = (...cs) => derivePartyState({ characters: cs });

  is(of().members, [], "no characters means an empty party, not a throw");
  is(derivePartyState(null).members, [], "no save at all is handled");
  is(of(mk(0, "Lazlo", 15), mk(1, "Snowe", 10), mk(2, "Kika", 11)).members.map((m) => m.name),
     ["Lazlo", "Kika"], "only 11 and 15 count as in the party");
  is(IN_PARTY, [11, 15], "the two in-party values are the documented ones");
  is(of(mk(0, "Lazlo", 15)).members[0].locked, true, "15 is flagged as locked (can't be removed)");
  is(of(mk(1, "Kika", 11)).members[0].locked, false, "11 is not locked");

  // Order is NOT claimed — the formation array hasn't been located, so saying otherwise would be
  // inventing data the editor doesn't have.
  is(of(mk(0, "A", 11)).ordered, false, "the derivation does not claim to know slot order");
  is(PARTY_MAX, 4, "the party size is the documented one");

  // Over-full is a warning, not an error: the enum permits it and the game's behaviour is
  // unverified, so the wording says "may" rather than asserting a consequence (rule 1).
  const over = of(...[11, 11, 11, 11, 11].map((r, i) => mk(i, "C" + i, r)));
  is(over.problems.map((p) => p.id), ["party-overfull"], "a fifth party member is reported");
  is(over.problems[0].sev, "warn", "…as a warning, since the enum allows it");
  is(of(...[11, 11, 11, 11].map((r, i) => mk(i, "C" + i, r))).problems, [],
     "exactly four is not a problem");

  // Removing means Recruited, not Not Recruited — dropping to 0 would un-recruit someone the
  // player actually has, which is a different and much worse edit.
  is(PARTY_REMOVE_TO, 10, "leaving the party sets Recruited (10), never Not Recruited (0)");
}

// ---- JSON snapshots -------------------------------------------------------
console.log("Snapshots — export / import:");
{
  const snap = snapshotFromSave(save, { app: "1.6.5" });
  is([snap.format, snap.version, snap.game], [SNAPSHOT_FORMAT, SNAPSHOT_VERSION, "Suikoden IV"],
     "a snapshot names its format, version and game");
  is(snap.characters.length, save.characters.length, "every decoded character is included");
  is(snap.save.names, { hero: "Lazlo" }, "names are exported keyed, not positional");

  // The property that makes this safe to attach to a bug report.
  const text = JSON.stringify(snap);
  is(/item|rune/i.test(text) && /Item\d|Rune\d/.test(text), false,
     "a snapshot carries values, never resolved game text");

  // The acceptance criterion: a round trip with nothing changed stages nothing.
  const rt = diffSnapshot(save, JSON.parse(JSON.stringify(snap)));
  is([rt.error, rt.skipped], [undefined, []], "an untouched snapshot imports without error");
  is(buildDiff({ save, ...rt }), [], "export → import on an unmodified save stages ZERO changes");

  // ...and one hand edit stages exactly one reviewable change.
  const edited = JSON.parse(JSON.stringify(snap));
  edited.characters[0].maxHP = 777;
  const one = diffSnapshot(save, edited);
  is(one.charEdits, { 0: { maxHP: 777 } }, "one hand-edited field produces exactly one staged edit");
  is(buildDiff({ save, ...one, labels }), [{ g: "Lazlo", t: "Max HP: 100 → 777" }],
     "…and exactly one reviewable row");

  // Matching is by rosterIndex, so a snapshot taken before a rename still lands correctly.
  const renamed = JSON.parse(JSON.stringify(snap));
  renamed.characters[0].name = "Someone Else";
  renamed.characters[0].exp = 9000;
  is(diffSnapshot(save, renamed).charEdits, { 0: { exp: 9000 } },
     "a character renamed in the snapshot still matches by roster index");

  // A character the loaded save doesn't have is reported, never silently dropped.
  const extra = JSON.parse(JSON.stringify(snap));
  extra.characters.push({ rosterIndex: 99, name: "Ghost", maxHP: 5 });
  const ex = diffSnapshot(save, extra);
  is(ex.skipped, ["character #99 (Ghost)"], "a character not in this save is reported as skipped");
  is(ex.charEdits, {}, "…and stages nothing for it");

  // Refusals.
  is(diffSnapshot(save, { format: "s3save-snapshot", version: 1 }).error !== undefined, true,
     "a snapshot from another game is refused");
  is(/s3save-snapshot/.test(diffSnapshot(save, { format: "s3save-snapshot", version: 1 }).error), true,
     "…and the message says what it actually was");
  is(diffSnapshot(save, { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION + 1 }).error !== undefined, true,
     "a snapshot from a newer build is refused rather than half-read");
  is(diffSnapshot(save, null).error !== undefined, true, "a non-object is refused");
  is(diffSnapshot(null, snap).error !== undefined, true, "importing with no save loaded is refused");

  // Junk values must not stage. A snapshot is user-editable text, so this is a real input.
  const junk = JSON.parse(JSON.stringify(snap));
  junk.characters[0].maxHP = "lots";
  junk.characters[0].exp = null;
  junk.save.potch = "9999";
  const jd = diffSnapshot(save, junk);
  is([jd.charEdits, jd.saveEdits], [{}, {}],
     "non-numeric values in a hand-edited snapshot are ignored, not coerced");
}

// ---- staging journal ------------------------------------------------------
console.log("Staging journal — undo/redo:");
{
  // A scripted edit sequence over a toy state, driven exactly the way both editors drive it:
  // snapshot before, snapshot after, record the pair.
  let state = { hp: 100 };
  let clock = 1000;
  const j = createJournal({ coalesceMs: 600, now: () => clock });
  const set = (key, label, v) => {
    const before = { ...state };
    state = { ...state, hp: v };
    const after = { ...state };
    j.record({ key, label, undo: () => (state = before), redo: () => (state = after) });
  };

  is([j.canUndo(), j.canRedo()], [false, false], "a fresh journal has nothing to undo or redo");
  is(j.undo(), false, "undo on an empty journal is a no-op, not a throw");
  is(j.redo(), false, "redo on an empty journal is a no-op, not a throw");

  clock = 1000; set("hp", "Max HP", 200);
  clock = 3000; set("hp", "Max HP", 300);      // outside the window → its own step
  is(j.depth(), { undo: 2, redo: 0 }, "two separate edits are two steps");
  is(state.hp, 300, "state advanced");

  j.undo(); is(state.hp, 200, "undo steps back one edit");
  j.undo(); is(state.hp, 100, "undo back to the original value");
  is(j.canUndo(), false, "nothing left to undo");
  is(j.depth(), { undo: 0, redo: 2 }, "both edits are now redoable");

  j.redo(); is(state.hp, 200, "redo replays the first edit");
  j.redo(); is(state.hp, 300, "redo replays the second");
  is(j.canRedo(), false, "nothing left to redo");

  // Forking: a new edit after an undo discards the redo branch, as every editor does.
  j.undo();
  clock = 9000; set("hp", "Max HP", 999);
  is([j.canRedo(), state.hp], [false, 999], "a new edit after undo discards the redo branch");
}

console.log("Journal — coalescing:");
{
  let state = 0, clock = 0;
  const j = createJournal({ coalesceMs: 600, now: () => clock });
  const type = (v) => {
    const before = state, after = v;
    state = v;
    j.record({ key: "rate", label: "Encounter rate", undo: () => (state = before), redo: () => (state = after) });
  };
  // Typing "250" fires three input events in quick succession.
  clock = 0; type(2); clock = 80; type(25); clock = 160; type(250);
  is(j.depth().undo, 1, "a burst of typing in one field collapses to a single undo step");
  j.undo();
  is(state, 0, "undoing that burst returns the *original* value, not an intermediate keystroke");

  // A different field never coalesces, however fast.
  let s2 = { a: 0, b: 0 }; clock = 0;
  const j2 = createJournal({ coalesceMs: 600, now: () => clock });
  const rec = (k) => { const before = { ...s2 }; s2 = { ...s2, [k]: 1 }; const after = { ...s2 };
    j2.record({ key: k, label: k, undo: () => (s2 = before), redo: () => (s2 = after) }); };
  rec("a"); clock = 10; rec("b");
  is(j2.depth().undo, 2, "two different fields stay two steps even within the window");

  // Pausing past the window starts a new step.
  let s3 = 0; clock = 0;
  const j3 = createJournal({ coalesceMs: 600, now: () => clock });
  const r3 = (v) => { const b = s3, a = v; s3 = v;
    j3.record({ key: "x", label: "x", undo: () => (s3 = b), redo: () => (s3 = a) }); };
  r3(1); clock = 5000; r3(2);
  is(j3.depth().undo, 2, "pausing longer than the window starts a new step");

  // seal() ends the current step explicitly — what a blur handler uses.
  let s4v = 0; clock = 0;
  const j4 = createJournal({ coalesceMs: 600, now: () => clock });
  const r4 = (v) => { const b = s4v, a = v; s4v = v;
    j4.record({ key: "x", label: "x", undo: () => (s4v = b), redo: () => (s4v = a) }); };
  r4(1); j4.seal(); clock = 10; r4(2);
  is(j4.depth().undo, 2, "seal() forces the next edit into a new step even inside the window");
}

console.log("Journal — bounds and notifications:");
{
  let clock = 0, fired = 0;
  const j = createJournal({ limit: 3, coalesceMs: 0, now: () => ++clock, onChange: () => fired++ });
  const noop = { undo() {}, redo() {} };
  for (let i = 0; i < 5; i++) j.record({ label: `e${i}`, undo: noop.undo, redo: noop.redo });
  is(j.depth().undo, 3, "the stack is bounded — oldest entries drop past the limit");
  is(j.undoLabel(), "e4", "the newest entry is on top");
  is(fired, 5, "onChange fires once per record");
  j.undo(); is(fired, 6, "onChange fires on undo");
  j.redo(); is(fired, 7, "onChange fires on redo");
  j.reset();
  is([j.depth(), j.undoLabel(), j.redoLabel()], [{ undo: 0, redo: 0 }, null, null],
     "reset clears both stacks and both labels");
}

console.log(failures ? `\nFAILED (${failures})` : "\nAll s4-core checks passed.");
process.exit(failures ? 1 : 0);
