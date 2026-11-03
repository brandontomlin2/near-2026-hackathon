// Usage: node scripts/screenshot.mjs [--out FILE | --update-docs]
// Runs the demo into a temp dir and renders its index.html with a headless
// Chrome/Chromium already on this machine. Writes out/page.png (gitignored) by
// default, so a judge's git tree stays clean. --update-docs refreshes the tracked
// docs/img/page.png instead (maintainers; the bytes depend on the local browser
// and fonts). No browser: exit 2.
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = join(ROOT, "out", "page.png");
export const DOCS_OUT = join(ROOT, "docs", "img", "page.png");
const USAGE = `Usage: node scripts/screenshot.mjs [--out FILE | --update-docs]
  --out FILE      where to write the PNG (default out/page.png, gitignored)
  --update-docs   refresh the tracked docs/img/page.png the README embeds`;

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

/** CLI flags -> { out }. Throws an Error with a one-line message on bad input. */
export function parseArgs(argv) {
  let out = null;
  let docs = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update-docs") docs = true;
    else if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new Error("--out needs a file path");
      out = resolve(v);
      i++;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out && docs) throw new Error("use --out or --update-docs, not both");
  return { out: docs ? DOCS_OUT : out ?? DEFAULT_OUT };
}

export function run({ candidates = BROWSER_CANDIDATES, exists = existsSync, out = DEFAULT_OUT, log = console.log, err = console.error } = {}) {
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
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`screenshot: ${e.message}\n${USAGE}`);
    process.exitCode = 1;
  }
  if (opts) process.exitCode = run(opts);
}
