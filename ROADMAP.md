# Suikoden IV Editor — delivery roadmap

Execution plan for all 43 open issues, written on the assumption that **every one of them gets
built**. The ordering question is therefore not "which are worth doing" but "which order costs
least" — foundations before the things that stand on them, and the long-pole research started
early because it is gated by latency, not effort.

Companion to [`CAPABILITY_GAP_AUDIT.md`](CAPABILITY_GAP_AUDIT.md), which says *what* is missing.
This says *in what order*, and *why that order*.

---

## 1. The shape of the backlog

43 issues: 14 S · 16 M · 9 L · 3 XL · 1 unsized (#1).

Three things dominate the dependency graph. Everything else is downstream of one of them.

```
#2  s4-core.js  ──┬─► #3 undo  ──► #4 revert
 (DOM-free       ├─► #12 health lint ◄── #15 decode invariants
  modules,       ├─► #13 guide overlays
  M)             ├─► #10 inventory
                 └─► #9 e2e can finally test logic, not strings

#5  ISO tab shell ──► #19 .s4mod · #20 Changes · #21 Text · #23–#30 (every future ISO tab)
 (S)

#31 KEYSTONE FILEDATA ──► #22 #23 #24 #25 #26 #27 #28 #29 #30 #32 · half of #17 #37
 └ #44 index (proven) ─► #45 entry semantics ─► #46 codec? ─► #47 content map
        ▲
        └── #34 PCSX2 harness (L) makes #47 tractable (Attack D)
```

- **#2 is the first commit.** Today `validate.mjs` can only assert that strings appear in
  `app.js`. Until the rules live in a DOM-free module, nothing written after this point is
  testable, and the cost of that compounds with every feature.
- **#5 is the cheapest high-leverage item.** Eight issues need somewhere to render. Build the
  shell before the first tab, not after the third.
- **#31 blocks 9 issues and gates two more.** It is research, so it should be *running* while
  the build track proceeds — not queued behind it.

Four issues (**#38 #39 #40 #41**) are not features at all. They are acceptance criteria that
belong on other issues. They resolve in Phase 0 as written policy, and their code halves land
with the features they guard.

---

## 2. Two tracks, in parallel

| | **Build track** | **Research track** |
|---|---|---|
| Nature | Bounded, sequential, testable | Unbounded, latency-gated, may fail |
| Gating | Each phase gates the next | Gates all of Phase 6 |
| Start | Phase 0 | **Phase 0 — same day** |
| Converge | | Phase 6 |

Starting the research track late is the single biggest schedule risk in this backlog. #31's
first milestone is already reached (§6) and its remaining unknowns are bounded, but if it turns
out to need an emulator run (Attack D), that is a calendar dependency, not an engineering one.

---

## 3. Phases

### Phase 0 — Rules of the road, and a CI to enforce them

*#33 #38 #42 #43 #8 · policy halves of #39 #40 #41 · plus one unfiled prerequisite*

> **Unfiled prerequisite: there is no CI.** `.github/` contains only `ISSUE_TEMPLATE/config.yml`.
> #8 ("version-drift guard in CI") and #43 ("add a CI check") both assume a workflow that does
> not exist. Add `.github/workflows/ci.yml` running `npm test` from `web/tests` first, or those
> two issues have nowhere to land.

These are all size S and they are the constraints every later phase must satisfy. Writing them
after the feature wave means retrofitting them.

1. `.github/workflows/ci.yml` — `npm test` on push + PR. Node + Python, no disc, no BIOS, no
   emulator. Python is installed deliberately rather than letting the round-trip skip itself:
   `save-roundtrip.mjs` drives the real `s4save` codec, and it is the only test that exercises
   the actual save format.
2. `CLAUDE.md` carrying the four house rules, so they bind AI sessions too:
   - **#38** *correct or absent, never wrong* — a check missing its lookup doesn't run; a field
     with no verified data renders nothing.
   - **#33** notebook discipline — every RE session appends a dated section **including the ones
     that found nothing**, with their search parameters; corrections supersede in place with the
     original kept; graduate a topic to `docs/` past ~1,000 lines.
   - **#42** every committed JSON has a committed generator script. `s4_unites.json` and
     `s4_affinities.json` currently don't — backfill them.
   - **#43** no game data, ever; fixtures are generated from the editor's own constants.
3. **#8** version-drift guard — three-place coupling (`index.html` footer / `APP_VERSION` /
   `sw.js` cache name) already caused one shipped desync. A comment is not a guard.
4. **#43** CI check: refuse any commit adding a file >1 MB or matching `*.iso|*.ps2|*.max|*.mcd`.
5. **#39 #40 #41** — write the rules down and add them to the issue template as a checklist:
   per-mechanism verification state; write *every* duplicate copy and report the count; every
   field carries a `sig()` and a mismatched site refuses the write.

**Exit:** CI green on every push. `CLAUDE.md` exists. #33 #38 #43 #8 closed; #39 #40 #41 closed
as policy with their code halves tracked on the features they guard.

**#42 stays open** — its rule is written (CLAUDE.md §4) but the generator backfill is not done.
`s4_unites.json` and `s4_affinities.json` were extracted by hand and still have no script. The
unite source (`Guides/…Combo Attacks Guide….pdf`) is committed so that generator can be written;
the affinity source (OmegaDL50's GameFAQs FAQ) is **not** in the repo, so that one needs its
source text committed first. Neither is stdlib-trivial — PDF text extraction is the actual work,
and this repo's Python is stdlib-only by policy.

---

### Phase 1 — The spine

*#2 → #5 → #3 → #4 → #6 → #7*

**#2 first, alone, with no behaviour change.** Move `lvFromExp`/`expFromLv`, the `CHAR_CAP`
clamps, `affFor`+`AFF_ALIAS`, `buildDiff()` and `REC_STATES` into `web/s4-core.js` using S3's
IIFE/`module.exports` wrapper verbatim. Add `tests/s4-core.mjs` asserting real round-trips. This
commit should be provably inert — it exists to make everything after it testable.

**#5 next** (tab shell, S). Cheap, and it unblocks Phase 4 and Phase 6 alike. Keep the
save/apply toolbar *outside* the tab host so staged edits from several tabs land in one review —
that is how S3 gets one review list across 22 tabs.

**#3 then #4** (undo/redo, per-field `↺` + `Revert all`). Sequence matters: **both must exist
before any bulk operation ships.** A bulk scale applied to the wrong scope with no undo is
unrecoverable, and Phase 6 is full of bulk operations. #4 is nearly free — `iso.js` already
keeps `orig` for every window and `isDirty()` already compares against it; the data is there,
it just isn't exposed.

**#6 #7** last in the phase — low-risk UX. #7 matters more than its size suggests: the ISO
editor is a completely Pyodide-free code path, and right now nothing tells the user that during
~10 MB of cold-start download.

> Known trap, already paid for in S3 (#6): key blurb expand-state by **summary text**, not
> element identity, or every card snaps shut on the first re-render.

**Exit:** headless tests exercise real logic. ISO editor has tabs. Every edit is undoable and
revertible at three granularities.

---

### Phase 2 — Test harness

*#9*

Land this **after the shell stabilizes and before the feature wave** — not at full S3 scale.

**Recommendation: don't write 5,533 lines up front.** Ship the infrastructure plus a thin smoke
suite, then make "adds its own e2e case" an acceptance criterion on every subsequent issue. The
suite grows with the features instead of being a separate project that goes stale.

1. `chromium-path.mjs` verbatim.
2. `synth-s4-iso.mjs` — build the fixture from `FIELDS`' own `sig()` constants, so it cannot
   drift from the code under test and ships no game data (this is what makes **#43** a proof
   rather than a promise).
3. Smoke suite: load synthetic ISO → read each field → move the slider → review sheet shows
   `old → new` → streamed-copy path emits the right byte runs.

**Exit:** `npm run test:e2e` runs headless against a generated fixture. A deliberately broken
picker fails the suite.

---

### Phase 3 — Save editor depth (no new RE needed)

*#15 → #12 → #14 → #16 → #11 → #36 → #37 (interim)*

Ordered by what feeds what:

- **#15 decode-time invariants first.** The ingredients already exist and are unused:
  `s4save.py:387-407` parses the icon.sys title (`Suikoden4 [NN] LVLnn / H:MM`), so every save
  carries an **independent witness** for chapter, level and playtime. That cross-check ran during
  RE; it should run on every load. Its structured finding list is the input to #12.
- **#12 health lint** consumes that list. Start with the checks S4 can make *today*: silent
  clamps (the user types 99999 HP, sees it accepted, gets 9999 with no notice), out-of-enum
  recruit values, `11`/`15` party members who aren't recruited, unknown rune/item ids, EXP that
  disagrees with the displayed level. Every fix **stages**, never writes.
- **#14 JSON snapshot** early, out of order by size, because it is the best bug-report format
  this project can have: it contains no copyrighted game data and can be pasted into an issue.
  Everything after this phase gets easier to debug.
- **#16 before #10.** #16 derives the equipment **category table** from the same purity analysis
  that located the slots ("+0xBE holds only armor/robes and +0xC2 only boots/shoes, 100% pure").
  That purity analysis *is* a category table — emit it to JSON. #10's pickers need it too, so
  building it here avoids doing it twice.
- **#11 party view** ships **read-only immediately** — the party is derivable from the recruit
  enum (`11`/`15`) with zero new RE. True slot *ordering* needs the capture session (§5).
- **#36 #37** are pure wins over data already committed: the affinity matrix and unite table
  already exist as JSON and currently only surface as tooltips. #37's interim half extracts rune
  descriptions from `Cheats/S4 Rune List.pdf` — 42 runes, the most decision-relevant pickers in
  the app, unblocked today.

**#10 inventory** sits at this phase's edge: it needs RE, but *not* FILEDATA. **Spend five
minutes on the cheat tables before anything else** — `Cheats/Suikoden IV (USA).ct` already
yielded potch, current HP, the world-map flags and the Recruited byte. If inventory is in there,
`save_offset = ram_addr - 0x532860` and it ships this phase. If not, it joins the capture queue.

> **Risk:** getting one-per-slot wrong **destroys items** — the game stores three Fury Runes as
> three slots, not one slot with a count of 3. Ship #10 read-only first, verify against a real
> save, then enable writes.

---

### Phase 4 — ISO features that aren't blocked

*#18 → #19 → #20 (Half B) + #41 → #21*

- **#18 region parity.** The asymmetry is user-visible and confusing: the *save* editor supports
  NTSC-U and PAL, the *ISO* editor hard-fails PAL as "not Suikoden IV". The patch shapes are
  known (`addiu a0, zero, imm`; a `beqz` to nop; a `jal` to replace), so this is a pattern search
  against the PAL ELF, not fresh RE. Where a region's offset is unknown, **hide the field for
  that region** rather than guess.
- **#19 `.s4mod` + `.xdelta`.** `vcdiff.js` is game-agnostic and copies over. `allRuns()` already
  returns `[{off, bytes}]` — the exact shape needed. S4's edits are currently three 4-byte code
  patches, so a recipe file is ~300 bytes. This is the difference between "a personal tool" and
  "a project that can have a modding community", for size M.
- **#20 Half B + #41 together** — they are the same test. Every code patch replaces a *documented*
  word, so the audit already knows what stock looked like; `FIELDS` carries the stock bytes today.
  `tests/stock-restore.mjs` reads them off the pristine disc and fails if one disagrees — *that
  is what makes "restore to stock" mean restore to pristine rather than restore to what this repo
  believes stock was.* Half A waits for #31.
  > `Base ISO/` and `Cheats/` are **gitignored**. This test must skip cleanly when absent,
  > mirroring how `save-roundtrip.mjs` skips without `python3`.
- **#21 in-ELF text scan** is a bounded experiment with a defined negative outcome. The notebook
  says character/item strings aren't ASCII in the ELF — but that's *game-data* strings, and it
  doesn't follow that no UI text is there. Run the scanner for ASCII **and** Shift-JIS/UTF-16
  (the save titles are already Shift-JIS full-width, so an ASCII-only scan may miss everything).
  Either a Text tab ships, or **the negative result is documented with its search parameters**
  and the issue closes pointing at #31. A recorded dead end is a deliverable.

---

### Phase 5 — Research track (runs from day one, parallel to 0–4)

*#34 → #31 · capture session for #35 #1 #10 #11 · #23/#24 anchor hunt*

**#34 PCSX2 harness first.** It is a near-verbatim port — `tools/pcsx2/` has no S3-specific logic
beyond an ELF calibration constant, and S4's RAM-mirror fact (`save = ram - 0x532860`) makes
calibration *easier* than S3's. Its `selftest.py` runs in CI with no emulator, disc or BIOS.
Every hard blocker in this backlog is identified **in S4's own notes** as savestate-gated; this
is that unlock.

**#31** then proceeds on the four attacks in the issue. See §6 — the outer tiling milestone is
already reached, which changes what's left.

**#23/#24 anchor hunt** can run alongside: the notebook asks for "a name-string or damage-value
anchor from a guide". `Cheats/S4 Rune List.pdf` is in hand. Search for a *multiset* of a record's
values at a consistent stride — a single value is noise, a record's worth is a fingerprint.

---

### Phase 6 — Post-keystone wave

*#32 → #22 → #26 #23 #24 → #28 → #27 → #25 → #29 → #30*

Ordered by rising risk and falling certainty:

1. **#32 sub-file browser first.** It falls straight out of #44 and is the first *user-visible* deliverable of #31 and it makes
   further RE community-scalable: ~1,000 unlabeled sub-archives become a worklist instead of a
   wall. Read-only on purpose — a raw byte editor over thousands of unknown blobs is a footgun.
2. **#22 renaming next** — validates the whole decompress → edit → recompress → fix-offsets loop
   on the lowest-risk possible target. A wrong name is cosmetic; a wrong enemy record is not.
3. **#26 #23 #24** — the data tables. Investigate #23 and #24 *together*; they are almost
   certainly the same table region.
4. **#28 #27 #25** — per-map encounters, shops, growth curves.
5. **#29 #30 last.** Both XL, both destructive if wrong, both with S3 lessons that cost real
   releases. #30 in particular is a retargeted-`jal` trampoline with an ordering rule on restore
   (call sites before the helper block, or a live jump lands in restored code and hangs).

Three properties are **acceptance criteria on every issue in this phase**, from #40/#41:

- **Bulk tuning is idempotent**, recomputed from a committed *stock* base — not the file's
  current values. ×3 after ×2 gives ×3, not ×6. On a disc the index doesn't describe, the editor
  **says so** and falls back rather than writing someone else's numbers over yours.
- **Every duplicate copy is written**, and the review reports the count ("×4 copies"). S3 shipped
  an invisible bug for a whole release because the edit landed on the copy the rune menu doesn't
  read.
- **Unverifiable records ship read-only rather than wrong.**

---

### Phase 7 — The guide layer

*#13 → #17 → #37 (full) → #10 (errand costs)*

Last because it is the widest and it depends on both earlier tracks: the extraction pipeline
(#42's generator discipline) *and* FILEDATA for descriptions and shop/drop tables.

- **#13** — build `Editor/build_s4_guide_refs.py` on the model of S3's. Committed source text in,
  committed JSON out, **never scraped at runtime**. A character absent from the guides renders
  **no note**.
- **#17** — ship the **ordering + how-to + story/optional split** first; the errand-cost machinery
  (shop counters, drop tables) is a follow-up behind #31. Mark auto-joining story characters faded
  + ⚠ — manually recruiting them can soft-lock an early save.

---

## 4. Issues that are not engineering-gated

**#1 (force NG+)** is blocked on a save nobody has. It needs a pre-final-boss → clear-data pair.
Everything else about it is already scoped. Its one cheap supporting task is worth doing anyway
and helps five other issues: **write `Editor/s4_savediff.py`** — two payloads in, changed runs
out, with mapped fields annotated and the known-noisy regions (the playtime mirrors at
`+0x108/+0x2E8/+0x5B8/+0x720`, world-map flags, character records) suppressed. Build it during
Phase 3; it is the tool the capture session in §5 consumes.

---

## 5. One emulator session unblocks five issues

Each of these is individually cheap and individually requires sitting at PCSX2. **Batch them.**
Do this once, early, ideally right after `s4_savediff.py` exists and #34 can drive the captures.

| Capture | Unblocks |
|---|---|
| Save → recruit exactly ONE known unit → save to a new slot. ×3. | **#35** (confirms `RECRUIT_BASE`/`RECRUIT_STRIDE` against ground truth, finds any additional HQ/availability state that moves) |
| Save → pick up one known item → save. | **#10** inventory offset — the 519 known item ids make id-membership a very strong filter |
| Save → reorder the party → save. | **#11** true slot ordering |
| Pre-final-boss save + clear-data save + first NG+ save. | **#1** |
| Savestate during a battle. | **#31** Attack D, **#23/#24** spell/unite tables, **#25** growth curves |

The last row is the highest-value single artifact in the backlog: a `.p2s` holds full EE RAM, so
a table found live by its known values can be searched **back into** `FILEDATA` to find its
on-disc source. That converts every remaining Phase 6 blocker from a search problem into a lookup.

---

## 6. Findings from this review that change the plan

Four corrections, recorded here and due to be appended to `Editor/Suikoden4_offsets.md` as a
dated section per **#33**.

**(a) #31 was two-thirds solved already. Re-scoped into #44 #45 #46 #47.**

The notebook records *"BI2 (60MB) has 55 real entries"*. It doesn't — those are the **first
archive's** entries. `FILEDATA.BI2` is **260** back-to-back self-describing archives (4,537
entries); `FILEDATA.BI1` is **1,066** (57,771 entries). 1,326 archives, 62,308 sub-files.

S3's tiling test — the technique #28 calls "the single most transferable in this document" —
**passes outright, first try**: BI2 **258/258** consecutive pairs tile exactly, BI1 **1065/1065**,
with BI1's last archive ending on the file's *exact* final byte (delta 0). Sector-aligned, zero
gaps, zero overlaps.

And the codec — #31's hardest unknown — probably isn't one. For every `flags=2` entry,
`size − (next.offset − this.offset) == 16`: **20,830 of 20,830, zero exceptions**. Six sampled
payloads are 1.00–1.01× ratio, entropy 4.9–6.7 b/B against ~7.99 for compressed data, and visibly
full of `00 00 80 3f` — IEEE-754 `1.0`. They are plain float/geometry data. There is also an
undocumented third flag value (`flags=3`, 220 entries).

So the keystone splits four ways, and only the last is genuinely open:

| | | |
|---|---|---|
| **#44** | outer archive index | **proven**; needs committing as script + test |
| **#45** | entry semantics — `flags`, the +16 rule, 15 unparsed archives | bounded |
| **#46** | is there a codec at all? | bounded; 6 samples say no, 21,153 unswept |
| **#47** | content map — locate the first game table | **the real remaining work** |

Full evidence and search parameters are in `Editor/Suikoden4_offsets.md` under the dated
*"FILEDATA re-examined"* section, with the two wrong claims superseded in place per #33.

**(b) All the research inputs are on this machine but none are in the repo.**
`Base ISO/Suikoden IV (USA).iso` (4.36 GB), `Cheats/` (two CT tables, a 588 KB pnach, the rune
list PDF) and `Saves/` all exist locally and are all **gitignored** — correctly, they're not
redistributable. Consequence for the plan: every test that needs them (#41 stock-restore, #20
Half B, #9's real-disc cases) **must skip cleanly when absent**, or CI breaks for everyone
including the maintainer's own clean clone. Mirror the `save-roundtrip.mjs` skip pattern.

**(c) There is no CI.** Two issues assume one. See Phase 0.

**(d) The 588 KB pnach hasn't been mined.** `Cheats/Suikoden IV (NTSC-U).pnach` is the largest
unexamined research input in the tree. pnach lines are literal `patch=1,EE,<addr>,<type>,<value>`
records — i.e. a pile of **already-located EE addresses**, each of which maps into the save with
`save = ram - 0x532860`. That is the same lever that cracked recruitment, potch, game time and
the world-map flags. It costs an afternoon and may retire #10 and #11's RE outright. **Do it in
Phase 3, before any byte-diffing.**

---

## 7. Standing rules (from #38–#43, binding on every phase)

- **Correct or absent, never wrong.** No placeholders, no plausible guesses. A check missing its
  lookup doesn't run.
- **Every edit is staged.** Fixes, imports and applied patches stage like any other edit and go
  through `old → new` review. Nothing writes directly.
- **No game data in the repo.** Fixtures are generated from the editor's own constants.
- **Record negative results**, with their parameters, in the notebook. A recorded dead end is
  worth more than a question reopened every few months.
- **Verify against pristine bytes before writing**; refuse a site whose signature doesn't match.
- **Write every duplicate copy**, and say so in the review.
- **State what has actually been played.** A confidence badge moves only on a play report about
  *that mechanism*; a report earned under a different patch shape does not transfer.
