# Suikoden IV — random encounter rate (reverse-engineering + rate cheat)

Region: **NTSC-U (SLUS-209.79)**, boot ELF `SLUS_209.79;1` (ISO LBA 367, loads at EE
vaddr `0x280000`). Addresses below are EE RAM / PCSX2 addresses (== ELF vaddr).

> ⚠️ **Not verified on hardware from this analysis alone.** The mechanism was traced by
> static disassembly (capstone) and is high-confidence, but the exact *feel* of each rate
> should be confirmed in-game. Tune the single constant `N` to taste (see below).

## How random encounters are gated

The main field step-loop lives inside the per-field update function at `0x2D4D80`. The
encounter throttle is a classic **"accumulate danger, compare to a random threshold"**:

```
0x2D5C3C  addiu a0, zero, 0x64      ; a0 = 100  ← RATE KNOB (rand range)
0x2D5C40  jal   0x2809D0            ; v0 = rand(0 .. a0-1)      (LCG, mult 0x5D588B65)
0x2D5C44  (s1 = 0)                  ; delay slot: reset the danger accumulator
0x2D5C50  (s2 = v0)                 ; threshold = rand(0..99)
  ... per step, over party/tile entries ...
0x2D5C70  lbu  v0, -5(s0)           ; v0 = per-tile "danger" weight
0x2D5C74  addu s1, s1, v0           ; s1 += danger
0x2D5C78  slt  v1, s1, s2           ; still below the random threshold?
0x2D5C7C  bnel v1, zero, <skip>     ; yes → no encounter this step
0x2D5C84  jal  0x2D5D70             ; encounter GATE → v0 (1 = allow, 0 = suppress)
0x2D5C88  (a0 = *s0)                ; delay slot
0x2D5C8C  bnez v0, 0x2D5868         ; gate said allow → START BATTLE
```

- **Threshold `s2 = rand(0..99)`.** `0x2809D0` is the game RNG: it advances an LCG seed at
  `0x004F75B0` (multiplier `0x5D588B65`), converts to a float in `[0,1)`, multiplies by the
  range `a0`, floors, and clamps to `[0, a0)`. So a larger range ⇒ a larger *average*
  threshold ⇒ more danger must accumulate before an encounter ⇒ **fewer encounters**.
- **The gate `0x2D5D70`** decides whether an allowed step actually battles. It returns 1
  in normal play; it is *also the Champion's Rune implementation* — it scans each party
  member's 3 rune slots (`xori v0, 0x1C`; **`0x1C` = Champion's Rune**) and, when that rune
  is equipped and the party's average is high enough, returns 0 to suppress the encounter.
  This is why the community "No Random Battles" cheat overwrites the call at `0x2D5C84`
  with `li v0,0` — it forces the gate result to 0.

## The rate knob

The cleanest, lowest-risk lever is the **rand range** at `0x2D5C3C`
(`addiu a0, zero, N`, opcode `0x24040000 | N`). It only changes the range of this one
threshold draw — no other logic is touched. Encounter rate scales roughly as **`100 / N`**
of the default (default `N = 100`). The immediate is 16-bit, so `N` can be `1 … 32767`.

| Effect | N (dec) | instruction word | approx rate |
|---|---|---|---|
| ~4× more | 25 | `24040019` | 4× |
| ~2× more | 50 | `24040032` | 2× |
| **default** | 100 | `24040064` | 1× (no patch) |
| ~½ | 200 | `240400C8` | 0.5× |
| ~¼ | 400 | `24040190` | 0.25× |
| ~1/10 | 1000 | `240403E8` | 0.1× |
| near-off | 30000 | `24047530` | ~0.3% |

### PCSX2 pnach

Add **one** of these to your NTSC-U cheats pnach (e.g. append to
`Suikoden IV (NTSC-U).pnach`, or the CRC-named pnach PCSX2 expects). Pick a single line —
they all patch the same address, so enable only one:

```ini
[Encounter Rate — Half]
patch=1,EE,202D5C3C,extended,240400C8

[Encounter Rate — Quarter]
patch=1,EE,202D5C3C,extended,24040190

[Encounter Rate — Very rare (1/10)]
patch=1,EE,202D5C3C,extended,240403E8

[Encounter Rate — Double]
patch=1,EE,202D5C3C,extended,24040032

[Encounter Rate — 4x (grinding)]
patch=1,EE,202D5C3C,extended,24040019
```

`20` = the raw "constant 32-bit write to EE RAM" command; `2D5C3C` = the address; the value
is the replacement instruction word. Fully off is better done with the existing community
"No Random Battles" code (it forces the gate at `0x2D5C84`), or use the near-off row above.

### In-game alternative (no cheats, save-editable)

The game already ships an encounter-*reducer*: the **Champion's Rune** (`0x1C`) or the
**Champion's Orb** accessory (`0x1BD`). Equipping either (which the save editor can do)
suppresses encounters once the party is strong enough — that is exactly what the gate at
`0x2D5D70` implements.

## ISO edit (percentage knob)

Encounter rate is game code, not save data, so it can't live in the save editor — but it
*can* be baked into the ISO with a 4-byte edit. The instruction sits at:

- **ISO offset `0x10E43C`** (= LBA 367 × 2048 `0xB7800` + ELF offset `0x56C3C`),
  vaddr `0x2D5C3C` in `SLUS_209.79;1`.

The USA ISO is a plain 2048-byte/sector image, so there's **no ECC/EDC to rebuild** — just
overwrite the 4 bytes with the little-endian word `0x24040000 | N`.

Use the helper, which takes a **percentage of normal** (100 = unchanged, 50 = half,
200 = double) and computes `N = round(10000 / percent)`:

```bash
python3 Editor/s4_encounter_rate.py --status     # show current rate
python3 Editor/s4_encounter_rate.py 50           # set to 50% (half) — in place
python3 Editor/s4_encounter_rate.py 100          # restore default
```

It verifies the `addiu a0,zero,imm` signature before writing (so it won't patch a PAL or
mismatched build) and re-reads to confirm the write. Fully reversible via `... 100`.
