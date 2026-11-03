// Usage: node scripts/screenshot.mjs [--out FILE]
// Runs the demo into a temp dir and renders its index.html to docs/img/page.png
// with a headless Chrome/Chromium already on this machine. No browser: exit 2.
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser(candidates = BROWSER_CANDIDATES, exists = existsSync) {
  return candidates.find((p) => exists(p)) ?? null;
}

export function run({ candidates = BROWSER_CANDIDATES, exists = existsSync, out = join(ROOT, "docs/img/page.png"), log = console.log, err = console.error } = {}) {
  const browser = findBrowser(candidates, exists);
  if (!browser) {
    err("screenshot: no headless Chrome/Chromium found (looked for Google Chrome, Chromium, Brave). Install one and re-run `npm run screenshot`.");
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), "page-shot-"));
  try {
    const demo = spawnSync(process.execPath, [join(ROOT, "scripts/demo.mjs"), "--out", tmp], { cwd: ROOT, encoding: "utf8" });
    if (demo.status !== 0) { err(`screenshot: demo failed\n${demo.stderr}`); return 1; }
    mkdirSync(dirname(out), { recursive: true });
    const shot = spawnSync(browser, [
      "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
      `--user-data-dir=${join(tmp, "profile")}`,
      "--window-size=1280,2400", `--screenshot=${out}`,
      pathToFileURL(join(tmp, "index.html")).href,
    ], { encoding: "utf8", timeout: 60000 });
    if (!existsSync(out) || statSync(out).size === 0) { err(`screenshot: browser produced no image\n${shot.stderr}`); return 1; }
    log(`wrote ${out} (${statSync(out).size} bytes) using ${browser}`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  process.exitCode = run(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
}
