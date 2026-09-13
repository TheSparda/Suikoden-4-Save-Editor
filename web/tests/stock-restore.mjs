// Verify every documented stock constant against a real pristine disc (#41, #20 Half B).
//
// This is the test that makes "Restore to stock" mean restore to PRISTINE, rather than restore
// to what this repo believes stock was. Without it, a wrong `offBytes` is invisible: the editor
// would cheerfully write its own mistaken idea of stock onto a user's disc and report success.
//
// It needs a disc, which the repo does not and will not ship (CLAUDE.md rule 3). Base ISO/ is
// gitignored, so this SKIPS cleanly when no disc is present — a test that fails on a clean clone
// or in CI is a broken test. Point it at one with:
//
//     S4_ISO=/path/to/"Suikoden IV (USA).iso" npm run test:stock
//
// It also looks in the conventional spot (Base ISO/) so the maintainer needs no env var.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadIsoFields } from "./load-iso-fields.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function findIso() {
  if (process.env.S4_ISO) return fs.existsSync(process.env.S4_ISO) ? process.env.S4_ISO : null;
  const dir = path.join(REPO, "Base ISO");
  if (!fs.existsSync(dir)) return null;
  const iso = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".iso"))
    // Biggest first: a full disc image, not a stray demo or a partial download.
    .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)[0];
  return iso && iso.size > 1e9 ? path.join(dir, iso.f) : null;
}

const iso = findIso();
if (!iso) {
  console.log("Stock constants: skipped — no pristine disc (set S4_ISO, or put one in Base ISO/)");
  process.exit(0);
}

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

const FIELDS = loadIsoFields();
const fd = fs.openSync(iso, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b); };
const hex = (a) => [...a].map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

console.log(`Stock constants, against ${path.basename(iso)} (${(fs.statSync(iso).size / 1e9).toFixed(2)} GB):`);

for (const f of FIELDS) {
  const got = readAt(f.off, f.len);

  // 1. The signature must accept the pristine disc. A sig() that rejects stock would refuse to
  //    load a legitimate disc — the most user-visible way this can be wrong.
  if (f.sig) {
    (f.sig(got) ? ok : bad)(`${f.key}: sig() accepts the pristine bytes at 0x${f.off.toString(16).toUpperCase()}`);
  }

  // 2. Documented stock bytes must BE the pristine bytes. This is the one that makes restore
  //    trustworthy, and the one nothing else can check.
  if (f.offBytes) {
    const want = Uint8Array.from(f.offBytes);
    const same = want.length === got.length && want.every((b, i) => b === got[i]);
    (same ? ok : bad)(`${f.key}: documented stock bytes match the disc`
      + (same ? ` (${hex(want)})` : `\n      disc says     ${hex(got)}\n      offBytes says ${hex(want)}`));
  } else {
    ok(`${f.key}: value field, no single stock word to verify`);
  }

  // 3. A patched shape must also pass sig(), or applying the patch makes the disc unloadable.
  if (f.onBytes && f.sig) {
    (f.sig(Uint8Array.from(f.onBytes)) ? ok : bad)(`${f.key}: sig() still accepts the disc after patching`);
  }

  // 4. read() on the pristine disc must give the documented default, or the UI opens showing a
  //    value the disc doesn't hold.
  if (f.def != null) {
    const dv = new DataView(got.buffer, got.byteOffset, got.length);
    const v = f.read(dv);
    (v === f.def ? ok : bad)(`${f.key}: reads its documented default (${f.def}) on a pristine disc, got ${v}`);
  }
}

// The region gate itself: a pristine NTSC-U disc must be accepted by every signature at once,
// which is what commitIso() requires before it will load anything.
{
  const allPass = FIELDS.every((f) => !f.sig || f.sig(readAt(f.off, f.len)));
  (allPass ? ok : bad)("a pristine NTSC-U disc passes every signature — commitIso() would load it");
}
fs.closeSync(fd);

console.log(failures ? `\nFAILED (${failures})` : "\nEvery stock constant matches the pristine disc.");
process.exit(failures ? 1 : 0);
