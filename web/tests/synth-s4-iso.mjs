// Build a synthetic Suikoden IV "ISO" for headless tests (#9).
//
// Ships no game data (CLAUDE.md rule 3), and cannot drift from the editor: every planted byte
// comes from the real FIELDS table's own write() at the field's stock value, loaded out of
// web/iso.js. A fixture assembled from constants copied into the test tree would prove the copy.
//
// Only the editable window is materialised. The real disc is 4.36 GB; max(off+len) across the
// fields is about 1.1 MB, and commitIso() refuses anything shorter than that but doesn't care
// how much longer it is — so ~1.1 MB is a complete fixture, not a truncated one.
//
// Everything outside the planted words is zero. That is deliberate: a field whose sig() would
// accept zeros is a field whose signature isn't discriminating, and the suite should be able to
// notice that rather than have it masked by plausible-looking filler.
import fs from "fs";
import { loadIsoFields } from "./load-iso-fields.mjs";

export const FIELDS = loadIsoFields();

// commitIso()'s own bound, computed the same way it computes it.
export const MAX_OFF = FIELDS.reduce((a, f) => Math.max(a, f.off + f.len), 0);
export const SIZE = MAX_OFF + 2048;      // a little tail, so "file too short" is never the reason

// Stock value per field type: a bool is off, a scalar sits at its documented default.
const stockValue = (f) => (f.type === "bool" ? 0 : (f.def != null ? f.def : 0));

export function buildSynthIso({ overrides = {} } = {}) {
  const buf = new Uint8Array(SIZE);
  for (const f of FIELDS) {
    const dv = new DataView(buf.buffer, f.off, f.len);
    const v = f.key in overrides ? overrides[f.key] : stockValue(f);
    f.write(dv, v);                       // the editor's own encoder — never a literal here
  }
  return buf;
}

// Self-check: a fixture the editor would reject is worse than no fixture, because the failure
// surfaces as "not Suikoden IV" three layers away from the cause.
export function verifySynthIso(buf) {
  const problems = [];
  for (const f of FIELDS) {
    const bytes = buf.slice(f.off, f.off + f.len);
    if (f.sig && !f.sig(bytes)) problems.push(`${f.key}: sig() rejects the bytes we planted`);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const readBack = f.read(dv), want = stockValue(f);
    if (readBack !== want) problems.push(`${f.key}: read back ${readBack}, planted ${want}`);
  }
  return problems;
}

// CLI: `node synth-s4-iso.mjs out.iso` — handy for poking at the fixture by hand.
if (process.argv[1] && process.argv[1].endsWith("synth-s4-iso.mjs")) {
  const out = process.argv[2] || "synth-s4.iso";
  const buf = buildSynthIso();
  const problems = verifySynthIso(buf);
  if (problems.length) { console.error("fixture is invalid:\n  " + problems.join("\n  ")); process.exit(1); }
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} — ${buf.length} bytes, ${FIELDS.length} fields planted from iso.js's own write()`);
}
