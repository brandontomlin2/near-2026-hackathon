// Renders the four seeded agents (memory_depth 1).
//
//   node scripts/render-agents.mjs                   default style -> out/<id>.svg
//   node scripts/render-agents.mjs --style sticker   -> out/styles/sticker/<id>-<mood>.svg + sheet.svg
//   node scripts/render-agents.mjs --style all       every style under out/styles/
//   --out <dir>                                      output root (default: out)

import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../src/traits/agents.mjs";
import { renderSvg } from "../src/art/render.mjs";
import { renderSheet } from "../src/art/sheet.mjs";
import { STYLE_NAMES, getStyle } from "../src/art/styles/index.mjs";
import { assertSafeOutDir } from "../src/util/outdir.mjs";

/** Throw before anything is created if `dir` (or the nearest existing ancestor) cannot take new entries. */
function assertWritableDir(dir) {
  let probe = resolve(dir);
  while (!existsSync(probe)) probe = dirname(probe);
  if (!statSync(probe).isDirectory()) throw new Error(`cannot create ${dir}: ${probe} is not a directory`);
  accessSync(probe, constants.W_OK);
}

/** Every file is rendered in memory and every directory checked first, so a failure leaves no half-finished set behind. */
function writeAll(files) {
  const dirs = [...new Set(files.map(([path]) => dirname(path)))];
  for (const dir of dirs) assertWritableDir(dir);
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  for (const [path, svg] of files) writeFileSync(path, svg);
  return files.map(([path]) => path);
}

/** @param {string} [outDir] @returns {string[]} written paths */
export function renderAll(outDir = "out") {
  return writeAll(AGENTS.map((a) => [join(outDir, `${a.id}.svg`), renderSvg(a.traits)]));
}

/** @param {string} name @param {string} [outRoot] @returns {Array<[string, string]>} path and svg pairs, not yet written */
function renderStyleFiles(name, outRoot = "out") {
  const style = getStyle(name);
  const dir = join(outRoot, "styles", style.name);
  const files = AGENTS.flatMap((a) => style.moods.map((mood) => [join(dir, `${a.id}-${mood}.svg`), style.render(a.traits, { mood })]));
  files.push([join(dir, "sheet.svg"), renderSheet(style, { moods: style.moods })]);
  return files;
}

/**
 * Every agent in every mood of one style, plus a contact sheet
 * (rows = agents, columns = moods).
 * @param {string} name
 * @param {string} [outRoot]
 * @returns {string[]} written paths
 */
export function renderStyle(name, outRoot = "out") {
  return writeAll(renderStyleFiles(name, outRoot));
}

const USAGE = `Usage: node scripts/render-agents.mjs [--style NAME|all] [--out DIR]
  --style NAME  render one style (${STYLE_NAMES.join(", ")}) or "all" under DIR/styles/
  --out DIR     output root (default out)
Offline; nothing is signed or sent.`;

function parseArgs(argv) {
  const opts = { style: undefined, out: "out", help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") {
      opts.help = true;
    } else if (flag === "--style") {
      if (!value || value.startsWith("-")) throw new Error(`--style needs a name, got ${JSON.stringify(value)}`);
      if (value !== "all") getStyle(value); // throws "unknown style" with the valid names
      opts.style = value;
      i++;
    } else if (flag === "--out") {
      if (!value || value.startsWith("-")) throw new Error(`--out needs a directory, got ${JSON.stringify(value)}`);
      opts.out = value;
      i++;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return opts;
}

/** @param {string[]} argv @returns {string[]} written paths */
export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return [];
  }
  assertSafeOutDir(opts.out);
  if (opts.style === undefined) return renderAll(opts.out);
  const names = opts.style === "all" ? STYLE_NAMES : [opts.style];
  return writeAll(names.flatMap((n) => renderStyleFiles(n, opts.out)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const p of main(process.argv.slice(2))) console.log(p);
  } catch (err) {
    console.error(`render: ${String(err instanceof Error ? err.message : err).split("\n")[0]} (see --help)`);
    process.exit(2);
  }
}
