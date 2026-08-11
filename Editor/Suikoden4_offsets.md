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
| +0x0C | u32 | **CRC32** of body `0x20..end` | **CRACKED** — `zlib.crc32(gamedata[0x20:])` matches the first dword on all 5 saves. |
| +0x10 | 16 bytes | **custom hash tail** | changes with content but is NOT plain MD5/SHA1[:16]/RIPEMD of any swept range or framing (CRC-salt, length-salt, field-zeroed). Almost certainly a bespoke EE routine — needs MIPS disassembly of `SLUS_209.79` to reproduce. **This is the remaining write gate.** |
| +0x28 | char[16?] | Hero name ("Sparda") | ASCII, null-padded |
| +0x38 | char[] | 2nd name ("Sta"…) | |
| +0x4A | char[] | Ship name ("Basel") | |
| +0x5C | u32 | 0x1D (29) | matches on-screen level LVL29 in the save title |

The save title (icon.sys, Shift-JIS full-width) parses as
`Suikoden4 [NN] LVLnn / H:MM` — chapter, level, playtime.

**Checksum status: PARTIALLY CRACKED.** The `0x0C` dword is a standard CRC32 of the body
(`gamedata[0x20:]`) — solved and reproducible. The `0x10..0x1F` 16-byte tail is a custom
hash that resists every standard algorithm/framing tried; reproducing it needs MIPS
disassembly of the boot ELF's save routine. Until that tail is solved, writing a modified
save risks a load failure, so the save side ships **read-only**. Never write the save blind.

Playtime appears mirrored as several incrementing u32 copies (+0x108, +0x2E8, +0x5B8,
+0x720 all step by 112 between the 4:42 and 4:49 saves). Potch offset in the save is
still **UNCONFIRMED** (RAM potch is +0x535EF8, but the save is a compacted structure).
