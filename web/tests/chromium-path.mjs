// Find a Chromium to drive, without making the caller care how (#9).
//
// playwright-core deliberately ships no browser, so the suite has to locate one. Order matters:
// a Playwright-managed build first (it is the one Playwright is version-matched to), then an
// explicit override, then whatever the machine already has. If none is found the caller SKIPS
// rather than fails — a developer without a browser should still be able to run `npm test`, and
// CI installs one explicitly.
import fs from "fs";
import os from "os";
import path from "path";

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// Playwright's download cache, newest build first.
function playwrightCache() {
  const roots = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : [path.join(os.homedir(), "Library", "Caches", "ms-playwright"),   // macOS
       path.join(os.homedir(), ".cache", "ms-playwright"),              // Linux
       path.join(process.env.LOCALAPPDATA || "", "ms-playwright")];     // Windows
  const out = [];
  for (const root of roots) {
    if (!exists(root)) continue;
    const dirs = fs.readdirSync(root)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      // numeric, not lexicographic: chromium-1243 must beat chromium-998
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    for (const d of dirs) {
      // Playwright renamed the macOS payload directory when it split by arch (chrome-mac →
      // chrome-mac-arm64 / chrome-mac-x64). Checking only the old name doesn't fail — it
      // quietly falls through to whatever ancient build still uses it, which is worse.
      // Recent builds also renamed the bundle itself (Chromium.app → "Google Chrome for
      // Testing.app"), so both names are tried under each arch directory.
      for (const mac of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"]) {
        out.push(
          path.join(root, d, mac, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
          path.join(root, d, mac, "Chromium.app", "Contents", "MacOS", "Chromium"),
          path.join(root, d, mac, "headless_shell"),
        );
      }
      for (const hs of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64",
                        "chrome-headless-shell-linux64"]) {
        out.push(path.join(root, d, hs, "chrome-headless-shell"));
      }
      out.push(
        path.join(root, d, "chrome-linux", "chrome"),
        path.join(root, d, "chrome-linux", "headless_shell"),
        path.join(root, d, "chrome-win", "chrome.exe"),
      );
    }
  }
  return out;
}

const SYSTEM = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChromium() {
  const candidates = [process.env.PW_CHROMIUM, ...playwrightCache(), ...SYSTEM];
  return candidates.find(exists) || null;
}
