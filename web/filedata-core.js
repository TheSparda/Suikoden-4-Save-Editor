// FILEDATA archive parsing — pure, no DOM, no disc I/O (issues #32/#44).
//
// The ISO editor's Files tab and Editor/build_s4_subfile_index.py implement the same walk. This
// module is the browser half's rules in one testable place, so "what the tab shows" and "what the
// index script emits" cannot drift apart.
//
// Format (see Editor/Suikoden4_offsets.md, 2026-09-12):
//
//   archive +0x00 u32 magic 0x82734927 | +0x04 u32 0 | +0x08 u32 total | +0x0C u32 0
//           +0x10 16-byte rows (id, flags, offset, size); row[0] is a COUNT SENTINEL whose
//                 `id` field is the entry count, not an id
//
// The archives tile their containing file exactly, which is why walking beats scanning: each
// archive's `total`, rounded up to a sector, lands on the next archive's header.
//
// `flags` is carried through UNINTERPRETED. It is not understood (#45/#46) — labelling 2 as
// "compressed" is exactly the guess this repo's first rule forbids.
(function (root) {
  "use strict";

  const MAGIC = 0x82734927;
  const SECTOR = 2048;
  const HEADER_LEN = 0x10;
  const ROW_LEN = 16;
  const MAX_PLAUSIBLE_COUNT = 4000;   // a "count" past this is not a count

  const sectorRound = (n) => Math.ceil(n / SECTOR) * SECTOR;

  // Parse an archive header from its first 16 bytes. Returns null when it isn't one.
  function parseHeader(bytes) {
    if (!bytes || bytes.length < HEADER_LEN) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    const total = dv.getUint32(8, true);
    if (!total) return null;
    return { total, step: sectorRound(total) };
  }

  // Parse an entry table given the bytes starting at the archive's +0x10.
  // Returns { count, entries } — `entries` excludes the sentinel and any zero-size row.
  // An archive with count 0 is legitimately EMPTY (15 of BI1's are); that is not an error.
  function parseEntries(bytes) {
    if (!bytes || bytes.length < ROW_LEN) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const count = dv.getUint32(0, true);
    if (count === 0) return { count: 0, entries: [] };
    if (count > MAX_PLAUSIBLE_COUNT) return null;
    const have = Math.min(count, Math.floor(bytes.length / ROW_LEN));
    const entries = [];
    for (let i = 1; i < have; i++) {
      const o = i * ROW_LEN;
      const size = dv.getUint32(o + 12, true);
      if (size > 0) {
        entries.push({ id: dv.getUint32(o, true), flags: dv.getUint32(o + 4, true),
                       off: dv.getUint32(o + 8, true), size });
      }
    }
    return { count, entries, truncated: have < count };
  }

  // Does this run of archives tile its file? The property the walk depends on, exposed so it can
  // be asserted rather than assumed.
  function checkTiling(archives, fileSize) {
    let ok = 0, pairs = 0;
    for (let i = 1; i < archives.length; i++) {
      pairs++;
      if (sectorRound(archives[i - 1].total) === archives[i].off - archives[i - 1].off) ok++;
    }
    const last = archives[archives.length - 1];
    const end = last ? last.off + sectorRound(last.total) : 0;
    return { ok, pairs, tailBytes: fileSize == null ? null : fileSize - end };
  }

  const api = { MAGIC, SECTOR, HEADER_LEN, ROW_LEN, MAX_PLAUSIBLE_COUNT,
                sectorRound, parseHeader, parseEntries, checkTiling };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FiledataCore = api;
})(typeof self !== "undefined" ? self : globalThis);
