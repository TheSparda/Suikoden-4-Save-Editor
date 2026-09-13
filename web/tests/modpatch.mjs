// .s4mod recipes and .xdelta round-trips (#19) — no browser.
//
// The recipe format and the import rules live in iso.js, which is a browser IIFE; what IS
// testable headlessly is the property the whole feature rests on: a patch built from staged
// edits, decoded back, reproduces exactly those edits and nothing else. That is checked here
// against the real Vcdiff module and the real FIELDS table, with a synthetic disc.
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { buildSynthIso, FIELDS } from "./synth-s4-iso.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const Vcdiff = createRequire(import.meta.url)(path.join(WEB, "vcdiff.js"));

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const is = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m)
  : bad(`${m}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`));

console.log("Mod patches (#19):");

const disc = buildSynthIso();

// Stage the same edits the editor would: each field's own write() at a non-stock value.
const staged = [
  { key: "encounterRate", value: 250 },
  { key: "championAlways", value: 1 },
].map(({ key, value }) => {
  const f = FIELDS.find((x) => x.key === key);
  const b = new Uint8Array(f.len);
  b.set(disc.slice(f.off, f.off + f.len));
  f.write(new DataView(b.buffer), value);
  return { off: f.off, data: b, key };
});

// --- .xdelta: build from edits, decode, confirm it reproduces the patched disc ---
{
  const patch = Vcdiff.buildXdelta(disc.length, staged.map((e) => ({ off: e.off, data: e.data })));
  ok(`a patch for a ${(disc.length / 1e6).toFixed(1)} MB disc is ${patch.length} bytes`);
  is([patch[0], patch[1], patch[2], patch[3]], [0xd6, 0xc3, 0xc4, 0x00], "it carries the VCDIFF magic");

  const want = disc.slice();
  for (const e of staged) want.set(e.data, e.off);
  const got = Vcdiff.decode(disc, patch);
  is(got.length, want.length, "decoding reproduces a file of the right size");
  let firstDiff = -1;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) { firstDiff = i; break; }
  is(firstDiff, -1, "decoding reproduces the patched disc byte for byte");

  // The property the ISO editor actually relies on: plan() finds the changed spans without ever
  // being shown the source file.
  const spans = [];
  Vcdiff.eachWindow(patch, (w) => { for (const [a, b] of w.plan()) spans.push([w.targetStart + a, w.targetStart + b]); });
  const covered = staged.every((e) => spans.some(([a, b]) => a <= e.off && b >= e.off + e.data.length));
  (covered ? ok : bad)(`plan() locates every edit without the source file (${spans.length} span(s))`);
  const spanBytes = spans.reduce((n, [a, b]) => n + (b - a), 0);
  (spanBytes < 4096 ? ok : bad)(`…and narrows a ${(disc.length / 1e6).toFixed(1)} MB disc to ${spanBytes} bytes`);
}

// --- an unmodified disc produces a patch with nothing to apply ---
{
  const patch = Vcdiff.buildXdelta(disc.length, []);
  const got = Vcdiff.decode(disc, patch);
  let same = got.length === disc.length;
  for (let i = 0; same && i < disc.length; i++) if (got[i] !== disc[i]) same = false;
  (same ? ok : bad)("a patch with no edits round-trips the disc unchanged");
  const spans = [];
  Vcdiff.eachWindow(patch, (w) => { for (const s of w.plan()) spans.push(s); });
  is(spans.length, 0, "…and plan() reports no changed spans");
}

// --- refusals ---
{
  const tryIt = (bytes, what) => {
    try { Vcdiff.eachWindow(bytes, () => {}); bad(`${what} was not refused`); }
    catch (e) { ok(`${what} is refused — ${e.message.split(".")[0]}`); }
  };
  tryIt(new Uint8Array([1, 2, 3, 4, 5]), "a file with the wrong magic");
  tryIt(new Uint8Array([0xd6, 0xc3, 0xc4, 0x09, 0x00]), "an unknown VCDIFF version");
  // Secondary compression is xdelta3's DEFAULT, so this is the message users will actually hit.
  const lzma = new Uint8Array([0xd6, 0xc3, 0xc4, 0x00, 0x01]);
  try { Vcdiff.eachWindow(lzma, () => {}); bad("an LZMA-compressed patch was not refused"); }
  catch (e) {
    (/-S none/.test(e.message) ? ok : bad)("an LZMA patch names the exact fix (-S none) rather than crashing");
  }
}

console.log(failures ? `\nFAILED (${failures})` : "\nMod patch checks passed.");
process.exit(failures ? 1 : 0);
