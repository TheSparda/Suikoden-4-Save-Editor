# Suikoden IV ISO & Save Editor

A cross-platform local web app for inspecting and (eventually) editing **Suikoden IV**
(PS2, USA — SLUS-209.79). Built in the same style as the
[Suikoden III Editor](https://github.com/TheSparda/Suikoden-3-Editor): stdlib-only Python,
a local browser UI, and a strict "never write unverified data" discipline.

Nothing is uploaded — the server runs on your machine and only touches the ISO or
memory-card file you point it at.

## Requirements
Python 3.8+ and a modern browser. macOS / Windows / Linux.

## Run
- **macOS:** double-click `Start Editor (Mac).command`
- **Windows:** double-click `Start Editor (Windows).bat`
- **Terminal:** `python3 Editor/s4editor.py "Base ISO/Suikoden IV (USA).iso"`

Then open the printed `http://127.0.0.1:8749`.

## What works today (v1)
- **ISO tab** — verifies the disc (serial SLUS-209.79), shows the ISO9660 file map
  (`SLUS_209.79`, `FILEDATA.BIN/BI1/BI2`, `STR.BIN`, …), and a hex explorer + byte
  search for locating tables.
- **Saves tab** — opens a PS2 memory card (`.ps2/.mcd/.mc2/.bin`), finds Suikoden IV
  saves (`BASLUS-20979…`), and displays each save's header, hero/ship names, and the
  parsed save title (chapter / level / playtime). **Read-only.**
- **Reference tab** — browsable database extracted from the community Cheat Engine
  table: 113 characters, 519 items, 42 runes, and the full character record layout.

## What's deferred (and why)
This project follows the S3 editor's rule: expose only what's verified.
- **Save writing is off.** The gamedata payload carries a 20-byte digest at offset
  `0x0C` that gates save loading (same class of problem as S3's checksum). It isn't a
  plain SHA1/MD5 of any obvious range — it's salted/custom. Until it's cracked, a
  modified save could fail to load, so writing stays disabled.
- **New-game ISO stat editing is off.** The in-RAM record *shape* is fully known
  (stride `0x78`; STR/SKL/MAG/… at `+0x20…`), but the initial-stats copy that seeds a
  new game lives packed inside `FILEDATA.*` and hasn't been located yet. The hex
  explorer exists to help find it.

See `Editor/Suikoden4_offsets.md` for the full reverse-engineering notes.

## Layout
```
Editor/
  s4editor.py            web server + embedded UI
  s4patch.py             ISO identity, file map, hex/byte-search tools
  s4save.py              PS2 memory-card reader (PS2MFS + ECC), read-only
  s4_char_offsets.json   113 characters (record offset -> name)
  s4_item_names.json     519 item ids -> names
  s4_rune_names.json     42 rune ids -> names
  Suikoden4_offsets.md   reverse-engineering documentation
Base ISO/                your Suikoden IV (USA).iso
Cheats/                  the source Cheat Engine table
```

## Credits
Data model derived from the community PCSX2 Cheat Engine table for Suikoden IV NTSC.
PS2 memory-card ECC routine from `mymc` (Ross Ridge, public domain).
