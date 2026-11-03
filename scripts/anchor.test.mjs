import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runSwarm } from "../src/swarm/runner.mjs";
import { buildMockRun, main, mockReport } from "./anchor.mjs";

const run = async (argv) => {
  const lines = [];
  const code = await main(argv, (l) => lines.push(l));
  return { code, lines };
};

test("same mock run gives the same round hashes and payload", async () => {
  const a = await mockReport();
  const b = await mockReport();
  assert.deepEqual(a, b);
  assert.deepEqual(await buildMockRun(), await buildMockRun());
  assert.equal(a.roundHashes.length, 3);
  for (const { hash } of a.roundHashes) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.roundHashes[0].hash, a.roundHashes[1].hash);
});

test("report is a dry run: no transaction, signing still required", async () => {
  const r = await mockReport();
  assert.equal(r.status, "dry-run");
  assert.equal(r.transactionHash, null);
  assert.equal(r.anchor.methodName, "anchor_sheet");
  assert.equal(r.anchor.network, "testnet");
  assert.equal(r.anchor.signing, "required");
  assert.equal(r.anchor.args.sheet_hash, r.sheetHash);
});

test("--dry-run --check prints OK and JSON", async () => {
  const { code, lines } = await run(["--dry-run", "--check"]);
  assert.equal(code, 0);
  assert.match(lines[0], /^OK: round hashes are deterministic/);
  assert.equal(JSON.parse(lines[1]).mode, "dry-run");
});

test("refuses without --dry-run and on unknown flags", async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--live"])).code, 2);
  assert.equal((await run(["--dry-run", "--live"])).code, 2);
});

test("CLI process exits 0 and prints the payload", () => {
  const r = spawnSync(process.execPath, [new URL("./anchor.mjs", import.meta.url).pathname, "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).anchor.methodName, "anchor_sheet");
});

test("round hashes are the swarm hash chain", async () => {
  const run = await runSwarm({ rounds: 3, seed: 1 });
  const r = await mockReport();
  assert.deepEqual(r.roundHashes.map((x) => x.hash), run.roundHashes);
});
