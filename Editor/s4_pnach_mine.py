#!/usr/bin/env python3
"""
Mine a PS2 pnach cheat file for addresses that land inside the Suikoden IV save block.

The save `gamedata` payload is a verbatim image of the game's state block at EE 0x532860, so any
address a cheat writes inside that window maps straight to a save offset:

    save_offset = ram_addr - 0x532860

A pnach is therefore a pile of *already-located, already-named* offsets — `[Hero Codes\\Max HP]`
tells you both where and what. That is how the layout in `Suikoden4_offsets.md` dated 2026-09-12
was recovered, and it is the cheapest lead available for anything still unmapped.

Reads a pnach, writes nothing. The pnach itself is third-party research input and is NOT
redistributed — `Cheats/` is gitignored (CLAUDE.md rule 3), so this script takes a path.

    python3 Editor/s4_pnach_mine.py "Cheats/Suikoden IV (NTSC-U).pnach"
    python3 Editor/s4_pnach_mine.py <file> --field "Max HP"     # one field across every section
    python3 Editor/s4_pnach_mine.py <file> --stride             # infer record stride per field

stdlib only, like the rest of Editor/.
"""
import re
import sys
import collections

BASE = 0x532860          # EE address of the state block the save mirrors
SIZE = 0xE260            # its length, and the save payload's body length

SECTION = re.compile(r"^\[(.+)\]$")
# patch=<cpu>,<mem>,<addr>,<size>,<value> — the top nibble of <addr> is the PS2 code type
PATCH = re.compile(r"^patch=\d+,EE,([0-9A-Fa-f]{8}),\w+,([0-9A-Fa-f]{8})$")


def parse(path):
    """Yield (section, kind, field, ram_addr, code_type, value) for every EE patch line."""
    section = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            m = SECTION.match(line)
            if m:
                section = m.group(1)
                continue
            m = PATCH.match(line)
            if not m or section is None:
                continue
            raw = int(m.group(1), 16)
            kind, _, field = section.partition("\\")
            yield (section, kind.replace(" Codes", "").strip(), field.strip() or section,
                   raw & 0x0FFFFFFF, (raw >> 28) & 0xF, int(m.group(2), 16))


def in_save(addr):
    return BASE <= addr < BASE + SIZE


def summarise(path):
    rows = [r for r in parse(path)]
    inside = [r for r in rows if in_save(r[3])]
    secs = {r[0] for r in rows}
    print(f"{path}")
    print(f"  patch lines            : {len(rows)}")
    print(f"  sections               : {len(secs)}")
    print(f"  lines inside the save  : {len(inside)}  "
          f"({100 * len(inside) / max(len(rows), 1):.1f}%)")
    fields = collections.Counter(r[2] for r in inside)
    print(f"  distinct field names   : {len(fields)}")
    print("\n  most common fields (these are the ones with a record per character):")
    for name, n in fields.most_common(15):
        print(f"    {n:4}  {name}")


def field_map(path, field):
    """Every character's address for one named field, sorted — the deltas are the record stride."""
    rows = [r for r in parse(path) if in_save(r[3]) and r[2].lower() == field.lower()]
    rows.sort(key=lambda r: r[3])
    if not rows:
        return print(f"no in-save lines for field {field!r}")
    print(f"{field}: {len(rows)} records")
    prev = None
    for _sec, who, _f, addr, typ, val in rows:
        d = f"  Δ={addr - prev:#x}" if prev is not None else ""
        print(f"  {addr:#010x}  save+{addr - BASE:#06x}  type{typ:X}  val={val:#010x}  {who}{d}")
        prev = addr


def strides(path):
    """Infer the record stride per field from the spacing of its per-character copies."""
    by = collections.defaultdict(list)
    for _sec, _who, field, addr, _typ, _val in parse(path):
        if in_save(addr):
            by[field].append(addr)
    print(f"{'field':<28} {'n':>4}  stride  first save offset")
    for field, addrs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        if len(addrs) < 3:
            continue
        addrs = sorted(set(addrs))
        deltas = collections.Counter(b - a for a, b in zip(addrs, addrs[1:]))
        stride, n = deltas.most_common(1)[0]
        # A field with one dominant delta is a per-character array; a scattered one is not.
        if n < len(addrs) * 0.6:
            continue
        print(f"{field:<28} {len(addrs):>4}  {stride:#06x}  +{addrs[0] - BASE:#06x}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    target = sys.argv[1]
    if "--field" in sys.argv:
        field_map(target, sys.argv[sys.argv.index("--field") + 1])
    elif "--stride" in sys.argv:
        strides(target)
    else:
        summarise(target)
