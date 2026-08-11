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
