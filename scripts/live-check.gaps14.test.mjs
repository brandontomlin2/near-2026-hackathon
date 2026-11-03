// Process-level behaviour of scripts/live-check.mjs not pinned elsewhere: the exact
// usage and unknown-argument messages and exit codes, with a preloaded network guard
// so the no-argument paths provably make no request when no account is set.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./live-check.mjs";

const SCRIPT = fileURLToPath(new URL("./live-check.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));

function cli(t, args, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "live-check-gaps14-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, NODE_OPTIONS: `--import ${NO_NETWORK}`, ...env },
  });
}

test("--help and -h print the usage on stdout, exit 0, and do not run the checklist", (t) => {
  for (const flag of ["--help", "-h"]) {
    const r = cli(t, [flag]);
    assert.equal(r.status, 0, flag);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^Usage: node scripts\/live-check\.mjs \[--offline\]\n/);
    assert.match(r.stdout, /account ids are never\s+printed/);
    assert.doesNotMatch(r.stdout, /\[(ok|todo|skip)\]/);
  }
});

test("an unknown argument exits 2 with exactly one stderr line, empty stdout and no checklist", (t) => {
  const r = cli(t, ["--bogus"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, 'live-check: unknown argument "--bogus"; the only option is --offline (see --help)\n');
  const positional = cli(t, ["stray"]);
  assert.equal(positional.status, 2);
  assert.match(positional.stderr, /unknown argument "stray"/);
});

test("--help wins over an unknown argument", (t) => {
  const r = cli(t, ["--bogus", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage:/);
});

test("with a mainnet NEAR_NETWORK the checklist is not ready and the todo names the allowed value without echoing the account", async () => {
  const r = await check(
    { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet", NEAR_NETWORK: "mainnet" },
    { statWasm: () => 10, fetch: async () => ({ json: async () => ({ result: {} }) }), wasm: "/w.wasm" },
  );
  assert.equal(r.ready, false);
  assert.ok(r.lines.includes("[todo] NEAR_NETWORK must be unset or testnet"));
  assert.equal(r.lines.at(-1), "ready: no. Fix the [todo] items above.");
  assert.ok(!r.lines.join("\n").includes("mainnet"), "the bad value is not printed");
});

test("the wasm line shows its path and byte size when built", async () => {
  const r = await check({}, { statWasm: () => 1234, fetch: async () => assert.fail("no request"), wasm: "/some/where.wasm" });
  assert.equal(r.lines[0], "[ok]   wasm built: /some/where.wasm (1234 bytes)");
});
