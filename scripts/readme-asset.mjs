// Regenerates the README's demo assets from a real offline demo run:
//   npm run readme-asset                  -> out/readme-asset/ (gitignored; a judge's tree stays clean)
//   npm run readme-asset -- --update-docs -> docs/img/ (refresh the committed assets)
//   npm run readme-asset -- --out DIR     -> DIR
// The assets are chaotic-share.svg (round 6 share card) and chaotic-sheet.txt
// (Chaotic's round 6 sheet text). Never hand-edit the committed copies;
// scripts/readme-asset.test.mjs fails if they drift from what the demo generates.
// An existing file at either name that this tool did not write is left alone
// unless --force.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDemo } from "../src/demo/pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ASSET_DIR = path.join(ROOT, "docs", "img");
export const DEFAULT_OUT_DIR = path.join(ROOT, "out", "readme-asset");
export const SHARE_NAME = "chaotic-share.svg";
export const SHEET_NAME = "chaotic-sheet.txt";
const USAGE = `Usage: node scripts/readme-asset.mjs [--out DIR | --update-docs] [--force]
  --out DIR       where to write the assets (default out/readme-asset, gitignored)
  --update-docs   refresh the tracked docs/img assets the README embeds
  --force         replace an existing asset file that this tool did not write
  -h, --help      print this help and exit 0
Exit 0: wrote the assets. 1: failure. 2: usage error.`;

// An earlier file from this tool: the share card is an SVG document, the sheet
// starts with the responder's first label. Anything else is someone's file.
const OWN_ASSET = Object.freeze({
  [SHARE_NAME]: /^<svg[\s>]/,
  [SHEET_NAME]: /^Who I am: /,
});

/**
 * Refuse to overwrite a file this tool did not write, unless --force. Runs
 * before the demo, so a refusal writes nothing. Throws an Error with a one-line message.
 */
export function assertAssetsWritable(dir, force) {
  if (force) return;
  for (const [name, pattern] of Object.entries(OWN_ASSET)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`cannot read existing ${file}: ${e.message}`);
    }
    if (!pattern.test(text)) throw new Error(`${file} exists and is not an asset this tool wrote; pass --force to replace it`);
  }
}

/** Run the demo in a temp dir and return the asset bytes the README embeds. */
export async function generateAssets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme-asset-"));
  try {
    await runDemo({ outDir: dir });
    const share = fs.readFileSync(path.join(dir, "share", "chaotic-6.svg"), "utf8");
    const { sheet } = JSON.parse(fs.readFileSync(path.join(dir, "memory", "chaotic", "sheet.json"), "utf8"));
    return { [SHARE_NAME]: share, [SHEET_NAME]: `${sheet}\n` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** CLI flags -> { dir, force }. Throws an Error with a one-line message on bad input. */
export function parseArgs(argv) {
  let dir = null;
  let docs = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    else if (a === "--update-docs") docs = true;
    else if (a === "--force") force = true;
    else if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new Error("--out needs a directory");
      dir = path.resolve(v);
      i++;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (dir && docs) throw new Error("use --out or --update-docs, not both");
  return { dir: docs ? ASSET_DIR : dir ?? DEFAULT_OUT_DIR, force };
}

/** Write the generated assets into dir, logging the full path of each file. */
export function writeAssets(assets, dir, log = console.log) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(assets)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    log(`wrote ${file}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`readme-asset: ${e.message} (see --help)`);
    process.exitCode = 2;
  }
  if (opts?.help) {
    console.log(USAGE);
    opts = null;
  }
  if (opts) {
    try {
      assertAssetsWritable(opts.dir, opts.force);
    } catch (e) {
      console.error(`readme-asset: ${e.message}`);
      process.exitCode = 1;
      opts = null;
    }
  }
  if (opts) {
    try {
      writeAssets(await generateAssets(), opts.dir);
    } catch (e) {
      // An unwritable --out is a runtime failure: one line, no stack trace, exit 1.
      console.error(`readme-asset: cannot write ${opts.dir}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}
