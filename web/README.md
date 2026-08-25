# Suikoden IV Save Editor — Web (Pyodide + PWA)

A browser build of the editor. Open a save (or your ISO), edit it, and write it back —
**entirely on your device**. Nothing is uploaded. It installs to an Android/desktop home
screen and works offline after the first load.

Live: **https://thesparda.github.io/Suikoden-4-Save-Editor/web/**

Three tabs:

- **Save Editor** — full parity with the desktop tool (runs the real `s4save.py` in Pyodide).
- **ISO Editor** — direct disc edits (encounter rate + code toggles), written in place on
  desktop or streamed as a patched copy on Android.
- **Reference** — browse the 113 characters, 519 items, 42 runes, and rune affinities.

---

## Save Editor

Runs the repo's real, stdlib-only Python save module (`../Editor/s4save.py`, plus
`s4files.py` and `s4lzari.py`) **unchanged** inside [Pyodide](https://pyodide.org) (CPython
in WebAssembly). Your picked save is written into an in-memory filesystem, decoded and
edited by the same trusted code the desktop app uses, and the edited bytes are read straight
back out for saving. All format sniffing, checksums (CRC32 + reversed MD5) and PS2
memory-card ECC are handled by the Python module — nothing is re-implemented in JS.

**Layout** mirrors the desktop editor: a persistent **Overview** card (region · checksum ·
recruited count, Names, Potch, game time, world-map "mark fully explored") above a subtab
card:

- **Characters** — one card per character: recruitment status, Level/EXP, weapon level, Max
  HP, the eight stats, three rune slots, unite-attack levels, and seven equipment slots.
  - **Searchable pickers** replace the 500+-item dropdowns — type to filter by name or id.
  - **Rune affinities** shown inline (🔥⚡💧🌪⛰, 1 poor–4 excellent) from the GameFAQs FAQ,
    so you pick runes with intent.
  - **★ Max out** preset per character (stats, HP, level, weapon Lv, unites) — staged and
    reviewable.
- **Recruit** — a filterable table of every character with a recruitment-status dropdown
  per row, to set recruitment in bulk (with a soft-lock warning).

Plus a **max** button on Potch. Every edit is **staged**, shown in an **old → new review**
before it's written, and highlighted as unsaved.

**Save paths:** download the edited copy everywhere; **save in place** to the original file
on desktop Chromium (File System Access); **Apply & share…** to another app on Android.
A save shared *into* the installed PWA opens automatically. The last-opened save reopens
with one tap.

### Supported formats

| Format | Extension | Read | Write |
|---|---|:--:|:--:|
| PS2 memory card (PS2MFS) | `.ps2` `.mcd` `.mc2` `.bin` | ✅ | ✅ |
| CodeBreaker | `.cbs` | ✅ | ✅ |
| EMS / uLaunchELF | `.psu` | ✅ | ✅ |
| SharkPort / X-Port | `.sps` | ✅ | ✅ |
| MAX Drive | `.max` | ✅ | read-only |
| PS3 export (signed) | `.psv` | ✅ | read-only |

To edit a `.max`/`.psv`, convert it to a memory card / `.psu` / `.cbs` first.

---

## ISO Editor

Direct edits to the game disc — no upload, only tiny byte-runs change. It reads just the
small code windows it edits from the ~4.36 GB ISO (ranged `Blob.slice`), so nothing large is
held in memory, and verifies the **NTSC-U (SLUS-209.79)** signature before allowing changes.

**Random encounters** (all reverse-engineered from the boot ELF):

- **Encounter rate** — a **slider** (¼ / Half / Stock / Double / Triple presets + a number
  box) that scales how often random battles trigger, with a live "≈ ½× the battles"
  readout. The game rolls the threshold as `rand(0..N-1)`; this sets `N = round(10000 / %)`.
- **Champion's Rune effect — always on** — runs the game's own selective suppression (skip
  enemies weaker than your party, party-wide) *without equipping the rune*.
- **Turn off random battles completely** — no random encounters anywhere (stronger than the
  Champion's Rune, which only stops weaker enemies).

Every change is confirmed in an **old → new review** first.

**Save paths:**
- **Desktop Chrome/Edge/Brave/Opera** — writes the changed bytes **in place** via the File
  System Access API (the 4 GB around them is untouched).
- **Android Chrome/Firefox** — **streams a patched copy** of the whole disc to your
  downloads through the app's own service worker (bounded memory, nothing uploaded). Swap
  the copy in for your ISO to play.
- **Anywhere** — **Copy pnach line** emits ready-to-use PCSX2 codes for your current values.

Full reverse-engineering notes: [`../Editor/Suikoden4_encounter_rate.md`](../Editor/Suikoden4_encounter_rate.md).
Prefer the command line? [`../Editor/s4_encounter_rate.py`](../Editor/s4_encounter_rate.py)
patches the ISO by percentage in place.

---

## PWA / offline

- Installable (manifest + service worker); works offline after the first load.
- The service worker is **network-first** for the app shell (with `no-store`, so a new
  deploy is picked up on the next launch and the version can't desync), and **cache-first**
  for the version-pinned Pyodide CDN (~10 MB, downloaded once).
- A **version-behind banner** offers to update when a newer build is deployed, and a footer
  **↻ Force refresh** clears the service worker + caches if anything is ever stuck.
- Mobile-first: safe-area insets, sticky action toolbar, full-width picker/review sheets,
  44px touch targets; no horizontal overflow at 320/360 px.

## Safety

- **Nothing is uploaded** — saves and the ISO are read on your device only.
- Save writes recompute the checksum (+ memory-card ECC); ISO writes only touch the changed
  byte-runs and are region-gated.
- Every write is preceded by an explicit **old → new review**. Back up first anyway.

---

## Run / deploy

This folder fetches `../Editor/*.py` and the reference JSON at runtime, so it must be served
from the **repo root** (not with `web/` as the site root).

**Local:**
```bash
python3 -m http.server 8791     # run from the repo root
# open http://localhost:8791/web/
```

**GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `/ (root)`. The repo
root has a `.nojekyll` file so `.py` files are served verbatim. Every push to `main`
rebuilds the site. Pyodide is pinned to `v0.26.2` in both `index.html` and `sw.js`.

## Tests

Ships **no game data** — fixtures are built from the engine's own constants. From `web/tests`:

```bash
npm test
```

- `validate.mjs` — static checks: JS parses; reference-table sizes; `s4save.py` offset
  self-consistency; ISO field offsets inside the boot ELF; save + ISO save-path wiring;
  affinity data + coverage; version lockstep.
- `save_roundtrip.py` — imports the **real** `s4save` and drives a synthetic payload through
  decode → edit → write → re-decode, asserting checksum + ECC. Skips cleanly without Python.

## Android / emulator flow

1. Open the live URL in Chrome; wait for "Python engine ready."
2. Tap **⬇ Install app** for a home-screen icon (works offline after the 2nd visit).
3. **Saves:** export/copy the memory-card file (or a `.cbs`/`.psu`/`.sps`) out of your
   emulator → open it here → edit → **Apply & download** (or share) → copy it back.
4. **ISO:** open the disc in the ISO Editor → change the encounter rate → **Save patched
   copy** → replace your ISO with the download.
