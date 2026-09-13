// Version lockstep guard (issue #8).
//
// The app version lives in three places that must agree:
//   web/app.js      APP_VERSION  — what the update banner compares against
//   web/index.html  footer       — what the user sees, and what the banner reads off a deploy
//   web/sw.js       CACHE        — the precache bucket; a stale name serves stale shell files
//
// This repo has already shipped one desync (commit 1e58260, "fix version desync"). app.js
// carries the comment "keep in lockstep with the footer in index.html" — a comment is not a
// guard, which is what this file is for.
//
// sw.js's CACHE deliberately embeds the version rather than an independent counter: a cache
// epoch that can be bumped separately is a second source of truth, and the whole point here is
// that there is only one. The activate handler purges any cache not in `keep`, so a version bump
// cleanly retires the old bucket (SHARE_CACHE is listed separately and survives).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");
const app = read("app.js"), html = read("index.html"), sw = read("sw.js");

const SEMVER = String.raw`\d+\.\d+\.\d+`;
const sites = [
  ["app.js APP_VERSION", new RegExp(`APP_VERSION\\s*=\\s*"(${SEMVER})"`).exec(app)],
  ["index.html footer", new RegExp(`·\\s*v(${SEMVER})`).exec(html)],
  ["sw.js CACHE", new RegExp(`CACHE\\s*=\\s*"s4editor-v(${SEMVER})"`).exec(sw)],
];

console.log("Version lockstep:");

const missing = sites.filter(([, m]) => !m).map(([name]) => name);
if (missing.length) {
  // A site whose pattern stopped matching is worse than a mismatch: the guard would silently
  // pass while the value drifts. Fail loudly and name the site.
  for (const name of missing) bad(`${name} — no version found (pattern changed? guard is blind)`);
} else {
  const found = sites.map(([name, m]) => [name, m[1]]);
  const versions = new Set(found.map(([, v]) => v));
  if (versions.size === 1) {
    ok(`all three sites agree on v${found[0][1]}`);
    for (const [name, v] of found) ok(`  ${name} = ${v}`);
  } else {
    bad(`version drift across ${versions.size} distinct values — bump all three together:`);
    for (const [name, v] of found) console.log(`      ${name.padEnd(22)} ${v}`);
  }
}

// The share cache is a separate bucket by design — it holds a file shared into the PWA that is
// waiting to be opened, and must survive a version bump. Both files must name it identically or
// the hand-off silently drops the file.
console.log("Share-cache pairing:");
const shareApp = /SHARE_CACHE\s*=\s*"([^"]+)"/.exec(app);
const shareSw = /SHARE_CACHE\s*=\s*"([^"]+)"/.exec(sw);
(shareApp && shareSw && shareApp[1] === shareSw[1]
  ? ok : bad)(`app.js and sw.js agree on SHARE_CACHE (${shareApp?.[1]} / ${shareSw?.[1]})`);
(shareSw && !new RegExp(SEMVER).test(shareSw[1])
  ? ok : bad)("SHARE_CACHE carries no version — it must survive a version bump");

console.log(failures ? `\nFAILED (${failures})` : "\nVersion lockstep OK.");
process.exit(failures ? 1 : 0);
