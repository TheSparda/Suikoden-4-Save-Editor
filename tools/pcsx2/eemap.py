"""Map ISO file offsets to live EE RAM addresses (and back) — Suikoden IV.

The three code patches this editor writes live inside the boot ELF, which the PS2 loads into
main RAM as one contiguous chunk. So an offset patched on disc has a fixed counterpart in the
running game's memory, and that is what turns "did my edit land?" from a human playing for ten
minutes into a memory read.

Ported from the Suikoden III harness (#34). Two things are S4-specific and both make calibration
EASIER rather than harder:

  * The ELF program header gives the file<->vaddr delta as a starting guess, exactly as in S3.
  * S4 also has a second, independent anchor S3 does not: the save `gamedata` payload is a
    verbatim image of the state block at EE 0x532860 (proven in Suikoden4_offsets.md). So a
    known save value — potch, game time — can be located in RAM directly, with no ELF involved.

The doc constants are trusted only as starting guesses: `calibrate` re-derives the real delta by
finding an anchor of ISO bytes inside an actual RAM dump. A game that relocates its executable,
or a doc constant that drifts, shows up as a calibration failure rather than a table of
plausible-looking garbage.
"""
import os

# From the ELF program header, per Editor/Suikoden4_offsets.md: the boot ELF is at LBA 367.
ELF_FILE_BASE = 367 * 2048          # 0xB7800
ELF_VADDR_BASE = 0x100000           # first PT_LOAD vaddr
DEFAULT_DELTA = ELF_VADDR_BASE - ELF_FILE_BASE

EE_RAM_SIZE = 32 * 1024 * 1024

# S4's anchor is one of the editor's own patch sites: the stock "jal 0x2D5D70" word at the
# noBattles site. It is four bytes this repo has verified against a pristine disc
# (web/tests/stock-restore.mjs), which makes it the natural thing to search RAM for.
VERSION_CHECK_OFF = 0x10E484
VERSION_CHECK_BYTES = bytes((0x5C, 0x57, 0x0B, 0x0C))

# The editor's patch sites, so a harness run can name what it read.
# (file_offset, length, description)
TABLES = {
    "encounterRate":  (0x10E43C, 4, "encounter threshold (addiu a0, zero, imm)"),
    "championAlways": (0x10E610, 4, "Champion's Rune branch (beqz s4)"),
    "noBattles":      (0x10E484, 4, "random-battle call (jal)"),
}

# The save state block: `gamedata` is a verbatim image of EE 0x532860, so save_offset =
# ram_addr - STATE_BLOCK. This is S4's second anchor and needs no ELF calibration at all.
STATE_BLOCK = 0x532860
STATE_BLOCK_LEN = 0xE260


class CalibrationError(RuntimeError):
    pass


class EeMap:
    """A file-offset <-> EE-address mapping with a known (or calibrated) delta."""

    def __init__(self, delta=DEFAULT_DELTA, calibrated=False):
        self.delta = delta
        self.calibrated = calibrated

    def to_ee(self, file_off):
        # Two separate guards. The lower one is exact: nothing before the ELF's first
        # mapped byte is in RAM at all, and offsets like 0 would otherwise map to a
        # perfectly plausible-looking address. The upper one is only the RAM bound,
        # because the ELF's length on disc is not recorded anywhere we trust — an
        # offset past the executable but still inside 32 MB will map without complaint.
        if file_off < ELF_FILE_BASE:
            raise ValueError(
                "file offset %d is before the ELF's first mapped byte (0x%X) — it is "
                "not loaded into RAM" % (file_off, ELF_FILE_BASE)
            )
        addr = file_off + self.delta
        if not 0 <= addr < EE_RAM_SIZE:
            raise ValueError(
                "file offset %d maps to 0x%08X, outside EE RAM — it is probably not "
                "inside the boot ELF" % (file_off, addr)
            )
        return addr

    def to_file(self, ee_addr):
        off = ee_addr - self.delta
        if off < ELF_FILE_BASE:
            raise ValueError(
                "EE address 0x%08X is below the ELF's load address — it is RAM the "
                "game allocated, not something with a place on the disc" % ee_addr
            )
        return off

    def site_ee(self, name):
        """EE address of a named patch site."""
        off, _len, _desc = TABLES[name]
        return self.to_ee(off)

    @staticmethod
    def save_offset(ee_addr):
        """Save-payload offset for an EE address inside the state block, or None.

        This is S4's second mapping and it needs no calibration: the save `gamedata` payload is a
        verbatim image of EE 0x532860, so the relationship is fixed by the game, not by where the
        loader happened to place the executable.
        """
        if STATE_BLOCK <= ee_addr < STATE_BLOCK + STATE_BLOCK_LEN:
            return ee_addr - STATE_BLOCK
        return None

    @staticmethod
    def state_ee(save_offset):
        """EE address of a save-payload offset — the inverse of save_offset()."""
        if not 0 <= save_offset < STATE_BLOCK_LEN:
            raise ValueError("save offset 0x%X is outside the %d-byte state block"
                             % (save_offset, STATE_BLOCK_LEN))
        return STATE_BLOCK + save_offset

    def __repr__(self):
        return "EeMap(delta=0x%X%s)" % (
            self.delta,
            "" if self.calibrated else ", uncalibrated",
        )


def read_anchor(iso_path, file_off=VERSION_CHECK_OFF, length=64):
    """Pull `length` bytes of the ISO around a known offset, to search RAM for.

    Reads from `file_off` backwards by a third so the anchor straddles the offset; a
    window that starts exactly at a table boundary is more likely to be all-zero
    padding, which matches everywhere and calibrates to nonsense.
    """
    start = max(0, file_off - length // 3)
    with open(iso_path, "rb") as f:
        f.seek(start)
        data = f.read(length)
    if len(data) < length:
        raise CalibrationError("could not read %d bytes at %d from %s" % (length, start, iso_path))
    return start, data


def calibrate_from_dump(ee_dump, anchor_off, anchor_bytes):
    """Find `anchor_bytes` in an EE RAM image and derive the file->EE delta.

    `ee_dump` is the raw 32 MB eeMemory image (see savestate.extract_ee_ram).
    Raises if the anchor is missing or ambiguous — an anchor that appears twice means
    the game keeps a second copy and we cannot tell which one the code reads.
    """
    if len(anchor_bytes) < 8:
        raise CalibrationError("anchor too short to be unique")
    hits = []
    pos = ee_dump.find(anchor_bytes)
    while pos != -1:
        hits.append(pos)
        if len(hits) > 8:
            break
        pos = ee_dump.find(anchor_bytes, pos + 1)
    if not hits:
        raise CalibrationError(
            "anchor bytes not found in the RAM dump — either the disc is not this "
            "build, or the dump was taken before the ELF finished loading"
        )
    if len(hits) > 1:
        raise CalibrationError(
            "anchor found at %d places (%s) — pick a longer/more distinctive anchor"
            % (len(hits), ", ".join("0x%08X" % h for h in hits))
        )
    return EeMap(delta=hits[0] - anchor_off, calibrated=True)


def calibrate(iso_path, ee_dump, file_off=VERSION_CHECK_OFF, length=64):
    """Convenience: take the anchor from the ISO and calibrate against a RAM dump."""
    start, data = read_anchor(iso_path, file_off, length)
    return calibrate_from_dump(ee_dump, start, data)


def verify_with_pine(client, eemap, iso_path):
    """Cheap online check that `eemap` is right: the four version-check bytes must read
    back identically from the mapped EE address. Returns (ok, expected, got)."""
    with open(iso_path, "rb") as f:
        f.seek(VERSION_CHECK_OFF)
        expected = f.read(4)
    got = client.read_bytes(eemap.to_ee(VERSION_CHECK_OFF), 4)
    return got == expected, expected, got


def describe(off):
    """Name what lives at a file offset, for harness output."""
    for name, (base, length, desc) in TABLES.items():
        if base <= off < base + length:
            return "%s+%d (%s)" % (name, off - base, desc)
    return "0x%X (unmapped)" % off




def default_iso_candidates():
    """Where the repo's own scripts expect a disc to live, for CLI convenience."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return [
        os.environ.get("S4_ISO", ""),
        os.path.join(root, "ISO", "Suikoden III (USA).iso"),
    ]
