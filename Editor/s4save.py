#!/usr/bin/env python3
"""
Suikoden IV PS2 memory-card save reader (READ-ONLY, stdlib only).

Opens an 8 MB PS2 memory-card image (*.ps2 / *.mcd), walks the PS2MFS filesystem,
finds the Suikoden IV USA save folders (BASLUS-20979...), and decodes each save's
`gamedata` payload for display.

Layout facts (validated 2026-08-10 against 5 real saves; see Suikoden4_offsets.md):
  - Card pages are 512 data + 16 ECC spare = 528 bytes on disk (PS2MFS).
  - Each S4 save folder is `BASLUS-20979s4NN`; its payload file has the same name and
    is 57952 bytes.
  - gamedata header: +0x00 u32 version(=6), +0x08 u16 slot#, +0x0C .. +0x1F a 20-byte
    digest/checksum (SHA1-shaped, salted/custom — NOT yet cracked), hero/ship names as
    ASCII from ~0x28.

WRITING is intentionally NOT implemented: the 0x0C..0x1F digest is a save-load gate
whose algorithm is unsolved, so a modified save could fail to load. This module is the
read-only foundation; write support is deferred until that digest is cracked. The PS2MFS
walker + Hamming ECC below are the same verified code as the S3 editor, so once the
digest falls, in-place write-back drops straight in.
"""
import struct, os

MAGIC = b"Sony PS2 Memory Card Format"
S4_PREFIX = "BASLUS-20979"     # USA Suikoden IV save-folder prefix on the memcard

# --- PS2 memory-card ECC (Hamming) — verbatim from mymc (Ross Ridge, public domain).
def _parityb(a):
    a ^= a >> 1; a ^= a >> 2; a ^= a >> 4
    return a & 1
_PARITY = [_parityb(b) for b in range(256)]
_CPM = [0] * 256
for _b in range(256):
    _m = 0
    for _i, _msk in enumerate([0x55, 0x33, 0x0F, 0x00, 0xAA, 0xCC, 0xF0]):
        _m |= _PARITY[_b & _msk] << _i
    _CPM[_b] = _m

def ecc_chunk(chunk):
    cp = 0x77; lp0 = 0x7F; lp1 = 0x7F
    for i in range(len(chunk)):
        b = chunk[i]
        cp ^= _CPM[b]
        if _PARITY[b]:
            lp0 ^= ~i
            lp1 ^= i
    return bytes([cp & 0xFF, lp0 & 0x7F, lp1 & 0xFF])

def ecc_page(page512):
    out = b"".join(ecc_chunk(page512[i*128:(i+1)*128]) for i in range(4))
    return out + b"\x00\x00\x00\x00"

# --- gamedata layout ------------------------------------------------------------
GD_SIZE       = 57952
OFF_VERSION   = 0x00     # u32, = 6
OFF_SLOT      = 0x08     # u16, matches folder suffix
DIGEST_OFF    = 0x0C     # 20 bytes, SHA1-shaped save-load gate (uncracked)
DIGEST_LEN    = 20

# Editable-looking name fields, ASCII null-padded. Offsets from hexdump of real saves;
# widths are conservative (stop at the next field). Cross-verified: hero "Sparda", ship
# "Basel". Exposed read-only until the checksum is cracked.
NAME_FIELDS = [
    ("hero",  0x28, 16, "Hero name"),
    ("ship",  0x4A, 16, "Ship name"),
]

def _read_str(data, off, n):
    return data[off:off+n].split(b"\x00")[0].decode("latin1", "replace")


class MemCard:
    """Read-only PS2MFS memory-card image walker (handles 528-byte spare pages).
    Same verified implementation as the S3 editor's s3save.MemCard."""
    def __init__(self, data):
        if data[:len(MAGIC)] != MAGIC:
            raise ValueError("not a PS2 memory-card image")
        self.data = bytearray(data)
        self.page_len = struct.unpack_from("<H", data, 0x28)[0]
        self.pages_per_cluster = struct.unpack_from("<H", data, 0x2A)[0]
        self.pages_per_block = struct.unpack_from("<H", data, 0x2C)[0]
        self.clusters = struct.unpack_from("<I", data, 0x30)[0]
        self.alloc_offset = struct.unpack_from("<I", data, 0x34)[0]
        self.rootdir_cluster = struct.unpack_from("<I", data, 0x3C)[0]
        self.ifc_list = list(struct.unpack_from("<32I", data, 0x50))
        self.cluster_size = self.page_len * self.pages_per_cluster
        total_pages = self.clusters * self.pages_per_cluster
        spare_page = self.page_len + (self.page_len // 512) * 16
        if total_pages * spare_page == len(data):
            self.raw_page = spare_page
        elif total_pages * self.page_len == len(data):
            self.raw_page = self.page_len
        else:
            self.raw_page = len(data) // total_pages

    def _page(self, n):
        off = n * self.raw_page
        return self.data[off:off + self.page_len]

    def _cluster(self, c):
        base = c * self.pages_per_cluster
        return b"".join(self._page(base + i) for i in range(self.pages_per_cluster))

    def _fat(self, cluster):
        per = self.cluster_size // 4
        ifc = self.ifc_list[cluster // (per * per)]
        fat_cluster = self._cluster(ifc)
        ptr = struct.unpack_from("<I", fat_cluster, ((cluster // per) % per) * 4)[0]
        real = self._cluster(ptr)
        return struct.unpack_from("<I", real, (cluster % per) * 4)[0]

    def _chain(self, first, size):
        out = b""
        c = first
        while size > 0 and (c & 0x7FFFFFFF) != 0x7FFFFFFF and c != 0xFFFFFFFF:
            out += self._cluster((c & 0x7FFFFFFF) + self.alloc_offset)
            nxt = self._fat(c & 0x7FFFFFFF)
            if nxt == 0xFFFFFFFF:
                break
            c = nxt
            size -= self.cluster_size
        return out

    @staticmethod
    def _dirent(buf, off):
        mode = struct.unpack_from("<H", buf, off)[0]
        length = struct.unpack_from("<I", buf, off + 4)[0]
        cluster = struct.unpack_from("<I", buf, off + 0x10)[0]
        name = buf[off + 0x40:off + 0x40 + 32].split(b"\x00")[0].decode("ascii", "replace")
        return {"mode": mode, "is_dir": bool(mode & 0x0020), "length": length,
                "cluster": cluster, "name": name}

    def _listdir(self, dir_cluster, count):
        data = self._chain(dir_cluster, count * 512)
        out = []
        for i in range(count):
            o = i * 512
            if o + 0x60 > len(data):
                break
            out.append(self._dirent(data, o))
        return out

    def root_entries(self):
        head = self._chain(self.rootdir_cluster, 512)
        root_len = self._dirent(head, 0)["length"]
        return self._listdir(self.rootdir_cluster, root_len)

    def find_s4_saves(self):
        out = []
        for e in self.root_entries():
            if e["is_dir"] and e["name"].startswith(S4_PREFIX):
                out.append({"folder": e["name"], "cluster": e["cluster"],
                            "length": e["length"]})
        return out

    def read_file(self, dir_cluster, dir_len, filename):
        for e in self._listdir(dir_cluster, dir_len):
            if e["name"] == filename and not e["is_dir"]:
                return self._chain(e["cluster"], e["length"])[:e["length"]]
        return None


def load_card(path):
    with open(path, "rb") as f:
        return MemCard(f.read())


def slot_label(folder):
    """'BASLUS-20979s400' -> 'Slot 0'. Falls back to the raw folder tail."""
    tail = folder[len(S4_PREFIX):]
    if tail.startswith("s4") and tail[2:].isdigit():
        return f"Slot {int(tail[2:])}"
    return tail or folder


# --- save title (icon.sys) ------------------------------------------------------
_FW_MAP = {chr(0xFF01 + i): chr(0x21 + i) for i in range(94)}
_FW_MAP["　"] = " "
def _title_from_icon_sys(ic):
    """PS2 browser title in icon.sys (Shift-JIS full-width), e.g.
    'Suikoden4 [00] LVL29 / 004:42' -> chapter/level/playtime."""
    if not ic or len(ic) < 0xC0 + 4:
        return {}
    raw = ic[0xC0:0xC0 + 68].split(b"\x00")[0].decode("shift_jis", "replace")
    norm = "".join(_FW_MAP.get(c, c) for c in raw)
    out = {"title": norm}
    import re
    m = re.search(r"\[(\d+)\]", norm)
    if m: out["slot"] = int(m.group(1))
    m = re.search(r"LVL?\s*(\d+)", norm, re.I)
    if m: out["level"] = int(m.group(1))
    m = re.search(r"(\d+:\d+)\s*$", norm)
    if m: out["playtime"] = m.group(1)
    return out


def decode_save(gamedata):
    """Decode one save's gamedata payload (header + names). Read-only view."""
    names = [{"key": key, "label": label, "value": _read_str(gamedata, off, n), "max": n}
             for key, off, n, label in NAME_FIELDS]
    return {
        "size": len(gamedata),
        "version": struct.unpack_from("<I", gamedata, OFF_VERSION)[0],
        "slot": struct.unpack_from("<H", gamedata, OFF_SLOT)[0],
        "digest": gamedata[DIGEST_OFF:DIGEST_OFF + DIGEST_LEN].hex(),
        "names": names,
        "writable": False,   # checksum uncracked — read-only for now
    }


def read_all_s4_saves(path):
    """Open a memcard file, decode every S4 save it contains."""
    card = load_card(path)
    saves = []
    for s in card.find_s4_saves():
        gd = card.read_file(s["cluster"], s["length"], s["folder"])
        if not gd:
            continue
        dec = decode_save(gd)
        dec["folder"] = s["folder"]
        dec["label"] = slot_label(s["folder"])
        ic = card.read_file(s["cluster"], s["length"], "icon.sys")
        dec["meta"] = _title_from_icon_sys(ic)
        saves.append(dec)
    return saves


def scan_memcards(roots):
    """Find 8 MB PS2 memory-card images (carrying an S4 save) near the given roots."""
    seen, found = set(), []
    exts = (".ps2", ".mcd", ".mc2", ".bin")
    for r in roots:
        if not r or not os.path.isdir(r):
            continue
        for dp, _, files in os.walk(r):
            if dp.count(os.sep) - r.count(os.sep) > 4:
                continue
            for fn in files:
                if not fn.lower().endswith(exts):
                    continue
                full = os.path.join(dp, fn)
                if full in seen:
                    continue
                seen.add(full)
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                if sz not in (8650752, 8388608) and not (8_000_000 <= sz <= 9_500_000):
                    continue
                try:
                    with open(full, "rb") as fh:
                        head = fh.read(64)
                    if head[:len(MAGIC)] != MAGIC:
                        continue
                    with open(full, "rb") as fh:
                        blob = fh.read()
                    has_s4 = S4_PREFIX.encode() in blob
                except OSError:
                    continue
                found.append({"path": full, "name": fn, "size": sz,
                              "mb": round(sz / 1048576, 1), "hasS4": has_s4})
    found.sort(key=lambda x: (not x["hasS4"], x["name"].lower()))
    return found


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) < 2:
        print("usage: s4save.py <memcard.ps2> [--json]")
        sys.exit(1)
    saves = read_all_s4_saves(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(saves, indent=2)); sys.exit(0)
    for s in saves:
        print(f"\n=== {s['label']} ({s['folder']}) ver={s['version']} "
              f"digest={s['digest'][:16]}… ===")
        if s.get("meta"):
            print("  title:", s["meta"].get("title", ""))
        for n in s["names"]:
            print(f"  {n['label']}: {n['value']!r}")
