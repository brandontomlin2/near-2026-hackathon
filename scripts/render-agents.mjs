// Renders the four seeded agents (memory_depth 1) to <outDir>/<id>.svg.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../src/traits/agents.mjs";
import { renderSvg } from "../src/art/render.mjs";

/** @param {string} [outDir] @returns {string[]} written paths */
export function renderAll(outDir = "out") {
  mkdirSync(outDir, { recursive: true });
  return AGENTS.map((a) => {
    const path = join(outDir, `${a.id}.svg`);
    writeFileSync(path, renderSvg(a.traits));
    return path;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const p of renderAll()) console.log(p);
}
