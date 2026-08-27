# Suikoden IV (USA, SLUS-209.79) — reverse-engineering notes

Ground-truth sources used:
- `Cheats/Suikoden IV NTSC PCSX2 1_7_5_332.CT` — Cheat Engine table (in-**RAM** layout).
- 5 real PS2 saves (`BASLUS-20979s400/401/402`) pulled from two local memcards.
- The USA ISO (`Suikoden IV (USA).iso`), serial **SLUS-209.79**, VER 1.00, NTSC.

Two independent layouts live here — keep them straight:
- **RAM layout** (from the CT): valid only while the game is running; base pointer is
  found by an AOB scan. Useful as a *map* of the record shape, NOT as file offsets.
- **Save layout** (the memcard `gamedata` payload): what the save editor reads/writes.
- **ISO layout**: flat byte offsets into the disc image, for new-game editing.

---

## ISO9660 layout (2048-byte sectors)

| File            | LBA (sector) | Size (bytes)  | Notes |
|-----------------|--------------|---------------|-------|
| `SYSTEM.CNF`    | 366          | 54            | `BOOT2 = cdrom0:\SLUS_209.79;1` |
| `SLUS_209.79`   | 367          | 3,214,528     | boot ELF (`\x7fELF`) |
| `STR.BIN`       | 389,722      | 1,186,701,312 | streamed movie/audio |
| `TRG.BIN`       | 969,166      | 30,523,392    | |
| `FILEDATA.BIN`  | 984,070      | 1,078,327,296 | main packed game data |
| `FILEDATA.BI1`  | 1,510,597    | 1,074,509,824 | |
| `FILEDATA.BI2`  | 2,035,260    | 60,162,048    | |
| `MARGIN.DAT`    | 2,064,636    | 134,217,728   | padding |

Raw byte offset of a file = `LBA * 2048`. Character/item strings are NOT in the ELF as
plain ASCII (searched: not found), so game text lives packed inside `FILEDATA.*` — the
initial-stats table location is still **UNCONFIRMED** (research task #3).

---

## RAM character record (from the CT) — the record SHAPE

The trainer walks an array of `CharacterInfoNumPartyMembers = 0x71 (113)` records with
**stride `0x78` (120 bytes)**. The "Character" dropdown values ARE `charIndex * 0x78`
byte offsets (all 113 verified divisible by 0x78). Two parallel base pointers:

- `FirstPartyExp`  base = `OurBasePtr + 0x532968` — the stat/exp record
- `FirstPartyItem` base = `OurBasePtr + 0x532920` — equipment record (0x48 earlier)
- `PotchOffset`         = `OurBasePtr + 0x535EF8` — money (u32)
- `CurrentHP` (battle)  = `OurBasePtr + 0x1B8D60`
- World-map flags       = `OurBasePtr + 0x53D1B0` (0x175 u32 flags)

### Stat record (relative to `iPartySlot` = charIndex*0x78, on `FirstPartyExp` base)
| Off | Type | Field |
|-----|------|-------|
| +0x00 | u16 | Experience (toward next) |
| +0x0A | u16 | Current HP |
| +0x1E | u16 | Max HP |
| +0x20 | u16 | STR |
| +0x22 | u16 | SKL |
| +0x24 | u16 | MAG |
| +0x26 | u16 | EVA |
| +0x28 | u16 | PDF |
| +0x2A | u16 | MDF |
| +0x2C | u16 | SPD |
| +0x2E | u16 | LUK |
| +0x49 | u8  | current rune uses (set = +0x4D to refill) |
| +0x4D | u8  | max rune uses |

### Equipment record (relative to `iPartySlot`, on `FirstPartyItem` base)
| Off | Type | Field |
|-----|------|-------|
| +0x00 | u16 | Equipped Head |
| +0x02 | u16 | Equipped Body |
| +0x04 | u16 | Equipped Hands |
| +0x06 | u16 | Equipped Feet |
| +0x08 | u16 | Equipped Other 1 |
| +0x0A | u16 | Equipped Other 2 |
| +0x0C | u16 | Equipped Other 3 |
| +0x10 | u8  | Head Rune |
| +0x11 | u8  | Right-Hand Rune |
| +0x12 | u8  | Left-Hand Rune |

ID tables extracted to JSON: `s4_char_offsets.json` (113), `s4_item_names.json` (519),
`s4_rune_names.json` (42).

---

## Save file (`gamedata` payload) — 57,952 bytes

Header (confirmed by hexdump + cross-save diff of 3 saves in the same playthrough):

| Off | Type | Field | Evidence |
|-----|------|-------|----------|
| +0x00 | u32 | version = 6 | constant across all saves |
| +0x04 | u32 | = 1 | constant |
| +0x08 | u16 | slot number | 0/1/2 match folder s400/401/402 |
| +0x0C | u32 | **CRC32** of `gamedata[0x20:0x20+0xE240]` (little-endian) | **CRACKED** — verified on all saves. |
| +0x10 | 16 bytes | **MD5** of `gamedata[0x20:0x20+0xE240]`, **byte-reversed** | **CRACKED** — the game stores the 16-byte MD5 digest in reverse byte order. Verified on all saves. |

## Character records (corrected)
**Record size = 0xF0 (240 bytes)**, array starts at gamedata `0x1E4`, one record per roster
index (`index = cheat_table_offset / 0x78`). An earlier reading used stride `0x78`, which is
wrong: `0x78` is half a record, so it only aligned for index 0 (the Hero) and mislabeled
everyone else. Proven with known anchors across two independent playthroughs — Hero (idx 0)
holds the Rune of Punishment; Ted (idx 3) always holds the Soul Eater — both decode exactly,
and every roster name lines up.

Within each record (offsets relative to record base at `0x1E4 + index*0xF0`):
| Offset | Type | Field |
|---|---|---|
| +0x00 | u16 (low byte = id) | Rune slot 1 |
| +0x02 | u16 (low byte = id) | Rune slot 2 |
| +0x04 | u16 (low byte = id) | Rune slot 3 |
| +0x74 | u16 | EXP toward next (stat sub-block starts here; lands at 0x258 for idx 0) |
| +0x74+0x0A | u16 | Current HP (reads 0 when saved out of battle) |
| +0x74+0x1E | u16 | Max HP |
| +0x74+0x20 | u16[8] | STR SKL MAG EVA PDF MDF SPD LUK |

Equipment block (7 u16 slots, offsets relative to record base):
| Offset | Slot |
|---|---|
| +0xBC | Head |
| +0xBE | Body |
| +0xC0 | Hands |
| +0xC2 | Feet |
| +0xC4 | Accessory 1 |
| +0xC6 | Accessory 2 |
| +0xC8 | Accessory 3 |

Located and slot-ordered **by category purity**, no controlled save needed: diffing units
recruited in one playthrough but not the other showed this region is all-zero for unrecruited
units and fills with wearables once recruited. Tallying item categories per slot across all
recruited characters in two playthroughs, +0xBE holds only armor/robes and +0xC2 only
boots/shoes (100% pure); head/hands/accessory slots hold only their category once garbage
(unrecruited) records are excluded. +0xCA is always empty, so the block is exactly 7 slots.
Runes + stats + HP + equipment are all verified and write-enabled.

### Checksum, fully solved (write-enabled)
Found by disassembling `SLUS_209.79` (MIPS64, PS2). The save serializer at vaddr
`0x471C34` calls, over `base = gamedata+0x20`, `len = 0xE240` (57920 bytes):
1. `0x4E1848` → CRC32 (standard reflected table at vaddr `0x583AB4`) → stored LE at `+0x0C`.
2. `0x4E1890` → MD5 (init constants `67452301/EFCDAB89/98BADCFE/10325476` at `0x4E2CF0`) →
   the 16-byte digest is written **reversed** to `+0x10`.

```python
import hashlib, zlib, struct
body = gamedata[0x20:0x20+0xE240]
struct.pack_into("<I", gd, 0x0C, zlib.crc32(body) & 0xFFFFFFFF)
gd[0x10:0x20] = hashlib.md5(body).digest()[::-1]
```
| +0x28 | char[16?] | Hero name ("Sparda") | ASCII, null-padded |
| +0x38 | char[] | 2nd name ("Sta"…) | |
| +0x4A | char[] | Ship name ("Basel") | |
| +0x5C | u32 | 0x1D (29) | matches on-screen level LVL29 in the save title |

The save title (icon.sys, Shift-JIS full-width) parses as
`Suikoden4 [NN] LVLnn / H:MM` — chapter, level, playtime.

**Checksum status: FULLY CRACKED (write-enabled).** Both fields are reproducible (CRC32 +
reversed MD5 over `0x20..0x20+0xE240`), verified against all sample saves. Save write-back
recomputes them before committing, then refreshes each memcard page's Hamming ECC.

Playtime appears mirrored as several incrementing u32 copies (+0x108, +0x2E8, +0x5B8,
+0x720 all step by 112 between the 4:42 and 4:49 saves). Potch offset in the save is
still **UNCONFIRMED** (RAM potch is +0x535EF8, but the save is a compacted structure).

## FILEDATA archive format (BI1 / BI2) — CRACKED
`FILEDATA.BI1` and `FILEDATA.BI2` are packed archives (NOT flat data). Header + file table:
- `+0x00` u32 magic `0x82734927`
- `+0x04` u32 = 0
- `+0x08` u32 total archive size
- `+0x0C` u32 = 0
- `+0x10` onward: 16-byte entries `(id u32, flags u32, offset u32, size u32)`.
  - `id` is a content hash/key (e.g. 0xE94F, 0x50EC); families share high bits.
  - `flags`: 0 = stored, 2 = compressed (observed on the larger paired entries).
  - `offset` is relative to the archive (file) start; entries are offset-ordered.
  - Header row's first field doubles as the entry count (BI2: 0x38 = 56 slots).
BI2 (60MB) has 55 real entries; many appear as a 256-byte header entry (flags 0)
immediately followed by a flags=2 data entry — a header+compressed-payload pairing.
`FILEDATA.BIN` is unrelated (starts with a copy of SYSTEM.CNF text).

STATUS: container format decoded; the per-entry compression (flags=2) and which entry
holds character/item/spell tables are not yet mapped. Editing needs: identify the target
entry, decompress it, edit, recompress, fix offsets/sizes. Deferred — big effort, and the
save editor already covers character/rune/equipment editing for existing playthroughs.

## Recruitment flags — CRACKED (write-enabled)
**Recruited[i] = gamedata `0x164 + rosterIndex*0x78` (one byte per character).**
Values (decimal): `0` Not Recruited · `1` In Your Company (guest) · `10` Recruited ·
`11` In Party · `15` Permanently In Party (hero).

How it fell: a newer community Cheat Engine table ("Suikoden IV (USA).ct") exposes a live
per-character "Recruited" byte in RAM. MIPS disassembly of `SLUS_209.79` then showed the
function pair at `0x468710/0x468720` returning a **static pointer `0x532860` and size
`0xE260`** — i.e. the save gamedata is a **verbatim image of the game's state block at EE
`0x532860`**, so every RAM address maps linearly to a save offset (`save = ram - 0x532860`;
the CT's Recruited `0x5329C4` → save `0x164`). The CT dropdown values are decimal (15 =
0xF "Permanently In Party"), which the hero byte confirms in every save.

The array is indexed by our roster index but with **stride 0x78** — it threads through the
0xF0 character records' unclaimed bytes (`+0x70`/`+0xE8`), which is why per-record scans
never found it. Verified on 8 saves (NTSC-U + PAL): all values enum-pure, recruited counts
track story progression (4 → 62 → 107), and decoding `11/15` as "party" reproduces
story-accurate party lists (e.g. the canonical early party Hero/Chiepoo/Paula/Jewel).
Note: unrecruited-but-statted records (the new-game seed) plus guests (`1`) explain every
earlier heuristic mismatch — non-combat stars recruit with placeholder battle records.

The editor exposes this as a per-character dropdown; only the five known enum values are
writable. Caveat: setting `10` marks a unit recruited exactly as the game tracks it, but
story-gated availability (e.g. HQ facilities tied to plot beats) is separate state.

## (superseded) earlier investigation notes
Recruitment is **not** stored inside the 0xF0 character record (every record offset was
checked across a controlled same-playthrough pair; none flips on recruit).

A deep search of the gamedata body did not yield a verifiable recruit bit-table. Two
leads looked promising by magnitude but both proved to be **coincidences**:
- `0x97D8`/`0xA090` gain ~+50 bits between CodeBreaker saves `11240`→`11251` (a near-ideal
  controlled pair: same playthrough, level 99, playtime 98999, ~50 units recruited between
  them). But these regions are **empty in early saves** where the Hero et al. are already
  recruited, so they can't be a persistent recruit flag — they track some other ~50-entry
  event/collection that happened to grow by the same count.
- `0x9606` has ~50 bits set in every save (an "every-third-bit" `001`-per-entry pattern),
  but the region is **byte-identical across all five saves** — a static config table, not
  recruitment.

Root cause of the blocker: solving this from saves alone needs a trustworthy per-character
"is recruited" ground truth, and the only one available (equip/maxHP/rune record-filled)
is a **heuristic** — the new-game seed pre-fills maxHP, so it over/mis-counts. Against that
fuzzy truth, several unrelated regions match by count, and none matches the full
across-saves *signature* multiset. ELF disassembly didn't rescue it either: the game text
is packed (no name-string anchors), there is no static character↔star permutation table
(the one 108-value run found at vaddr `0x501D90` is a graphics byte-swizzle table), and the
save block is assembled via indirection that hides the recruit table's RAM base.

**What would finish it (verified, cheap):** a **single-recruit** controlled pair — save,
recruit exactly ONE known unit, save again to a new slot. A one-unit diff pinpoints the
single bit that flips, giving that unit's exact bit with zero ambiguity; a few such pairs
reveal the ordering for all units. A speculative toggle is intentionally NOT shipped — and
note that flipping a recruit bit alone may not make a unit usable, since HQ/party
availability and story gates are separate state.

## New Game+ / clear-data flag — NOT yet located

S4 has a New Game+: you beat the game, save the clear data, then start a new game from that
file to carry over Potch and a subset of items (craftables transfer; the Champion's Rune and
the Hero/Guardian/Pirate King equipment sets are excluded). A second-or-later playthrough
also unlocks Triangle to skip cutscenes.

Nothing in the save is currently known to hold "this playthrough has been cleared". The
mapped regions (header, names, `0x108`/`0x164`/`0x1E4` per-character arrays, potch `0x3698`,
world-map flags `0xA950`) leave most of the 57,952-byte body unclaimed, and no candidate has
been identified. All 8 research saves are mid-playthrough, which is why it hasn't fallen out
of existing data.

**What would finish it:** a controlled pair — save right before the final boss, beat the
game, save the clear data to a different slot — then diff, suppressing the mapped fields and
the playtime mirrors (`+0x108/+0x2E8/+0x5B8/+0x720`). Failing that, a RAM search over EE
`0x532860..+0xE260` with a clear file loaded (`save = ram - 0x532860`), or disassembly of the
new-game menu / cutscene-skip read sites in `SLUS_209.79`. Open question the ELF route also
answers: whether the carry-over set is a flag at all, or is computed when the clear-data save
is written — if the latter, flipping a bit on a mid-game save may be accepted but carry
nothing. Nothing speculative is shipped. Tracked in issue #1.

## Spell / unite tables — NOT yet located
S3 kept spell/unite parameter tables in the ELF 2nd PT_LOAD, findable by an ascending
damage curve. S4's ELF 2nd PT_LOAD (file 0x278480, vaddr 0x4F7480) was scanned the same
way; the ascending-field heuristic is too noisy here (hit only lookup ramps like a
37,39,41,… scaling table at vaddr 0x589FB0, not spells). Needs a name-string or
damage-value anchor from a guide to pin the table. Deferred.
