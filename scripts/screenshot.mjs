// Usage: node scripts/screenshot.mjs [--out FILE | --update-docs] [--force]
// Runs the demo into a temp dir and renders its index.html with a headless
// Chrome/Chromium already on this machine. Writes out/page.png (gitignored) by
// default, so a judge's git tree stays clean. --update-docs refreshes the tracked
// docs/img/page.png instead (maintainers; the bytes depend on the local browser
// and fonts). An existing --out that is not a PNG is left alone unless --force.
// No browser: exit 2.
import { existsSync, mkdtempSync, mkdirSync, openSync, readSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { plural } from "../src/util/plural.mjs";
import { pathProblem } from "../src/util/path-problem.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = join(ROOT, "out", "page.png");
export const DOCS_OUT = join(ROOT, "docs", "img", "page.png");
const USAGE = `Usage: node scripts/screenshot.mjs [--out FILE | --update-docs] [--force]
  --out FILE      where to write the PNG (default out/page.png, gitignored)
  --update-docs   refresh the tracked docs/img/page.png the README embeds
  --force         replace an existing --out that is not a PNG this tool wrote
  -h, --help      print this help and exit 0
Exit 0: wrote the PNG. 1: failure. 2: usage error, or no browser found.`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An earlier screenshot: a PNG. Anything else at --out is someone's file. */
function isPng(file) {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(PNG_SIGNATURE.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(PNG_SIGNATURE);
  } finally {
    closeSync(fd);
  }
}

/**
 * The one-line reason an existing --out must not be replaced, or null when it is
 * missing, a PNG, or --force was given. Runs before the demo or the browser.
 */
function refusalFor(out, force) {
  if (!existsSync(out)) return null;
  if (statSync(out).isDirectory()) return `--out ${out} is a directory; give a file path`;
  if (force) return null;
  try {
    if (isPng(out)) return null;
  } catch (e) {
    return `cannot read existing --out ${out}: ${e.message}`;
  }
  return `--out ${out} exists and is not a PNG image this tool wrote; pass --force to replace it`;
}

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
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    else if (a === "--update-docs") docs = true;
    else if (a === "--force") force = true;
    else if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new Error("--out needs a file path");
      out = resolve(v);
      i++;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out && docs) throw new Error("use --out or --update-docs, not both");
  return { out: docs ? DOCS_OUT : out ?? DEFAULT_OUT, force };
}

export function run({ candidates = BROWSER_CANDIDATES, exists = existsSync, out = DEFAULT_OUT, force = false, log = console.log, err = console.error } = {}) {
  const browser = findBrowser(candidates, exists);
  if (!browser) {
    err("screenshot: no headless Chrome/Chromium found (looked for Google Chrome, Chromium, Brave). Install one and re-run `npm run screenshot`.");
    return 2;
  }
  const refusal = refusalFor(out, force);
  if (refusal) {
    err(`screenshot: ${refusal}`);
    return 1;
  }
  const tmp = mkdtempSync(join(tmpdir(), "page-shot-"));
  try {
    const demo = spawnSync(process.execPath, [join(ROOT, "scripts/demo.mjs"), "--out", tmp], { cwd: ROOT, encoding: "utf8" });
    if (demo.status !== 0) { err(`screenshot: demo failed\n${demo.stderr}`); return 1; }
    try {
      mkdirSync(dirname(out), { recursive: true });
    } catch (e) {
      // An unwritable --out is a runtime failure: one line, no stack trace, exit 1.
      err(`screenshot: cannot write ${out}: ${pathProblem(e, "--out") ?? e.message}`);
      return 1;
    }
    const shot = spawnSync(browser, [
      "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
      `--user-data-dir=${join(tmp, "profile")}`,
      "--window-size=1280,2400", `--screenshot=${out}`,
      pathToFileURL(join(tmp, "index.html")).href,
    ], { encoding: "utf8", timeout: 60000 });
    if (!existsSync(out) || statSync(out).size === 0) { err(`screenshot: browser produced no image\n${shot.stderr}`); return 1; }
    log(`wrote ${out} (${plural(statSync(out).size, "byte")}) using ${browser}`);
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
    console.error(`screenshot: ${e.message} (see --help)`);
    process.exitCode = 2;
  }
  if (opts?.help) console.log(USAGE);
  else if (opts) process.exitCode = run(opts);
}
