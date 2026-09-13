// No-game-data guard (issue #43).
//
// This project ships no copyrighted disc images, saves or extracted game text, and says so in
// its README, in CLAUDE.md rule 3, and in the privacy guarantee the web app makes to users.
// .gitignore is the intent; this file is the proof.
//
// It checks what is actually *tracked by git*, not what happens to sit in the working tree —
// Base ISO/, Cheats/ and Saves/ are expected to exist locally on the maintainer's machine and
// are correctly ignored. The failure mode this guards is a `git add -f`, a renamed extension, or
// a fixture someone built from a real disc and committed by accident.
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" });

// Extensions that are game data by definition. .bin is deliberately absent: it is both a memory
// card image and a perfectly ordinary name, so it is caught by the size rule instead.
const BANNED_EXT = /\.(iso|ps2|mcd|mc2|max|psv|cbs|sps|psu|p2s|bin)$/i;
const BANNED_DIR = /^(Base ISO|Saves|Cheats)\//;
// Generous: the largest legitimately-tracked file today is a 526 KB guide PDF and the icons are
// a few KB. A megabyte of anything new is worth a human look.
const MAX_BYTES = 1024 * 1024;

let tracked;
try {
  tracked = git("ls-files", "-z").split("\0").filter(Boolean);
} catch (e) {
  // Not a git checkout (a tarball, a vendored copy). Skip rather than fail — per CLAUDE.md rule 3,
  // a test that fails where it cannot run is a broken test.
  console.log("No-game-data guard:\n  – skipped (not a git checkout)");
  process.exit(0);
}

console.log(`No-game-data guard: ${tracked.length} tracked files`);

const banned = tracked.filter((f) => BANNED_EXT.test(f));
(banned.length === 0 ? ok : bad)(
  banned.length ? `game-data extensions tracked: ${banned.join(", ")}` : "no game-data extensions tracked");

const inDirs = tracked.filter((f) => BANNED_DIR.test(f));
(inDirs.length === 0 ? ok : bad)(
  inDirs.length ? `files tracked under an ignored research directory: ${inDirs.join(", ")}`
                : "nothing tracked under Base ISO/, Saves/ or Cheats/");

// Size check via `git ls-files` + cat-file, so it measures the committed blob rather than a
// working-tree file that may differ.
const sized = git("ls-files", "-s", "-z").split("\0").filter(Boolean).map((l) => {
  const [meta, file] = l.split("\t");
  return { sha: meta.split(" ")[1], file };
});
const sizes = execFileSync("git", ["-C", REPO, "cat-file", "--batch-check=%(objectsize)"],
  { input: sized.map((s) => s.sha).join("\n"), encoding: "utf8" })
  .trim().split("\n").map(Number);

const big = sized.map((s, i) => ({ ...s, size: sizes[i] }))
  .filter((s) => s.size > MAX_BYTES)
  .sort((a, b) => b.size - a.size);

(big.length === 0 ? ok : bad)(
  big.length
    ? `files over ${(MAX_BYTES / 1024).toFixed(0)} KB — game data, or move it out of git:\n` +
      big.map((b) => `      ${(b.size / 1024 / 1024).toFixed(2)} MB  ${b.file}`).join("\n")
    : `no tracked file exceeds ${(MAX_BYTES / 1024).toFixed(0)} KB`);

// The fixtures the suite runs on must be generated, never captured. This is what makes the
// guarantee a proof rather than a promise (see #9 / #43).
console.log("Fixture provenance:");
const fixtures = tracked.filter((f) => /^web\/tests\/.*(fixture|synth)/i.test(f));
(fixtures.every((f) => /\.(mjs|js|py)$/.test(f)) ? ok : bad)(
  fixtures.length
    ? `every committed fixture is a generator, not data (${fixtures.length} file(s))`
    : "no fixtures committed yet — generators land with #9");

console.log(failures ? `\nFAILED (${failures})` : "\nNo game data tracked.");
process.exit(failures ? 1 : 0);
