# Suikoden IV Editor — capability gap audit against the Suikoden III Editor

**Audited:** 2026-09-12
**Subject:** `TheSparda/Suikoden-4-Save-Editor` @ `3b2ea22` (web app v1.6.5)
**Benchmark:** `TheSparda/Suikoden-3-Editor` @ `4e2a739` (web app v1.152.0)

This document exists to be **turned into issues**. Every numbered entry below is written as a
self-contained issue body: what the Suikoden III editor does, why it matters, exactly where the
reference implementation lives, a concrete build plan for S4, a reverse-engineering recipe where
the data isn't located yet, acceptance criteria, and the known risks.

Nothing here is aspirational hand-waving — every "S3 does X" claim is anchored to a file and line
in the S3 repo, and every "S4 lacks X" claim was checked against the S4 source, not its README.

---

## 0. Scorecard

| | Suikoden III editor | Suikoden IV editor |
|---|---|---|
| Web app source | `app.js` 2,574 L · `iso.js` 10,782 L · **9 shared core modules** | `app.js` 879 L · `iso.js` 467 L · **0 shared core modules** |
| Save-editor tabs | Overview + **7** (Characters, Recruit, 108 Stars, Party, Field character, Inventory, Health) | Overview + **2** (Characters, Recruit) |
| ISO-editor tabs | **22** (Characters, Growth, Support, Weapons, Shops, Runes, Passives, Spells, Unites, Mounts, Story content, Gear, Sets, Food, Movement, Encounter, Enemies, War, Text, Reference, Test, Changes) | **0** — a single flat list of **3** fields in one group |
| Editable ISO fields | thousands (94 spells, 38 unites, ~1,960 enemy variants, 4,403 sub-files indexed, 270 audited code-patch constants) | **3** (encounter rate, Champion's Rune always-on, battles off) |
| Undo / redo | ✅ `iso.js:2028` full stack + Ctrl/Cmd+Z | ❌ none (`grep -c undo` → 0) |
| Staged edits + review | ✅ both editors | ✅ both editors |
| Per-field revert (`↺`) / Revert all | ✅ | ❌ |
| Mod sharing (`.s3mod` recipe, `.xdelta` in/out) | ✅ `iso.js:3186`, own VCDIFF codec `vcdiff.js` | ❌ |
| pnach export | ❌ | ✅ `iso.js:217` — **S4 is ahead here** |
| Disc diff vs pristine ("Changes" tab) | ✅ `iso.js:10533` + `changes-core.js` | ❌ |
| Code-patch audit + restore-to-stock | ✅ 270 constants, `tests/stock-restore.mjs` | ❌ |
| Save health lint | ✅ `health-core.js` 520 L, 423 L of tests | ❌ |
| Guide overlays (caps, growth ranges, effects) | ✅ `guide-core.js` + 6 generated JSON tables | partial — rune affinities only |
| Reference browser | ✅ 8 sub-tabs incl. sub-file browser, item sources, music | 3 flat tables |
| Test suite | 17 Node suites + 5,533-line Playwright e2e + budget/shard runners + PCSX2 harness | 2 checks (`validate.mjs`, `save_roundtrip.py`) |
| Research docs | 8 dedicated docs + a 3,862-line offsets notebook | 2 docs (13 KB + 6 KB) |
| Emulator verification tooling | ✅ `tools/pcsx2/` (PINE socket, RAM snapshot/diff/scan, boot-verify) | ❌ |

**The headline:** the S4 save editor is a credible ~60% of the S3 save editor. The S4 **ISO
editor is ~2%** of the S3 ISO editor, and that is where almost all of the gap sits — because S3's
game data lives in the boot ELF where it can be read directly, while S4's lives inside the packed
`FILEDATA.*` archives that nobody has opened yet. **Issue #30 is the keystone**: until `FILEDATA`
is cracked, most of Part 3 cannot be built at all.

---

## How to file these

Suggested labels, used throughout:

- `area:save` · `area:iso` · `area:reference` · `area:infra` · `area:research` · `area:docs`
- `size:S` (≤ half a day) · `size:M` (1–3 days) · `size:L` (a week+) · `size:XL` (multi-week research)
- `blocked:filedata` — cannot start until issue **#30** lands
- `parity:s3` — a port of an existing, proven S3 feature

Entries marked **[PORT]** have a working S3 implementation to copy. Entries marked **[RESEARCH]**
need reverse engineering first and have no shortcut.

---

# Part 1 — Foundation & infrastructure

These are cheap, unblock everything downstream, and several of them are pure file copies. **Do
this part first.** Every later issue assumes #1–#4 exist.

---

## #1 — Extract shared logic into DOM-free `*-core.js` modules  **[PORT]**
`area:infra` · `size:M` · `parity:s3`

### What S3 does
S3 splits every non-trivial rule out of the UI into a pure, DOM-free, Pyodide-free module that
both the browser and the Node tests load:

| Module | Lines | Owns |
|---|---|---|
| `web/health-core.js` | 520 | save-health audit rules + item classification |
| `web/recruit-core.js` | 310 | recruitment staging math, team bitmask |
| `web/vcdiff.js` | 335 | full VCDIFF encoder/decoder |
| `web/blurb-core.js` | 165 | long-description collapse |
| `web/rename-core.js` | 117 | same-length disc-wide rename |
| `web/changes-core.js` | 106 | byte-run diff + field-map join |
| `web/svag-core.js` | 103 | PS-ADPCM audio decode |
| `web/guide-core.js` | 73 | guide reference joins |
| `web/text-core.js` | 69 | in-ELF string scanner |

Each is `(function (root) { … })(typeof module !== "undefined" ? module.exports : window)` so the
same file is a `<script>` tag in the browser and an `import` in a `.mjs` test.

The stated reason is in `health-core.js`'s own header: *"they used to live inline in app.js as a
second copy; owning them here means the audit and the inventory UI can never disagree."* The
second reason is testability — the save-editor UI needs Pyodide, which headless CI can't load, so
any rule left inside `app.js` is effectively untestable.

### Why it matters for S4
S4 has **zero** such modules. Every rule lives inline in `web/app.js` / `web/iso.js`, which means
`validate.mjs` can only do static text assertions (does the file parse, does this string appear)
rather than actually exercising logic. This is the single biggest reason S4's test suite is 2
checks instead of 17 — and it will get worse with every feature added.

### How to build it
1. Create `web/s4-core.js` as the first module, using the S3 IIFE/`module.exports` pattern verbatim
   (copy the wrapper from `web/guide-core.js`, the smallest example).
2. Move these out of `app.js` with no behaviour change:
   - `lvFromExp` / `expFromLv` (`app.js:62-63`) and the `CHAR_CAP` clamp table (`app.js:19`)
   - `affFor` + `AFF_ALIAS` affinity resolution (`app.js:25`, `app.js:130`)
   - `buildDiff()` (`app.js:602`) — the staged-edit → review-row transform
   - `recName()` / `REC_STATES` recruitment enum (`app.js:14`, `app.js:631`)
3. Add `<script src="s4-core.js">` to `index.html` **before** `app.js`.
4. Add `web/tests/s4-core.mjs` that imports it and asserts the round-trips
   (`expFromLv(lvFromExp(n)) === n` for every valid `n`, every `REC_STATES` value names itself,
   clamps land on the documented caps).
5. Wire it into `package.json`'s `test` script.

### Acceptance criteria
- [ ] `web/s4-core.js` exists and is loaded by both `index.html` and a new Node test.
- [ ] `app.js` contains no duplicate copy of any moved function.
- [ ] `npm test` runs the new suite and it exercises real logic, not string matching.
- [ ] No user-visible behaviour change.

---

## #2 — Undo / redo for every staged edit  **[PORT]**
`area:infra` · `size:M` · `parity:s3`

### What S3 does
`web/iso.js:2028` — `let UNDO = [], REDO = [], REC = null;` with `resetUndo()` at `:2053`. Every
write goes through a recorder that captures the pre-image byte run; the toolbar carries `↶`/`↷`
and binds `Ctrl/Cmd+Z` and `Shift+Ctrl/Cmd+Z`. This sits *on top of* per-field `↺` restore and
`Revert all` — three different granularities of undo.

### Why it matters for S4
S4 has none (`grep -c "undo" web/app.js web/iso.js` → `0 0`). Today the only way to unwind a
mis-click in the S4 editor is to reload the page and lose every staged edit. On an ISO editor with
a slider this is merely annoying; the moment S4 gains bulk operations (#20, #21) it becomes a
correctness problem — a bulk scale applied to the wrong scope is unrecoverable.

### How to build it
1. In `s4-core.js` (from #1), add a generic staging journal:
   `record(label, undoFn, redoFn)` pushing onto `UNDO`, clearing `REDO`.
2. In `app.js`, route every mutation of `CE` (`app.js:511` `ce(ri)`) and `NAMES` through it.
3. In `iso.js`, route every `f.write(dv, v)` call through it, capturing `w.buf.slice()` of the
   affected window before the write.
4. Add the `↶`/`↷` buttons next to the existing dirty badge, plus the keyboard bindings.
5. Add per-field `↺` (see #3) which pushes onto the same journal.

### Acceptance criteria
- [ ] Ctrl/Cmd+Z unwinds the last staged edit in both Save and ISO modes; Shift+Z redoes it.
- [ ] Undoing back to zero makes the dirty badge read clean and `buildDiff()` return `[]`.
- [ ] A new Node test drives the journal headlessly through a scripted edit sequence.

---

## #3 — Per-field `↺` restore and a global `Revert all`  **[PORT]**
`area:infra` · `size:S` · `parity:s3`

### What S3 does
Every editable field in both S3 editors carries a `↺` button that restores that one field to the
value the file was loaded with, and the toolbar carries `Revert all`. Because S3 keeps `orig`
alongside `buf` for every window (`iso.js` `WINDOWS[k] = {buf, orig, …}`), restore is a byte copy,
not a recomputation — so it is exact even for fields whose display value is derived.

### Why it matters for S4
S4 already keeps `orig` for every ISO window (`iso.js` `commitIso()` stores `orig: bytes.slice()`)
and `isDirty(k)` already compares against it — the data is *there*, it just isn't exposed. On the
save side `CE` is a sparse overlay, so restore is a `delete CE[ri][key]`. Both are a few lines.
This is the cheapest user-visible win in the whole document.

### How to build it
1. ISO: add a `↺` button to every field row, shown only when `isDirty(f.key)`. On click,
   `w.buf.set(w.orig)` for that window, then re-render.
2. Save: add `↺` per input, shown when `CE[ri]` has that key. On click, `delete CE[ri][key]`; if
   the object is empty, `delete CE[ri]` so `buildDiff()` stays honest.
3. Toolbar `Revert all`: clear `CE`, `NAMES`, and reset every ISO window to `orig`.
4. Both push onto the #2 journal so they are themselves undoable.

### Acceptance criteria
- [ ] `↺` appears only on dirty fields and restores exactly the loaded byte value.
- [ ] `Revert all` returns `countEffective()` to 0 and every ISO window to byte-identical `orig`.
- [ ] Reverting a field whose display is derived (Level ← EXP) restores the stored EXP, not a
      recomputed approximation.

---

## #4 — A real tab shell for the ISO editor  **[PORT]**
`area:iso` · `size:S` · `parity:s3`

### What S3 does
`web/iso.js:3345-3348` defines `VIEWS` as a flat `[key, label]` array of 22 entries, rendered as a
tab bar with one `draw*(host)` function per view. Adding a tab is one array entry plus one
function — the shell is deliberately trivial so the cost of a new editor surface is the editor,
not the plumbing.

### Why it matters for S4
S4's `iso.js` renders one flat list grouped only by `f.group` (currently the single group
`"Random encounters"`). Every ISO issue in Part 3 needs somewhere to live. Build the shell before
the first tab, not after the third.

### How to build it
1. Add `const VIEWS = [["encounter", "Encounters"]];` to `iso.js` and render a `.subbar` of chips
   matching S3's markup so the existing CSS applies.
2. Move the current `FIELDS` rendering into `drawEncounters(host)`.
3. Persist the active tab in `localStorage` (S3 does; it survives the version-update reload).
4. Keep the save/apply toolbar **outside** the tab host so staged edits from several tabs apply
   together — this is how S3 gets one review list across 22 tabs.

### Acceptance criteria
- [ ] The ISO editor renders a tab bar; the existing three fields live under `Encounters`.
- [ ] Staged edits survive tab switches and appear in one combined review.
- [ ] Adding a tab requires touching exactly two places.

---

## #5 — `data-sum` long-description collapse  **[PORT]**
`area:infra` · `size:S` · `parity:s3`

### What S3 does
`web/blurb-core.js` (165 L, tested by `tests/blurb-core.mjs` 225 L). Any block with a `data-sum`
attribute renders collapsed to its one-line summary with a "Show more" button. Three invariants
the module's header calls out and the tests enforce: the full text stays **in the DOM** (hidden,
not removed) so `textContent` and Ctrl-F still find it; expanded state is keyed by the **summary
text**, not the element, so a full re-render doesn't collapse what you opened; and `data-sum=""`
means "derive from the first sentences".

### Why it matters for S4
S4's ISO fields already carry multi-sentence `sub:` and `hint:` prose (see the `championAlways`
and `noBattles` entries in `iso.js`) and that prose is genuinely load-bearing — it is what makes
the toggles safe to use. As S4 adds tabs this becomes a wall of text above every table. S3 hit
exactly this and solved it once.

> ⚠️ **Known trap, already paid for in S3:** a card that tracks open state only via `ontoggle`
> snaps shut on the first edit that triggers a re-render. Key the state by summary text, as
> `blurb-core.js` does, not by element identity.

### How to build it
1. Copy `web/blurb-core.js` and `web/tests/blurb-core.mjs` from the S3 repo verbatim — it has no
   S3-specific content.
2. Add the `<script>` tag and the `.blurb` CSS rules from S3's `style.css`.
3. Add `data-sum` to the two `.sub` paragraphs in `index.html` and to each ISO field's `sub`/`hint`.

### Acceptance criteria
- [ ] Long blocks collapse to one line with a working toggle.
- [ ] Expanding, then editing a field, leaves the block expanded.
- [ ] `document.body.textContent` still contains the full hidden prose.

---

## #6 — Boot gate: don't let Pyodide block the ISO editor  **[PORT]**
`area:infra` · `size:S` · `parity:s3`

### What S3 does
S3's `index.html` carries an inline `#bootOv` overlay **in the markup, not in `app.js`**, so it
paints on the first frame. It scopes itself to the loader card only, with a three-step progress
list (runtime → save module → reference tables), a progress bar, and two escape hatches:
`ISO Editor → (no Python needed)` and `Dismiss`. The comment above it explains the reasoning:
*"it used to blank the whole screen, which made the rest of the app look broken for the length of
a 10 MB download."* Tested by `tests/boot-gate.mjs` (214 L).

### Why it matters for S4
S4 shows a single `<span class="spinner"></span>Starting Python engine…` line inside the drop
zone, and its `pickBtn` is `disabled` until Pyodide is up — but the **ISO Editor tab is a
completely Pyodide-free code path** and there is nothing telling the user that. On a cold mobile
connection that's ~10 MB of dead time during which the working half of the app looks broken.

### How to build it
1. Port S3's `#bootOv` block from `index.html` (markup + `.boot-*` CSS), retargeted at `#loaderCard`.
2. Drive its three steps from the existing `bootPyodide()` `grab()` progression (`app.js:67-71`).
3. Wire `#bootIso` to `setMode("iso")` (`app.js:806`) and `#bootHide` to dismiss.
4. Port `tests/boot-gate.mjs`.

### Acceptance criteria
- [ ] The gate is visible on first paint, before any JS runs.
- [ ] It covers only the loader card; mode tabs, theme buttons and install button stay live.
- [ ] Clicking "ISO Editor" during boot switches modes and the ISO editor is fully usable.

---

## #7 — Version-drift guard in CI  **[PORT]**
`area:infra` · `size:S` · `parity:s3`

### What S3 does
`web/tests/version-drift.mjs` (113 L) fails the build if the version in `index.html`'s footer,
`app.js`'s `APP_VERSION`, and `sw.js`'s cache name disagree. S3 shipped a version-desync bug and
then made it impossible to re-ship.

### Why it matters for S4
S4 has the identical three-place coupling — `index.html` footer `v1.6.5`, `app.js:21`
`APP_VERSION = "1.6.5"` with the comment *"keep in lockstep with the footer in index.html"*, and
`sw.js`'s cache name. A comment is not a guard. S4 has already fixed one version-desync bug
(commit `1e58260`, "fix version desync").

### How to build it
Copy `web/tests/version-drift.mjs`, retarget the three regexes at the S4 filenames, add to
`package.json`'s `test` script.

### Acceptance criteria
- [ ] Bumping the version in only one of the three files fails `npm test` with a clear message.

---

## #8 — Playwright e2e suite with a synthetic ISO fixture  **[PORT]**
`area:infra` · `size:L` · `parity:s3`

### What S3 does
- `web/tests/e2e.mjs` — 5,533 lines of Playwright driving the real app.
- `web/tests/synth-iso.mjs` (736 L) — **builds a fake ISO from the editor's own table constants**,
  so the suite ships no game data and can't drift from the code under test.
- `web/tests/shard.mjs` (96 L) — parallel sharded runner (`E2E_WORKERS=6`).
- `web/tests/budget.mjs` (151 L) + `timings.json` / `tiers.json` — per-section time budgets.
- `web/tests/chromium-path.mjs` — auto-resolves a browser, no `PW_CHROMIUM` needed.
- `npm run test:loop` to iterate, `npm run test:gate` before pushing.

### Why it matters for S4
S4 has **no browser test at all**. `validate.mjs` asserts that strings appear in `app.js`; it
cannot catch a picker that doesn't open, a review sheet that renders empty rows, or a save path
that silently drops an edit. Every issue in Parts 2 and 3 adds UI that nothing will test.

> ⚠️ **Two traps S3 hit, both worth pre-empting:** (a) a new e2e section needs both an `if (ON)`
> gate and a `budget.mjs --update` entry, or the gate fails *silently* and only `npm test` catches
> it; (b) when several suites share `$TMPDIR`, a *random subset* of failures means a collision
> with a peer run, not a regression — namespace the temp dir per run.

### How to build it
1. Copy `chromium-path.mjs` verbatim.
2. Write `web/tests/synth-s4-iso.mjs` on S3's model: emit a byte buffer long enough to cover
   `FIELDS.reduce(max(off+len))`, containing exactly the signature bytes each `f.sig()` checks
   (`iso.js` `FIELDS[*].sig`). Roughly 1 MB, generated, never committed as game data.
3. Write `web/tests/e2e.mjs` covering, in order of value:
   load a synthetic ISO → read back each field → move the slider → confirm the review sheet lists
   `old → new` → confirm the streamed-copy path emits the right byte runs; then the save editor
   against the synthetic payload `save_roundtrip.py` already builds.
4. Add `test:e2e` to `package.json`; add sharding only once the suite exceeds ~2 minutes.

### Acceptance criteria
- [ ] `npm run test:e2e` runs headless against a generated fixture with no game data in the repo.
- [ ] A deliberately broken picker or review sheet fails the suite.

---

# Part 2 — Save editor gaps

S4's save editor is the strong half. These entries close it to parity.

---

## #9 — Inventory editor (party bags + storage)  **[RESEARCH → PORT]**
`area:save` · `size:L`

### What S3 does
A full `Inventory` sub-tab (`app.js:671`): every bag, split into *Party Items* vs *Key/Valuables*,
with name-resolved searchable pickers, quantities, add and remove. Crucially it models the game's
actual storage shape rather than a flat list — before the parties merge, each of Hugo/Chris/
Geddoe/Thomas has their own bag **and** their own storage; afterwards it's one shared party bag
plus one shared 210-slot storage.

It also encodes the rule that bit S3 hard: **runes, armour and key items are one-per-slot**. The
game holds three Fury Runes as three slots, not one slot with a count of 3. Writing a count there
is what used to make spare copies vanish. `health-core.js` owns `itemStackable(id)` and
`itemCategory(id)` so the inventory UI and the health audit can never disagree, and new items are
appended after a bag's last entry rather than dropped into a gap.

### Why it matters for S4
This is the **largest single missing save feature**. S4 can edit what a character *wears* but
nothing they *carry*. There is no potion, no rune in the bag, no key item. For most players
"give me 99 of X" is the single most-wanted save edit and S4 cannot do it.

### Reverse engineering needed first
The inventory offset is **not yet located** in S4. `Editor/s4save.py` has no inventory constants.
The good news is that S4 has the strongest possible lever, documented in
`Editor/Suikoden4_offsets.md`: *"the save gamedata is a verbatim image of the game's state block
at EE `0x532860`, so every RAM address maps linearly to a save offset (`save = ram - 0x532860`)"*.

So the recipe is:
1. Open `Cheats/Suikoden IV NTSC PCSX2 2_2_0.CT` and `Cheats/Suikoden IV (USA).ct` and look for an
   inventory/item-bag entry. The CT already yielded `PotchOffset`, `CurrentHP`, the world-map flags
   and the Recruited byte — inventory is the obvious next candidate and may already be in there.
2. If the CT has it: `save_offset = ram_addr - 0x532860`. Done, with no emulator run.
3. If not: take two saves from the same playthrough separated by **one known item pickup**, diff
   the 57,952-byte payload. An inventory entry is a `(u16 id, u8 qty)`-shaped record; the item ids
   are already known from `Editor/s4_item_names.json` (519 entries), so a candidate region is one
   where every non-zero u16 lands inside that id set. That id-membership test is a very strong
   filter and is the same trick S3 used for its equipment block ("category purity").
4. Confirm slot count and stride by checking a save with a nearly-full bag against one with few
   items — the boundary is where the trailing zeros start.

### How to build it
1. Add `INVENTORY_OFF`, `INVENTORY_SLOTS`, `INVENTORY_STRIDE` to `s4save.py` with the same
   evidence comment style the existing constants use.
2. Add `decode_inventory(gamedata)` and an `inventory` key in `apply_edits_to_gamedata`
   (`s4save.py:476`).
3. Port S3's stackable/one-per-slot rules into `s4-core.js` (from #1) — **derive S4's own bands**,
   don't copy S3's `ITEM_ONE_PER_SLOT_EXC` set, which is S3 item ids.
4. Build the sub-tab reusing the existing `openPicker()` (`app.js:159`) over `REF.items`.

### Acceptance criteria
- [ ] Items can be added, removed, re-typed and re-quantified; edits appear in the review sheet.
- [ ] One-per-slot categories refuse a quantity and occupy one slot each.
- [ ] Appending lands after the last entry, never in a gap.
- [ ] A round-trip test asserts the bag survives decode → edit → write → re-decode.

### Risks
- Getting one-per-slot wrong **destroys items**. Ship read-only first, verify against a real save
  in PCSX2, then enable writes.

---

## #10 — Party / battle formation editor  **[PORT]**
`area:save` · `size:M`

### What S3 does
A `Party` sub-tab (`app.js:669`) editing the active battle party (up to 6) by character name, with
per-slot mounts, and re-deriving the battle formation from the party list on apply (`app.js:1983`).

### Why it matters for S4
S4 exposes party membership **only indirectly**, through the recruitment enum: `11 = In Party`,
`15 = Permanently In Party` (`s4save.py` `RECRUIT_STATES`). That is the game's own flag, so it
works — but there is no view of "who is in my party right now", no slot ordering, and no guard
against putting seven people in a six-person party. S4 is a naval game with a 4-person land party
plus ship crew, so the ordering question is, if anything, more load-bearing than in S3.

### How to build it
1. Derive the current party by scanning the recruit array for `11`/`15` — that needs no new RE and
   ships immediately as a **read-only** party view.
2. To get true slot *ordering*, find the party-slot array: same CT → `save = ram - 0x532860`
   recipe as #9. Look for a short array of roster indices (values `0..112`) that changes when you
   reorder the party in game.
3. Render six (or the S4-correct count) slots with the existing character picker, and stage changes
   as recruit-enum writes plus, once located, slot-array writes.

### Acceptance criteria
- [ ] The tab shows the current party derived from the recruit enum, correct on a real save.
- [ ] Adding a 7th member is refused with a clear message rather than silently written.
- [ ] Removing someone from the party sets them to `10` (Recruited), not `0` (Not Recruited).

---

## #11 — Save health lint  **[PORT]**
`area:save` · `size:M` · `parity:s3`

### What S3 does
`web/health-core.js` (520 L; `tests/health-core.mjs` 423 L) is a lint over the save that runs on
**the file plus your pending edits**, so it catches both damage already in the file and damage you
are about to write. Findings are `{id, sev, group, title, detail, where?, fix?}` in three
severities:

- **problems** — an unrecruited character in the active party; current HP above max HP.
- **warnings** — a rune carrying a stack count (the shape that made spare copies vanish); a value
  the engine will clamp on write, *quoting what will actually land*; the same skill in two slots;
  gear in a slot that doesn't take it; items sitting after a gap in a bag.
- **notes** — a party leader who isn't in the party; a skill above the guide's cap.

Most findings carry a one-click **Fix**, and a fix only *stages* its change — it still goes through
Review changes. The tab badges the problem count, and decode-time layout checks are folded in so
it's the one place to look.

The module's house rule is worth copying verbatim: *"correct or absent, never wrong. A check that
needs a lookup the caller didn't supply simply doesn't run, and no finding claims a consequence
that isn't derivable from the write path."*

### Why it matters for S4
S4 clamps silently. `app.js:19` `CHAR_CAP = { maxHP: 9999, exp: 98999, weaponLvl: 15 }` and
`s4save.py` `_clamp()` will quietly reduce an out-of-range value — the user types 99999 HP, sees
it accepted, and the save gets 9999 with no notice. S4 also has genuinely reachable bad states its
own README warns about ("with a soft-lock warning" on the bulk recruit tab) but nothing detects.

### How to build it
1. Create `web/health-core.js` on the S3 module shape (needs #1's pattern).
2. Start with the checks S4 can make **today**, no new RE required:
   - a value that will be clamped on write, quoting the landing value (`CHAR_CAP`, `POTCH_MAX`,
     `EXP_MAX`, `WLVL_MAX` — all already in `s4save.py`)
   - a recruit enum value outside the five known states
   - `11`/`15` party members who are not recruited
   - more party members than the game allows
   - a rune id or item id not present in the reference tables
   - EXP that disagrees with the displayed level (`lvFromExp`, `app.js:62`)
3. Add an `#healthTab` sub-tab badged with the problem count.
4. Every finding with a `fix` stages ops through the existing `CE` overlay so it lands in the
   review sheet.
5. Port `tests/health-core.mjs`'s structure: a table of synthetic saves, each asserting exactly
   which findings fire.

### Acceptance criteria
- [ ] Typing an out-of-range value produces a warning naming the value that will actually be written.
- [ ] Every finding either has a working Fix or explicitly says why it can't be auto-fixed.
- [ ] A Fix stages rather than writes; the review sheet shows it.
- [ ] Headless tests cover every rule.

---

## #12 — Guide overlays on every field  **[PORT]**
`area:save` · `area:reference` · `size:L`

### What S3 does
`web/guide-core.js` + six generated JSON tables (`Editor/build_guide_refs.py` parses saved
Suikosource guide text). Fields show verified reference data **inline**:

- each stat shows its growth rate and expected Lv-99 range
- Max HP shows the HP row
- Level shows the level that character joins at
- each rune slot shows whether it's innate or **opens at Lv N**
- each skill slot shows that character's **maximum grade**, or that they can't learn it at all
- item/skill pickers show rune effects, food heals and per-rank skill effects

Its house rule is the same "correct or blank, never wrong": support characters who don't fight and
a handful of units the guides omit simply render **no note** rather than a guess, and the module
header lists exactly who falls in that hole and why.

### Why it matters for S4
S4 has exactly one overlay — rune affinities from OmegaDL50's GameFAQs FAQ (`s4_affinities.json`,
1.2 KB, shown as 🔥⚡💧🌪⛰ 1–4). Everything else is a bare number box. A user setting SKL to 400
has no idea whether that is high, low, or impossible for that character.

### How to build it
S4's advantage: the repo already ships `Guides/Suikoden IV - Combo Attacks Guide` and
`Cheats/S4 Rune List.pdf`, and unite names were already extracted from the former into
`s4_unites.json` — so the extraction pipeline exists in spirit.

1. Write `Editor/build_s4_guide_refs.py` on the model of `Editor/build_guide_refs.py`: saved guide
   text in, verified JSON out, committed. Never scrape at runtime.
2. Target, in rough value order:
   - **per-character stat growth / Lv-99 ranges** — a GameFAQs stat-growth FAQ exists for S4
   - **rune compatibility / who can equip what** — extend the existing affinity table
   - **weapon sharpening levels and names per character**
   - **item descriptions** — S4's item names are known (519) but descriptions are not
3. Create `web/guide-core.js` doing the roster-name → guide-key join, including S4's alias case
   (`AFF_ALIAS` at `app.js:25` already handles `Frederica`/`Fredrica` — fold it in here).
4. Render notes inline under each field.

### Acceptance criteria
- [ ] Guide data is generated by a committed script from committed source text, never fetched live.
- [ ] A character absent from the guides renders **no note**, never a placeholder or a guess.
- [ ] A test asserts coverage counts and that every join key resolves or is on a documented
      exception list.

---

## #13 — JSON snapshot export / import of a whole save  **[PORT]**
`area:save` · `size:M` · `parity:s3`

### What S3 does
An `⬇ Export / ⬆ Import` pair on the Overview card producing a human-readable JSON of the entire
save, which you can edit in a text editor or share. Importing **stages the differences through the
normal review-and-Apply path** rather than writing anything directly — so an imported snapshot is
as safe and as reviewable as a hand edit.

### Why it matters for S4
This is the cheapest path to shareable S4 "builds" and, more importantly, it is the best bug-report
format the project can have: a user with a broken save exports JSON, which contains no copyrighted
game data and can be pasted into an issue.

### How to build it
1. `decode_save()` (`s4save.py:445`) already returns a dict — serialise that plus `characters`.
2. Export: `JSON.stringify(saves[curSlot], null, 2)` with a `format`/`version`/`game` header.
3. Import: parse, diff against the loaded save, write the differences into `CE`/`NAMES`, then call
   the existing `openConfirm()` (`app.js:633`). **Never write directly.**
4. Reject a snapshot whose `game` field isn't S4 or whose version is newer than the app.

### Acceptance criteria
- [ ] Export → import on an unmodified save stages **zero** changes.
- [ ] Export → hand-edit one field → import stages exactly one reviewable change.
- [ ] A snapshot from a different game is refused with a clear message.

---

## #14 — Decode-time invariant checks  **[PORT]**
`area:save` · `size:M` · `parity:s3`

### What S3 does
Every save is cross-checked against invariants a correct layout can't violate **as it decodes** —
including comparing the level it reads against the level the save's own PS2 browser title reports.
A save that doesn't decode cleanly says so loudly before you edit it; benign discrepancies with a
known explanation get a quiet note instead, *so the loud warning keeps its meaning*.

### Why it matters for S4
S4 already has the ingredients and doesn't use them. `s4save.py:387-407` parses the icon.sys title
(`Suikoden4 [NN] LVLnn / H:MM`, Shift-JIS full-width) — so the save carries an **independent
witness** for chapter, level and playtime. The offsets doc explicitly notes the hero's EXP was
validated this way during RE. That validation should run on every load, not just during research.

### How to build it
In `decode_save()`, after decoding, assert and surface:
1. hero level from EXP (`lvFromExp`) vs `LVLnn` in the title
2. `GAMETIME_OFF` seconds vs `H:MM` in the title
3. every recruit byte ∈ `RECRUIT_STATES`
4. every EXP ≤ `EXP_MAX`, weapon level ≤ `WLVL_MAX`, potch ≤ `POTCH_MAX`
5. every non-zero equipment id present in `s4_item_names.json`, every rune id in `s4_rune_names.json`

Return them as a structured list; the UI renders hard failures as a blocking banner and known-benign
ones as a quiet note. Feed the same list into the #11 health tab.

### Acceptance criteria
- [ ] A deliberately corrupted synthetic save produces a loud, specific warning before editing.
- [ ] A normal save from any supported region and container produces no warning.
- [ ] The benign/loud split is a documented list, not a severity guess.

---

## #15 — Character-detail parity: current HP, level-up preview, sharpen names
`area:save` · `size:S`

### What S3 does
Per character: level, weapon (sharpen) level, **current and max HP**, EXP, all 7 stats, equipped
runes and armour with category-filtered pickers, 8 skill slots with rank tier E…S, and
per-character recruitment.

### Why it matters / what S4 is missing
Checked against `s4save.py`, S4 covers Max HP, the 8 stats, EXP/level, weapon level, 3 runes, 7
equipment slots and 5 unite slots. Genuinely missing:

- **Current HP** — `s4save.py` documents this as deliberately excluded: *"Current HP is not
  persisted in the record — the game restores it to Max HP on load, so every saved value reads 0."*
  That is a correct decision and should stay; this issue is only to make the UI *say so* where a
  user would look for it, as S3 does for its own omissions.
- **Rune uses** — the CT exposes `+0x49` current rune uses and `+0x4D` max uses (see
  `Suikoden4_offsets.md`, RAM stat record). These are in the RAM record; map them into the save
  record with the `- 0x532860` rule and expose "refill rune uses", a genuinely wanted edit.
- **Equipment category filtering** — S4's picker (`app.js:547`) opens the **full 519-item list**
  for every slot. S3 filters by category so a helmet slot offers helmets. S4 can derive category
  from the same evidence the offsets doc used to *locate* the slots ("+0xBE holds only armor/robes
  and +0xC2 only boots/shoes, 100% pure") — that purity analysis **is** a category table; emit it
  to JSON and use it.

### Acceptance criteria
- [ ] Rune uses are editable with a "refill" button, or the issue documents why the offset didn't map.
- [ ] Equipment pickers default to the slot's category with a "show all" escape.
- [ ] Fields the editor deliberately omits (current HP) say so where the user looks for them.

---

## #16 — Recruitment guide ordering and a completion checklist
`area:save` · `area:reference` · `size:L`

### What S3 does
The `108 Stars` tab (`app.js:668`) is the most elaborate thing in the S3 save editor. It lays the
Stars of Destiny out **in the recruitment guide's order — the order you can actually get them in** —
cut into that order's stages, each stage with its own progress and foldable once done. It shows the
guide's how-to line under each missing optional star, "next in guide order", and a `＋ recruit`
button that stages it in place.

Under each how-to it spells out **what that errand needs**: where the item it asks for comes from
and when (the disc's own shop counters — town, regular stock vs rare find, per-visit chance, which
story stages carry it — plus enemy drops with level/odds/area, and treasure chests), the potch
price measured against your purse, and any star you must bring along or recruit first with a ✓/✗.
Where nothing is known **it says so rather than guessing**. Each can be *handed over*: the item
goes into the right party's bag, a potch price is topped up by exactly the shortfall — both staged,
both reviewable.

### Why it matters for S4
S4's `Recruit` tab is a flat filterable table of 113 rows in **roster-index order** with a dropdown
each. That is a data view, not a guide. S4 has 108 Stars too, and the "which ones am I missing and
how do I get them" question is identical.

### How to build it
1. Save a recruitment-order guide (GameFAQs / Suikosource have S4 ones) into `Editor/guides/` as
   text, exactly as S3 does with `Editor/suikosource/`.
2. Write `Editor/build_s4_recruit_order.py` emitting `s4_recruit_order.json`
   (`{index, star, guideOrder, stage, optional|story, howTo, needs:[…]}`).
3. Ship the **ordering + how-to + story/optional split** first. The errand-cost machinery
   (shop counters, drop tables) depends on `FILEDATA` (#30) and should be a follow-up.
4. Mark story characters that auto-join as faded + ⚠, as S3 does — manually recruiting them is
   unneeded and can soft-lock an early save.

### Acceptance criteria
- [ ] Stars render in guide order, grouped into stages, with per-stage progress.
- [ ] Story vs optional is derived from the guide, not hand-maintained in JS.
- [ ] A star with no known how-to renders "not known" rather than an invented one.
- [ ] `＋ recruit` stages a change that appears in the review sheet.

---

## #17 — Region parity for the ISO editor
`area:iso` · `size:M`

### What S3 does
S3 is USA-only and says so once, everywhere.

### Why it matters for S4
S4's **save** editor supports NTSC-U *and* PAL (`s4save.py:54` `s4_region()`, and the offsets doc
records recruitment verified "across 8 saves (NTSC-U + PAL)"). But the **ISO** editor is NTSC-U
only and hard-fails PAL with a signature mismatch (`iso.js` `commitIso()` → *"PAL/other builds
aren't supported here"*). That asymmetry will confuse every PAL user who gets their save edited
and then can't touch their disc.

### How to build it
1. Obtain PAL `SLES-529.13` offsets for the three existing sites. The patch *shapes* are known
   (`addiu a0, zero, imm`; a `beqz` to nop; a `jal` to replace) so this is a pattern search, not a
   fresh RE: search the PAL boot ELF for the same instruction sequence around the same relative
   position in the encounter routine.
2. Generalise `FIELDS` entries to carry per-region offsets: `off: { "SLUS-209.79": 0x10E43C,
   "SLES-529.13": … }`, with region detected from the disc, as `s4_region()` already does for saves.
3. Where a region's offset is unknown, **hide the field for that region** rather than guessing.

### Acceptance criteria
- [ ] A PAL disc loads and reports its region rather than erroring as "not Suikoden IV".
- [ ] Fields with a verified PAL offset are editable; ones without are hidden with a reason.

---

# Part 3 — ISO editor gaps

**This is where the gap lives.** S3's ISO editor is 10,782 lines across 22 tabs; S4's is 467 lines
with 3 fields. Most of Part 3 is gated on **#30 (crack `FILEDATA`)** — read that first.

Three entries here are **not** gated and should be built immediately: #18 (mod recipes), #19
(Changes/audit), #20 (in-ELF text).

---

## #18 — Mod recipes (`.s4mod`) and `.xdelta` import/export  **[PORT]**
`area:iso` · `size:M` · `parity:s3` · *not blocked*

### What S3 does
Two export formats, both built from staged edits with **no need to write the 4 GB ISO first**
(`iso.js:3186` onward):

- **`.s3mod` recipe** — a tiny, reversible, version-checked JSON of the exact byte changes
  (`{format:"s3mod", version:1, game:"SLUS-20387", versionWord: VERSION_VAL, patches:[…]}`,
  `iso.js:3201`). A recipe for the wrong game or region is **rejected**.
- **`.xdelta` (VCDIFF)** — synthesised directly from the edits by S3's own encoder
  (`web/vcdiff.js`, 335 L, `tests/vcdiff.mjs` 232 L). No `xdelta3` binary, no 4 GB diff.

`Apply patch…` takes **both**, detecting the format from file contents not extension. An applied
patch is **staged like any other edit** — reviewable, undoable, revertible — and the multi-GB image
is never fully read; only the touched regions are examined. If the patch carries xdelta3's
checksum, applying it to the wrong or already-modified disc is detected and refused.

Two limits, reported rather than guessed around: xdelta3's default LZMA secondary compression can't
be read (ask for `-S none`), and a patch touching bytes outside the editable region is refused
whole rather than half-applied.

### Why it matters for S4
S4 has no mod sharing at all. Today the only way to share an S4 disc change is to describe it in
words or ship a 4.36 GB file. `.s4mod` is the difference between "this project can have a modding
community" and "this project is a personal tool" — and since S4's edits are currently **three
4-byte code patches**, a recipe file would be about 300 bytes.

### How to build it
1. Copy `web/vcdiff.js` and `web/tests/vcdiff.mjs` from S3 — they are game-agnostic.
2. Export `.s4mod` from `allRuns()` (`iso.js`, already implemented and already the exact shape
   needed: `[{off, bytes}]`). Header: `{format:"s4mod", version:1, game:"SLUS-209.79", patches}`.
3. Import: validate the game/region header, then write each run into the corresponding `WINDOWS`
   entry's `buf`, then call the existing review sheet. A run falling outside every known window is
   a **whole-file refusal**, not a partial apply.
4. Export `.xdelta` from the same run list; import by decoding and reusing the same staging path.

### Acceptance criteria
- [ ] Export → import on a clean disc reproduces the same staged edits byte-for-byte.
- [ ] A recipe naming another game or region is refused with a clear message.
- [ ] An `.xdelta` touching bytes outside the editable windows is refused whole.
- [ ] An LZMA-compressed `.xdelta` produces the specific "ask for `-S none`" message, not a crash.

---

## #19 — "Changes" tab: what is already on this disc + restore-to-stock  **[PORT]**
`area:iso` · `size:L` · `parity:s3` · *not blocked*

### What S3 does
`iso.js:10533` + `web/changes-core.js`. Every other tab reports what *you* staged this session —
the review list is built as you edit, so it is a **history, not a map**. Open a disc somebody
patched last month and the editor has nothing to say about it. The Changes tab answers that
instead, in two halves:

**Half A — diff against a pristine disc.** Point it once at a pristine copy and it lists every
differing byte **decoded field by field** (*"Kite · power: 40 → 199"*), grouped, with addresses and
a `↺` per row that stages a revert. Bytes no known field claims are still listed **as hex**,
because a change the tab quietly omitted would defeat the point. `changes-core.js`'s contract,
enforced by `checkRegions()`: regions are sorted and **do not overlap**, and any unclaimed byte is
an `unmapped` row rather than dropped.

**Half B — code-patch audit with no second file.** Every code patch the editor makes replaces a
*documented* word, so the audit knows what stock looked like. **Restore all to stock** stages every
site; each row has its own `↺`. `web/tests/stock-restore.mjs` (178 L) reads all **270** of those
constants off a pristine USA disc and fails if one disagrees — *which is what makes "restore to
stock" mean restore to pristine rather than restore to what this repo believes stock was.*

Findings that can **hang the game** rather than just change a number are sorted to the top and say
what they do when they go wrong. That is not hypothetical — it is how S3 caught a bad patch on a
real disc on 2026-09-06, named the two words with no pristine copy involved, and fixed a frozen
scene on the same save.

### Why it matters for S4
S4 writes **code patches to the boot ELF**. `iso.js`'s `FIELDS` already carries the stock bytes for
every one (`offBytes`, and `sig()` accepts both stock and patched shapes). A user who patches a
disc, plays for a month, and then wants to know what they did has no way to find out and no way to
undo it. S4 is one small step from Half B — the constants are literally already in the file.

### How to build it
**Half B first — it is nearly free.**
1. Add a `Changes` tab (needs #4) that, for each `FIELDS` entry, compares the loaded window against
   the entry's stock bytes and reports non-stock sites.
2. Add per-row `↺` staging the stock bytes and a `Restore all to stock`.
3. Add `web/tests/stock-restore.mjs`: given a pristine ISO path in an env var, assert every
   `offBytes` matches the disc; skip cleanly when no disc is present (mirror how
   `save-roundtrip.mjs` skips without `python3`).

**Half A once #30 lands** and there is a field map worth joining against: copy `changes-core.js`
verbatim (it is game-agnostic — byte-run diff plus a map join) and build the region map from the
same table constants the views read, as S3 does.

### Acceptance criteria
- [ ] Opening a previously-patched disc lists every non-stock site with its meaning.
- [ ] `Restore all to stock` stages (not writes) and the review sheet shows every restored site.
- [ ] The stock constants are verified against a real pristine disc by a test.
- [ ] Sites that can hang the game sort first and say what goes wrong.

---

## #20 — In-ELF text editor (UI strings, menus, battle messages)  **[RESEARCH]**
`area:iso` · `size:M` · *not blocked by #30, but needs its own RE*

### What S3 does
A `Text` tab backed by `web/text-core.js` (69 L, `tests/text-core.mjs` 112 L). The boot ELF stores
its English UI text as printable-ASCII runs with **no table of contents**, so the module finds them
by scanning for printable runs and filtering out the ones that look like code or format strings
(rejecting format/path punctuation, hex literals, arrows, underscores, and a letter adjacent to a
digit). Minimum run length 8. Each string is capped to its original byte length.

It is scoped honestly and says so in its own header: *"these are UI / battle / menu / prize / error
strings and character blurbs. Story dialogue is not here — it lives in packed event files elsewhere
on the disc, outside the ELF, and no editor in this repo can reach it."*

### Why it matters for S4
S4 can't edit a single word of text. Renaming an item, fixing a translation nit, retitling a menu —
none of it is possible.

### The S4-specific problem, and how to attack it
`Suikoden4_offsets.md` records a blocker: *"Character/item strings are NOT in the ELF as plain
ASCII (searched: not found), so game text lives packed inside `FILEDATA.*`."* That is true for
**game data strings** (item/character names) — but it does not follow that *no* text is in the ELF.
S3's own Text tab finds debug strings, format strings and UI labels, and the S4 offsets doc itself
quotes an ELF-resident format string during RE: `"%s: No.=%02xH sect=%6xH…"`-style printf text is
exactly the class `text-core.js` filters *out*.

So the work is:
1. Port `text-core.js` and run its scanner across S4's boot ELF (`LBA 367`, 3,214,528 bytes —
   small enough to load whole).
2. Report what it finds. If the result is only debug/format strings, **document that as a closed
   dead end** and close the issue pointing at #30 — a recorded dead end is worth more than a
   question reopened every few months (S3's explicit policy).
3. If real UI prose is present, ship the tab with the same length cap and the same scope note.
4. Check for a **non-ASCII** encoding before concluding absence: S4's save titles are Shift-JIS
   full-width (`s4save.py:387` `_FW_MAP`), so the ELF may hold UTF-16 or Shift-JIS runs that an
   ASCII scan misses entirely. Scan for both.

### Acceptance criteria
- [ ] The scanner runs over the real S4 ELF and its findings are written up.
- [ ] Either a Text tab ships with length-capped in-place edits, **or** the negative result is
      documented in `Suikoden4_offsets.md` with the search parameters used.

---

## #21 — Character / item / rune renaming  **[BLOCKED on #30 or #20]**
`area:iso` · `size:M`

### What S3 does
Two mechanisms:
- **In-place record renames** — rune names, item names, food names, gear names, spell names, each
  capped to the byte slot the disc reserves, **mirrored across every copy**. S3 found that 27
  descriptions and 43 names are stored **twice** (e.g. *Kite* the rune and *Kite* the spell it
  grants), and an edit writes every copy so the rune menu, battle command and item list agree.
- **Disc-wide rename** (`web/rename-core.js`, 117 L) — a same-length global byte replacement for
  Hugo, Chris, Geddoe and Koroku. Same-length is the safety guarantee: it shifts zero bytes, so it
  cannot corrupt any table, script offset or pointer anywhere. The list is limited to names that
  never occur inside a longer word — which is why *Luc* isn't offered ("Lucia", "Luck").

> ⚠️ **S3 shipped a bug here worth learning from (issue #11):** the twice-stored-description mirror
> only works while **both** copies still read alike. A half-patched disc needs the name set
> directly. Write every copy, and detect the half-patched state.

### How to build it for S4
The S4 hero's name is already editable in the **save** (`NAME_FIELDS` in `s4save.py`), so this
issue is about **disc-side** names: items, runes, characters in menus.

- If #20 finds names in the ELF: build the in-place capped editor directly.
- Otherwise this is blocked on #30. Once `FILEDATA` opens, the name table is the first thing to
  look for — it is what `s4_item_names.json` (519 entries) was extracted from a cheat table to
  work around.
- Port `rename-core.js` for the disc-wide variant. **Re-derive the safe-name list for S4** — run
  the "never occurs inside a longer word" test against a pristine S4 disc; do not assume S3's list.

### Acceptance criteria
- [ ] Renames are capped to the original byte length and refuse longer input rather than truncating.
- [ ] Every stored copy of a name is written; a half-patched disc is detected and reported.
- [ ] The disc-wide rename list is derived by a committed script, not hand-written.

---

## #22 — Spell / magic parameter editor  **[BLOCKED on #30]**
`area:iso` · `size:L`

### What S3 does
A `Spells` tab over 94 records (`iso.js:57`: `SPELL = {off: 0x3EC2A0, count: 94, stride: 0x20, …}`)
editing power, cast cost, element, target, AOE radius and status effect, with:
- a **rune reskin** that edits every spell a rune grants at once for any of the 49 granting runes,
  reading each rune's slots off the disc so it follows a reassignment
- quick presets (*Power 9999*, *Make AOE*, *Add poison*)
- a **bulk Power scale** over the whole table
- optional description rewrites

S3 also decoded the targeting bitfield exhaustively (`Suikoden3_ISO_offsets.md` §"flags14 targeting
bitfield… decoded across all 94 records, 0 exceptions") and learned the hard way that **a target
change is more than one field**: flags14 bit16 is a separate "no aiming step" bit, and leaving it
stranded is a confirmed in-play **soft lock**. There is also a third field — the radius byte — that
must move with the target.

### The S4 blocker
`Suikoden4_offsets.md` is explicit: *"Spell / unite tables — NOT yet located. S3 kept spell/unite
parameter tables in the ELF 2nd PT_LOAD, findable by an ascending damage curve. S4's ELF 2nd
PT_LOAD (file 0x278480, vaddr 0x4F7480) was scanned the same way; the ascending-field heuristic is
too noisy here… Needs a name-string or damage-value anchor from a guide to pin the table."*

### How to unblock it
1. **Get the anchor the doc asks for.** `Cheats/S4 Rune List.pdf` is already in the repo. Extract
   concrete numbers — a specific spell's damage, cast cost, or level requirement — and search the
   ELF and `FILEDATA` for that *multiset* of values at a fixed stride. A single value is noise; a
   record's worth of values at a consistent stride is a fingerprint. This is exactly how S3
   recovered its enemy index: *"the (hp,hp,lv) fingerprint made [a savestate] unnecessary."*
2. **Use the RAM-mirror trick that already works for S4.** Saves are a verbatim image of EE
   `0x532860`. A PCSX2 savestate holds full EE RAM; cast a spell, snapshot, and the live spell
   record is findable by its known values — then search those bytes back into `FILEDATA` to find
   the on-disc source. S3 built `tools/pcsx2/` (see #33) for precisely this.
3. Only then build the tab.

### Acceptance criteria
- [ ] The spell table's offset, count and stride are documented in `Suikoden4_offsets.md` with the
      evidence that pinned them.
- [ ] The editor writes power/cost/element/target and re-reads them identically.
- [ ] If targeting is a multi-field change in S4 as it is in S3, **all** dependent fields move
      together, and a test asserts no field can be left stranded.

---

## #23 — Unite attack editor  **[BLOCKED on #30]**
`area:iso` · `size:M`

### What S3 does
A `Unites` tab over 38 records (`iso.js:58`: `UNITE = {off: 0x3ECF90, count: 38, stride: 0x28, …}`)
with the same bulk Power scale as the Spells tab, plus the characters involved in each unite.

### Why it matters for S4
S4 already knows **29 combos by name with partner tooltips** (`s4_unites.json`, extracted from
ninjaskipper's GameFAQs guide) and can edit each unite's **level** in the save (`OFF_PROG_UNITES`).
What it cannot touch is the unite's own power/element/target on the disc. Same blocker as #22 and
almost certainly the same table region — **investigate them together.**

### Acceptance criteria
- [ ] Unite parameters are editable, or the negative result is documented.
- [ ] The existing `s4_unites.json` names are joined onto the disc records rather than re-derived.

---

## #24 — Character growth, starting stats and skill caps  **[BLOCKED on #30]**
`area:iso` · `size:L`

### What S3 does
Three related tabs backed by four ELF record tables (`iso.js:27`):
`TABLES = { list1: [4078716, 140], list2: [4068152, 132], list3: [4089904, 8], list4: [4061704, 28] }`
with `LIST_COUNT = { list1: 80, list2: 80, list3: 35, list4: 28 }`.

- **Characters** — starting stats, equipment (rune Head/Right/Left), skills + ranks
- **Growth** — stat-growth rates, fixed skills, 43-skill maximum-level caps, one-click presets
  (*Set to guide caps* / *Max all* / *Clear*), plus **bulk scaling** that multiplies every
  character's growth rate at once with idempotent *Tougher / Hard / Brutal* presets, optionally
  scoped to whatever the filter box shows
- **Support** — list3 support skills

### The S4 blocker
`README.md` already documents this honestly under "Not included (and why)": *"New-game character
stat tables — S4 keeps these inside `FILEDATA`'s ~1,000 unlabeled sub-archives, consumed by overlay
code, with no strings and no static tables in the boot ELF (join stats are computed from growth
curves, not stored). A PCSX2 savestate would unlock this."*

That is a good analysis and this issue does not contradict it — it specifies what to build **once
#30 lands**, and records that the savestate path is the known unblock.

### Acceptance criteria
- [ ] Starting stats and growth curves are located and documented.
- [ ] Bulk scaling is **idempotent** — running ×2 twice gives ×2, not ×4 — recomputed from a stored
      stock base, exactly as S3 does (see #28 for the pattern).

---

## #25 — Equipment, weapons, armour sets and food  **[BLOCKED on #30]**
`area:iso` · `size:L`

### What S3 does
Four tabs:
- **Gear** — name, DEF, price, description and **5 effect slots**
  (`iso.js:125`: `GEAR = {stride: 0x44, def: 0x10, price: 0x08, name: -0x04, effs: […]}`)
- **Weapons** — ATK across all 16 sharpen levels (`list4`, a clean monotonic curve per weapon class)
- **Sets** — armor-set composition, the set-bonus constants patched straight into game code (potch
  multiplier, counter chance, heal share), and **which set grants which effect**, since each bonus
  is a hard-coded check on the set number that can be re-pointed
- **Food** — rename a dish, rewrite its description, set heal amount and proc chance
  (`iso.js:121`: `FOOD = {off: 0x3E91D0, stride: 0x48, count: 60, …}`)

> One S3 lesson worth carrying: the gear effect map was shipped **wrong** and corrected only after
> a tester reported it ("off by 1"). The fix came from re-deriving every effect type against the
> in-game **descriptions** rather than from the code alone. Cross-validate any S4 effect table the
> same way.

### Acceptance criteria
- [ ] Item stat/effect records are located; the effect-type map is cross-validated against in-game
      descriptions, not just plausibility.
- [ ] Types with zero occurrences on the disc are labelled "unverified" rather than guessed.

---

## #26 — Shops  **[BLOCKED on #30]**
`area:iso` · `size:M`

### What S3 does
A `Shops` tab (`iso.js:33`) over fixed shop/inventory tables, and — behind the 108 Stars tab —
**per-town shop counters** including regular stock vs rare find, the rare find's per-visit chance,
and which story stages carry each item. S3 also recorded that a full shop mapping is partly
**script-driven** and said so rather than over-claiming.

### Acceptance criteria
- [ ] Shop stock is editable per shop, or the script-driven portion is documented as out of reach.

---

## #27 — Per-area / per-map encounter tuning  **[BLOCKED on #30]**
`area:iso` · `size:M`

### What S3 does
Beyond its global rate, S3 edits **every area's own base rate**: 23 areas, 133 chapter-variant
tables, 1,612 map records, each with *None / Half / Stock / Double* presets that scale from the
disc's own numbers (so re-applying never compounds and *Stock* is a byte-exact restore), plus a per-
map post-battle **grace distance**. Towns read 0; field maps read 2–9.

It also splits the global rate into its **three constituent multipliers** — walking (100), running
(120), running mounted (150) — editable independently, so you can change the *shape* of the risk
rather than its size.

And it exposes **movement rules**: the game checks which animation you're playing before rolling at
all, so "walking triggers encounters — off" is a distinct toggle from a rate of 0.

> ⚠️ S3's safety rule, which S4 must copy: **lowering a rate is always safe; raising one from 0 is
> not.** A map the game never fights on has no monster party loaded. Rows at 0 are tagged and
> zone-less archives are flagged.

### How S3 got there, and why it maps onto S4
This was S3's **exact equivalent of S4's `FILEDATA` problem**, and it was solved — twice, with the
first answer wrong. `DATA/FSECT.BIN` was written off in 2026-08-09 as *"a pointer/relocation table,
not a file sector index"* because its u32s looked like EE RAM addresses (`0x0157xxxx`). On
2026-08-29 that was overturned: the entries decode as `sect = w & 0xFFFFF`, `size = w >> 20`, both
in 2048-byte sectors — **relative to the containing archive**, which is exactly why they looked
like pointers.

The test that settled it is the one to steal: **a directory's entries tile its archive exactly.**
23.8% of consecutive pairs satisfy `sect[i] + size[i] == sect[i+1]`, and those pairs form runs that
each end precisely on one archive's own sector count. 28 of 29 archives resolved with no unmatched
runs. With sub-file boundaries in hand, the search space for the room table collapsed from 3.5 GB
to ~100 candidates per archive and the table fell straight out.

See #30 — this tiling test is the single most transferable technique in this document.

### Acceptance criteria
- [ ] Per-map rates are editable with presets that scale from stock and never compound.
- [ ] Maps at rate 0 are tagged and raising them warns.
- [ ] *Stock* is a byte-exact restore, verified by a test.

---

## #28 — Enemy editor with idempotent bulk tuning  **[BLOCKED on #30]**
`area:iso` · `size:XL`

### What S3 does
`iso.js:8194` `drawEnemies()`. S3 found that the game keeps **no global monster table** — every
area's battle pack carries its own copies, so the same Blade Bunny is a different record in every
region. The tab decodes **81 packs, ~1,960 encounter variants** (indexed by
`Editor/build_enemy_index.py`, cross-checked against the Suikosource bestiary at 97%+ on potch/SP)
and edits per variant: level, HP, 8 combat stats, EXP/SP/potch rewards, and a 5-slot drop table
with weights out of 1000.

**Spawn zones & formations** turn the same tab into an encounter designer: each map zone has spawn
slots (which monster, and which stat variant) and formations (encounter groups with relative
weights). The slot picker is restricted to the pack's own roster **on purpose** — monsters from
other packs would spawn without their models loaded and crash the game.

Three engineering properties worth copying exactly:
1. **Bulk tuning is idempotent.** Every value recomputes from a fixed base, so ×3 after ×2 gives
   ×3 of the original, not ×6.
2. **The base is the stock disc's numbers, not the file's.** The index stores each variant's stock
   values next to its offsets, so re-opening an already-tuned ISO *recovers what was done to it*
   ("already tuned: HP ×1.2"), prefills the boxes, and keeps multiplying the stock numbers. On a
   disc the index doesn't describe, the editor **says so** and falls back to the file's own values
   rather than writing someone else's numbers over yours.
3. **Every edit is written through to every byte-verified streaming copy**, and the review says so
   ("Potch: 33000 → 44444 (×4 copies)"). A pack whose offsets can't be verified ships **read-only
   rather than wrong**.

### The S4 note
`Suikoden3_ISO_offsets.md` records that S3's *first* enemy investigation concluded base stats were
probably computed by battle code rather than stored — and that conclusion was wrong. S4's README
currently makes the same computed-not-stored argument for its stat tables. Treat that as a
hypothesis to test after #30, not a settled result.

### Acceptance criteria
- [ ] Bulk scaling is idempotent and recomputes from a committed stock base index.
- [ ] Every duplicate copy of a record is written; the review reports the copy count.
- [ ] Unverifiable packs are read-only, never written on a guess.

---

## #29 — Passive / support rune switches  **[BLOCKED on #30]**
`area:iso` · `size:XL`

### What S3 does
This is S3's most technically ambitious feature and the one whose *approach* transfers even if the
target doesn't. Two separate questions, answered in two places:

**Whether a passive fires.** The 22 support runes the engine actually asks about can be handed to
**specific characters** without equipping the rune. Each passive is one question the engine asks —
*"does this character have item N equipped?"* — always through the same three seven-slot equipment
lookups, and S3 located all **51** sites where it's asked. The patch shape is the important part:
the answer is **not** a word written over the call, it is a **retargeted call**. The site's `jal`
stays a `jal`, its branch delay slot is never touched, exactly one word per site changes, and the
new target is a 288-byte helper relocated over a dead routine plus a 22×16-byte table of one bit
per character. The helper identifies the character the way the game does — by where its record sits
in a static 112-entry array — which is also what keeps a forced passive **off enemies**, since an
enemy's record is heap-allocated and can never land in that array. Every site is byte-checked
against a pristine disc before writing, and clearing restores stock exactly.

**How much it is worth.** A passive's *strength* is 16 constants across 13 runes, read from the
instruction each rune runs right after asking whether you have it. These need **no switch** and
work on a stock disc, but they are **global** — raising Killer raises it for everyone, enemies
included. The tab says so.

Three hard-won lessons, all relevant to S4 regardless of the feature:
- **"Exhaustive PT_LOAD search found nothing" ≠ absent.** Fortune's check turned out to live in a
  **streaming battle overlay ~1 GB into the disc**, not the executable. Three exhaustive ELF
  searches found nothing because it wasn't there. R5900 three-operand multiply can also hide the
  trail.
- **Restoring has an ordering rule.** The relocated helper block only goes back once **nothing
  jumps into it** — a live jump landing in restored code is its own hang. "Restore all" does call
  sites first.
- **A patch can be installed and unreachable.** A disc patched before the trampoline existed
  carries an older inline shape and ends up with 640 bytes of unreachable leftover. The audit
  reports that as *leftover*, not as live code, and lets you restore it on its own.

### Why this is listed for S4
Not because S4 has the same runes — because S4's **existing** `championAlways` toggle is exactly
this class of patch done the crude way (nop a branch, globally). The S3 machinery is what turns
"force this for everyone" into "force this for Hugo alone", and it is the generalisable upgrade
path once S4's equipment-check sites are located.

### Acceptance criteria
- [ ] Any forced-passive patch verifies every site against pristine bytes before writing.
- [ ] Clearing restores stock byte-for-byte, with the call-sites-before-helper ordering enforced.
- [ ] A forced passive provably cannot reach enemy records.

---

# Part 4 — Research unblocks

Part 3 is mostly gated on one thing. This part is that thing, plus the tooling that makes it
tractable.

---

## #30 — ⭐ KEYSTONE: crack the `FILEDATA` archives  **[RESEARCH]**
`area:research` · `size:XL` · **blocks #21–#29**

### The situation
`Suikoden4_offsets.md` already got further than most projects do. The container format is decoded:

```
+0x00 u32 magic 0x82734927
+0x04 u32 = 0
+0x08 u32 total archive size
+0x0C u32 = 0
+0x10… 16-byte entries: (id u32, flags u32, offset u32, size u32)
        id    = content hash/key; families share high bits
        flags = 0 stored, 2 compressed
        offset= relative to archive start; entries are offset-ordered
```

BI2 (60 MB) has 55 real entries, many as a 256-byte header entry (flags 0) immediately followed by
a flags=2 data entry — a header + compressed-payload pairing. The doc's own status line:
*"container format decoded; the per-entry compression (flags=2) and which entry holds
character/item/spell tables are not yet mapped."*

So there are exactly **two** unknowns: the **compression codec**, and the **content map**.

### Attack A — identify the compression (do this first; it is bounded)
1. Extract one flags=2 payload and its paired 256-byte flags=0 header. The header almost certainly
   carries the uncompressed size and possibly a codec tag — diff several headers to find the field
   that tracks the payload's decompressed size.
2. Test the standard PS2-era candidates in order of prior probability, all cheap to try:
   **zlib/raw-deflate**, **LZSS** (the Sony/mymc family — note the repo *already ships an LZARI
   decoder*, `Editor/s4lzari.py`, and LZARI is LZSS + arithmetic coding, so the same window
   parameters are a live lead), **LZ77 with a 4 KB ring buffer**, **Sony's `DECOMP`/ICE**, and
   **LZMA**.
3. Entropy-profile the payload first: a flat byte histogram suggests arithmetic/range coding
   (LZARI-family), a spiky one with visible literal runs suggests LZSS/deflate. This single
   measurement eliminates half the candidate list before you write any code.
4. If none fit, find the decompressor **in the ELF**: search for the string `FILEDATA` and the
   magic `0x82734927`, then follow the loader. A PS2 LZSS decompressor is a short, very
   recognisable loop (shift a control byte, branch to literal-copy or window-copy). This path is
   guaranteed to work and is how S3 eventually resolved its own archive question.

### Attack B — the tiling test (S3's proven directory technique)
Even with entries in hand, you need to know **which** entry holds what. S3's `FSECT.BIN` crack is
directly applicable and is documented in `Suikoden3_ISO_offsets.md` §"FSECT.BIN CRACKED":

> A directory's entries **tile its archive exactly.** Check `entry[i].offset + entry[i].size ==
> entry[i+1].offset` across the table. Runs that tile, and that end precisely on the archive's own
> size, confirm you are reading a real directory in the right units. 28 of S3's 29 archives
> resolved with **no unmatched runs at all** — that is what turned a 3.5 GB search into ~100
> candidates per archive.

S4's entries are already offset-ordered per the doc, so run this test immediately: it will confirm
the entry table is complete and reveal any entries you're mis-parsing.

### Attack C — content fingerprinting (how to find the table you want)
Once sub-files are enumerable, do **not** scan for "a table that looks like stats". S3 tried that
and recorded the failure: a field-shape scan returned *"~3,000–4,000 candidate tables per archive —
chance level"* because mostly-zero data satisfies every constraint. What worked was a
**multi-value fingerprint with a cross-check**:

- The enemy index got its power from recovering each copy's file↔vaddr delta and validating
  pointers against it.
- The room table fell out because the area id is a **discriminator**: a run is accepted only while
  the low byte stays constant and the high byte counts up by one, and the whole archive must then
  agree on one area id.

For S4, the ready-made fingerprints are:
- **519 known item ids** (`s4_item_names.json`) — a table whose every u16 lands inside that set is
  almost certainly item-related.
- **42 known rune ids**, **113 known character indices**.
- **Concrete numbers from `Cheats/S4 Rune List.pdf`** and the combo guide.

### Attack D — the savestate shortcut (fastest, needs an emulator run)
S4 has the cleanest possible version of this because of the RAM-mirror fact already proven:
`save = ram - 0x532860`. A PCSX2 `.p2s` savestate holds full EE RAM.

1. Boot the game, reach a battle, take a savestate.
2. Find the live table in RAM by its known values (a spell's damage, an item's id).
3. **Search those exact bytes back into the `FILEDATA` archives** to find the on-disc source.

This converts every remaining Part 3 blocker from a search problem into a lookup. Both the S3 and
S4 notebooks independently identify a savestate as the unblock; S3 built `tools/pcsx2/` (#33) to
automate exactly this loop.

### Acceptance criteria
- [ ] A committed `Editor/build_s4_subfile_index.py` enumerates every `FILEDATA.*` entry with
      offset, size, flags and decompressed size.
- [ ] The tiling test passes and is asserted by a test.
- [ ] flags=2 payloads decompress, with the codec named and documented.
- [ ] At least one game table (items, spells, characters or enemies) is located and documented in
      `Suikoden4_offsets.md` with its evidence.

---

## #31 — Sub-file browser (Reference → Files)  **[PORT, after #30]**
`area:reference` · `size:M`

### What S3 does
A read-only browser over the disc's **4,403 packed sub-files across 28 archives**, listing each
one's ISO offset, size and identified kind (battle / town / map / unidentified), with a **Peek**
hex dump reading the first 256 bytes straight off your disc. Town entries carry a **pickup census**
counted from the game's own object names.

It is **deliberately read-only**, and says why: *"everything editable inside these files has its own
tab, and a raw byte editor over thousands of unknown blobs would be a footgun rather than a
feature."* The index is rebuilt from a pristine disc by a committed script.

### Why it matters for S4
This is the natural first *user-visible* deliverable of #30, and it is what makes further RE
community-scalable — anyone can open the browser, peek at an unidentified blob, and report what
they find. S4 has ~1,000 unlabeled sub-archives; a browser turns that from a wall into a worklist.

### Acceptance criteria
- [ ] Every archive's sub-files list with offset, size, flags and kind.
- [ ] Peek reads from the user's own disc; the repo ships only the index.
- [ ] Read-only, with the reasoning stated on the tab.

---

## #32 — Reverse-engineering notebook discipline  **[PORT]**
`area:docs` · `size:S` (ongoing)

### What S3 does
`Editor/Suikoden3_ISO_offsets.md` is **3,862 lines** and is the primary record — a dated, append-only
notebook where every investigation gets a section, including the ones that failed. Longer
investigations graduate to their own file in `docs/` (8 of them).

The policy is stated outright: *"Several document things that turned out **not** to work. Those are
kept deliberately — a recorded dead end is worth more than a question re-opened every few months."*

The notebook is what made S3's hardest wins possible. `FSECT.BIN` was written off as a relocation
table in one entry and correctly identified as a directory in a later one — and because the first
entry was **kept**, the correction is legible and the wrong premise is on record so nobody repeats
it. It even names scans not to repeat: *"Two scans that DO NOT work — do not repeat them."*

### Why it matters for S4
S4's `Suikoden4_offsets.md` is 13 KB and already has this instinct — the "(superseded) earlier
investigation notes" section, and the explicit *"What would finish it (verified, cheap)"* line on
recruitment, are exactly right. This issue is just to make it a **standing convention**:

1. Every RE session appends a dated section, whether or not it succeeded.
2. Failed searches record their **parameters**, so the next person knows what's already excluded.
3. Corrections supersede in place, with the original kept and marked.
4. When a doc exceeds ~1,000 lines, graduate the topic to `docs/TOPIC_RESEARCH.md`.
5. Add this to `CLAUDE.md` so it applies to AI sessions too.

### Acceptance criteria
- [ ] `CLAUDE.md` carries the notebook convention.
- [ ] The next three RE sessions each leave a dated section, including any that found nothing.

---

## #33 — PCSX2 automation harness  **[PORT]**
`area:infra` · `area:research` · `size:L` · `parity:s3`

### What S3 does
`tools/pcsx2/` — stdlib only, nothing to install — drives PCSX2 over its **PINE socket**:

| Command | Does |
|---|---|
| `doctor` | environment check |
| `boot-verify` | boots an edited disc and **reads the tables back out of EE RAM** |
| `snapshot` / `diff` / `scan` | RAM research: snapshot around a known in-game action, diff, narrow to the bytes that moved |
| `read` / `poke` / `codes` / `states` | direct RAM and savestate access |

`python3 tools/pcsx2/selftest.py` covers PINE framing, savestate parsing, scan narrowing, ELF
calibration and PNG hashing, and **runs in CI where no disc or BIOS exists**.

Its stated purpose is the honest one: *"The test suite proves the editor writes the bytes it means
to. It cannot prove the game reads them the way we think. `tools/pcsx2/` closes that gap."*

### Why it matters for S4
Every hard S4 blocker in this document — `FILEDATA` content mapping (#30), the spell table (#22),
starting stats (#24) — is explicitly identified **in S4's own notes** as savestate-gated. S4's
README says it in plain words: *"A PCSX2 savestate would unlock this; until then they aren't
editable."*

This harness is that unlock, and it is a **direct port** — `tools/pcsx2/` has no S3-specific logic
beyond an ELF calibration constant. Porting it is likely the single highest-leverage engineering
task in the whole document after #30, because it makes #30 tractable.

### How to build it
1. Copy `tools/pcsx2/` wholesale: `pine.py`, `cli.py`, `eemap.py`, `ramscan.py`, `harness.py`,
   `spdprobe.py`, `pngdiff.py`, `selftest.py`.
2. Retarget the ELF calibration to `SLUS_209.79` and the base address to S4's `0x532860` state
   block — S4's mirror fact makes calibration *easier* than S3's.
3. Port `selftest.py` into CI.
4. Port `docs/PCSX2_AUTOMATION.md`.

### Acceptance criteria
- [ ] `python3 -m tools.pcsx2.cli doctor` runs against a local PCSX2.
- [ ] `snapshot` / `diff` / `scan` narrow a known in-game change (recruit one unit) to the correct
      save offset, reproducing a result already proven from saves.
- [ ] `selftest.py` passes in CI with no emulator, disc or BIOS.

---

## #34 — Finish the recruitment ordering with a single-recruit controlled pair  **[RESEARCH]**
`area:research` · `size:S`

### The situation
This one is *already scoped in S4's own notes* and is cheap. `Suikoden4_offsets.md` records the
recruit byte as CRACKED — but also records a remaining gap under *"What would finish it (verified,
cheap)"*: a **single-recruit controlled pair** — save, recruit exactly ONE known unit, save again to
a new slot. A one-unit diff pinpoints the bit that flips with zero ambiguity.

The doc also warns, correctly: *"flipping a recruit bit alone may not make a unit usable, since
HQ/party availability and story gates are separate state."*

### Why it is still worth doing
It is a couple of hours of play plus a diff, it validates the shipped recruitment editor against
ground truth rather than against a heuristic, and it is the prerequisite for detecting the
soft-lock states the UI currently only warns about in prose (see #11).

### Acceptance criteria
- [ ] At least three single-recruit pairs captured and diffed.
- [ ] The result confirms or corrects `RECRUIT_BASE`/`RECRUIT_STRIDE`, and finds any *additional*
      state that moves on recruit (HQ/availability flags).
- [ ] Findings appended to `Suikoden4_offsets.md` per #32.

---

# Part 5 — Reference data & discovery

---

## #35 — Reference tab: from three tables to a research surface  **[PORT]**
`area:reference` · `size:M`

### What S3 does
`iso.js:9417-9424` — eight reference sub-tabs, each with a live count:

| Tab | Contents |
|---|---|
| Items | id → name |
| Classes | character classes |
| Skills | id → name |
| Item sources | **where each item comes from** — shop, drop, chest |
| Files | the 4,403-sub-file browser (#31) |
| Pickups | per-map chest / corpse / herb census |
| Mounts | decoded mount system: rider and mount capability, per-area bundling, mechanics that can't be exposed as fields |
| Music | every BGM cue in the event scripts + the BGM/ambient pair on every room record |

Note what the last two do: they surface **decoded-but-not-editable** knowledge. S3's policy is that
research which can't become a field still becomes a *view*, rather than living only in a markdown
file.

### Why it matters for S4
S4's Reference tab is three flat tables (113 characters, 519 items, 42 runes) rendered by one
`renderRefTable()` (`app.js:738`). Three concrete additions available **today**, with no new RE:

1. **Rune affinities as a full matrix** — `s4_affinities.json` is already loaded and currently only
   surfaces per-character inline. A sortable rune × character matrix is a genuinely useful planning
   tool and costs one render function.
2. **Unite attacks table** — `s4_unites.json` already has 29 combos with partners; today those only
   appear as tooltips on a character card. A standalone table answers "which unites exist and who
   do I need" in one place.
3. **Search across all tables** — the existing `openPicker()` filter (`app.js:159`) already does
   type-to-filter; lift it to the Reference tab.

### Acceptance criteria
- [ ] Reference gains the affinity matrix and unite table from existing committed data.
- [ ] Each sub-tab shows a live count, as S3's do.
- [ ] Adding a sub-tab is one array entry plus one draw function.

---

## #36 — Item descriptions
`area:reference` · `size:M` · *partly blocked on #30*

### What S3 does
`Editor/build_item_desc_extra.py` extracts authoritative item descriptions from the disc, and every
picker throughout **both** editors shows id + name + in-game description + category. Where a record
genuinely lacks a description (runes and foods have none), S3 substitutes verified **guide** text
instead — and where the guides have no entry either, shows **nothing rather than a guess**.

### Why it matters for S4
S4's pickers show name and id only. On a 519-item list that is a real usability problem: "Sacrificial
Jizo" tells you nothing about what it does, and there are dozens of similarly opaque names.

### How to build it
- Descriptions are almost certainly in `FILEDATA` (#30), same as the names were.
- **Interim, unblocked:** the repo already ships `Cheats/S4 Rune List.pdf`. Extract rune
  descriptions from it into `s4_rune_desc.json` via a committed script and surface them in the rune
  picker. That covers the 42 runes — the most decision-relevant pickers in the app — today.

### Acceptance criteria
- [ ] Rune descriptions ship from a committed generator script over committed source text.
- [ ] Pickers render a description when one exists and **nothing** when it doesn't.

---

# Part 6 — Process & quality conventions

These are not features. They are the habits that let S3 reach 152 releases without shipping a disc
corrupter, and they are cheap to adopt now and expensive to retrofit later.

---

## #37 — Adopt the "correct or absent, never wrong" rule explicitly
`area:docs` · `size:S`

Stated in `health-core.js` and `guide-core.js` and applied throughout S3: a check that needs a
lookup the caller didn't supply **simply doesn't run**; a field with no verified data shows
**nothing**, never a placeholder or a plausible guess; no finding claims a consequence that isn't
derivable from the write path.

S3's README applies this to whole features: unverifiable enemy packs ship **read-only rather than
wrong**; a disc the index doesn't describe makes the editor **say so** and fall back rather than
write someone else's numbers over yours.

**Action:** write this into `CLAUDE.md` as a project rule, and audit the existing S4 UI against it.

---

## #38 — Distinguish tested / untested / confirmed, per mechanism
`area:docs` · `size:S`

S3 marks every risky patch with what is actually known, and the distinction is fine-grained: a
confidence badge moves only on a play report about **that mechanism**, and a report earned under a
different patch shape **does not transfer**. Mount re-pairings carry per-combination markers
(*confirmed / expected / untested / rough / won't animate*). Features that are patched-but-unproven
live on a dedicated **Test** tab, because *"the patch working is not the same as the game coping."*

**Why S4 needs it now:** S4 ships `championAlways` and `noBattles` as ordinary checkboxes. Their
descriptive prose is excellent, but nothing states whether either has been **played**. The
encounter-rate slider likewise. Add a per-field verification state and render it.

> Note the counter-lesson S3 also learned: do **not** put tested/untested badges on things where
> the UI already states plainly what it does and the mechanism is not risky. Badges everywhere is
> noise; badges on risky, playable mechanisms is signal.

---

## #39 — Write every duplicate copy, and detect half-patched discs
`area:iso` · `size:S` · *applies as soon as S4 edits data*

Two S3 findings that cost real releases:
- Enemy data is **duplicated across streaming copies**; every edit must be written through to every
  byte-verified copy, and the review must say so ("×4 copies").
- 27 descriptions and 43 names are **stored twice**, and the mirror only works while both copies
  still read alike. A half-patched disc needs the value set directly. This is what made S3 issue
  #11 — a duplicated rune description — invisible for a whole release: *"the edit was on the disc,
  just on the copy the rune menu doesn't read."*

**Action:** before shipping any S4 data-table editor (#21–#28), search the disc for duplicate copies
of the record being edited and write them all. Make this an acceptance criterion on each of those
issues.

---

## #40 — Verify every patch site against pristine bytes before writing
`area:iso` · `size:S`

S3 checks that a site is still the shape it decoded before writing, and reverts byte-for-byte.
`web/tests/stock-restore.mjs` reads **270** stock constants off a pristine disc and fails if one
disagrees.

S4 already has the good instinct — every `FIELDS` entry has a `sig()` that accepts stock or patched
shapes and refuses anything else. Formalise it:
- [ ] Every future field carries a `sig()`.
- [ ] A test reads every `offBytes` off a real pristine disc (skipping cleanly when absent).
- [ ] Writing to a site whose signature doesn't match is refused with a specific message.

---

## #41 — Ship generated reference data, never runtime scraping
`area:reference` · `size:S`

S3's `Editor/build_*.py` scripts regenerate every reference table from a pristine disc plus saved
guide text in `Editor/suikosource/`, and the **output** is committed. The app never fetches a
third-party site at runtime.

S4 already follows this for its five JSON tables. **Action:** make it explicit in `CLAUDE.md`, and
add the missing generator scripts — `s4_unites.json` and `s4_affinities.json` appear to have been
extracted by hand, so their provenance isn't reproducible. Every committed JSON should have a
script that rebuilds it.

---

## #42 — Keep the privacy and no-game-data guarantees stated and tested
`area:docs` · `size:S`

Both repos ship no game data and both say so. S3 goes one step further: `web/tests/synth-iso.mjs`
**builds fixtures from the editor's own constants**, so the test suite proves the no-game-data rule
rather than relying on `.gitignore`.

**Action:** keep S4's existing guarantee, and when #8 lands, build its fixtures the same way. Add a
CI check that no file over ~1 MB and no `.iso`/`.ps2`/`.max` is ever committed.

---

# Part 7 — Suggested order

The dependency structure is lopsided: a handful of cheap, unblocked items deliver most of the
near-term value, and then everything else waits on one research problem.

### Wave 1 — unblocked, high value, mostly ports (≈2–3 weeks)
| # | Item | Size |
|---|---|---|
| #1 | Shared `*-core.js` modules | M |
| #3 | Per-field `↺` + Revert all | S |
| #4 | ISO tab shell | S |
| #7 | Version-drift guard | S |
| #6 | Boot gate | S |
| #2 | Undo / redo | M |
| #18 | `.s4mod` + `.xdelta` | M |
| #19 (Half B) | Code-patch audit + restore-to-stock | M |
| #5 | `data-sum` collapse | S |
| #35 | Reference: affinity matrix + unite table | M |

Everything in Wave 1 is a port or a small original, needs no new reverse engineering, and makes the
editor meaningfully better on its own.

### Wave 2 — makes the hard problems tractable (≈3–4 weeks)
| # | Item | Size |
|---|---|---|
| #33 | PCSX2 harness | L |
| #8 | Playwright e2e + synthetic fixture | L |
| #11 | Save health lint | M |
| #14 | Decode-time invariants | M |
| #32 | Notebook discipline | S |
| #34 | Single-recruit controlled pair | S |

**#33 is the pivot.** Both repos' notes independently conclude that a PCSX2 savestate unlocks the
remaining S4 blockers; this wave builds the tool that produces them on demand.

### Wave 3 — the keystone
| # | Item | Size |
|---|---|---|
| #30 | Crack `FILEDATA` | XL |
| #31 | Sub-file browser | M |
| #9 | Inventory (needs its own small RE, not #30) | L |
| #10 | Party editor | M |

### Wave 4 — the ISO editor S3 has
#21–#29 in whatever order the `FILEDATA` content map makes possible. Expect the order to be decided
by **what falls out of #30 first**, not by a plan written now. S3's own tab order was emergent for
exactly this reason.

### Parallel track, any time
#12 (guide overlays), #13 (JSON snapshot), #16 (108 Stars ordering), #36 (rune descriptions),
#37–#42 (conventions). These need guide text and discipline rather than reverse engineering, and
are good work for a contributor who isn't doing RE.

---

# Part 8 — Where Suikoden IV is already ahead

An audit that only lists deficits is a bad audit. These are real and should be **kept**, and two of
them are worth porting *back* into the S3 editor.

1. **pnach export.** `iso.js:217` — `⧉ Copy pnach line` emits ready-to-use PCSX2 codes for the
   current values, with a documented ISO-offset → EE-vaddr conversion (`iso.js:306`). **S3 has no
   pnach export at all** (`grep -c pnach` → 0). This is genuinely better: it gives users a
   zero-risk way to try a change without touching their disc, and it works in browsers that can't
   write a 4 GB file. **→ port this back to S3.**

2. **Multi-region save support.** S4's save editor handles NTSC-U *and* PAL with a region badge per
   save (`s4save.py:54`), verified across 8 saves in both regions. S3 is USA-only.

3. **A fallback path for every browser.** S4 degrades in three tiers — in-place (desktop Chromium),
   streamed copy (Android), pnach line (anywhere) — and the UI explains which one you're in
   (`iso.js:204`, `iso.js:222`). S3 has the first two; the third is S4's.

4. **`s4files.py` container breadth.** Six save container formats including `.max` (LZARI) and
   `.psv`, with the payload located by **self-validation** — the one window whose internal CRC/MD5
   checks out — rather than by a hardcoded offset. That is a more robust technique than a fixed
   offset table and generalises to containers not yet seen.

5. **Honest, prominent scope statements.** S4's README "Not included (and why)" section is
   excellent and states the `FILEDATA` blocker plainly rather than leaving it implied. Keep this.

6. **Rune affinities inline at the point of decision.** Showing 🔥⚡💧🌪⛰ ratings *on the rune
   picker* rather than in a reference table is the right place for that data. S3's guide overlays
   do the same thing for other fields; this is S4 independently arriving at the same principle.

---

# Appendix A — Source anchors

Every claim above is checkable. The main ones:

**Suikoden III** (`TheSparda/Suikoden-3-Editor` @ `4e2a739`)

| What | Where |
|---|---|
| ISO tab list (22 views) | `web/iso.js:3345-3348` |
| Test tab list | `web/iso.js:5844-5845` |
| Reference sub-tabs (8) | `web/iso.js:9417-9424` |
| Save sub-tabs (7) | `web/app.js:666-672` |
| Undo/redo stack | `web/iso.js:2028`, `:2053` |
| `.s3mod` recipe export | `web/iso.js:3186-3208` |
| `.xdelta` synthesis | `web/iso.js:3210` |
| Changes tab | `web/iso.js:10533` |
| Enemies tab | `web/iso.js:8194` |
| War tab | `web/iso.js:8273` |
| ELF table constants | `web/iso.js:27` (`TABLES`), `:57` (`SPELL`), `:58` (`UNITE`), `:121` (`FOOD`), `:125` (`GEAR`), `:147` (`RUNE_TBL`) |
| Review-changes modal | `web/app.js:2018` |
| Core modules | `web/{health,recruit,guide,text,changes,blurb,rename,svag}-core.js`, `web/vcdiff.js` |
| Test scripts | `web/tests/package.json` |
| `FSECT.BIN` crack (the tiling test) | `Editor/Suikoden3_ISO_offsets.md` §"FSECT.BIN CRACKED" (~line 1965) |
| Scans that don't work | same doc, §"Two scans that DO NOT work" (~line 1930) |

**Suikoden IV** (`TheSparda/Suikoden-4-Save-Editor` @ `3b2ea22`)

| What | Where |
|---|---|
| ISO editable fields (3) | `web/iso.js:21-66` (`FIELDS`) |
| pnach export | `web/iso.js:217`, offset→vaddr at `:306` |
| Save caps | `web/app.js:19` (`CHAR_CAP`), `:20` (`POTCH_MAX`) |
| Version lockstep comment | `web/app.js:21` |
| Picker | `web/app.js:159` (`openPicker`) |
| Staged-diff builder | `web/app.js:602` (`buildDiff`) |
| Review modal | `web/app.js:633` (`openConfirm`) |
| Save layout constants | `Editor/s4save.py:86-180` |
| RAM-mirror fact (`save = ram − 0x532860`) | `Editor/Suikoden4_offsets.md` §"Recruitment flags" |
| `FILEDATA` container format | `Editor/Suikoden4_offsets.md` §"FILEDATA archive format" |
| Spell table not located | `Editor/Suikoden4_offsets.md` §"Spell / unite tables" |
| Stat tables blocker | `README.md` §"Not included (and why)" |

---

# Appendix B — The five techniques worth stealing wholesale

Condensed from S3's research record. These are method, not code, and they apply to every remaining
S4 blocker.

1. **The tiling test for directories.** If you think a table is an archive directory, check that its
   entries tile the archive exactly (`off[i] + size[i] == off[i+1]`) and that runs end on the
   archive's real size. This turned S3's 3.5 GB search into ~100 candidates per archive, and it
   overturned a wrong verdict that had stood for three weeks.

2. **Fingerprint with a cross-check, never with a shape.** Scanning for "a table that looks right"
   returns thousands of hits at chance level, because mostly-zero data satisfies every constraint.
   Scan instead for a **multi-value signature with an internal consistency rule** — S3's enemy index
   used `(hp, hp, lv)` plus a recovered file↔vaddr delta; the room table used an area id that must
   stay constant while a room counter increments. For S4 the ready-made rule is id-set membership:
   519 known item ids, 42 rune ids, 113 character indices.

3. **A negative result is a deliverable.** Write down what you searched, with parameters, so it is
   never searched again. S3's notebook has an explicit "do not repeat these two scans" section, and
   several of its research docs exist purely to record that something doesn't work.

4. **"Exhaustive search found nothing" does not mean absent.** S3 searched the whole executable
   three times for Fortune's check. It was in a streaming battle overlay ~1 GB into the disc. If the
   ELF doesn't have it, the answer is that it's somewhere else — which for S4 means `FILEDATA`, and
   is precisely why #30 is the keystone.

5. **Prove the game reads it, not just that you wrote it.** A test suite proves the editor writes
   the bytes it means to and can never prove the game reads them as expected. That gap is what
   `tools/pcsx2/` exists to close (#33), and it is why S3 distinguishes *confirmed in play* from
   *patch applies cleanly* on every risky mechanism.

---

*Audit produced by comparing the two repositories' source, reference data, tests and
reverse-engineering notebooks. No game data was read, copied or redistributed.*
