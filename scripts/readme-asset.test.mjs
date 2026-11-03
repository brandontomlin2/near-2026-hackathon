import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { generateAssets, ASSET_DIR, SHARE_NAME, SHEET_NAME } from "./readme-asset.mjs";

test("committed README assets match what the demo generates (refresh: npm run readme-asset)", async () => {
  const assets = await generateAssets();
  for (const [name, text] of Object.entries(assets)) {
    const committed = fs.readFileSync(path.join(ASSET_DIR, name), "utf8");
    assert.equal(committed, text, `docs/img/${name} drifted; run npm run readme-asset`);
  }
});

test("README embeds the committed image and quotes the committed sheet", () => {
  const readme = fs.readFileSync(path.join(ASSET_DIR, "..", "..", "README.md"), "utf8");
  assert.ok(readme.includes(`docs/img/${SHARE_NAME}`), "README must embed the share card");
  const sheet = fs.readFileSync(path.join(ASSET_DIR, SHEET_NAME), "utf8").trim();
  const quoted = readme.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ");
  assert.ok(quoted.includes(sheet), "README must quote the committed sheet text verbatim");
});
