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
  | MAX Drive | `.max` | ✅ | read-only\* |

  \* `.psv` is a PS3 export signed with an HMAC-SHA1 signature; it's viewable/editable in
  the UI but not written back, since re-signing needs Sony's key. To edit a `.psv`, convert
  it to a memory card or `.psu`/`.cbs` first. `.max` is readable (LZARI decoder ported from
  mymc) but not re-encoded, so it's read-only too.

- **Full per-character editing** for every unit:
  - **Recruitment status** — a real per-character flag (Not Recruited / In Your Company /
    Recruited / In Party / Permanently In Party), the same byte the game itself checks
  - **EXP** (level derives from it) and **weapon level** (1–15)
  - **Max HP** and all eight stats — STR, SKL, MAG, EVA, PDF, MDF, SPD, LUK
  - **Three rune slots** (full rune list) and **unite-attack levels** (0–3)
  - **Seven equipment slots** — head, body, hands, feet, and three accessories
  - Plus the **hero name**, **ship name**, **potch (money)**, and a one-click
    **"world map fully explored"** toggle

- **Safe writes.** On save the app recomputes the gamedata checksum (CRC32 + byte-reversed
  MD5), refreshes each memory-card page's Hamming ECC, and for single-file containers
  re-packs and then **re-decodes to verify** the payload survived exactly. A `.bak` is made
  before the first write.

- **Quality-of-life UI.** Auto-scan for nearby saves, native file picker, **NTSC-U / PAL**
  badges, a live **checksum-ok** indicator, **collapsible** save cards when a card holds
  several slots, a sticky **Write** bar, per-save name/# filtering, and a per-character
  **recruitment dropdown** (unrecruited units render dimmed).

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

> To recruit a unit, set its **Recruitment** dropdown (e.g. to "Recruited") and Write —
> this flips the same flag the game checks. Note that story-gated content tied to specific
> plot beats remains governed by separate event state.

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

**Recruitment flag — solved.** MIPS disassembly showed the save gamedata is a verbatim
image of the game's state block at EE `0x532860`, which let the community cheat table's
live "Recruited" byte be mapped straight into the save: one byte per character at
`0x164 + rosterIndex*0x78` (0 Not Recruited / 1 In Your Company / 10 Recruited /
11 In Party / 15 Permanently In Party). Verified across NTSC-U and PAL saves.

**Single-file containers.** The 57,952-byte payload is located by *self-validation* — the
one window whose internal CRC/MD5 checks out — which is format-agnostic for uncompressed
containers; CodeBreaker files are RC4+zlib-decoded first.

Full notes: `Editor/Suikoden4_offsets.md`.

## What's deferred (and why)

- **New-game / ISO stat editing.** The record *shape* is known, but the initial-stats table
  that seeds a new game is packed inside `FILEDATA.*` and hasn't been located. The hex
  explorer exists to help find it.
- **Spell / unite parameter tables** — packed game data, not yet located.
- **`.psv` / `.max` write** — the PS3 signature needs Sony's key, and MAX Drive's LZARI
  re-encoder isn't ported (reading works).

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
