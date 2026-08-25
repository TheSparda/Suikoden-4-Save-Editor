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
for (const f of ["app.js", "iso.js", "sw.js"]) {
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

// 6) reference-data enrichment: affinities (B13) — data valid + covers the playable cast
console.log("Affinity reference (B13):");
const aff = JSON.parse(fs.readFileSync(path.join(ED, "s4_affinities.json"), "utf8"));
const affEntries = Object.entries(aff).filter(([k]) => !k.startsWith("_"));
const affBad = affEntries.filter(([, v]) => !Array.isArray(v) || v.length !== 5 || v.some((x) => x < 1 || x > 4));
(affEntries.length >= 40 ? ok : bad)(`affinity entries: ${affEntries.length}`);
(affBad.length === 0 ? ok : bad)("every affinity is [5] with values 1–4" + (affBad.length ? " (bad: " + affBad.map((x) => x[0]).join(", ") + ")" : ""));
// coverage against the roster, honouring the one alias in app.js
const roster = new Set(Object.values(chars));
const ALIAS = { Frederica: "Fredrica" };   // must match AFF_ALIAS in app.js
const resolvable = [...roster].filter((n) => aff[n] || aff[ALIAS[n]]).length;
(resolvable >= 40 ? ok : bad)(`roster characters with an affinity note: ${resolvable}`);
(/AFF_ALIAS\s*=\s*{\s*"Frederica"\s*:\s*"Fredrica"/.test(app) ? ok : bad)("app.js carries the Frederica→Fredrica alias");
(/s4_affinities\.json/.test(app) ? ok : bad)("app.js fetches s4_affinities.json (defensively)");

// 7) v2 depth features wired: presets (B18) + PWA force-refresh/version check (B17)
console.log("Depth features (B17/B18):");
(/applyPreset\(/.test(app) && /data-preset/.test(app) ? ok : bad)("per-character 'Max out' preset wired");
(/id="maxPotch"/.test(app) ? ok : bad)("'max' Potch preset wired");
(/function forceRefresh/.test(app) && /caches\.delete/.test(app) && /unregister/.test(app) ? ok : bad)("force-refresh clears SW + caches");
(/checkVersionBehind/.test(app) && /cache:\s*"no-store"/.test(app) ? ok : bad)("version-behind check (cache-busted, no-store)");
(/id="forceRefresh"/.test(html) && /id="updateBanner"/.test(html) ? ok : bad)("index.html has the force-refresh button + update banner");

// 7b) ISO editor: field offsets sit inside the boot ELF, streaming save is wired end-to-end
console.log("ISO editor:");
const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
const ELF_ISO_START = 367 * 2048;                 // boot ELF LBA 367
const ELF_ISO_END = ELF_ISO_START + 3214528;      // + ELF size
const isoOffs = [...iso.matchAll(/off:\s*(0x[0-9A-Fa-f]+)/g)].map((m) => parseInt(m[1], 16));
(isoOffs.length >= 2 ? ok : bad)(`ISO field offsets found: ${isoOffs.length}`);
(isoOffs.every((o) => o >= ELF_ISO_START && o < ELF_ISO_END) ? ok : bad)(`all ISO offsets inside the boot ELF [0x${ELF_ISO_START.toString(16)}..0x${ELF_ISO_END.toString(16)})`);
(isoOffs.includes(0x10E43C) ? ok : bad)("encounter-rate offset 0x10E43C present");
(/showOpenFilePicker/.test(iso) && /createWritable/.test(iso) && /keepExistingData/.test(iso) ? ok : bad)("in-place save (File System Access) wired");
(/ReadableStream/.test(iso) && /dl-register/.test(iso) && /_dl\//.test(iso) ? ok : bad)("streaming save (service-worker hand-off) wired");
(/dl-register/.test(sw) && /_dl\//.test(sw) && /new Response\(entry\.stream/.test(sw) ? ok : bad)("service worker serves the streamed download");
(/data-mode="iso"/.test(html) ? ok : bad)("index.html has the ISO Editor tab");
(/src=["']iso\.js["']/.test(html) ? ok : bad)("index.html loads iso.js");
(/iso\.js/.test(sw) ? ok : bad)("service worker precaches iso.js");
(/window\.ISO/.test(app) && /window\.ISO\.init/.test(app) ? ok : bad)("app.js hands off to the ISO editor on the iso tab");

// 8) version lockstep: app.js APP_VERSION === index.html footer version (B12 corollary)
console.log("Version lockstep:");
const appVer = (/APP_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/.exec(app) || [])[1];
const htmlVer = (/·\s*v(\d+\.\d+\.\d+)/.exec(html) || [])[1];
(appVer && appVer === htmlVer ? ok : bad)(`APP_VERSION (${appVer}) matches footer (${htmlVer})`);

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
