#!/usr/bin/env python3
"""
Suikoden IV PS2 memory-card save reader + writer (stdlib only).

Opens an 8 MB PS2 memory-card image (*.ps2 / *.mcd), walks the PS2MFS filesystem,
finds the Suikoden IV save folders (USA BASLUS-20979… / PAL BESLES-52913…), and decodes
each save's `gamedata` payload for display. The payload layout and checksum are identical
across regions, so USA and PAL saves are both fully supported.

Layout facts (validated 2026-08-10 against 5 real saves; see Suikoden4_offsets.md):
  - Card pages are 512 data + 16 ECC spare = 528 bytes on disk (PS2MFS).
  - Each S4 save folder is `<PREFIX>s4NN` (USA `BASLUS-20979`, PAL `BESLES-52913`); its
    payload file has the same name and is 57952 bytes.
  - gamedata header: +0x00 u32 version(=6), +0x08 u16 slot#, +0x0C u32 CRC32 + +0x10..0x1F
    byte-reversed MD5 over the body (cracked — see below), hero/ship names as ASCII from
    ~0x28.

WRITING is supported: the save digest was reverse-engineered from SLUS_209.79 (see
Suikoden4_offsets.md). Over body = gamedata[0x20:0x20+0xE240]:
  - +0x0C u32 = CRC32(body)                    (standard reflected, little-endian)
  - +0x10..  = MD5(body) with the 16 bytes byte-REVERSED
Write-back recomputes both, then refreshes each memcard page's Hamming ECC. A backup
of the whole card is made before the first write.
"""
import struct, os, shutil, hashlib, zlib

MAGIC = b"Sony PS2 Memory Card Format"
# Suikoden IV save-folder prefixes by region. The gamedata payload, offsets and checksum
# are identical across regions (verified: a PAL BESLES-52913 save reproduces the exact
# CRC32 + reversed-MD5 over 0x20..0x20+0xE240). All are 12 chars, so folder[12:] is the
# `s4NN` slot tail regardless of region.
S4_PREFIXES = ("BASLUS-20979",  # USA  (SLUS-209.79)
               "BESLES-52913")  # PAL  (SLES-529.13)
S4_PREFIX = S4_PREFIXES[0]      # default/back-compat (USA)

S4_REGION = {"BASLUS-20979": "NTSC-U", "BESLES-52913": "PAL"}  # prefix -> region label

def s4_match_prefix(name):
    """Return the region prefix that `name` starts with, or None."""
    for p in S4_PREFIXES:
        if name.startswith(p):
            return p
    return None

def s4_region(folder):
    """'BASLUS-20979s400' -> 'NTSC-U', 'BESLES-52913s400' -> 'PAL' (else '')."""
    return S4_REGION.get(s4_match_prefix(folder) or "", "")

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
DIGEST_OFF    = 0x0C     # 20 bytes total: CRC32 (u32) + reversed MD5 (16 bytes)
DIGEST_LEN    = 20
CRC_OFF       = 0x0C     # u32 little-endian CRC32 of BODY
MD5_OFF       = 0x10     # 16-byte MD5 of BODY, stored byte-reversed
BODY_OFF      = 0x20     # checksummed region start
BODY_LEN      = 0xE240   # checksummed region length (57920 bytes)

# --- character records -----------------------------------------------------------
# Each character record is 0xF0 (240) bytes. The record BASE is the rune block; the stat
# sub-block sits +0x74 into the record (so char0's stats land at 0x258, which is why an
# earlier 0x78-stride reading worked for char0 only — 0x78 aliased two halves of the real
# 0xF0 record and mislabeled every other character).
#
# Layout PROVEN against two independent playthroughs using known anchors: Hero (idx0) holds
# the Rune of Punishment; Ted (idx3) always holds the Soul Eater. Both decode exactly, and
# every roster name lines up (Elenor, Snowe, …). Ted's CT roster index is 3.
CHAR_BASE   = 0x1E4      # record 0 base (rune block). stat sub-block = 0x258 = 0x1E4 + 0x74
CHAR_STRIDE = 0xF0       # true per-character record size (240 bytes)
CT_STRIDE   = 0x78       # the cheat-table offset unit; roster index = ct_offset // 0x78
# rune slots (3 per character), low byte of each u16 at the record start
OFF_RUNES   = (0x00, 0x02, 0x04)
RUNE_SLOTS  = 3
# stat sub-block, offsets RELATIVE TO THE RECORD BASE. Max HP (+0x92) and the 8 stats
# (+0x94..) are confirmed against known values across two playthroughs.
OFF_MAXHP   = 0x92              # u16 max HP
OFF_STATS   = 0x94              # u16[8]: STR SKL MAG EVA PDF MDF SPD LUK
STAT_NAMES  = ["STR", "SKL", "MAG", "EVA", "PDF", "MDF", "SPD", "LUK"]
# NOT exposed, and why:
#  * Current HP is not persisted in the record — the game restores it to Max HP on load,
#    so every saved value reads 0. There is nothing meaningful to edit.
#  * Level is DERIVED from experience (Suikoden computes it), so there is no level byte to
#    set; changing a character's level means changing their EXP.
#  * The EXP field within the save has not been confirmed to the standard this tool holds
#    (candidates don't track level cleanly across two playthroughs), so it is left alone
#    rather than exposed as a guess that could corrupt a save.
# Equipment slots (u16 item ids), offsets RELATIVE TO THE RECORD BASE. Verified by category
# purity: across all recruited characters in two independent playthroughs, +0xBE holds only
# armor/robes and +0xC2 only boots/shoes (100% pure); head/hands/accessory slots likewise
# hold only their category once unrecruited (garbage) records are excluded. The block is
# exactly 7 slots — +0xCA is always empty.
EQUIP_SLOTS = [
    ("head", 0xBC), ("body", 0xBE), ("hands", 0xC0), ("feet", 0xC2),
    ("acc1", 0xC4), ("acc2", 0xC6), ("acc3", 0xC8),
]
EQUIP_OFF = dict(EQUIP_SLOTS)

def _char_names():
    """rosterIndex -> name, from s4_char_offsets.json (offset/0x78)."""
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import json
        raw = json.load(open(os.path.join(here, "s4_char_offsets.json")))
        return {int(k, 16) // CT_STRIDE: v for k, v in raw.items()}
    except Exception:
        return {}
CHAR_NAMES = _char_names()

def _rune_names():
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import json
        raw = json.load(open(os.path.join(here, "s4_rune_names.json")))
        return {int(k, 16): v for k, v in raw.items()}
    except Exception:
        return {}
RUNE_NAMES = _rune_names()

def _item_names():
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        import json
        raw = json.load(open(os.path.join(here, "s4_item_names.json")))
        return {int(k, 16): v for k, v in raw.items()}
    except Exception:
        return {}
ITEM_NAMES = _item_names()


def recompute_checksums(gamedata):
    """Return a copy of gamedata with CRC32 + reversed-MD5 recomputed over the body.
    This is the exact algorithm SLUS_209.79 uses to gate save loading."""
    b = bytearray(gamedata)
    body = bytes(b[BODY_OFF:BODY_OFF + BODY_LEN])
    struct.pack_into("<I", b, CRC_OFF, zlib.crc32(body) & 0xFFFFFFFF)
    b[MD5_OFF:MD5_OFF + 16] = hashlib.md5(body).digest()[::-1]
    return bytes(b)

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
            if e["is_dir"] and s4_match_prefix(e["name"]):
                out.append({"folder": e["name"], "cluster": e["cluster"],
                            "length": e["length"]})
        return out

    def read_file(self, dir_cluster, dir_len, filename):
        for e in self._listdir(dir_cluster, dir_len):
            if e["name"] == filename and not e["is_dir"]:
                return self._chain(e["cluster"], e["length"])[:e["length"]]
        return None

    # ---- write support (same in-place, ECC-refreshing approach as the S3 editor) ----
    def _chain_clusters(self, first, size):
        clusters, c = [], first
        while size > 0 and (c & 0x7FFFFFFF) != 0x7FFFFFFF and c != 0xFFFFFFFF:
            clusters.append((c & 0x7FFFFFFF) + self.alloc_offset)
            nxt = self._fat(c & 0x7FFFFFFF)
            if nxt == 0xFFFFFFFF:
                break
            c = nxt
            size -= self.cluster_size
        return clusters

    def _write_page(self, page_num, data512):
        off = page_num * self.raw_page
        self.data[off:off + self.page_len] = data512
        if self.raw_page >= self.page_len + 16:
            self.data[off + self.page_len:off + self.page_len + 16] = ecc_page(data512)

    def _write_cluster(self, cluster_num, data):
        base = cluster_num * self.pages_per_cluster
        for i in range(self.pages_per_cluster):
            seg = data[i*self.page_len:(i+1)*self.page_len]
            if len(seg) < self.page_len:
                seg = seg + b"\x00" * (self.page_len - len(seg))
            self._write_page(base + i, seg)

    def write_file(self, dir_cluster, dir_len, filename, new_content):
        """Replace a file's bytes in place (same length) and refresh ECC."""
        ent = None
        for e in self._listdir(dir_cluster, dir_len):
            if e["name"] == filename and not e["is_dir"]:
                ent = e; break
        if ent is None:
            raise KeyError(f"{filename} not found")
        if len(new_content) != ent["length"]:
            raise ValueError(f"length changed ({len(new_content)} != {ent['length']}); "
                             "in-place write only")
        clusters = self._chain_clusters(ent["cluster"], ent["length"])
        for i, cnum in enumerate(clusters):
            seg = new_content[i*self.cluster_size:(i+1)*self.cluster_size]
            if not seg:
                break
            self._write_cluster(cnum, seg)
        return len(clusters)

    def to_bytes(self):
        return bytes(self.data)


def load_card(path):
    with open(path, "rb") as f:
        return MemCard(f.read())


def slot_label(folder):
    """'BASLUS-20979s400'/'BESLES-52913s400' -> 'Slot 0'. Falls back to the folder tail."""
    p = s4_match_prefix(folder)
    tail = folder[len(p):] if p else folder
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


def decode_character(gamedata, roster_index):
    off = CHAR_BASE + roster_index * CHAR_STRIDE
    if off + CHAR_STRIDE > len(gamedata):
        return None
    stats = list(struct.unpack_from("<8H", gamedata, off + OFF_STATS))
    maxhp = struct.unpack_from("<H", gamedata, off + OFF_MAXHP)[0]
    runes = [gamedata[off + ro] for ro in OFF_RUNES]   # low byte of each rune slot
    equip = {name: struct.unpack_from("<H", gamedata, off + eo)[0]
             for name, eo in EQUIP_SLOTS}
    return {
        "rosterIndex": roster_index,
        "name": CHAR_NAMES.get(roster_index, f"#{roster_index}"),
        "addr": off,
        "maxHP": maxhp,
        "stats": dict(zip(STAT_NAMES, stats)),
        "runes": runes,
        "runeNames": [RUNE_NAMES.get(r, "") for r in runes],
        "equip": equip,
        "equipNames": {k: ITEM_NAMES.get(v, "") for k, v in equip.items()},
        "hasData": maxhp > 0 or sum(stats) > 0 or any(runes),
    }


def decode_characters(gamedata):
    n = (len(gamedata) - CHAR_BASE) // CHAR_STRIDE
    if CHAR_NAMES:
        n = min(n, max(CHAR_NAMES) + 1)
    return [c for c in (decode_character(gamedata, i) for i in range(n)) if c]


def decode_save(gamedata):
    """Decode one save's gamedata payload (header + names + characters)."""
    names = [{"key": key, "label": label, "value": _read_str(gamedata, off, n), "max": n}
             for key, off, n, label in NAME_FIELDS]
    body = gamedata[BODY_OFF:BODY_OFF + BODY_LEN]
    stored = gamedata[CRC_OFF:CRC_OFF + 4] + gamedata[MD5_OFF:MD5_OFF + 16]
    calc = (struct.pack("<I", zlib.crc32(body) & 0xFFFFFFFF)
            + hashlib.md5(body).digest()[::-1])
    return {
        "size": len(gamedata),
        "version": struct.unpack_from("<I", gamedata, OFF_VERSION)[0],
        "slot": struct.unpack_from("<H", gamedata, OFF_SLOT)[0],
        "digest": gamedata[DIGEST_OFF:DIGEST_OFF + DIGEST_LEN].hex(),
        "checksumValid": stored == calc,
        "names": names,
        "characters": [c for c in decode_characters(gamedata) if c["hasData"]],
        "writable": True,
    }


# --- editing --------------------------------------------------------------------
CHAR_FIELDS = {"maxHP": (OFF_MAXHP, 2)}
STAT_INDEX = {n: i for i, n in enumerate(STAT_NAMES)}

def _clamp(v, width):
    return max(0, min((1 << (8 * width)) - 1, int(v)))

def apply_edits_to_gamedata(gamedata, char_edits=None, name_edits=None):
    """char_edits: {rosterIndex: {field: value, "stats": {STAT: value}}}.
    name_edits:   {nameKey: "text"}.  Returns (new_gamedata_with_fixed_checksums, changed)."""
    b = bytearray(gamedata)
    changed = 0
    name_off = {k: (o, n) for k, o, n, _ in NAME_FIELDS}
    for key, val in (name_edits or {}).items():
        if key not in name_off:
            continue
        off, n = name_off[key]
        enc = str(val).encode("latin1", "replace")[:n]
        b[off:off + n] = enc + b"\x00" * (n - len(enc))
        changed += 1
    for ridx, fields in (char_edits or {}).items():
        base = CHAR_BASE + int(ridx) * CHAR_STRIDE
        if base + CHAR_STRIDE > len(b):
            continue
        for k, v in fields.items():
            if k == "stats":
                for sname, sval in (v or {}).items():
                    if sname in STAT_INDEX:
                        struct.pack_into("<H", b, base + OFF_STATS + STAT_INDEX[sname]*2,
                                         _clamp(sval, 2)); changed += 1
            elif k == "runes":
                # {slot(0..2): rune_id}. Write only the low byte of the rune u16 slot;
                # leave the high byte untouched (it is not part of the rune id).
                for slot, rid in (v or {}).items():
                    slot = int(slot)
                    if 0 <= slot < RUNE_SLOTS:
                        b[base + OFF_RUNES[slot]] = _clamp(rid, 1); changed += 1
            elif k == "equip":
                # {slotName: item_id (u16)}; 0 = empty slot.
                for sname, iid in (v or {}).items():
                    if sname in EQUIP_OFF:
                        struct.pack_into("<H", b, base + EQUIP_OFF[sname], _clamp(iid, 2))
                        changed += 1
            elif k in CHAR_FIELDS:
                off, w = CHAR_FIELDS[k]
                struct.pack_into({1:"<B",2:"<H",4:"<I"}[w], b, base + off, _clamp(v, w))
                changed += 1
    return recompute_checksums(bytes(b)), changed


def write_save_edits(path, folder, char_edits=None, name_edits=None, make_backup=True):
    """Apply edits to one save folder's gamedata on a memcard, in place. Recomputes the
    checksums + per-page ECC. Backs up the whole card first by default."""
    card = load_card(path)
    target = None
    for e in card.root_entries():
        if e["is_dir"] and e["name"] == folder:
            target = e; break
    if target is None:
        return {"error": f"save folder {folder} not found"}
    gd = card.read_file(target["cluster"], target["length"], folder)
    if gd is None:
        return {"error": "gamedata not found"}
    new_gd, changed = apply_edits_to_gamedata(gd, char_edits, name_edits)
    if changed == 0:
        return {"ok": True, "changed": 0, "note": "no editable fields in request"}
    if make_backup:
        bak = path + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
    clusters = card.write_file(target["cluster"], target["length"], folder, new_gd)
    with open(path, "wb") as f:
        f.write(card.to_bytes())
    return {"ok": True, "changed": changed, "clustersWritten": clusters,
            "crc": struct.unpack_from("<I", new_gd, CRC_OFF)[0]}


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
        dec["region"] = s4_region(s["folder"])
        for nm in dec["names"]:
            nm["folder"] = s["folder"]
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
                    has_s4 = any(p.encode() in blob for p in S4_PREFIXES)
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
