// FILEDATA archive parsing (#32/#44) — synthetic first, then the real disc.
//
// The synthetic half pins the rules. The real-disc half is what actually matters: it asserts the
// browser's parser reproduces the numbers Editor/build_s4_subfile_index.py gets, so the Files tab
// and the index script can't drift apart. It skips without a disc.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const F = createRequire(import.meta.url)(path.join(HERE, "..", "filedata-core.js"));

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const is = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m)
  : bad(`${m}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`));

const u32 = (arr, o, v) => { new DataView(arr.buffer).setUint32(o, v, true); };

console.log("filedata-core: header");
{
  const h = new Uint8Array(16);
  u32(h, 0, F.MAGIC); u32(h, 8, 5000);
  is(F.parseHeader(h), { total: 5000, step: 6144 }, "a valid header parses and rounds to a sector");
  is(F.sectorRound(2048), 2048, "an exact sector doesn't round up");
  is(F.sectorRound(2049), 4096, "one byte over rounds to the next sector");

  const wrong = new Uint8Array(16); u32(wrong, 0, 0xDEADBEEF); u32(wrong, 8, 100);
  is(F.parseHeader(wrong), null, "a wrong magic is not a header");
  const zero = new Uint8Array(16); u32(zero, 0, F.MAGIC); u32(zero, 8, 0);
  is(F.parseHeader(zero), null, "total 0 ends the walk rather than looping forever");
  is(F.parseHeader(new Uint8Array(4)), null, "a short read is not a header");
  is(F.parseHeader(null), null, "no bytes at all is handled");
}

console.log("filedata-core: entry table");
{
  const mk = (rows) => {
    const a = new Uint8Array((rows.length + 1) * 16);
    u32(a, 0, rows.length + 1);                       // sentinel carries the COUNT
    rows.forEach((r, i) => {
      const o = (i + 1) * 16;
      u32(a, o, r.id); u32(a, o + 4, r.flags); u32(a, o + 8, r.off); u32(a, o + 12, r.size);
    });
    return a;
  };
  const t = mk([{ id: 0xE94F, flags: 0, off: 0x3e0, size: 144 },
                { id: 0x50EC, flags: 2, off: 0x4d0, size: 32720 }]);
  const p = F.parseEntries(t);
  is(p.count, 3, "the sentinel's id field is the entry count");
  is(p.entries.length, 2, "the sentinel itself is not an entry");
  is(p.entries[0], { id: 0xE94F, flags: 0, off: 0x3e0, size: 144 }, "fields decode in order");
  is(p.entries[1].flags, 2, "flags is carried through uninterpreted");

  // 15 of BI1's archives are like this. It is not an error.
  const empty = new Uint8Array(16);
  is(F.parseEntries(empty), { count: 0, entries: [] }, "count 0 is a legitimately EMPTY archive");

  const zeroSize = mk([{ id: 1, flags: 0, off: 0x10, size: 0 }]);
  is(F.parseEntries(zeroSize).entries, [], "zero-size rows are skipped");

  const insane = new Uint8Array(16); u32(insane, 0, 999999);
  is(F.parseEntries(insane), null, "a count past the plausible bound is refused, not trusted");
  is(F.parseEntries(new Uint8Array(4)), null, "a short read is refused");

  // A truncated read must report itself rather than silently returning fewer entries.
  const big = mk([{ id: 1, flags: 0, off: 0, size: 8 }, { id: 2, flags: 0, off: 8, size: 8 }]);
  const cut = F.parseEntries(big.slice(0, 32));
  is(cut.truncated, true, "a truncated table says so");
}

console.log("filedata-core: tiling");
{
  const t = F.checkTiling([{ off: 0, total: 2048 }, { off: 2048, total: 4096 }, { off: 6144, total: 1000 }], 8192);
  is([t.ok, t.pairs, t.tailBytes], [2, 2, 0], "a tiling run reports itself and its tail");
  const gap = F.checkTiling([{ off: 0, total: 2048 }, { off: 8192, total: 2048 }], 10240);
  is([gap.ok, gap.pairs], [0, 1], "a gap is reported rather than ignored");
}

// --- against the real disc ---------------------------------------------------
const findIso = () => {
  if (process.env.S4_ISO) return fs.existsSync(process.env.S4_ISO) ? process.env.S4_ISO : null;
  const d = path.join(REPO, "Base ISO");
  if (!fs.existsSync(d)) return null;
  const f = fs.readdirSync(d).filter((x) => x.toLowerCase().endsWith(".iso"))
    .map((x) => ({ x, s: fs.statSync(path.join(d, x)).size })).sort((a, b) => b.s - a.s)[0];
  return f && f.s > 1e9 ? path.join(d, f.x) : null;
};
const iso = findIso();
if (!iso) {
  console.log("\nReal disc: skipped — no pristine disc (set S4_ISO)");
} else {
  console.log("\nfiledata-core: against the real disc");
  const fd = fs.openSync(iso, "r");
  const read = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b); };
  // The numbers Editor/build_s4_subfile_index.py reports. If the browser's parser disagrees with
  // the index script, the Files tab is showing something the index doesn't.
  const EXPECT = { BI1: { lba: 1510597, size: 1074509824, archives: 1066, entries: 57771, tail: 0 },
                   BI2: { lba: 2035260, size: 60162048, archives: 259, entries: 4537, tail: 2048 } };
  for (const [name, e] of Object.entries(EXPECT)) {
    const base = e.lba * 2048;
    const archives = [];
    let cur = 0, entries = 0;
    while (cur < e.size - 16) {
      const h = F.parseHeader(read(base + cur, F.HEADER_LEN));
      if (!h) break;
      archives.push({ off: cur, total: h.total });
      const head = F.parseEntries(read(base + cur + 0x10, F.ROW_LEN));
      if (head && head.count) {
        const full = F.parseEntries(read(base + cur + 0x10, F.ROW_LEN * head.count));
        if (full) entries += full.entries.length;
      }
      cur += h.step;
    }
    const t = F.checkTiling(archives, e.size);
    is(archives.length, e.archives, `${name}: archive count matches the index script`);
    is(entries, e.entries, `${name}: entry count matches the index script`);
    is([t.ok, t.pairs], [e.archives - 1, e.archives - 1], `${name}: every consecutive pair tiles`);
    is(t.tailBytes, e.tail, `${name}: tail is ${e.tail} bytes`);
  }
  fs.closeSync(fd);
}

console.log(failures ? `\nFAILED (${failures})` : "\nfiledata-core OK.");
process.exit(failures ? 1 : 0);
