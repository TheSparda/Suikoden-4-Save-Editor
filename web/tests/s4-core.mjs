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
        lvFromExp, expFromLv, gtLabel, recName, affFor, buildDiff } = core;

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

console.log(failures ? `\nFAILED (${failures})` : "\nAll s4-core checks passed.");
process.exit(failures ? 1 : 0);
