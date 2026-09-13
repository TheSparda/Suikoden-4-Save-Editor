#!/usr/bin/env python3
# Save-engine round-trip test for the web editor's Pyodide path.
#
# The web Save Editor runs Editor/s4save.py (+ s4files.py, s4lzari.py) unchanged in the
# browser (read_all_s4_saves / write_save_edits). The repo ships NO game data, so this builds
# a SYNTHETIC 57952-byte S4 "gamedata" payload — wrapped in the simplest single-file container
# the engine accepts (a bare payload it sniffs as "psu") — with planted values, then drives the
# real engine: decode -> edit -> write -> re-decode, asserting the values persist and the
# gamedata checksum (CRC32 + reversed MD5 over the body) stays valid. It also unit-checks the
# memory-card ECC helper and the "unrecognized file" path.
#
# Imports s4save directly (not a JS reimplementation) so offsets + checksum can never drift
# from the engine under test. Run via `node save-roundtrip.mjs` (skips cleanly if python3 is
# absent) or directly: `python3 save_roundtrip.py`.
import os
import sys
import struct
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "Editor"))
import s4save as SV  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    print("  %s %s%s" % ("✓" if cond else "✗", name, (" — " + extra) if extra else ""))
    if not cond:
        fails += 1


def build_payload():
    """A valid bare S4 gamedata payload with a few planted, verifiable values."""
    b = bytearray(SV.GD_SIZE)
    struct.pack_into("<I", b, SV.OFF_VERSION, 6)            # version = 6
    struct.pack_into("<H", b, SV.OFF_SLOT, 0)
    struct.pack_into("<I", b, SV.POTCH_OFF, 12345)          # potch
    struct.pack_into("<I", b, SV.GAMETIME_OFF, 3600)        # game time = 1h
    base = SV.CHAR_BASE                                      # roster index 0
    struct.pack_into("<H", b, base + SV.OFF_MAXHP, 181)     # max HP
    struct.pack_into("<H", b, base + SV.OFF_STATS, 58)      # STR = stats[0]
    b[base + SV.OFF_RUNES[0]] = 3                            # rune slot 0
    prog = SV.PROG_BASE                                      # roster 0 progression
    struct.pack_into("<I", b, prog + SV.OFF_PROG_EXP, 500)  # EXP
    b[prog + SV.OFF_PROG_WLVL] = 4                           # weapon level
    b[SV.RECRUIT_BASE] = 10                                  # roster 0 = "Recruited"
    nm = "TESTHERO".encode("latin1")                        # hero name field
    off, n, _ = next((o, nn, lbl) for k, o, nn, lbl in SV.NAME_FIELDS if k == "hero")
    b[off:off + len(nm)] = nm
    return SV.recompute_checksums(bytes(b))


def build_container(payload):
    """Wrap the payload so the engine sniffs it as a writable single-file save.
    A 64-byte header carrying the region folder name + the self-validating payload is
    detected as 'psu' by s4files._find_payload / _folder_of."""
    header = b"BASLUS-20979s400".ljust(64, b"\x00")
    return header + payload


# --- decode-time invariants (#15) ------------------------------------------------
# Built from the engine's own constants, never from a real save (CLAUDE.md rule 3). Each case
# plants exactly one defect and asserts exactly which finding fires — a check that can't be shown
# to fire on a broken save is not a check.
#
# Every mutated payload is re-checksummed. Otherwise the checksum finding fires on every case and
# masks whether the *intended* defect was detected, which is the difference between a test and a
# test-shaped thing.
def _findings(payload, meta=None):
    payload = SV.recompute_checksums(bytes(payload))
    return {f["id"] for f in SV.check_invariants(payload, SV.decode_save(payload), meta or {})}


def _check_invariants():
    base = build_payload()
    clean = _findings(base)
    check("a clean synthetic save produces no errors",
          not [f for f in SV.check_invariants(base, SV.decode_save(base), {}) if f["sev"] == "error"],
          ", ".join(sorted(clean)) or "none")

    # Recruitment enum purity. Roster 0 is the one build_payload() populates, so it is the one
    # that survives the hasData filter in decode_save.
    b = bytearray(base)
    b[SV.RECRUIT_BASE] = 7                                   # not one of the five
    check("an out-of-enum recruitment byte is an error", "recruit-enum" in _findings(b))

    # Engine caps — the values _clamp() would silently reduce on write.
    b = bytearray(base)
    struct.pack_into("<I", b, SV.POTCH_OFF, SV.POTCH_MAX + 1)
    check("potch over the cap is flagged", "potch-cap" in _findings(b))

    b = bytearray(base)
    struct.pack_into("<I", b, SV.PROG_BASE + SV.OFF_PROG_EXP, SV.EXP_MAX + 1)
    check("EXP over the cap is flagged", "exp-cap" in _findings(b))

    # The save's own independent witness: the PS2 browser title.
    d = SV.decode_save(base)
    hero = next((c for c in d["characters"] if c["rosterIndex"] == 0), None)
    if hero:
        lv = min(99, (hero["exp"] or 0) // 1000 + 1)
        check("a title agreeing with the decoded level says nothing",
              "title-level" not in _findings(base, {"level": lv}))
        check("a title disagreeing with the decoded level is reported",
              "title-level" in _findings(base, {"level": lv + 20}))
        check("a playtime far from the decoded game time is reported",
              "title-playtime" in _findings(base, {"playtime": "99:00"}))
        check("a playtime matching the decoded game time says nothing",
              "title-playtime" not in _findings(base, {"playtime": "1:00"}))

    # An unknown id is only meaningful against a table. With no table the check must SKIP rather
    # than fail every id in the save (CLAUDE.md rule 1).
    b = bytearray(base)
    b[SV.CHAR_BASE + SV.OFF_RUNES[0]] = 0xFE                 # not a known rune id
    check("an unknown rune id is reported", "rune-ids" in _findings(b))
    real = SV._ref_ids
    try:
        SV._ref_ids = lambda name: None
        check("no reference table means the id checks don't run, rather than failing everything",
              "rune-ids" not in _findings(b) and "item-ids" not in _findings(b))
    finally:
        SV._ref_ids = real

    # A damaged body is the one case where the checksum finding is the point.
    b = bytearray(base)
    b[SV.BODY_OFF + 64] ^= 0xFF
    check("a body that disagrees with its stored checksum is an error",
          "checksum" in {f["id"] for f in SV.check_invariants(bytes(b), SV.decode_save(bytes(b)), {})})

    # The #48 signature. Needs enough populated records to be meaningful, so the fixture is
    # widened here rather than asserted against a roster of one.
    b = bytearray(base)
    planted = 0
    for i in range(12):
        off = SV.CHAR_BASE + i * SV.CHAR_STRIDE
        if off + SV.CHAR_STRIDE > len(b):
            break
        struct.pack_into("<8H", b, off + SV.OFF_STATS, 50, 77, 77, 60, 61, 62, 63, 64)
        struct.pack_into("<H", b, off + SV.OFF_MAXHP, 200 + i)
        b[SV.RECRUIT_BASE + i * SV.RECRUIT_STRIDE] = 10
        planted += 1
    check("SKL == MAG across the roster is reported as misalignment",
          planted >= 8 and "stat-alias" in _findings(b), "%d records planted" % planted)

    # ...and the same fixture with distinct stats must NOT trip it, or the check is just noise.
    b2 = bytearray(b)
    for i in range(planted):
        off = SV.CHAR_BASE + i * SV.CHAR_STRIDE
        struct.pack_into("<8H", b2, off + SV.OFF_STATS, 50, 77, 88, 60, 61, 62, 63, 64)
    check("distinct SKL and MAG does not trip the misalignment check",
          "stat-alias" not in _findings(b2))


def main():
    print("Save-engine round-trip (synthetic S4 gamedata):")
    tmp = tempfile.mkdtemp(prefix="s4save-test-")
    path = os.path.join(tmp, "save.psu")
    with open(path, "wb") as f:
        f.write(build_container(build_payload()))

    # --- decode ---
    saves = SV.read_all_s4_saves(path)
    check("decodes exactly one save", isinstance(saves, list) and len(saves) == 1, str(type(saves)))
    s = saves[0]
    c0 = next(c for c in s["characters"] if c["rosterIndex"] == 0)
    check("potch decoded", s["potch"] == 12345, str(s["potch"]))
    check("game time decoded", s["gameTimeSec"] == 3600, str(s["gameTimeSec"]))
    check("maxHP decoded", c0["maxHP"] == 181, str(c0["maxHP"]))
    check("STR stat decoded", c0["stats"]["STR"] == 58, str(c0["stats"]["STR"]))
    check("rune slot 0 decoded", c0["runes"][0] == 3, str(c0["runes"][0]))
    check("weapon level decoded", c0["weaponLvl"] == 4, str(c0["weaponLvl"]))
    check("recruitment decoded", c0["recruited"] == 10, str(c0["recruited"]))
    check("hero name decoded", any(n["value"] == "TESTHERO" for n in s.get("names", [])))
    check("checksum reported valid", s["checksumValid"] is True)
    check("container is a writable single-file", s["writable"] is True and s["container"] == "psu")

    # --- edit (mirrors the web app's payload shape) ---
    res = SV.write_save_edits(
        path, s["folder"],
        char_edits={0: {"maxHP": 9999, "exp": 5000, "weaponLvl": 9, "recruited": 15,
                        "stats": {"STR": 250}, "runes": {0: 7}, "equip": {"head": 16}}},
        name_edits={"hero": "Zephon", "ship": "Basel"},
        save_edits={"potch": 999999, "gameTime": 7200, "worldMapFull": 1},
        make_backup=False,
    )
    check("write reports ok", res.get("ok") is True, str(res))
    check("write changed multiple fields", res.get("changed", 0) >= 8, "changed=%s" % res.get("changed"))

    # --- re-decode the WRITTEN file (proves it stays a valid, decodable save) ---
    saves2 = SV.read_all_s4_saves(path)
    check("re-decodes after write", isinstance(saves2, list) and len(saves2) == 1)
    s2 = saves2[0]
    c2 = next(c for c in s2["characters"] if c["rosterIndex"] == 0)
    check("potch persisted", s2["potch"] == 999999, str(s2["potch"]))
    check("game time persisted", s2["gameTimeSec"] == 7200, str(s2["gameTimeSec"]))
    check("maxHP persisted", c2["maxHP"] == 9999)
    check("EXP persisted", c2["exp"] == 5000)
    check("weapon level persisted", c2["weaponLvl"] == 9)
    check("STR persisted", c2["stats"]["STR"] == 250)
    check("rune persisted", c2["runes"][0] == 7)
    check("equipment persisted", c2["equip"]["head"] == 16, str(c2["equip"]["head"]))
    check("recruitment persisted", c2["recruited"] == 15)
    check("hero name persisted", any(n["value"] == "Zephon" for n in s2.get("names", [])))
    check("world map fully explored", s2["worldMapPct"] >= 99.0, str(s2["worldMapPct"]))
    check("checksum still valid after write", s2["checksumValid"] is True)

    # --- rejection path (what the web loader turns into a friendly message) ---
    bad = os.path.join(tmp, "junk.bin")
    with open(bad, "wb") as f:
        f.write(bytes(4096))
    rej = SV.read_all_s4_saves(bad)
    check("unrecognized file is rejected", isinstance(rej, dict) and "error" in rej, str(rej)[:60])

    # --- memory-card ECC helper (used when writing .ps2 cards) ---
    print("Memory-card ECC helper:")
    zero = SV.ecc_page(bytes(512))
    check("ecc_page returns 16 bytes", len(zero) == 16)
    check("ecc_page of a zero page is the known constant",
          zero == (bytes([0x77, 0x7F, 0x7F]) * 4) + b"\x00\x00\x00\x00", zero.hex())
    flipped = bytearray(512)
    flipped[0] = 0x01
    check("ecc changes when a byte flips (detects corruption)", SV.ecc_page(bytes(flipped)) != zero)

    print("\nDecode-time invariants (#15):")
    _check_invariants()

    print("\n%s" % ("All save round-trip checks passed." if fails == 0 else "%d check(s) FAILED." % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
