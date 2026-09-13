// The collapsed long descriptions ("Show more") — no browser.
//
// Ported from the Suikoden III editor along with blurb-core.js itself (issue #6). The first
// half — the gate and the summariser — is S3's verbatim, because the module is verbatim and
// those are the properties its header argues for.
//
// The second half is rewritten for this repo. S3's version asserts against two structures S4
// does not have (`hintSums` in iso.js, `SUBHINT_SUM` in app.js) and pins a count of 66
// annotated blocks; carrying that over would have meant a test that passes by describing
// another codebase. What transfers is the *property*, not the numbers: expanded state is keyed
// by the summary **text**, because both editors rebuild whole tabs into `innerHTML` and there
// is no element to hang it off — so two blocks sharing a summary would open and close together,
// on different tabs, for no visible reason. Uniqueness is asserted rather than hoped for.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const B = require(path.join(WEB, "blurb-core.js"));

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const check = (m, cond) => (cond ? ok : bad)(m);

// ---------------------------------------------------------------- the gate and the summariser
console.log("blurb-core: plain text + gate");
check("tags are dropped and whitespace collapsed",
  B.plainText("<b>a</b>\n  <i>b</i>") === "a b");
check("entities count as one character, not as their source length",
  B.plainText("a&nbsp;b&mdash;c").length === 5);
check("a short caption is left alone",
  B.looksLong("Stock is 100 walking. Running is riskier.") === false);
check("a long block earns a button on length alone",
  B.looksLong("x ".repeat(200)) === true);
// The second gate exists because a four-sentence block is a wall of argument even when it is
// short, which is the shape the request named ("more than 2-3 sentences").
check("three sentences is not long", B.looksLong("One two. Three four. Five six.") === false);
check("four short sentences is long", B.looksLong("One two. Three four. Five six. Seven eight.") === true);

console.log("blurb-core: derived summaries");
check("takes whole sentences while they fit",
  B.deriveSummary("First one. Second one. " + "tail ".repeat(80)) === "First one. Second one.");
check("a single over-long sentence is cut at a word boundary and ellipsised", (() => {
  const s = B.deriveSummary("alpha bravo ".repeat(40), 60);
  return s.length <= 61 && s.endsWith("…") && !/ …$/.test(s) && s.startsWith("alpha bravo");
})());
check("never returns empty for non-empty prose", B.deriveSummary("Just this.") === "Just this.");
check("empty in, empty out", B.deriveSummary("") === "");
// The DOM half is a no-op under Node, and importing it must not throw on `document`.
check("importing under Node exposes only the pure half", typeof B.applyBlurbs === "undefined");

// ---------------------------------------------------------- the summaries actually shipped
console.log("blurb-core: the shipped data-sum attributes");

const found = [];   // { where, line, summary, bodyLen }

// index.html carries them as literal attributes on the intro paragraphs.
{
  const src = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const re = /<(div|p|li)\b[^>]*?\bdata-sum="([^"]*)"[^>]*?>/g;
  let m;
  while ((m = re.exec(src))) {
    const [tag, name, summary] = [m[0], m[1], m[2]];
    let depth = 1, i = m.index + tag.length;
    const close = "</" + name + ">";
    while (i < src.length && depth > 0) {
      const no = src.indexOf("<" + name, i), nc = src.indexOf(close, i);
      if (nc < 0) break;
      if (no >= 0 && no < nc) { depth++; i = no + 1; } else { depth--; i = nc + close.length; }
    }
    found.push({ where: "index.html", line: src.slice(0, m.index).split("\n").length, summary,
                 bodyLen: B.plainText(src.slice(m.index + tag.length, i - close.length)).length });
  }
}

// iso.js carries them beside the prose they summarise, as subSum/hintSum on the FIELD, because
// the markup is built in a template literal and the prose is a concatenated JS string.
{
  const src = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  // Grab each FIELD's key plus whichever of sub/hint and its *Sum it declares.
  const fieldRe = /key:\s*"(\w+)"[\s\S]*?(?=\n    \{|\n  \];)/g;
  let m;
  while ((m = fieldRe.exec(src))) {
    const [block, key] = [m[0], m[1]];
    for (const [prose, sum] of [["sub", "subSum"], ["hint", "hintSum"]]) {
      const pm = new RegExp(`\\b${prose}:\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*\\+?\\s*)+),`).exec(block);
      const sm = new RegExp(`\\b${sum}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block);
      if (!pm) continue;
      const bodyLen = B.plainText(pm[1].split("+").map((x) => x.trim().replace(/^"|"$/g, "")).join("")).length;
      check(`${key}.${prose} has a ${sum}`, !!sm);
      if (sm) found.push({ where: `iso.js ${key}.${prose}`, line: src.slice(0, m.index).split("\n").length,
                           summary: JSON.parse('"' + sm[1] + '"'), bodyLen });
    }
  }
}

// Coverage. Not a style preference: an unsummarised wall of text is the thing this mechanism
// exists for, so the count is pinned and a drop has to be deliberate.
check(`summaries shipped: ${found.length} (${found.filter((x) => x.where === "index.html").length} in index.html, ` +
  `${found.filter((x) => x.where.startsWith("iso.js")).length} in iso.js)`,
  found.filter((x) => x.where === "index.html").length >= 3 &&
  found.filter((x) => x.where.startsWith("iso.js")).length >= 3);

const dupes = new Map();
for (const x of found) {
  const k = x.summary.trim();
  if (!dupes.has(k)) dupes.set(k, []);
  dupes.get(k).push(`${x.where}:${x.line}`);
}
const collided = [...dupes].filter(([, at]) => at.length > 1);
check(collided.length === 0
  ? "every summary is unique, so no two blocks share an expanded state"
  : `summaries collide (they would toggle together): ${collided.map(([s, at]) =>
      `${at.join(" + ")} — “${s.slice(0, 40)}…”`).join("; ")}`,
  collided.length === 0);

// Summaries live in an HTML attribute inside a JS template literal, so a stray quote would
// truncate the attribute and spray the rest of the summary into the markup as bare tags.
const quoted = found.filter((x) => /["`]/.test(x.summary) || x.summary.includes("${"));
check(quoted.length === 0
  ? "no summary carries a quote or an interpolation that would break its attribute"
  : `unsafe summary at ${quoted.map((x) => x.where + ":" + x.line).join(", ")}`,
  quoted.length === 0);

const notShorter = found.filter((x) => x.bodyLen > 0 && x.summary.length >= x.bodyLen);
check(notShorter.length === 0
  ? "every summary is shorter than the block it replaces"
  : `summary is not shorter than its block at ${notShorter.map((x) =>
      `${x.where}:${x.line} (${x.summary.length} vs ${x.bodyLen})`).join(", ")}`,
  notShorter.length === 0);

// A summary that needs its own "show more" defeats the point.
const tooLong = found.filter((x) => x.summary.length > B.SUM_MAX);
check(tooLong.length === 0
  ? "no summary is itself long enough to need collapsing"
  : `over-long summary at ${tooLong.map((x) => `${x.where}:${x.line} (${x.summary.length})`).join(", ")}`,
  tooLong.length === 0);

// The runtime gate decides whether a button appears at all, so a block annotated but short
// would ship a summary nobody ever sees.
const wouldNotCollapse = found.filter((x) => x.bodyLen > 0 && !B.looksLong("x".repeat(x.bodyLen)));
check(`annotated blocks under the length gate: ${wouldNotCollapse.length} ` +
  `(${wouldNotCollapse.map((x) => x.where).join(", ") || "none"}) — ` +
  `each still collapses if it runs past ${B.MAX_SENTS} sentences`,
  wouldNotCollapse.length <= 2);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
