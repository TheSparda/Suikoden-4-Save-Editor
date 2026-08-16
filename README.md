# Suikoden IV Save Editor

A cross-platform **save editor** for **Suikoden IV** (PlayStation 2) — edit character stats,
HP, runes, equipment and names directly in your PS2 saves, then have the file re-checksummed
and re-ECC'd so the game loads it normally. It runs as a small local web app (stdlib-only
Python, no install, nothing uploaded) in the same spirit as the
[Suikoden III Editor](https://github.com/TheSparda/Suikoden-3-Editor): **never write
unverified data.**

Works with both **NTSC-U** (SLUS-209.79) and **PAL** (SLES-529.13) — the save layout and
checksum are identical across regions, and each save is labelled with its region.

---

## Highlights

- **Opens what you actually have.** Whole memory-card images *and* individual exported saves:
  | Format | Extension | Read | Write |
  |---|---|:--:|:--:|
  | PS2 memory card (PS2MFS) | `.ps2` `.mcd` `.mc2` `.bin` | ✅ | ✅ |
  | CodeBreaker | `.cbs` | ✅ | ✅ |
  | EMS / uLaunchELF | `.psu` | ✅ | ✅ |
  | SharkPort / X-Port | `.sps` | ✅ | ✅ |
  | PS3 export (signed) | `.psv` | ✅ | read-only\* |
  | MAX Drive | `.max` | — | — (lzari) |

  \* `.psv` is a PS3 export signed with an HMAC-SHA1 signature; it's viewable/editable in
  the UI but not written back, since re-signing needs Sony's key. To edit a `.psv`, convert
  it to a memory card or `.psu`/`.cbs` first. (`.max` uses lzari compression and isn't read
  yet.)

- **Full per-character editing** for every recruited unit:
  - **Max HP** and all eight stats — STR, SKL, MAG, EVA, PDF, MDF, SPD, LUK
  - **Three rune slots** (full rune list)
  - **Seven equipment slots** — head, body, hands, feet, and three accessories
  - Plus the **hero name** and **ship name**

- **Safe writes.** On save the app recomputes the gamedata checksum (CRC32 + byte-reversed
  MD5), refreshes each memory-card page's Hamming ECC, and for single-file containers
  re-packs and then **re-decodes to verify** the payload survived exactly. A `.bak` is made
  before the first write.

- **Quality-of-life UI.** Auto-scan for nearby saves, native file picker, **NTSC-U / PAL**
  badges, a live **checksum-ok** indicator, **collapsible** save cards when a card holds
  several slots, a sticky **Write** bar, per-save name/# filtering, and clear **"not
  recruited"** markers on placeholder units (a unit the game hasn't given real stats yet).

- **Reference tab** — browsable database: 113 characters, 519 items, 42 runes, and the full
  character-record layout.

- **ISO Tools tab** — read-only disc inspection (identity/serial, ISO9660 file map, hex
  explorer + byte search). New-game/ISO editing is deferred (see below).

Nothing leaves your machine — the server runs locally and only touches the file you point
it at.

---

## Run

Requires **Python 3.8+** and a modern browser (macOS / Windows / Linux).

- **macOS:** double-click `Start Editor (Mac).command`
- **Windows:** double-click `Start Editor (Windows).bat`
- **Terminal:** `python3 Editor/s4editor.py`

Then open the printed `http://127.0.0.1:8749`.

## How to use

1. **Save Editor** tab → **Choose file…** or pick one from the auto-scanned list
   (memory cards and individual save files are listed separately).
2. Expand a save (multi-slot cards start collapsed), edit any recruited character's stats,
   runes, equipment, or the hero/ship names.
3. Click **Write**. A backup is made, the checksum + ECC are rebuilt, and the save reloads
   to confirm.

> Editing an unrecruited placeholder unit won't recruit it — recruitment is tracked by a
> separate in-game flag, not by the character's stat record. Such units are marked
> **"not recruited."**

---

## How it works (verified internals)

**Save checksum — solved.** The gamedata payload (57,952 bytes) is gated by a 20-byte digest
at `0x0C`, reverse-engineered from the game's MIPS code. Over `body = gamedata[0x20 :
0x20+0xE240]`:
- `+0x0C` = `CRC32(body)` (little-endian)
- `+0x10` = `MD5(body)` stored **byte-reversed**

Verified against every sample save; write-back reproduces both exactly.

**Character record.** 240-byte (`0xF0`) records starting at gamedata `0x1E4`, one per roster
index. Runes at `+0x00/+0x02/+0x04`; a stat sub-block at `+0x74` (EXP, Max HP, the eight
stats); equipment at `+0xBC…+0xC8`. Anchored with known facts (Hero = Rune of Punishment,
Ted = Soul Eater) across independent playthroughs.

**Single-file containers.** The 57,952-byte payload is located by *self-validation* — the
one window whose internal CRC/MD5 checks out — which is format-agnostic for uncompressed
containers; CodeBreaker files are RC4+zlib-decoded first.

Full notes: `Editor/Suikoden4_offsets.md`.

## What's deferred (and why)

- **A "recruited" toggle.** Recruitment isn't stored in the character record, and the save's
  recruit flag couldn't be isolated cleanly from sample saves without a controlled
  single-recruit diff. Rather than write a guessed flag, it's left out.
- **New-game / ISO stat editing.** The record *shape* is known, but the initial-stats table
  that seeds a new game is packed inside `FILEDATA.*` and hasn't been located. The hex
  explorer exists to help find it.
- **Spell / unite parameter tables** — packed game data, not yet located.
- **`.sps` / `.psv` write and `.max` support** — container integrity/compression not
  reconstructed yet.

---

## Layout
```
Editor/
  s4editor.py            web server + embedded UI
  s4save.py              PS2 memory-card reader + writer (PS2MFS + ECC)
  s4files.py             individual save-file containers (.cbs/.psu/.sps/.psv)
  s4patch.py             ISO identity, file map, hex/byte-search tools
  s4_char_offsets.json   113 characters (record offset -> name)
  s4_item_names.json     519 item ids -> names
  s4_rune_names.json     42 rune ids -> names
  s4_affinities.json     per-character rune affinities
  Suikoden4_offsets.md   reverse-engineering documentation
Base ISO/                your Suikoden IV disc image (USA or PAL) — not included
```

## Credits
Data model derived from the community PCSX2 Cheat Engine table for Suikoden IV.
PS2 memory-card ECC routine and the CodeBreaker RC4 constant from `mymc`
(Ross Ridge, public domain). Save files, disc images, and third-party guides are **not**
included in this repository.
