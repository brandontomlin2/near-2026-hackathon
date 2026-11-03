// Renders the four seeded agents (memory_depth 1).
//
//   node scripts/render-agents.mjs                   default style -> out/<id>.svg
//   node scripts/render-agents.mjs --style sticker   -> out/styles/sticker/<id>-<mood>.svg + sheet.svg
//   node scripts/render-agents.mjs --style all       every style under out/styles/
//   --out <dir>                                      output root (default: out)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AGENTS } from "../src/traits/agents.mjs";
import { renderSvg } from "../src/art/render.mjs";
import { renderSheet } from "../src/art/sheet.mjs";
import { STYLE_NAMES, getStyle } from "../src/art/styles/index.mjs";

/** @param {string} [outDir] @returns {string[]} written paths */
export function renderAll(outDir = "out") {
  mkdirSync(outDir, { recursive: true });
  return AGENTS.map((a) => {
    const path = join(outDir, `${a.id}.svg`);
    writeFileSync(path, renderSvg(a.traits));
    return path;
  });
}

/**
 * Every agent in every mood of one style, plus a contact sheet
 * (rows = agents, columns = moods).
 * @param {string} name
 * @param {string} [outRoot]
 * @returns {string[]} written paths
 */
export function renderStyle(name, outRoot = "out") {
  const style = getStyle(name);
  const dir = join(outRoot, "styles", style.name);
  mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const a of AGENTS) {
    for (const mood of style.moods) {
      const path = join(dir, `${a.id}-${mood}.svg`);
      writeFileSync(path, style.render(a.traits, { mood }));
      paths.push(path);
    }
  }
  const sheet = join(dir, "sheet.svg");
  writeFileSync(sheet, renderSheet(style, { moods: style.moods }));
  paths.push(sheet);
  return paths;
}

const USAGE = `Usage: node scripts/render-agents.mjs [--style NAME|all] [--out DIR]
  --style NAME  render one style (${STYLE_NAMES.join(", ")}) or "all" under DIR/styles/
  --out DIR     output root (default out)
Offline; nothing is signed or sent.`;

/** @param {string[]} argv @returns {string[]} written paths */
export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { style: { type: "string" }, out: { type: "string", default: "out" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return [];
  }
  if (values.style === undefined) return renderAll(values.out);
  const names = values.style === "all" ? STYLE_NAMES : [getStyle(values.style).name];
  return names.flatMap((n) => renderStyle(n, values.out));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const p of main(process.argv.slice(2))) console.log(p);
  } catch (err) {
    // First line only: node's parseArgs messages carry a long hint after it.
    console.error(`render: ${String(err instanceof Error ? err.message : err).split("\n")[0]}`);
    process.exit(2);
  }
}
