#!/usr/bin/env python3
"""
Suikoden IV (USA, SLUS-209.79) ISO patcher / research tool.

Two halves, mirroring the Suikoden III editor's discipline:
  * VERIFIED  — ISO identity + file map. Safe to rely on.
  * RESEARCH  — locate the initial character-stat table inside FILEDATA.*. The exact
                base offset is NOT confirmed yet, so this half only *searches* the ISO
                and dumps candidates. Nothing is written to the stat table blind.

The in-RAM record SHAPE (stride 0x78, stat offsets) is known from the Cheat Engine
table (see Suikoden4_offsets.md); the initial-stats copy that seeds a NEW GAME lives
packed inside FILEDATA and still needs to be located before write support is safe.

Usage:
  python3 s4patch.py identify "Base ISO/Suikoden IV (USA).iso"
  python3 s4patch.py files    "Base ISO/Suikoden IV (USA).iso"
  python3 s4patch.py find-bytes "…iso" --hex "20 00 22 00" [--start 0 --end 0]
  python3 s4patch.py dump      "…iso" --off 0x1234 --len 256
"""
import argparse, os, struct, sys, shutil, datetime, json

HERE = os.path.dirname(os.path.abspath(__file__))
SECTOR = 2048

# --- VERIFIED: ISO identity + file map (parsed from the real USA ISO) ----------
GAME_SERIAL = "SLUS-209.79"
BOOT_ELF    = "SLUS_209.79;1"

# name -> (LBA sector, size bytes). Raw byte offset = LBA * 2048.
ISO_FILES = {
    "SYSTEM.CNF;1":   (366, 54),
    "SLUS_209.79;1":  (367, 3214528),
    "STR.BIN;1":      (389722, 1186701312),
    "TRG.BIN;1":      (969166, 30523392),
    "FILEDATA.BIN;1": (984070, 1078327296),
    "FILEDATA.BI1;1": (1510597, 1074509824),
    "FILEDATA.BI2;1": (2035260, 60162048),
    "MARGIN.DAT;1":   (2064636, 134217728),
}

# --- character record SHAPE (from the CT; RAM layout, reused as the record schema) ---
CHAR_STRIDE = 0x78
STAT_FIELDS = [                       # offset within record, width, label
    (0x00, 2, "Experience"),
    (0x0A, 2, "Current HP"),
    (0x1E, 2, "Max HP"),
    (0x20, 2, "STR"), (0x22, 2, "SKL"), (0x24, 2, "MAG"), (0x26, 2, "EVA"),
    (0x28, 2, "PDF"), (0x2A, 2, "MDF"), (0x2C, 2, "SPD"), (0x2E, 2, "LUK"),
]
EQUIP_FIELDS = [
    (0x00, 2, "Head"), (0x02, 2, "Body"), (0x04, 2, "Hands"), (0x06, 2, "Feet"),
    (0x08, 2, "Other1"), (0x0A, 2, "Other2"), (0x0C, 2, "Other3"),
    (0x10, 1, "Head Rune"), (0x11, 1, "Right Rune"), (0x12, 1, "Left Rune"),
]


def _load_json(name, default):
    try:
        with open(os.path.join(HERE, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default

CHAR_OFFSETS = _load_json("s4_char_offsets.json", {})   # "28C8" -> "Adrienne"
ITEM_NAMES   = _load_json("s4_item_names.json", {})     # "0001" -> "Medicine"
RUNE_NAMES   = _load_json("s4_rune_names.json", {})     # "01"   -> "Fire Rune"

# character list keyed by index (offset/0x78), sorted by name for the UI
def character_list():
    out = []
    for hexoff, name in CHAR_OFFSETS.items():
        off = int(hexoff, 16)
        out.append({"index": off // CHAR_STRIDE, "offset": off, "name": name})
    out.sort(key=lambda c: c["name"])
    return out


# --- ISO helpers ---------------------------------------------------------------
def identify(path):
    with open(path, "rb") as f:
        f.seek(16 * SECTOR)
        pvd = f.read(SECTOR)
        ok_iso = pvd[1:6] == b"CD001"
        f.seek(366 * SECTOR)
        cnf = f.read(54).decode("latin1", "replace")
    return {"path": path, "size": os.path.getsize(path), "iso9660": ok_iso,
            "system_cnf": cnf.strip(), "serial": GAME_SERIAL,
            "match": BOOT_ELF in cnf}

def read_at(path, off, length):
    with open(path, "rb") as f:
        f.seek(off)
        return f.read(length)

def file_region(name):
    """(byte_offset, size) for a known ISO file."""
    lba, size = ISO_FILES[name]
    return lba * SECTOR, size

def find_bytes(path, needle, start=0, end=0, limit=64):
    """Scan the ISO for a byte pattern; return matching absolute offsets (capped)."""
    end = end or os.path.getsize(path)
    hits = []
    chunk = 1 << 20
    with open(path, "rb") as f:
        pos = start
        f.seek(pos)
        overlap = len(needle) - 1
        prev = b""
        while pos < end:
            buf = f.read(min(chunk, end - pos))
            if not buf:
                break
            hay = prev + buf
            base = pos - len(prev)
            i = hay.find(needle)
            while i != -1:
                hits.append(base + i)
                if len(hits) >= limit:
                    return hits
                i = hay.find(needle, i + 1)
            prev = hay[-overlap:] if overlap else b""
            pos += len(buf)
    return hits


def _backup(path):
    bak = path + ".bak"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    return bak


def _cli():
    ap = argparse.ArgumentParser(description="Suikoden IV ISO tool")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("identify"); p.add_argument("iso")
    p = sub.add_parser("files");    p.add_argument("iso")
    p = sub.add_parser("find-bytes"); p.add_argument("iso")
    p.add_argument("--hex", required=True); p.add_argument("--start", type=lambda x: int(x,0), default=0)
    p.add_argument("--end", type=lambda x: int(x,0), default=0)
    p = sub.add_parser("dump");     p.add_argument("iso")
    p.add_argument("--off", required=True, type=lambda x: int(x,0))
    p.add_argument("--len", type=lambda x: int(x,0), default=256)
    a = ap.parse_args()

    if a.cmd == "identify":
        print(json.dumps(identify(a.iso), indent=2))
    elif a.cmd == "files":
        for name, (lba, size) in ISO_FILES.items():
            print(f"{name:16s} LBA {lba:>9}  off 0x{lba*SECTOR:X}  size {size}")
    elif a.cmd == "find-bytes":
        needle = bytes.fromhex(a.hex.replace(" ", ""))
        hits = find_bytes(a.iso, needle, a.start, a.end)
        print(f"{len(hits)} hit(s):", [hex(h) for h in hits])
    elif a.cmd == "dump":
        data = read_at(a.iso, a.off, a.len)
        for o in range(0, len(data), 16):
            row = data[o:o+16]
            print(f"{a.off+o:08X}  " + " ".join(f"{x:02X}" for x in row) + "  " +
                  "".join(chr(x) if 32 <= x < 127 else "." for x in row))

if __name__ == "__main__":
    _cli()
