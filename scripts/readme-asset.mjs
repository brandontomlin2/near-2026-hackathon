// Refreshes the README's committed demo assets from a real offline demo run:
//   npm run readme-asset
// Writes docs/img/chaotic-share.svg (round 6 share card) and
// docs/img/chaotic-sheet.txt (Chaotic's round 6 sheet text). Never hand-edit them;
// scripts/readme-asset.test.mjs fails if they drift from what the demo generates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDemo } from "../src/demo/pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ASSET_DIR = path.join(ROOT, "docs", "img");
export const SHARE_NAME = "chaotic-share.svg";
export const SHEET_NAME = "chaotic-sheet.txt";

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = await generateAssets();
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  for (const [name, text] of Object.entries(assets)) {
    fs.writeFileSync(path.join(ASSET_DIR, name), text);
    console.log(`wrote docs/img/${name}`);
  }
}
