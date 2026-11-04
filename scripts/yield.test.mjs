import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { main } from "./yield.mjs";

const TESTNET_ENV = {
  NEAR_NETWORK: "testnet",
  YIELD_VAULT_ACCOUNT_ID: "vault.x.testnet",
  YIELD_RUNNER_ACCOUNT_ID: "runner.x.testnet",
};

/** Run main() in-process with captured output, a recording spawner and a fresh out dir. */
async function run(argv, env = {}, { spawnStatus = 0, hasNear } = {}) {
  const out = mkdtempSync(join(tmpdir(), "yield-cli-"));
  assertSafeOutDir(out);
  const stdout = [];
  const stderr = [];
  const calls = [];
  const io = {
    env,
    log: (...a) => stdout.push(a.join(" ")),
    err: (s) => stderr.push(String(s)),
    spawner: (bin, args) => {
      calls.push({ bin, args });
      return spawnStatus;
    },
    now: () => Date.UTC(2026, 10, 3),
  };
  if (hasNear) io.hasNear = hasNear;
  try {
    const code = await main([...argv, "--out", out], io);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls, out };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("mock mode with an empty env: exit 0, proposal, off-chain rules, dry-run execute_swap, no spawn", async () => {
  const r = await run([], {});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /proposal: pool /);
  assert.ok(r.stdout.includes("vault rules (off chain):"));
  assert.ok(r.stdout.includes("DRY RUN, not sent"));
  assert.match(r.stdout, /near contract call-function as-transaction \S+ execute_swap json-args /);
  assert.match(r.stdout, /scoreboard/);
  assert.deepEqual(r.calls, []);
});

test("the track record is written under DIR/yield/ledger.json", async () => {
  const out = mkdtempSync(join(tmpdir(), "yield-cli-"));
  try {
    const stdout = [];
    const code = await main(["--out", out], { env: {}, log: (s) => stdout.push(s), err: () => {}, spawner: () => assert.fail("no spawn") });
    assert.equal(code, 0);
    assert.ok(existsSync(join(out, "yield", "ledger.json")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("--send without --i-approve is refused and nothing is spawned", async () => {
  const r = await run(["--send", "--agent", "skeptic"], TESTNET_ENV, { hasNear: () => true });
  assert.notEqual(r.code, 0);
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, []);
});

test("--i-approve without --send is a usage error (2)", async () => {
  const r = await run(["--i-approve"], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--i-approve only applies together with --send/);
  assert.deepEqual(r.calls, []);
});

test("--send --i-approve without --agent is refused (2)", async () => {
  const r = await run(["--send", "--i-approve"], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls, []);
});

test("--send with NEAR_NETWORK=mainnet is refused and nothing is spawned", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic"], { ...TESTNET_ENV, NEAR_NETWORK: "mainnet" }, { hasNear: () => true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /mainnet/);
  assert.deepEqual(r.calls, []);
});

test("--send with a .near vault id is refused and the id is not echoed", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic"], { ...TESTNET_ENV, YIELD_VAULT_ACCOUNT_ID: "vault.x.near" }, { hasNear: () => true });
  assert.notEqual(r.code, 0);
  assert.ok(!r.stderr.includes("vault.x.near"));
  assert.deepEqual(r.calls, []);
});

test("NEAR_NETWORK=mainnet without --send is refused with exit 1", async () => {
  const r = await run([], { NEAR_NETWORK: "mainnet" });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.deepEqual(r.calls, []);
});

test("--send --i-approve --agent skeptic on testnet spawns only skeptic argv, all testnet", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic"], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.length >= 1, "skeptic should have sent at least one swap");
  for (const c of r.calls) {
    assert.equal(c.bin, "near");
    assert.ok(c.args.includes("testnet"));
    assert.ok(c.args.includes("execute_swap"));
    assert.ok(c.args.includes("vault.x.testnet"));
    assert.ok(c.args.includes("runner.x.testnet"));
    assert.ok(!c.args.some((a) => /mainnet/i.test(a)));
  }
  assert.match(r.stdout, /SENDING to testnet/);
});

test("--send argv count equals the skeptic executions in --json output", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--json", "--rounds", "2"], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dry_run, false);
  const shownExecs = doc.rounds.flatMap((x) => x.executions);
  assert.ok(shownExecs.every((x) => x.agent === "skeptic"));
  assert.equal(r.calls.length, shownExecs.length);
  assert.equal(doc.sent.length, shownExecs.length);
});

test("a failing near exit status stops the run with exit 1", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--rounds", "3"], TESTNET_ENV, { hasNear: () => true, spawnStatus: 7 });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1);
  assert.match(r.stderr, /status 7/);
});

test("--send refuses when near-cli-rs is not available", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic"], TESTNET_ENV, { hasNear: () => false });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test("--json parses, has dry_run true and a scoreboard with all four agents", async () => {
  const r = await run(["--json"], {});
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dry_run, true);
  assert.equal(doc.mode, "mock");
  assert.deepEqual(doc.scoreboard.map((s) => s.agent).sort(), ["aloof", "chaotic", "skeptic", "social"]);
  assert.deepEqual(doc.sent, []);
  assert.deepEqual(r.calls, []);
});

test("usage errors: unknown agent, bad rounds, unknown flag exit 2; --help exits 0", async () => {
  assert.equal((await run(["--agent", "nobody"])).code, 2);
  assert.equal((await run(["--rounds", "0"])).code, 2);
  assert.equal((await run(["--rounds", "51"])).code, 2);
  assert.equal((await run(["--bogus"])).code, 2);
  const h = await run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /^Usage: /);
});
