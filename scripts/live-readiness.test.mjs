// Pins what docs/live-readiness.md tells the owner to rely on the moment he says yes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as renderMain } from "./render-agents.mjs";
import { AGENTS, DEFAULT_WASM, tokenMetadata } from "./testnet-deploy.mjs";
import { TX_FILE_LABEL, SEND_COMMAND, evidenceCommand } from "./live-proof.mjs";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const doc = read("docs/live-readiness.md");
const pkg = JSON.parse(read("package.json"));

test("the files `npm run render` writes are the bytes each token's media_hash commits to", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-readiness-"));
  try {
    renderMain(["--out", dir]);
    for (const agent of AGENTS) {
      const bytes = readFileSync(join(dir, `${agent.token_id}.svg`));
      assert.equal(createHash("sha256").update(bytes).digest("base64"), tokenMetadata(agent).media_hash, agent.token_id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every `npm run <script>` in the live-readiness doc exists in package.json", () => {
  const used = [...doc.matchAll(/npm run ([a-z:-]+)/g)].map((m) => m[1]);
  assert.ok(used.length >= 6);
  for (const name of used) assert.ok(pkg.scripts[name], `npm run ${name} is not a package.json script`);
});

test("the doc quotes the wasm path, send command, tx file and evidence command the scripts use", () => {
  assert.ok(doc.includes(DEFAULT_WASM.split("/contracts/")[1]), "wasm path");
  assert.ok(doc.includes(SEND_COMMAND), "send command");
  assert.ok(doc.includes(TX_FILE_LABEL), "tx file");
  assert.ok(doc.includes(evidenceCommand("<contract>.testnet")), "evidence command");
});
