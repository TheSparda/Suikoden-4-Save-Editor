// Fast, browser-free checks for the web editor — safe to run in CI and on session start.
// Verifies: the client JS parses; the reference tables have their expected sizes; the engine's
// key layout constants are self-consistent; and the app shell + PWA are wired (script tag,
// both mode tabs, manifest share_target, service-worker share handler + precache).
// Exits non-zero on any failure so CI/hooks catch drift before it ships.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..");
const ED = path.join(REPO, "Editor");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

// 1) JS syntax
console.log("JS syntax:");
for (const f of ["app.js", "sw.js"]) {
  try { execFileSync(process.execPath, ["--check", path.join(WEB, f)]); ok(f); }
  catch (e) { bad(`${f} — ${String(e.stderr || e).split("\n")[0]}`); }
}

// 2) reference tables (the same JSON the app fetches into Pyodide)
console.log("Reference tables:");
const items = JSON.parse(fs.readFileSync(path.join(ED, "s4_item_names.json"), "utf8"));
const runes = JSON.parse(fs.readFileSync(path.join(ED, "s4_rune_names.json"), "utf8"));
const chars = JSON.parse(fs.readFileSync(path.join(ED, "s4_char_offsets.json"), "utf8"));
JSON.parse(fs.readFileSync(path.join(ED, "s4_unites.json"), "utf8"));   // parse-only
(Object.keys(items).length >= 500 ? ok : bad)(`items parsed: ${Object.keys(items).length}`);
(Object.keys(runes).length >= 40 ? ok : bad)(`runes parsed: ${Object.keys(runes).length}`);
(Object.keys(chars).length >= 100 ? ok : bad)(`characters parsed: ${Object.keys(chars).length}`);
(("0000" in items && items["0000"].toLowerCase() === "nothing") ? ok : bad)('item id 0 = "Nothing" (empty-slot sentinel)');

// 3) engine layout constants are self-consistent (static drift check, no Python needed)
console.log("Engine layout:");
const src = fs.readFileSync(path.join(ED, "s4save.py"), "utf8");
const parseNum = (t) => { t = t.trim().replace(/_/g, ""); return /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10); };
// Reads a module constant, handling both `NAME = val` and tuple `A, NAME = x, val` forms.
const konst = (name) => {
  const re = new RegExp(`^([\\w,\\s]*\\b${name}\\b[\\w,\\s]*)=\\s*([^\\n#]+)`, "m");
  const m = re.exec(src);
  if (!m) return null;
  const names = m[1].split(",").map((x) => x.trim());
  const vals = m[2].split(",").map((x) => x.trim());
  const i = names.indexOf(name);
  const v = i >= 0 && i < vals.length ? parseNum(vals[i]) : NaN;
  return Number.isNaN(v) ? null : v;
};
const GD = konst("GD_SIZE"), BOFF = konst("BODY_OFF"), BLEN = konst("BODY_LEN");
const CBASE = konst("CHAR_BASE"), CSTR = konst("CHAR_STRIDE");
const POTCH = konst("POTCH_OFF"), WMOFF = konst("WORLDMAP_OFF"), WMW = konst("WORLDMAP_WORDS");
(GD === 57952 ? ok : bad)(`GD_SIZE = ${GD}`);
(BOFF != null && BLEN != null && BOFF + BLEN <= GD ? ok : bad)(`body [${BOFF}..${BOFF + BLEN}) fits in ${GD}`);
(CBASE != null && CSTR != null && CBASE + 113 * CSTR <= GD ? ok : bad)(`113 character records fit (end ${CBASE + 113 * CSTR})`);
(POTCH != null && POTCH + 4 <= GD ? ok : bad)(`potch u32 in range (${POTCH})`);
(WMOFF != null && WMW != null && WMOFF + 4 * WMW <= GD ? ok : bad)(`world-map flags fit (end ${WMOFF + 4 * WMW})`);

// 4) app shell + PWA wiring
console.log("App shell / PWA:");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
(/src=["']app\.js["']/.test(html) ? ok : bad)("index.html loads app.js");
(/data-mode="save"/.test(html) && /data-mode="ref"/.test(html) ? ok : bad)("both mode tabs present");
(/viewport-fit=cover/.test(html) ? ok : bad)("viewport-fit=cover (notch-safe)");
const man = JSON.parse(fs.readFileSync(path.join(WEB, "manifest.webmanifest"), "utf8"));
(man.share_target && man.share_target.action ? ok : bad)("manifest declares a share_target");
(man.display === "standalone" && man.icons && man.icons.length >= 3 ? ok : bad)("manifest: standalone + 3 icons");
const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
(/app\.js/.test(sw) ? ok : bad)("service worker precaches app.js");
(/share-target/.test(sw) && /SHARE_CACHE/.test(sw) ? ok : bad)("service worker handles the share-target POST");

// 5) the app.js glue calls the real engine functions (not a JS reimplementation)
console.log("Engine reuse:");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
(/read_all_s4_saves/.test(app) && /write_save_edits/.test(app) ? ok : bad)("app.js drives read_all_s4_saves + write_save_edits");
(/make_backup=False/.test(app) ? ok : bad)("write passes make_backup=False (never litters MEMFS)");

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
