// Regression (#189 review): verify.sh --live must still FAIL its deploy nft stage
// when the contract wasm is missing. The --json plan skips the wasm gate, so
// verify.sh must not pass --json to deploy:nft, and the plain dry run must fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./testnet-deploy.mjs";

test("verify.sh runs the deploy nft stage without --json (keeps the wasm gate)", () => {
  const sh = readFileSync(new URL("./verify.sh", import.meta.url), "utf8");
  const line = sh.split("\n").find((l) => l.startsWith('planned "deploy nft"'));
  assert.ok(line, "deploy nft stage present");
  assert.doesNotMatch(line, /--json/);
});

test("deploy dry run with no wasm built fails (what verify.sh --live sees)", async () => {
  const errs = [];
  const missing = join(tmpdir(), `no-such-wasm-${process.pid}-${Date.now()}.wasm`);
  const env = { NEAR_NETWORK: "testnet", NEAR_ACCOUNT_ID: "owner.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.owner.testnet" };
  const code = await run(["deploy", "--wasm", missing], env, { out: () => {}, err: (l) => errs.push(l) });
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /wasm not found/);
});
