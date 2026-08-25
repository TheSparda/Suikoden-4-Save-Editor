#!/usr/bin/env python3
"""
Suikoden IV — random-encounter-rate ISO patcher (NTSC-U, SLUS-209.79).

The field encounter throttle draws its threshold as rand(0..N-1); the range N is the
immediate of `addiu a0, zero, 0x64` inside the boot ELF. Rate scales ~ 100/N of default
(default N = 100). So to set the rate to PERCENT of normal:  N = round(10000 / PERCENT)
(100% -> N=100 = unchanged, 50% -> 200 = half, 25% -> 400, 200% -> 50 = double).

It edits 4 bytes in place at ISO offset 0x10E43C. The ISO is a plain 2048-byte/sector image,
so there is no ECC/EDC to rebuild. Fully reversible: `... 100` restores the default.

Usage:
    python3 s4_encounter_rate.py --status                 # show current rate, write nothing
    python3 s4_encounter_rate.py 50                        # set encounters to 50% (half)
    python3 s4_encounter_rate.py 100                       # restore default
    python3 s4_encounter_rate.py 25 --iso "/path/to.iso"   # explicit ISO path

See Suikoden4_encounter_rate.md for the full reverse-engineering write-up.
"""
import argparse
import os
import struct
import sys

# boot ELF at ISO LBA 367 (offset 0xB7800); the knob is at ELF offset 0x56C3C.
ISO_OFFSET = 367 * 2048 + 0x56C3C          # = 0x10E43C
DEFAULT_N = 100
IMM_MAX = 0x7FFF                            # addiu immediate is signed 16-bit
DEFAULT_ISO = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "Base ISO", "Suikoden IV (USA).iso")


def _word(n):
    return 0x24040000 | (n & 0xFFFF)       # addiu a0, zero, n


def _read_n(f):
    f.seek(ISO_OFFSET)
    b = f.read(4)
    if len(b) != 4:
        raise SystemExit("error: could not read the patch offset (ISO too small?)")
    # signature check: the instruction must be `addiu a0, zero, imm` (xx xx 04 24 LE)
    if b[2] != 0x04 or b[3] != 0x24:
        raise SystemExit(
            f"error: bytes at 0x{ISO_OFFSET:X} are {b.hex(' ')}, not `addiu a0,zero,imm`.\n"
            "This patcher is NTSC-U (SLUS-209.79) only — a PAL or different build won't match.")
    return struct.unpack_from("<H", b, 0)[0], b


def n_to_pct(n):
    return round(10000 / n) if n else 0


def pct_to_n(pct):
    if pct <= 0:
        raise SystemExit("error: percent must be > 0")
    return max(1, min(IMM_MAX, round(10000 / pct)))


def main():
    ap = argparse.ArgumentParser(description="Set Suikoden IV random-encounter rate in the ISO.")
    ap.add_argument("percent", nargs="?", type=float,
                    help="encounter rate as %% of normal (100 = unchanged, 50 = half, 200 = double)")
    ap.add_argument("--iso", default=DEFAULT_ISO, help="path to the USA ISO")
    ap.add_argument("--status", action="store_true", help="show current rate and exit")
    args = ap.parse_args()

    iso = os.path.abspath(args.iso)
    if not os.path.isfile(iso):
        raise SystemExit(f"error: ISO not found: {iso}")

    if args.status or args.percent is None:
        with open(iso, "rb") as f:
            n, b = _read_n(f)
        print(f"ISO: {iso}")
        print(f"offset 0x{ISO_OFFSET:X}: {b.hex(' ')}  (rand range N = {n})")
        print(f"current encounter rate: ~{n_to_pct(n)}% of default"
              f"{'  (default)' if n == DEFAULT_N else ''}")
        if args.percent is None and not args.status:
            print("\ngive a percent to change it, e.g.:  python3 s4_encounter_rate.py 50")
        return

    n = pct_to_n(args.percent)
    new = struct.pack("<I", _word(n))
    with open(iso, "r+b") as f:
        old_n, old = _read_n(f)
        f.seek(ISO_OFFSET)
        f.write(new)
        f.flush()
        os.fsync(f.fileno())
        f.seek(ISO_OFFSET)
        check = f.read(4)
    if check != new:
        raise SystemExit("error: write-back verification failed — ISO NOT reliably patched.")
    print(f"ISO: {iso}")
    print(f"offset 0x{ISO_OFFSET:X}: {old.hex(' ')} (N={old_n}, ~{n_to_pct(old_n)}%)"
          f"  ->  {new.hex(' ')} (N={n}, ~{n_to_pct(n)}%)")
    print(f"done. Encounter rate is now ~{n_to_pct(n)}% of normal.")
    print(f"revert with:  python3 {os.path.basename(__file__)} 100")


if __name__ == "__main__":
    main()
