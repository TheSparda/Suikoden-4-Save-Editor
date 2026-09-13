# Working rules for this repo

Binding on humans and AI sessions alike. These are not style preferences — each one exists
because getting it wrong has already cost this project or its sibling
([Suikoden III editor](https://github.com/TheSparda/Suikoden-3-Editor)) a shipped bug.

Delivery plan: [`ROADMAP.md`](ROADMAP.md). Gap analysis: [`CAPABILITY_GAP_AUDIT.md`](CAPABILITY_GAP_AUDIT.md).

---

## 1. Correct or absent, never wrong

A field with no verified data shows **nothing** — never a placeholder, never a plausible guess,
never an interpolation. A check that needs a lookup the caller didn't supply simply doesn't run.
No finding claims a consequence that isn't derivable from the write path.

This scales up to whole features: an unverifiable record ships **read-only rather than wrong**.
On a disc the index doesn't describe, say so and fall back — never write someone else's numbers
over the user's.

> Why: a wrong number looks exactly like a right one. A blank is self-describing.

## 2. Every edit is staged

Nothing writes to a save or a disc without an explicit **old → new** review. That includes
health-lint fixes, imported snapshots, applied `.s4mod`/`.xdelta` patches, presets and bulk
operations. They stage like any other edit; they never write directly.

## 3. No game data in the repo

No ISOs, saves, memory cards or extracted game text. `Base ISO/`, `Saves/` and `Cheats/` are
gitignored and must stay that way.

Test fixtures are **generated from the editor's own constants**, so the suite proves the rule
instead of relying on `.gitignore`, and a fixture can never drift from the code under test.
Enforced by `web/tests/no-game-data.mjs`.

**Corollary:** research inputs live on the maintainer's machine, not in CI. Any test needing a
pristine disc, a cheat table or a real save **must skip cleanly when it is absent** — mirror the
skip in `web/tests/save-roundtrip.mjs`. A test that fails on a clean clone is a broken test.

## 4. Ship generated reference data, never runtime scraping

Every committed JSON table has a committed script that rebuilds it from committed source text or
from a pristine disc. The app never fetches a third-party site at runtime.

Provenance backlog, tracked in #42: `s4_unites.json` and `s4_affinities.json` were extracted by
hand and do not yet have generators.

## 5. Notebook discipline

`Editor/Suikoden4_offsets.md` is the primary record, and it is append-only.

1. Every reverse-engineering session appends a **dated section** — including the ones that found
   nothing.
2. A failed search records its **parameters**, so the next person knows what is already excluded.
3. Corrections **supersede in place**: the original stays, marked, with the correction beside it.
   The wrong premise is the useful part — it is what stops the question being reopened.
4. Past ~1,000 lines, graduate a topic to `docs/TOPIC_RESEARCH.md`.

> Why: S3 wrote off `FSECT.BIN` as a relocation table, then correctly identified it as a directory
> three weeks later. That correction is legible *only* because the wrong entry was kept. The same
> thing just happened here — the FILEDATA "55 entries" and "flags=2 = compressed" readings were
> both wrong, and both are now on record rather than quietly deleted (#31).

## 6. Verify against pristine bytes before writing

Every patch site carries a `sig()` that accepts the stock and patched shapes and **nothing else**.
A site whose signature doesn't match refuses the write with a specific message. Restoring is
byte-exact, not a recomputation.

## 7. Write every duplicate copy

Game data is duplicated across streaming copies and mirrored name/description records. An edit
writes **every** copy, and the review says how many ("Potch: 33000 → 44444 (×4 copies)").

> Why: S3 shipped a rune-description fix that was invisible for an entire release — the edit was
> on the disc, just on the copy the rune menu doesn't read.

## 8. Bulk operations are idempotent

Every bulk-scaled value recomputes from a **stored stock base**, not from the file's current
numbers. ×3 after ×2 gives ×3, not ×6. Re-opening an already-tuned disc recovers what was done
to it rather than compounding it.

## 9. Say what has actually been played

A patch working is not the same as the game coping. Track verification state **per mechanism**;
a play report earned under one patch shape **does not transfer** to another. Features that are
patched-but-unproven say so where the user can see it.

## 10. Version lockstep

`APP_VERSION` in `web/app.js`, the footer in `web/index.html`, and `CACHE` in `web/sw.js` must all
carry the same version. Enforced by `web/tests/version-drift.mjs` — a comment is not a guard, and
this repo has already shipped one desync (`1e58260`).

Bumping the version means tagging and cutting a GitHub release.

---

## Repo layout

| | |
|---|---|
| Web app | `web/app.js` (save editor) · `web/iso.js` (ISO editor) · `web/index.html` · `web/sw.js` |
| Save engine | `Editor/s4save.py` (offsets + codec) · `Editor/s4files.py` (containers) · `Editor/s4lzari.py` |
| Reference data | `Editor/s4_char_offsets.json` (113) · `s4_item_names.json` (519) · `s4_rune_names.json` (42) · `s4_unites.json` (29) · `s4_affinities.json` |
| RE notebook | `Editor/Suikoden4_offsets.md` · `Editor/Suikoden4_encounter_rate.md` |
| Tests | `web/tests/` — `npm test` from that directory |

The web app is served from the **repo root**, not `web/` — it fetches `../Editor/*.py` and the
reference JSON at runtime.

```bash
python3 -m http.server 8791     # from the repo root, then open /web/
```

## The one fact that unlocks most offset work

The save `gamedata` payload is a **verbatim image of the game's state block at EE `0x532860`**.
Any RAM address maps into the save linearly:

```
save_offset = ram_address - 0x532860
```

That is how the recruitment flag, potch, game time and the world-map flags were all located. Try
it **before** any byte-diffing — `Cheats/` holds three community cheat tables and a 588 KB pnach,
all of which are piles of already-located EE addresses.
