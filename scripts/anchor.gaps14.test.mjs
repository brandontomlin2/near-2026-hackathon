// Behaviour of scripts/anchor.mjs not pinned by anchor.test.mjs and the CLI suites:
// the shape and meaning of the printed report, the --check line, --help routing,
// and the exact process-level usage error.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hashSheet } from "../src/anchor/hash.mjs";
import { UsageError, main, mockReport, parseArgs } from "./anchor.mjs";

const SCRIPT = fileURLToPath(new URL("./anchor.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));

const cli = (args) =>
  spawnSync(process.execPath, ["--import", NO_NETWORK, SCRIPT, ...args], { encoding: "utf8" });

test("the report has exactly mode, status, transactionHash, roundHashes, sheetHash and anchor, with rounds numbered from 1", async () => {
  const r = await mockReport();
  assert.deepEqual(Object.keys(r).sort(), ["anchor", "mode", "roundHashes", "sheetHash", "status", "transactionHash"]);
  assert.deepEqual(r.roundHashes.map((x) => x.round), [1, 2, 3]);
  assert.equal(r.mode, "dry-run");
});

test("the anchor payload targets the mock contract and token, is a first anchor, and carries the sheet hash of the mock sheet", async () => {
  const { anchor, sheetHash } = await mockReport();
  assert.equal(anchor.contractId, "mock-contract.testnet");
  assert.equal(anchor.args.token_id, "aloof");
  assert.equal(anchor.firstAnchor, true);
  assert.equal(anchor.depositYocto, "10000000000000000000000");
  assert.equal(sheetHash, hashSheet("Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n"));
  assert.equal(anchor.args.sheet_hash, sheetHash);
});

test("--check output: the OK line names the round count, then the JSON; without --check there is only the JSON", async () => {
  const lines = [];
  assert.equal(await main(["--dry-run", "--check"], (l) => lines.push(l)), 0);
  assert.equal(lines[0], "OK: round hashes are deterministic (3 rounds, same mock run twice)");
  assert.equal(lines.length, 2);
  const plain = [];
  assert.equal(await main(["--dry-run"], (l) => plain.push(l)), 0);
  assert.equal(plain.length, 1);
  assert.equal(plain[0], lines[1], "the JSON is the same with and without --check");
});

test("parseArgs: --help and -h win over bad flags; the order of flags does not matter; errors are UsageError", () => {
  assert.deepEqual(parseArgs(["--bogus", "--help"]), { help: true });
  assert.deepEqual(parseArgs(["-h"]), { help: true });
  assert.deepEqual(parseArgs(["--check", "--dry-run"]), { help: false, check: true });
  assert.deepEqual(parseArgs(["--dry-run"]), { help: false, check: false });
  assert.throws(() => parseArgs(["--check"]), (e) => e instanceof UsageError && e.message === "--dry-run is required; this CLI never signs");
  assert.throws(() => parseArgs(["--dry-run", ""]), (e) => e instanceof UsageError && e.message === 'unknown argument ""');
});

test("--help prints the usage to stdout and returns 0 without building the report", async () => {
  const lines = [];
  assert.equal(await main(["--help"], (l) => lines.push(l)), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^usage: npm run anchor -- --dry-run \[--check\]/);
  assert.match(lines[0], /Offline: no keys, no network, nothing signed or sent\.$/);
});

test("process-level usage error: exact stderr, exit 2, empty stdout, and it never reaches the network guard", () => {
  const r = cli([]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "anchor: --dry-run is required; this CLI never signs (see --help)\n");
  const ok = cli(["--dry-run", "--check"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  assert.match(ok.stdout, /^OK: round hashes are deterministic \(3 rounds/);
});
