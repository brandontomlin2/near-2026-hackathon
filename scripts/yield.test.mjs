import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { initialState } from "../src/yield/ledger.mjs";
import { defaultVaultConfig } from "../src/yield/strategies.mjs";
import { main } from "./yield.mjs";

const NOW_MS = Date.UTC(2026, 10, 3);
const TESTNET_ENV = {
  NEAR_NETWORK: "testnet",
  YIELD_VAULT_ACCOUNT_ID: "vault.x.testnet",
  YIELD_RUNNER_ACCOUNT_ID: "runner.x.testnet",
};

/** Write a --vault-state file (the target vault's get_config()/get_state()) and return its path. */
function vaultStateFile(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yield-vs-"));
  const doc = { config: defaultVaultConfig("skeptic", { runner: "runner.x.testnet" }), state: initialState(), fetched_at: new Date(NOW_MS - 60_000).toISOString(), block_height: 123456, ...overrides };
  const file = join(dir, "vault.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}
const VS = () => ["--vault-state", vaultStateFile()];

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
    now: () => NOW_MS,
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

test("--send with --rounds > 1 is a usage error (2) and nothing is spawned", async () => {
  for (const argv of [
    ["--send", "--i-approve", "--agent", "skeptic", "--rounds", "2"],
    ["--rounds", "50", "--send", "--i-approve", "--agent", "skeptic"],
  ]) {
    const r = await run(argv, TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--rounds greater than 1 cannot be combined with --send/);
    assert.deepEqual(r.calls, []);
    assert.equal(r.stdout, "");
  }
  // One round with --send, and many rounds as a dry run, stay allowed.
  assert.equal((await run(["--send", "--i-approve", "--agent", "skeptic", "--rounds", "1", ...VS()], TESTNET_ENV, { hasNear: () => true })).code, 0);
  assert.equal((await run(["--rounds", "3"])).code, 0);
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

test("--send without --vault-state is refused with exit 1 and nothing is spawned", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic"], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--send needs --vault-state FILE/);
  assert.deepEqual(r.calls, []);
});

test("--send with an unreadable or incomplete --vault-state is refused and nothing is spawned", async () => {
  const missing = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", "/nonexistent/vault.json"], TESTNET_ENV, { hasNear: () => true });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read --vault-state/);
  assert.deepEqual(missing.calls, []);
  const noState = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile({ state: null })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(noState.code, 1);
  assert.match(noState.stderr, /needs both "config" and "state"/);
  assert.deepEqual(noState.calls, []);
});

test("--send checks proposals against the vault's real state: a paused vault gets no transaction", async () => {
  const paused = { ...initialState(), paused: true };
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile({ state: paused })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.doesNotMatch(r.stdout, /execute_swap/);
});

test("--send checks proposals against the vault's real config: a vault with no limits gets no transaction", async () => {
  const config = { ...defaultVaultConfig("skeptic", { runner: "runner.x.testnet" }), limits: [] };
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile({ config })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});

test("--vault-state without --send is a usage error (2)", async () => {
  const r = await run(["--vault-state", vaultStateFile()], {});
  assert.equal(r.code, 2);
});

test("--send --i-approve --agent skeptic on testnet spawns only skeptic argv, all testnet", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", ...VS()], TESTNET_ENV, { hasNear: () => true });
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
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--json", ...VS()], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dry_run, false);
  const shownExecs = doc.rounds.flatMap((x) => x.executions);
  assert.ok(shownExecs.every((x) => x.agent === "skeptic"));
  assert.equal(r.calls.length, shownExecs.length);
  assert.equal(doc.sent.length, shownExecs.length);
});

test("a failing near exit status stops the run with exit 1", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", ...VS()], TESTNET_ENV, { hasNear: () => true, spawnStatus: 7 });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1);
  assert.match(r.stderr, /status 7/);
});

test("--send refuses when near-cli-rs is not available", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", ...VS()], TESTNET_ENV, { hasNear: () => false });
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

const SEND = ["--send", "--i-approve", "--agent", "skeptic"];

test("M1: --send in mock mode uses the real clock, not the mock epoch", async () => {
  const r = await run([...SEND, "--json", ...VS()], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).rounds[0].now_ms, NOW_MS);
});

test("M1: --send refuses a vault-state whose spent.day is in the future", async () => {
  const day = Math.floor(NOW_MS / 86_400_000) + 1;
  const state = { ...initialState(), spent: { day, amounts: {} } };
  const r = await run([...SEND, "--vault-state", vaultStateFile({ state })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /spent\.day is in the future/);
  assert.deepEqual(r.calls, []);
});

test("M1: the daily cap is enforced off chain against the real day under --send", async () => {
  const day = Math.floor(NOW_MS / 86_400_000);
  const config = defaultVaultConfig("skeptic", { runner: "runner.x.testnet" });
  const amounts = Object.fromEntries(config.limits.map((l) => [l.token_id, l.daily_cap]));
  const state = { ...initialState(), spent: { day, amounts } };
  const r = await run([...SEND, "--vault-state", vaultStateFile({ state })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "cap already spent today: nothing may be sent");
});

test("M2: --send refuses a vault-state without fetched_at or block_height", async () => {
  for (const o of [{ fetched_at: undefined }, { block_height: undefined }, { fetched_at: "not a date" }, { block_height: 0 }, { block_height: "5" }]) {
    const r = await run([...SEND, "--vault-state", vaultStateFile(o)], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 1, JSON.stringify(o));
    assert.match(r.stderr, /fetched_at/);
    assert.deepEqual(r.calls, []);
  }
});

test("M2: --send refuses a stale vault-state and one fetched in the future", async () => {
  const stale = await run([...SEND, "--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS - 11 * 60_000).toISOString() })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /stale/);
  const future = await run([...SEND, "--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS + 10 * 60_000).toISOString() })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(future.code, 1);
  assert.match(future.stderr, /in the future/);
  assert.deepEqual([...stale.calls, ...future.calls], []);
  const fresh = await run([...SEND, ...["--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS - 9 * 60_000).toISOString() })]], TESTNET_ENV, { hasNear: () => true });
  assert.equal(fresh.code, 0, fresh.stderr);
});

test("L1: --send refuses vault === runner", async () => {
  const r = await run([...SEND, ...VS()], { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: "vault.x.testnet" }, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /different accounts/);
  assert.deepEqual(r.calls, []);
});

test("L3: --send does not write simulated P&L into the ledger", async () => {
  const out = mkdtempSync(join(tmpdir(), "yield-cli-"));
  try {
    const code = await main([...SEND, ...VS(), "--out", out], { env: TESTNET_ENV, log: () => {}, err: () => {}, spawner: () => 0, hasNear: () => true, now: () => NOW_MS });
    assert.equal(code, 0);
    assert.ok(!existsSync(join(out, "yield", "ledger.json")), "no ledger written under --send");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
