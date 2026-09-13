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
> ⚠ **PARTLY SUPERSEDED 2026-09-12** — see *"FILEDATA re-examined"* at the end of this file.
> The container header and entry-row shape below are **confirmed correct**. Two claims are
> **wrong** and are kept here on purpose so the wrong premise stays on record:
> (1) *"BI2 (60MB) has 55 real entries"* — that is the **first archive's** table; BI2 holds 260
> back-to-back archives. (2) *"flags: 0 = stored, 2 = compressed"* — flags=2 payloads measure as
> uncompressed.

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

## Spell / unite tables — NOT yet located
S3 kept spell/unite parameter tables in the ELF 2nd PT_LOAD, findable by an ascending
damage curve. S4's ELF 2nd PT_LOAD (file 0x278480, vaddr 0x4F7480) was scanned the same
way; the ascending-field heuristic is too noisy here (hit only lookup ramps like a
37,39,41,… scaling table at vaddr 0x589FB0, not spells). Needs a name-string or
damage-value anchor from a guide to pin the table. Deferred.

---

## 2026-09-12 — FILEDATA re-examined: 1,326 archives, tiling proven, no codec found

Supersedes parts of *"FILEDATA archive format (BI1 / BI2) — CRACKED"* above. Measured against
the pristine NTSC-U disc. Every figure is a full-population count with zero exceptions unless
labelled a sample. Tracked as #31 → #44 / #45 / #46 / #47.

### 1. Each file is a *run* of archives, not one archive

The earlier note read the first archive's entry table and took it for the whole file. It isn't.

| File | LBA | Size | Archives | Entries |
|---|---|---|---|---|
| `FILEDATA.BI2` | 2,035,260 | 60,162,048 | **260** | 4,537 |
| `FILEDATA.BI1` | 1,510,597 | 1,074,509,824 | **1,066** | 57,771 |

Every archive carries its own `0x82734927` header. The "55 real entries" figure was archive 0
of BI2 only; 259 further archives were never looked at.

### 2. S3's FSECT.BIN tiling test passes on the outer level, first try

`(total + 2047) // 2048 * 2048 == next_header_offset`:

- **BI2 — 258/258** consecutive pairs tile exactly. Last archive ends at 60,160,000 of
  60,162,048 (one sector of tail padding).
- **BI1 — 1065/1065** tile exactly. Last archive ends at **1,074,509,824 — the file's exact
  final byte, delta 0.**

Sector-aligned, zero gaps, zero overlaps. Consequence: the index needs no magic scan — walk the
chain from offset 0 reading each `total` and jumping. 1,326 small reads, not a 1 GB stream.

### 3. Entry rows — confirmed shape, corrected reading

```
archive +0x00 u32 magic 0x82734927 | +0x04 u32 0 | +0x08 u32 total | +0x0C u32 0
        +0x10 16-byte rows (id u32, flags u32, offset u32, size u32)
              row[0] is a SENTINEL: its `id` field is the entry count, flags=32, off=0, size=0
              offsets are archive-relative and 16-byte aligned (62,308 / 62,308 — 100%)
```

flags histogram — note the **third value, undocumented until now**:

| File | flags=0 | flags=2 | flags=3 |
|---|---|---|---|
| BI2 | 3,840 | 697 | — |
| BI1 | 37,095 | 20,456 | **220** (76–100 bytes each, BI1 only) |

### 4. The +16 rule (flags=2 only) — exact

For every flags=2 entry with a successor, sorted by offset:

```
size - (next.offset - this.offset) == 16          20,830 / 20,830
```

690/690 in BI2, 20,140/20,140 in BI1. Not a tendency. flags=0 overlaps its successor only
10–20% of the time with scattered deltas (-80, -48, +16, -32, -60 …); flags=3, 4.5%. Whatever
the +16 means, it is **specific to flags=2**. Structural explanation still unknown — #45.

### 5. flags=2 is almost certainly NOT compression

The earlier note reads flags=2 as compressed and sizes the whole problem around finding the
codec. Six flags=2 payloads were pulled from BI2 (the first such entry in each of the first six
archives), using the exact byte range the +16 rule gives:

| archive | id | declared size | on-disc bytes | ratio | entropy | distinct bytes |
|---|---|---|---|---|---|---|
| `0x0` | `0x75fb` | 2,176 | 2,160 | 1.01× | 6.29 | 230 |
| `0x178000` | `0x0e54` | 17,536 | 17,520 | 1.00× | 6.05 | 256 |
| `0x194800` | `0x7711` | 2,176 | 2,160 | 1.01× | 4.89 | 208 |
| `0x25e000` | `0x4d61` | 5,248 | 5,232 | 1.00× | 6.72 | 237 |
| `0x325000` | `0x4d61` | 5,248 | 5,232 | 1.00× | 6.72 | 237 |
| `0x35f000` | `0x6f9f` | 9,344 | 9,328 | 1.00× | 6.12 | 156 |

Three independent reasons these are not compressed:

1. **Ratio 1.00–1.01×.** Nothing is compressed; the 16-byte delta is the +16 rule, not a saving.
2. **The bytes are legible.** All six are full of `00 00 80 3f` — IEEE-754 LE `1.0`. Also
   `00 00 70 c1` (`-15.0`), `00 00 88 41` (`17.0`). Plain float data: transforms, vertices.
3. **Entropy 4.9–6.7 bits/byte**, as few as 156 distinct values. Compressed output sits at ~7.99
   with all 256 present.

`zlib` and raw-deflate tried on all six: both fail immediately.

**Search parameters, so this is not repeated:** candidates tried were zlib and raw-deflate only,
on 6 of 21,153 flags=2 payloads, BI2 only, each read as `[entry.offset, next.offset)`. LZSS,
LZARI (`s4lzari.py`), LZ77/4KB and LZMA were **not** tried, and BI1 was not sampled. The full
sweep is #46 — six samples do not settle a 21,153-member population, they only move the prior.

Note also that the "find the field tracking decompressed size" step is moot either way: if
flags=2 *were* compressed, the decompressed size is already the entry's `size` and the
compressed length is `next.offset - this.offset`.

### 6. Known gaps

- 15 of BI1's 1,066 archives have an entry-count sentinel outside the plausible range and were
  skipped. They tile correctly at the outer level, so they are real archives — either the count
  field is being misread or they use a variant layout. #45.
- No content mapping attempted yet. The fingerprints available are 519 item ids, 42 rune ids,
  113 roster indices, 29 unite combos and the numbers in `Cheats/S4 Rune List.pdf`. #47.
- PAL (`SLES-529.13`) not checked. The save layout matched across regions; this has not been
  assumed for the disc.

### 7. What this changes

The earlier STATUS line names two unknowns — the codec and the content map — and defers the
whole thing as "big effort". Re-reading it: the outer directory is solved (#44), the codec is
probably a misreading rather than a hard problem (#46), the entry semantics are a bounded format
question (#45), and only the content map (#47) is genuinely open.

---

## 2026-09-12 — the pnach maps into the save block, and it says CHAR_BASE/CHAR_STRIDE is wrong

`Cheats/Suikoden IV (NTSC-U).pnach` (588 KB, 5,496 `patch=` lines) had never been examined. It
is a large, **named** evidence source: 5,171 of its sections touch the save block, 5,314 patch
lines land inside `0x532860 .. +0xE260`, and the section names give every field a label for all
113 characters (`[Adrienne Codes\Max HP]`, `[Hero Codes\Head Rune Modifier]`, …).

The mapping is the one already proven here: `save_offset = ram_addr - 0x532860`. Confirmation is
immediate — the very first patch line, `[0:00:00 Game Time] patch=1,EE,20532880,…`, is
`0x532880 - 0x532860 = 0x20`, the known game-time offset. (The leading nibble is the PS2 code
type, not part of the address.)

### What it says the layout is

Sorting each character's `Max HP` code by address gives **113 records at stride 0x78**, first at
save `+0x126`. Taking the equipment block at `+0xC0` as the record base, the named fields land:

| Offset | Field (pnach's own name) |
|---|---|
| +0x00 … +0x0C | Head, Body, Hands, Feet, Other 1–3 (u16 each) |
| +0x10 / +0x11 / +0x12 | Head / Right / Left rune (u8 each) |
| +0x48 | Max EXP (u32) |
| +0x4C | Max Weapon LVL |
| +0x4E / +0x50 | Max ATK / Max DEF |
| +0x52 | Infinite HP (current HP) |
| +0x66 | Max HP |
| +0x68 … +0x76 | STR SKL MAG EVA PDF MDF SPD LUC |
| +0x8B … +0x98 | element equipped, rune pieces ×5, rune LVs |

Those are **the same two base pointers this document already records under the RAM layout**
(`FirstPartyItem` = `0x532920` → save `+0xC0`; `FirstPartyExp` = `0x532968` → save `+0x108`).
Since the save body is a verbatim image of that RAM block, the RAM layout *is* the save layout —
which this document had explicitly warned against assuming.

### The part that is a live bug

`s4save.py` uses `CHAR_BASE = 0x1E4`, `CHAR_STRIDE = 0xF0`, `OFF_MAXHP = 0x92`, `OFF_STATS = 0x94`.
Note it *already* uses `PROG_BASE = 0x108`, `PROG_STRIDE = 0x78` for EXP and weapon level, and the
pnach agrees with those exactly (`+0x00` EXP, `+0x04` weapon Lv). The disagreement is only about
Max HP and the eight stats.

Checked against two real CodeBreaker saves (11251, 11240):

- **Every** engine Max HP read aliases into another character's progression record.
  `0x1E4 + i*0xF0 + 0x92` is `0x108 + j*0x78 + 0x06` for **55/55** in-range `i` — offset `0x06` is
  the ATK field. The values are byte-identical by construction, in both saves.
- **`SKL == MAG` on 111 of 112 populated records** under the engine's reading — the signature of
  a window straddling a record boundary, not a real stat block. Under `PROG + 0x20` it is 4/61.
- `PROG + 0x0A` equals `PROG + 0x0C` on **61/61** records, consistent with current HP == Max HP
  for a save written outside battle. (This also corrects the note elsewhere in this file that
  current HP "reads 0 when saved out of battle" — it reads full.)
- Hero's `PROG` record decodes coherently end to end: EXP 98999, weapon Lv 15, ATK 437, DEF 288,
  curHP 608, maxHP 608, a stat block, maxHP again, a second stat block (base vs equipment-modified).

Consequence: **editing Max HP or any stat writes into a different character's record.** That is
data corruption, not a display error.

### What is NOT established

The rune and equipment offsets are a separate question and the evidence does **not** condemn them.
The existing anchors hold and the pnach-derived reading does not:

- Engine, both saves: Hero slot 1 = Rune Of Punishment, Ted slot 1 = Soul Eater — stable and correct.
- Pnach reading, same saves: Hero = [Sunbeam, Lightning, Rune Of Punishment]; Ted = [Fire, Soul
  Eater, Water] in one save and [Nothing, Nothing, Water] in the other. Ted without Soul Eater is
  wrong, so that reading is not simply correct either.
- The id-membership test does not discriminate equipment: engine 201/201 and pnach 192/192 valid
  item ids. It *does* discriminate runes — engine 45/98 (45.9%), pnach 114/114 — but the anchor
  test outranks it, so this is recorded as unresolved rather than decided.

**Search parameters, so this is not repeated:** two CodeBreaker saves from one playthrough
(11251, 11240) and the NTSC-U pnach only. No PAL save, no controlled pair, no in-game check. The
third sample (`suikoden-iv.6026.cbs`) failed to yield a payload and was skipped rather than
worked around.

### What would finish it

A single in-game check settles the whole thing in minutes: note one character's Max HP and STR on
screen, save, and read both candidate offsets. Deliberately **not** guessed at here — rewriting
the character-record decoder is the most dangerous change available in this repo, and a partial
fix that corrects Max HP while leaving runes on a frame that may also be wrong could make things
worse than the present state. Tracked as a bug issue with this evidence attached.
