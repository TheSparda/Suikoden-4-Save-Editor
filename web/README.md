# Suikoden IV Save Editor — Web (Pyodide + PWA)

A browser twin of the desktop editor. It opens a Suikoden IV PS2 save you pick, lets you
edit it, and downloads the edited copy — **entirely on your device**. The save file is
never uploaded. It installs to an Android/desktop home screen and works offline after the
first load.

Live: **https://thesparda.github.io/Suikoden-4-Save-Editor/web/**

## How it works

It runs the repo's real, stdlib-only Python save module (`../Editor/s4save.py`, plus
`s4files.py` and `s4lzari.py`) **unchanged** inside [Pyodide](https://pyodide.org)
(CPython in WebAssembly). The picked save is written into Pyodide's in-memory filesystem,
decoded and edited by the same trusted code the desktop app uses, and the edited bytes are
read straight back out for download. All format sniffing, checksums (CRC32 + reversed MD5)
and PS2 memory-card ECC are handled by the Python module — nothing is re-implemented in JS.

## What you can edit

Feature parity with the desktop Save Editor:

- **Per save:** hero name, ship name, Potch (money), game time, world-map "mark fully explored".
- **Per recruited character:** recruitment status, Level/EXP, weapon level, Max HP, the eight
  stats, three rune slots, unite-attack levels, and seven equipment slots — all via
  name dropdowns.

The ISO tools from the desktop app are intentionally left out — the web app is saves-only.

## Supported formats

| Format | Extension | Read | Write |
|---|---|:--:|:--:|
| PS2 memory card (PS2MFS) | `.ps2` `.mcd` `.mc2` `.bin` | ✅ | ✅ |
| CodeBreaker | `.cbs` | ✅ | ✅ |
| EMS / uLaunchELF | `.psu` | ✅ | ✅ |
| SharkPort / X-Port | `.sps` | ✅ | ✅ |
| MAX Drive | `.max` | ✅ | read-only |
| PS3 export (signed) | `.psv` | ✅ | read-only |

To edit a `.max`/`.psv`, convert it to a memory card / `.psu` / `.cbs` first.

## Android / emulator flow

1. Open the live URL in Chrome. First load pulls the Pyodide runtime (~10 MB) — wait for
   "Python engine ready."
2. Tap **⬇ Install app** to add it to your home screen (works offline after the 2nd visit).
3. In your PS2 emulator (AetherSX2 / NetherSX2 / PCSX2), export/copy out the memory-card
   file (or one of the individual `.cbs`/`.psu`/`.sps` saves people trade).
4. Open it here → edit → **Apply & download** → the edited copy lands in Downloads.
5. Copy the edited file **back** into the emulator's memory-card location.

## Run / deploy

This folder fetches `../Editor/*.py` and the reference JSON at runtime, so it must be
served from the **repo root** (not with `web/` as the site root).

**Local:**
```bash
python3 -m http.server 8791     # run from the repo root
# open http://localhost:8791/web/
```

**GitHub Pages:** Settings → Pages → Deploy from a branch → `main` / `/ (root)`. The repo
root has a `.nojekyll` file so `.py` files are served verbatim. Every push to `main`
rebuilds the site.

Pyodide is pinned to `v0.26.2` in both `index.html` and `sw.js`; bump both together.
