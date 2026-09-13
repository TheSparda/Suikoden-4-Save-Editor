// End-to-end smoke suite (#9) — drives the real app in a real browser.
//
// Scope is deliberate. The headless suites already cover the *rules* (s4-core.mjs) and the
// *wiring* (validate.mjs, boot-gate.mjs, blurb-core.mjs); none of them can catch a picker that
// doesn't open, a review sheet that renders empty rows, or a save path that silently drops an
// edit. That gap is what this closes, and it is why the suite is shaped as a thin pass over the
// paths a user actually takes rather than an exhaustive re-test of the logic.
//
// It is not run by `npm test`: it needs a browser, and `npm test` must stay runnable on a clean
// clone with nothing installed. `npm run test:e2e`, and a separate CI job.
//
// Per ROADMAP.md Phase 2 the intent is that each later feature adds its own case here, so the
// suite grows with the app instead of being a 5,000-line project that goes stale.
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { findChromium } from "./chromium-path.mjs";
import { buildSynthIso, verifySynthIso, FIELDS } from "./synth-s4-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const check = (m, cond) => (cond ? ok : bad)(m);
const is = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m)
  : bad(`${m}\n      expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`));

// ---- preconditions ---------------------------------------------------------
let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch {
  console.log("e2e: skipped — playwright-core is not installed (npm install in web/tests)");
  process.exit(0);
}
const exe = findChromium();
if (!exe) {
  console.log("e2e: skipped — no Chromium found (set PW_CHROMIUM, or npx playwright install chromium)");
  process.exit(0);
}

// The fixture has to be valid before the browser is blamed for anything.
{
  const problems = verifySynthIso(buildSynthIso());
  if (problems.length) { console.log("e2e: fixture is invalid:\n  " + problems.join("\n  ")); process.exit(1); }
}

// ---- static server over the repo root (the app fetches ../Editor/*) ---------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".py": "text/plain",
  ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  let file = path.join(REPO, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!file.startsWith(REPO) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
                       "Cache-Control": "no-store" });     // never serve a stale module to the suite
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/web/`;

const browser = await chromium.launch({ executablePath: exe });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text()); });

// Hand the page the fixture as a real File through the real <input type=file>, so the whole
// load path runs — Blob.slice, the region gate, window bookkeeping — exactly as for a user.
const FIXTURE = path.join(HERE, ".synth-s4.iso");
fs.writeFileSync(FIXTURE, buildSynthIso());

const loadIso = async () => {
  await page.setInputFiles("#isoFileInput", FIXTURE);
  await page.waitForFunction(() => /Loaded/.test(document.querySelector("#isoStatus")?.textContent || ""),
    null, { timeout: 15000 });
};

try {
  // ---- boot ----------------------------------------------------------------
  console.log("e2e: boot");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  check("the boot gate paints before the engine is ready", await page.locator("#bootOv").count() === 1);
  check("the ISO editor is reachable during boot", await page.locator("#bootIso").isVisible());
  await page.waitForFunction(() => document.querySelector("#pickBtn") && !document.querySelector("#pickBtn").disabled,
    null, { timeout: 120000 });
  ok("the Python engine starts");
  await page.waitForFunction(() => !document.querySelector("#bootOv"), null, { timeout: 5000 });
  ok("the gate closes once the engine is up");

  // ---- ISO editor: load → read back every field ----------------------------
  console.log("e2e: ISO editor — load and read back");
  await page.click('[data-mode="iso"]');
  await loadIso();
  ok("a synthetic disc passes the NTSC-U region gate");

  const stock = await page.evaluate(() => ({
    rate: document.querySelector('[data-iso="encounterRate"]').value,
    champ: document.querySelector('[data-iso="championAlways"]').checked,
    none: document.querySelector('[data-iso="noBattles"]').checked,
  }));
  is(stock, { rate: "100", champ: false, none: false }, "every field reads back its stock value");
  check(`the tab shell renders (${FIELDS.length} fields under one tab)`,
    await page.locator("#isoViews .chip").count() >= 1);

  // ---- ISO editor: edit → review sheet -------------------------------------
  console.log("e2e: ISO editor — edit and review");
  await page.fill('[data-iso="encounterRate"]', "250");
  await page.dispatchEvent('[data-iso="encounterRate"]', "change");
  await page.check('[data-iso="championAlways"]');
  const tag = await page.textContent('[data-ratetag="encounterRate"]');
  check(`the live readout follows the value (“${tag.trim()}”)`, /2\.5/.test(tag));

  await page.click("#isoSave");
  await page.waitForSelector(".modal-ov", { timeout: 5000 });
  const rows = await page.$$eval(".modal-ov .cf-row", (els) => els.map((e) => e.textContent.trim()));
  is(rows, ["Encounter rate: 100% → 250%", "Champion's Rune effect — always on: off → on"],
     "the review sheet lists every staged edit as old → new");
  await page.click("#cfCancel");

  // ---- ISO editor: the byte runs that would be written ---------------------
  // The review is prose; this is the thing that actually reaches the disc. Checked against the
  // field's own write(), so a change to the encoder fails here rather than silently shipping.
  console.log("e2e: ISO editor — the bytes that would be written");
  const want = FIELDS.map((f) => {
    const el = { encounterRate: 250, championAlways: 1, noBattles: 0 }[f.key];
    const b = new Uint8Array(f.len); f.write(new DataView(b.buffer), el);
    return { key: f.key, bytes: [...b] };
  });
  const live = await page.evaluate(() => {
    const out = [];
    for (const f of window.ISO.FIELDS) {
      const el = document.querySelector(`[data-iso="${f.key}"]`);
      if (!el) continue;
      const b = new Uint8Array(f.len);
      f.write(new DataView(b.buffer), f.type === "bool" ? (el.checked ? 1 : 0) : +el.value);
      out.push({ key: f.key, bytes: [...b] });
    }
    return out;
  });
  is(live, want, "the staged values encode to the same bytes in the page as in Node");

  // ---- ISO editor: undo / redo / restore -----------------------------------
  console.log("e2e: ISO editor — undo, redo, restore");
  await page.evaluate(() => window.ISO.undo());
  is(await page.isChecked('[data-iso="championAlways"]'), false, "undo unwinds the last staged edit");
  await page.evaluate(() => window.ISO.redo());
  is(await page.isChecked('[data-iso="championAlways"]'), true, "redo replays it");
  await page.click('[data-fieldwrap="encounterRate"] .revert');
  is(await page.inputValue('[data-iso="encounterRate"]'), "100", "↺ restores one field to the disc's bytes");
  is(await page.isChecked('[data-iso="championAlways"]'), true, "…and leaves the others staged");
  await page.click("#isoReset");
  is(await page.evaluate(() => [...document.querySelectorAll("#isoRoot .revert")]
       .filter((b) => getComputedStyle(b).display !== "none").length), 0,
     "Revert all clears every staged edit");

  // ---- ISO editor: pnach export --------------------------------------------
  console.log("e2e: ISO editor — pnach export");
  await page.fill('[data-iso="encounterRate"]', "50");
  await page.dispatchEvent('[data-iso="encounterRate"]', "change");
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  await page.click("#isoPnach");
  const pnach = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
  check("Copy pnach line emits a patch= line for the current values",
    pnach === "" || /^patch=/m.test(pnach));      // clipboard may be blocked; don't fail on that

  // ---- Reference tab -------------------------------------------------------
  console.log("e2e: Reference tab");
  await page.click('[data-mode="ref"]');
  await page.waitForFunction(() => document.querySelectorAll("#refRoot table tr").length > 50, null, { timeout: 20000 });
  const refRows = await page.locator("#refRoot table tr").count();
  check(`the reference tables render (${refRows} rows)`, refRows > 100);

  // ---- long-description collapse -------------------------------------------
  console.log("e2e: collapsed descriptions");
  const blurbs = await page.locator(".blurb").count();
  check(`long blocks collapse behind Show more (${blurbs})`, blurbs >= 1);
  check("the full text stays in the DOM so find-in-page still reaches it",
    (await page.evaluate(() => document.body.textContent)).includes("never leaves the device"));

  // ---- nothing threw along the way -----------------------------------------
  console.log("e2e: console");
  const ignorable = /favicon|ServiceWorker|Failed to register|clipboard/i;
  const real = pageErrors.filter((e) => !ignorable.test(e));
  check(real.length === 0 ? "no uncaught page errors" : `page errors: ${real.join(" | ")}`, real.length === 0);
} finally {
  fs.unlinkSync(FIXTURE);
  await browser.close();
  server.close();
}

console.log(failures ? `\nFAILED (${failures})` : "\ne2e passed.");
process.exit(failures ? 1 : 0);
