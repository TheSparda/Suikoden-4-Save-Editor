# Suikoden IV Save Editor

> **▶ [Open the editor](https://thesparda.github.io/Suikoden-4-Save-Editor/web/)** — edit
> your saves *and your disc* right in the browser, or install it on Android. Nothing to
> download, nothing uploaded.

A **save + ISO editor** for **Suikoden IV** (PlayStation 2) that runs entirely in your
browser. Edit recruitment, levels, stats, runes, equipment, unite attacks, money, and more
directly in your PS2 saves — the file is re-checksummed and re-ECC'd so the game loads it
normally — and scale the random-encounter rate on the disc.

Everything runs on your device via [Pyodide](https://pyodide.org) (CPython in WebAssembly);
your save never leaves the machine. Works on desktop and Android, and installs as an offline
PWA. One rule throughout: **never write unverified data** — every offset was
reverse-engineered and verified against real saves before its input appears in the UI.

Supports **NTSC-U** (SLUS-209.79) and **PAL** (SLES-529.13) saves — the save layout and
checksum are identical across regions, and each save shows a region badge. (ISO editing is
NTSC-U only.)

> Full UI walkthrough, install/offline details, and the Android flow are in
> [`web/README.md`](web/README.md).

---

## What you can edit

### Per character (all 113)
| Field | Range | Notes |
|---|---|---|
| **Recruitment status** | Not Recruited / In Your Company / Recruited / In Party / Permanently In Party | The exact per-character flag the game checks — the first public recruitment editor for S4 |
| **Level / EXP** | 1–99 / 0–98,999 | Level drives EXP via the game's flat `EXP = (Lv−1)×1000` curve |
| **Weapon level** | 1–15 | Skip the sharpening costs |
| **Max HP** | 0–9,999 | |
| **Stats** | STR SKL MAG EVA PDF MDF SPD LUK, 0–999 | |
| **Runes** | 3 slots, full 42-rune list | Searchable name pickers, with each character's elemental rune affinities shown inline |
| **Unite attacks** | 0–3 per combo | All **29 combos listed by name** with partner tooltips (e.g. Ted's Bow & Arrow + Barrage 1–4) |
| **Equipment** | 7 slots (head/body/hands/feet + 3 accessories), 519-item list | Searchable name pickers |

A per-character **★ Max out** preset (stats, HP, level, weapon Lv, unites) and a bulk
**Recruit** tab (set recruitment for every character in one place) speed up big edits.

### Per save
- **Hero name** and **ship name**
- **Potch** (money, up to 99,999,999)
- **Game time** (the playtime clock, in seconds with h:mm display)
- **World map** — shows % explored, one-click **"mark fully explored"**

> Recruiting via the dropdown flips the same byte the game uses, so the unit appears
> recruited exactly as if you'd met them. Story-gated events tied to specific plot beats
> remain governed by separate event state.

## Supported save formats

Open whole memory-card images *or* the individual exported saves people trade online:

| Format | Extension | Read | Write |
|---|---|:--:|:--:|
| PS2 memory card (PS2MFS) | `.ps2` `.mcd` `.mc2` `.bin` | ✅ | ✅ |
| CodeBreaker | `.cbs` | ✅ | ✅ |
| EMS / uLaunchELF | `.psu` | ✅ | ✅ |
| SharkPort / X-Port | `.sps` | ✅ | ✅ |
| MAX Drive | `.max` | ✅ | read-only\* |
| PS3 export (signed) | `.psv` | ✅ | read-only\* |

\* `.max` is decoded via an LZARI decompressor ported from mymc, but re-encoding isn't
implemented; `.psv` carries an HMAC-SHA1 signature that needs Sony's key to rebuild. To
edit either, convert it to a memory card / `.psu` / `.cbs` first.

## Safe writes

- Every edit is **staged** and shown in an explicit **old → new review** before it's written.
- The gamedata **checksum** (CRC32 + byte-reversed MD5) is recomputed on every write, so
  edited saves load normally.
- Memory-card writes refresh each page's **Hamming ECC**; single-file containers are
  re-packed and then **re-decoded to verify** the payload survived byte-for-byte.
- Your original file is never touched — edits download an edited *copy* (or write in place
  only when you pick a file via the browser's File System Access API and confirm).
- Inputs clamp to the game's own caps (EXP 98,999, weapon level 15, potch 99,999,999, …).

---

## Run

The editor is a static web app. Easiest: just **[open the live site](https://thesparda.github.io/Suikoden-4-Save-Editor/web/)**.

To run it locally, serve the **repo root** (the app fetches the Python engine + reference
JSON from `../Editor/` at runtime), then open `web/`:

```bash
python3 -m http.server 8791     # from the repo root
# open http://localhost:8791/web/
```

That's the only Python needed — it serves the files; the actual editing runs in your browser.

---

## How it works (verified internals)

**Save checksum — solved.** The 57,952-byte gamedata payload is gated by a 20-byte digest
at `0x0C`, reverse-engineered from the game's MIPS code. Over
`body = gamedata[0x20 : 0x20+0xE240]`: `+0x0C` = `CRC32(body)` and `+0x10` = `MD5(body)`
stored byte-reversed. Write-back reproduces both exactly.

**The save is a RAM snapshot.** MIPS disassembly of `SLUS_209.79` showed the gamedata is a
verbatim image of the game's state block at EE address `0x532860` — so every live-RAM
address from the community cheat table maps linearly to a save offset
(`save = ram − 0x532860`). This single fact unlocked most of the fields below.

**Character records.** 240-byte (`0xF0`) records from `0x1E4`, one per roster index:
runes at `+0x00/02/04`, stats at `+0x74…`, equipment at `+0xBC…+0xC8`. Anchored with known
facts (Hero = Rune of Punishment, Ted = Soul Eater) across independent playthroughs.

**Recruitment flag — solved.** One byte per character at `0x164 + index*0x78`
(0 / 1 / 10 / 11 / 15). Verified across 8 saves in both regions: values are enum-pure,
counts track story progression, and decoding "in party" states reproduces story-accurate
party lists.

**Progression record.** `0x108 + index*0x78`: EXP (u32, capped 98,999), weapon level
(u8), and the five named unite-attack level slots (`+0x65…+0x6D`), with the slot→combo
mapping taken from the cheat table's addresses and named from ninjaskipper's GameFAQs
Combo Attacks guide.

**Single-file containers.** The payload is located by *self-validation* — the one window
whose internal CRC/MD5 checks out. CodeBreaker files are RC4+zlib decoded; SharkPort's
trailing checksum was reverse-engineered and verified; MAX Drive is LZARI-decompressed.

Full notes: [`Editor/Suikoden4_offsets.md`](Editor/Suikoden4_offsets.md).

## ISO editing — random encounters

The boot ELF's random-encounter logic was reverse-engineered, so the **encounter rate** and
a couple of battle toggles are editable (this is code in `SLUS_209.79`, not save data):

- **Encounter rate** — a slider that scales how often random battles trigger. The game
  rolls the threshold as `rand(0..99)`; scaling that range scales the rate
  (`N = round(10000 / percent)`, so 50% ≈ half as many battles).
- **Champion's Rune effect — always on** — forces the game's own selective suppression
  (skip enemies weaker than the party) party-wide without equipping the rune.
- **Turn off random battles completely** — replaces the encounter-gate call with a no-op.

Two ways to apply, both **NTSC-U only** and fully reversible:

- **In the web app's ISO Editor** — writes the changed bytes in place on desktop Chromium,
  or streams a patched copy of the disc on Android. Nothing is uploaded.
- **CLI:** [`Editor/s4_encounter_rate.py`](Editor/s4_encounter_rate.py) sets the rate as a
  percentage with an in-place 4-byte edit:
  ```bash
  python3 Editor/s4_encounter_rate.py 50    # half as many encounters
  python3 Editor/s4_encounter_rate.py 100   # restore default
  ```

Full notes: [`Editor/Suikoden4_encounter_rate.md`](Editor/Suikoden4_encounter_rate.md).

## Not included (and why)

- **New-game character stat tables** — S4 keeps these inside `FILEDATA`'s ~1,000 unlabeled
  sub-archives, consumed by overlay code, with no strings and no static tables in the boot
  ELF (join stats are *computed* from growth curves, not stored). A PCSX2 savestate would
  unlock this; until then they aren't editable.
- **`.psv` / `.max` writing** — Sony signature / LZARI re-encoder respectively.

---

## Layout
```
web/                     the editor — a static browser app (Save + ISO editors, PWA)
  index.html · style.css · app.js · iso.js · sw.js · manifest.webmanifest · icons/
  README.md              the web app's own docs (UI, install, Android flow)
  tests/                 npm test — static checks + a synthetic-fixture engine round-trip
Editor/                  the save engine + reference data the web app loads at runtime
  s4save.py              PS2 memory-card reader + writer (PS2MFS + ECC) and save codec
  s4files.py             single-file containers (.cbs/.psu/.sps/.psv/.max)
  s4lzari.py             LZARI decoder (ported from mymc) for MAX Drive saves
  s4_encounter_rate.py   CLI: set the random-encounter rate by % (in-place ISO edit)
  s4_char_offsets.json   113 characters (record offset -> name)
  s4_item_names.json     519 item ids -> names
  s4_rune_names.json     42 rune ids -> names
  s4_unites.json         per-character unite-attack slot names + partners
  s4_affinities.json     per-character rune affinities
  Suikoden4_offsets.md   reverse-engineering notes (save layout + checksum)
  Suikoden4_encounter_rate.md  reverse-engineering notes for the encounter-rate patches
Base ISO/                your Suikoden IV disc image (USA or PAL) — not included
```

## Support & feature requests
Feature requests/Support avail on the **Toran Castle Discord**: https://discord.gg/KesHMX5P2Z

## Credits
Data model derived from the community PCSX2 Cheat Engine tables for Suikoden IV.
PS2 memory-card ECC, the CodeBreaker RC4 constant, and the LZARI algorithm from `mymc`
(Ross Ridge, public domain). Unite-attack names from ninjaskipper's GameFAQs Combo
Attacks guide; rune affinities from OmegaDL50's GameFAQs Rune Affinity FAQ. Save files,
disc images, and third-party guides are **not** included in this repository.
