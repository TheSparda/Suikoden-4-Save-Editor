#!/usr/bin/env python3
"""
Single-file PS2 save containers for Suikoden IV (stdlib only).

The main editor reads whole memory-card images (PS2MFS). This module handles the
individual exported-save formats people trade online, extracting the 57952-byte S4
`gamedata` payload and re-packing an edited one:

  * .cbs  CodeBreaker  — RC4 (fixed S-box) + zlib.        READ + WRITE (round-trip verified)
  * .psu  EMS / uLaunchELF — raw dirents, no compression.  READ + WRITE (in-place patch)
  * .sps  SharkPort / X-Port — raw + a trailing checksum.  READ only (container checksum
                                                            algorithm unverified)
  * .max  MAX Drive — lzari-compressed.                    UNSUPPORTED (no lzari)

The payload is located by self-validation: the S4 gamedata carries its own CRC32 +
byte-reversed MD5 (see s4save), so the correct 57952-byte window is the one whose digest
checks out. That is format-agnostic for the uncompressed containers; CBS is decoded first.
Nothing is written unless the re-packed file decodes back to the exact edited payload.

RC4 S-box is the public-domain CodeBreaker constant from mymc (Ross Ridge).
"""
import struct, os, zlib, hashlib, shutil

SINGLE_EXTS = (".cbs", ".sps", ".psu", ".max", ".psv")
S4_PREFIXES = (b"BASLUS-20979", b"BESLES-52913")
GD_LEN      = 57952
BODY_OFF, BODY_LEN = 0x20, 0xE240

CBS_MAGIC = b"CFU\x00"
MAX_MAGIC = b"Ps2PowerSave"
SPS_MAGIC = b"\x0d\x00\x00\x00SharkPortSave"
PSV_MAGIC = b"\x00VSP"                 # PS3 exported save (signed)

CBS_RC4_SBOX = bytes([95,31,133,111,49,170,59,24,33,185,206,28,7,76,156,180,129,184,239,152,89,174,249,38,227,128,163,41,45,115,81,98,124,100,70,244,52,26,246,225,186,58,13,130,121,10,92,22,113,73,142,172,140,159,53,25,69,148,63,86,12,145,0,11,215,176,221,57,102,161,118,82,19,87,243,187,78,229,220,240,101,132,178,214,223,21,60,99,29,137,20,189,210,54,254,177,202,139,164,198,158,103,71,55,66,109,106,3,146,112,5,125,150,47,64,144,196,241,62,61,1,247,104,30,195,252,114,181,84,207,231,65,228,77,131,85,18,34,9,120,250,222,167,6,8,35,191,15,204,193,151,97,197,74,230,160,17,194,234,116,2,135,213,209,157,183,126,56,96,83,149,141,37,119,16,94,155,127,216,110,218,162,46,32,79,205,143,203,190,90,224,237,44,154,212,226,175,208,169,232,173,122,188,168,242,238,235,245,166,153,40,36,108,43,117,93,248,211,134,23,251,192,123,179,88,219,199,75,255,4,80,233,136,105,201,42,171,253,91,27,138,217,236,39,68,14,51,200,107,147,50,72,182,48,67,165])


def _rc4(sbox, data):
    """CodeBreaker RC4 variant (note the (ii+1) index quirk). Symmetric."""
    s = bytearray(sbox); t = bytearray(data); j = 0
    for ii in range(len(t)):
        i = (ii + 1) % 256
        j = (j + s[i]) % 256
        s[i], s[j] = s[j], s[i]
        t[ii] ^= s[(s[i] + s[j]) % 256]
    return bytes(t)


def _valid_gd(gd):
    if len(gd) != GD_LEN or struct.unpack_from("<I", gd, 0)[0] != 6:
        return False
    body = gd[BODY_OFF:BODY_OFF + BODY_LEN]
    return (struct.unpack_from("<I", gd, 0x0C)[0] == (zlib.crc32(body) & 0xFFFFFFFF)
            and gd[0x10:0x20] == hashlib.md5(body).digest()[::-1])


def _find_payload(blob):
    """Offset of the first self-validating 57952-byte S4 payload, or -1."""
    start = 0
    while True:
        i = blob.find(b"\x06\x00\x00\x00", start)
        if i < 0 or i + GD_LEN > len(blob):
            return -1
        if _valid_gd(blob[i:i + GD_LEN]):
            return i
        start = i + 1


def _folder_of(blob):
    for p in S4_PREFIXES:
        i = blob.find(p)
        if i >= 0:
            return blob[i:i + 16].decode("latin1", "replace")
    return ""


def sniff(blob):
    if blob[:4] == CBS_MAGIC: return "cbs"
    if blob[:12] == MAX_MAGIC: return "max"
    if blob[:17] == SPS_MAGIC: return "sps"
    if blob[:4] == PSV_MAGIC: return "psv"       # PS3 signed export
    if _find_payload(blob) >= 0: return "psu"   # raw dirents / EMS / bare payload
    return None


def _cbs_inner(blob):
    """Decode a CBS file to (hlen, dlen, inner_bytes)."""
    if blob[:4] != CBS_MAGIC:
        raise ValueError("not a CBS file")
    d04, hlen = struct.unpack_from("<LL", blob, 4)
    dlen, flen = struct.unpack_from("<LL", blob, 12)
    body = blob[hlen:hlen + flen]
    inner = zlib.decompressobj().decompress(_rc4(CBS_RC4_SBOX, body), dlen)
    return hlen, dlen, inner


def _cbs_entries(inner):
    """Yield (offset, size, name) for each 64-byte-header entry in a CBS inner blob."""
    off = 0
    while off + 64 <= len(inner):
        size = struct.unpack_from("<L", inner, off + 16)[0]
        name = inner[off + 32:off + 64].split(b"\x00", 1)[0].decode("latin1", "replace")
        yield off + 64, size, name
        off += 64 + size


def extract(blob):
    """Return {format, folder, gamedata, writable, note} or {error}."""
    fmt = sniff(blob)
    if fmt is None:
        return {"error": "unrecognized save file (no S4 payload found)"}
    if fmt == "max":
        return {"error": "MAX Drive (.max) uses lzari compression, not supported yet"}
    if fmt == "cbs":
        try:
            _, _, inner = _cbs_inner(blob)
        except Exception as e:
            return {"error": f"CBS decode failed: {e}"}
        for doff, size, name in _cbs_entries(inner):
            if size == GD_LEN and any(name.encode().startswith(p) for p in S4_PREFIXES):
                gd = inner[doff:doff + size]
                if _valid_gd(gd):
                    return {"format": "cbs", "folder": name, "gamedata": gd,
                            "writable": True, "note": ""}
        return {"error": "no S4 gamedata entry inside CBS"}
    # uncompressed containers: locate by self-validation
    o = _find_payload(blob)
    if o < 0:
        return {"error": "no valid S4 payload in file"}
    gd = blob[o:o + GD_LEN]
    folder = _folder_of(blob)
    if fmt == "sps":
        return {"format": "sps", "folder": folder, "gamedata": gd, "writable": False,
                "note": "SharkPort container checksum not reconstructed — read-only"}
    if fmt == "psv":
        return {"format": "psv", "folder": folder, "gamedata": gd, "writable": False,
                "note": "PS3 (.psv) is signed — read-only"}
    return {"format": "psu", "folder": folder, "gamedata": gd, "writable": True, "note": ""}


def repack(blob, new_gd):
    """Return a new container with the S4 payload replaced by new_gd (same length),
    or raise ValueError if the format isn't writable. Verifies by re-extracting."""
    if len(new_gd) != GD_LEN:
        raise ValueError("gamedata must be exactly %d bytes" % GD_LEN)
    fmt = sniff(blob)
    if fmt == "cbs":
        hlen, dlen, inner = _cbs_inner(blob)
        inner = bytearray(inner)
        placed = False
        for doff, size, name in _cbs_entries(bytes(inner)):
            if size == GD_LEN and any(name.encode().startswith(p) for p in S4_PREFIXES):
                inner[doff:doff + size] = new_gd; placed = True; break
        if not placed:
            raise ValueError("gamedata entry not found in CBS")
        comp = _rc4(CBS_RC4_SBOX, zlib.compress(bytes(inner), 9))
        out = bytearray(blob[:hlen])
        struct.pack_into("<L", out, 16, len(comp))   # flen = compressed length
        out += comp
        out = bytes(out)
    elif fmt in ("psu",):
        o = _find_payload(blob)
        if o < 0:
            raise ValueError("payload not found")
        out = bytearray(blob); out[o:o + GD_LEN] = new_gd; out = bytes(out)
    else:
        raise ValueError("%s files are read-only" % (fmt or "unknown"))
    # verify: the re-packed file must decode back to exactly new_gd
    chk = extract(out)
    if chk.get("gamedata") != new_gd:
        raise ValueError("re-pack verification failed (decoded payload differs)")
    return out


def read_single(path):
    with open(path, "rb") as f:
        blob = f.read()
    return extract(blob)


def write_single(path, new_gd, make_backup=True):
    with open(path, "rb") as f:
        blob = f.read()
    out = repack(blob, new_gd)     # raises on any problem, incl. read-only formats
    if make_backup:
        bak = path + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


def scan_single_saves(roots):
    """Find individual S4 save files (.cbs/.sps/.psu/.max/.psv) near the given roots."""
    seen, found = set(), []
    for r in roots:
        if not r or not os.path.isdir(r):
            continue
        for dp, _, files in os.walk(r):
            if dp.count(os.sep) - r.count(os.sep) > 4:
                continue
            for fn in files:
                if not fn.lower().endswith(SINGLE_EXTS):
                    continue
                full = os.path.join(dp, fn)
                if full in seen:
                    continue
                seen.add(full)
                try:
                    with open(full, "rb") as fh:
                        blob = fh.read()
                except OSError:
                    continue
                info = extract(blob)
                if "gamedata" not in info:
                    continue
                found.append({"path": full, "name": fn,
                              "size": len(blob), "mb": round(len(blob) / 1048576, 2),
                              "kind": "file", "format": info["format"],
                              "folder": info.get("folder", ""),
                              "writable": info.get("writable", False)})
    found.sort(key=lambda x: x["name"].lower())
    return found
