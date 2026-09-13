// The boot gate (#7) — no browser.
//
// Ported in spirit from the Suikoden III editor's boot-gate.mjs, retargeted at this repo's
// markup and boot sequence.
//
// The property that actually matters is structural and is easy to lose in a refactor: the
// overlay must live in **index.html**, not be injected by app.js. If app.js builds it, it can't
// appear until app.js has parsed and run — which is exactly the window it exists to cover. A
// gate that shows up after the download it is narrating has started is worse than none.
//
// The second property is scope. It covers #loaderCard only, because Python gates loading a save
// and nothing else; the ISO editor is a completely Pyodide-free code path. If the overlay ever
// escapes that card it blanks the working half of the app for the length of a ~10 MB download,
// which is the bug the S3 comment records having shipped once.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const css = fs.readFileSync(path.join(WEB, "style.css"), "utf8");

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const check = (m, cond) => (cond ? ok : bad)(m);

console.log("Boot gate: it paints before any JS runs");
check("#bootOv is in index.html, not injected by app.js", /id="bootOv"/.test(html));
check("app.js does not create the overlay itself",
  !/createElement\(["']div["']\)[\s\S]{0,120}boot-ov/.test(app) && !/id="bootOv"/.test(app));
// The overlay must be inside #loaderCard in the source order, or it can't be scoped to it.
{
  const card = html.indexOf('id="loaderCard"');
  const ovAt = html.indexOf('id="bootOv"');
  const nextCard = html.indexOf('class="card"', card + 10);
  check("#bootOv sits inside #loaderCard", card >= 0 && ovAt > card && (nextCard < 0 || ovAt < nextCard));
}

console.log("Boot gate: scope");
check("it is absolutely positioned inside its card, not fixed to the viewport",
  /\.boot-ov\s*\{[^}]*position:absolute/.test(css) && !/\.boot-ov\s*\{[^}]*position:fixed/.test(css));
check("#loaderCard is a positioning context, so inset:0 means the card",
  /#loaderCard\s*\{[^}]*position:relative/.test(css));
// Anything outside the card must stay reachable while Python downloads.
for (const [what, sel] of [["mode tabs", 'class="modebar"'], ["the ISO editor root", 'id="isoRoot"'],
                           ["the reference root", 'id="refRoot"']]) {
  const at = html.indexOf(sel), card = html.indexOf('id="loaderCard"');
  const ov = html.indexOf('id="bootOv"');
  check(`${what} is outside the gated card`, at >= 0 && (at < card || at > ov));
}

console.log("Boot gate: the three steps match the real boot sequence");
for (const step of ["rt", "mod", "ref"]) {
  check(`step "${step}" is declared in the markup`, new RegExp(`data-step="${step}"`).test(html));
}
// Each declared step must actually be reached by a bootProgress call, or it would sit spinning
// forever; and every call must name a step the markup declares.
{
  const calls = [...app.matchAll(/bootProgress\(\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"(\w+)"\s*\)/g)]
    .map((m) => ({ pct: +m[1], msg: m[2], step: m[3] }));
  const named = new Set(calls.map((c) => c.step));
  check(`bootProgress names a step at every stage (${calls.map((c) => c.step).join(" → ")})`,
    ["rt", "mod", "ref", "done"].every((s) => named.has(s)));
  check("progress only ever moves forward", calls.every((c, i) => i === 0 || c.pct >= calls[i - 1].pct));
  check("the final call reaches 100%", calls.some((c) => c.pct === 100 && c.step === "done"));
  const declared = new Set([...html.matchAll(/data-step="(\w+)"/g)].map((m) => m[1]));
  const orphan = [...named].filter((s) => s !== "done" && !declared.has(s));
  check(orphan.length === 0 ? "every named step exists in the markup"
    : `bootProgress names steps the markup doesn't declare: ${orphan.join(", ")}`, orphan.length === 0);
}

console.log("Boot gate: escape hatches");
check("it offers the ISO editor, which needs no Python", /id="bootIso"/.test(html) && /bootIso[\s\S]{0,120}setMode\("iso"\)/.test(app));
check("it can be dismissed", /id="bootHide"/.test(html) && /bootHide[\s\S]{0,100}bootGate\.close\(\)/.test(app));
check("choosing the ISO editor closes the gate too", /bootIso[\s\S]{0,120}bootGate\.close\(\)/.test(app));

console.log("Boot gate: success and failure");
check("it closes when the engine is ready", /pyReady\.then\([\s\S]{0,300}bootGate\.close\(\)/.test(app));
check("it reports a failed boot instead of closing", /catch[\s\S]{0,120}bootGate\.fail\(/.test(app));
// A spinner next to "didn't start" reads as still-working, which is the opposite of the truth.
check("the in-flight step is marked failed, not left spinning",
  /boot-steps li\.on[\s\S]{0,200}classList\.remove\("on"\)[\s\S]{0,80}add\("bad"\)/.test(app));
check("a failed boot offers retry and a cache clear", /id="bootRetry"/.test(app) && /id="bootNuke"/.test(app));
check("the cache clear calls this repo's forceRefresh", /bootNuke[\s\S]{0,80}forceRefresh\(\)/.test(app));
check("the live region stops announcing itself as busy on failure", /aria-busy", "false"/.test(app));
// A late bootProgress must not be able to overwrite the error with "Ready" — that would report
// a working engine when there isn't one. Found by driving a fail() past a boot that then
// succeeded; only reachable in the real app through an ordering accident, cheap to rule out.
check("a failed gate is sticky against later progress updates",
  /let closed = false, failed = false/.test(app) && /if \(!o \|\| closed \|\| failed\) return/.test(app));

console.log("Boot gate: accessibility and motion");
check("the overlay is labelled by its own title", /aria-labelledby="bootTitle"/.test(html) && /id="bootTitle"/.test(html));
check("progress is announced politely", /id="bootMsg"[^>]*aria-live="polite"/.test(html));
check("reduced motion is respected", /prefers-reduced-motion[\s\S]{0,80}\.boot-ov/.test(css));
check("the gate is removed rather than left as an invisible layer", /\.remove\(\)/.test(app) && /classList\.add\("gone"\)/.test(app));

console.log(failures ? `\nFAILED (${failures})` : "\nBoot gate OK.");
process.exit(failures ? 1 : 0);
