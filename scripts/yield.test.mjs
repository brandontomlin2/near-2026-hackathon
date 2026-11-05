import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { initialState } from "../src/yield/ledger.mjs";
import { defaultVaultConfig } from "../src/yield/strategies.mjs";
import { yieldMockResponder } from "../src/yield/mock.mjs";
import { main } from "./yield.mjs";

const NOW_MS = Date.UTC(2026, 10, 3);
const TESTNET_ENV = {
  NEAR_NETWORK: "testnet",
  YIELD_VAULT_ACCOUNT_ID: "vault.x.testnet",
  YIELD_RUNNER_ACCOUNT_ID: "runner.x.testnet",
};

/** Write a --vault-state file (the target vault's get_config()/get_state()) and return its path. */
function vaultStateFile(overrides = {}, agent = "skeptic") {
  const dir = mkdtempSync(join(tmpdir(), "yield-vs-"));
  const doc = { config: defaultVaultConfig(agent, { runner: "runner.x.testnet" }), state: initialState(), vault_id: "vault.x.testnet", fetched_at: new Date(NOW_MS - 60_000).toISOString(), block_height: 123456, ...overrides };
  const file = join(dir, "vault.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}
const VS = (agent = "skeptic") => ["--vault-state", vaultStateFile({}, agent)];

/**
 * Under the shipped mock, --send (one round only) cannot reach the sender: in round 1 every
 * pool 1 proposal (aloof, social, skeptic) is refused as SOFT_OFF_REFERENCE and chaotic's
 * full-size wNEAR trade is vetoed by skeptic. To still exercise the send gate end to end, this
 * stub model answers chaotic with the mock's round 2 proposal (a modest wNEAR swap that passes the
 * vault rules, the strategy checks and the skeptic's audit); every other answer is the real mock's.
 */
const chaoticModest = (request) => {
  const facts = JSON.parse(request.messages.at(-1).content);
  if (facts.agent === "chaotic" && facts.task === "propose") facts.round = 2;
  return yieldMockResponder({ ...request, messages: [{ role: "user", content: JSON.stringify(facts) }] });
};
const CHAOTIC_SEND = ["--send", "--i-approve", "--agent", "chaotic"];

/** Run main() in-process with captured output, a recording spawner and a fresh out dir. */
async function run(argv, env = {}, { spawnStatus = 0, hasNear, responder } = {}) {
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
  // chaotic is the only agent with a sendable swap, and only with the stub model (see chaoticModest).
  if (responder ?? (argv.includes("chaotic") && argv.includes("--send") ? chaoticModest : null)) io.responder = responder ?? chaoticModest;
  try {
    const code = await main([...argv, "--out", out], io);
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls, out };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("mock mode with an empty env: exit 0, proposal, reference line, refusal, off-chain rules, no spawn", async () => {
  const r = await run([], {});
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /proposal: pool /);
  assert.ok(r.stdout.includes("vault rules (off chain):"));
  assert.ok(r.stdout.includes("DRY RUN, not sent (nothing is signed)"));
  // Round 1: the stable pool 1 is ~1860x off its $1 peg, so aloof, social and skeptic are refused and nothing executes.
  assert.equal((r.stdout.match(/^ {2}reference: quote \+1[0-9]{7} bps vs mock_usd_price reference \(limit 100 bps, stable pair: OFF REFERENCE\)$/gm) ?? []).length, 3);
  assert.ok(r.stdout.includes("reference: no reference price (rft has none): the floor is a spot sanity floor"));
  assert.equal((r.stdout.match(/strategy checks: SOFT_OFF_REFERENCE: pool 1 quote is \+\d+ bps off the reference price \(limit 100 bps for a stable pair\)/g) ?? []).length, 3);
  assert.equal((r.stdout.match(/outcome: rejected_soft/g) ?? []).length, 3);
  assert.doesNotMatch(r.stdout, /near contract call-function/);
  assert.match(r.stdout, /scoreboard/);
  assert.deepEqual(r.calls, []);
});

test("5 rounds --json: aloof and skeptic never trade, every pool 1 decision is refused with SOFT_OFF_REFERENCE or ERR_PRICE_FLOOR and carries the deviation", async () => {
  const r = await run(["--rounds", "5", "--json"], {});
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dry_run, true);
  const board = Object.fromEntries(doc.scoreboard.map((x) => [x.agent, x]));
  for (const id of ["aloof", "skeptic", "social"]) {
    assert.equal(board[id].trades, 0, `${id} trades`);
    assert.equal(board[id].pnl_micro_usd, "0", `${id} has no P&L loss`);
  }
  let pool1 = 0;
  for (const round of doc.rounds) {
    for (const x of round.executions) assert.notEqual(x.proposal.pool_id, 1, "no execute_swap on pool 1");
    for (const [id, d] of Object.entries(round.decisions)) {
      if (d.proposal?.pool_id !== 1) continue;
      pool1++;
      assert.ok(["rejected_soft", "rejected_hard"].includes(d.outcome), `${id} round ${round.round}: ${d.outcome}`);
      assert.ok(JSON.stringify([d.hard, d.soft]).match(/SOFT_OFF_REFERENCE|ERR_PRICE_FLOOR/), `${id} round ${round.round}`);
      assert.equal(d.max_reference_deviation_bps, 100);
      assert.equal(typeof d.reference_deviation_bps, "number");
      assert.ok(Math.abs(d.reference_deviation_bps) > 100);
    }
    assert.equal(round.decisions.chaotic.max_reference_deviation_bps, null, "rft has no reference price");
  }
  assert.ok(pool1 >= 10, `expected the stable agents to try pool 1 in most rounds (saw ${pool1})`);
});

test("round 2 (no pool 1 swap executes): chaotic's passing wNEAR swap is printed as a dry-run execute_swap, no spawn", async () => {
  const r = await run(["--rounds", "2"], {});
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("DRY RUN, not sent:"));
  assert.match(r.stdout, /near contract call-function as-transaction \S+ execute_swap json-args /);
  assert.doesNotMatch(r.stdout, /execute_swap json-args .*"pool_id":1/);
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

// chaotic, not skeptic: with a funded, unpaused snapshot chaotic sends exactly one swap (the control),
// so a zero-call result below can only come from the snapshot's state or config. skeptic sends nothing
// in round 1 either way, which made these assertions pass even when --send ignored the snapshot.
test("--send checks proposals against the vault's real state: a paused vault gets no transaction", async () => {
  const control = await run([...CHAOTIC_SEND, "--vault-state", vaultStateFile({}, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(control.code, 0, control.stderr);
  assert.equal(control.calls.length, 1, "control: the same snapshot unpaused sends chaotic's swap");
  const paused = { ...initialState(), paused: true };
  const r = await run([...CHAOTIC_SEND, "--json", "--vault-state", vaultStateFile({ state: paused }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "the snapshot's paused flag must block the swap");
  assert.match(r.stdout, /ERR_PAUSED/);
});

test("--send checks proposals against the vault's real config: a vault with no limits gets no transaction", async () => {
  const config = { ...defaultVaultConfig("chaotic", { runner: "runner.x.testnet" }), limits: [] };
  const r = await run([...CHAOTIC_SEND, "--json", "--vault-state", vaultStateFile({ config }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "the snapshot's empty limits must block the swap (the demo config would allow it)");
  // The agent sizes off its limits, so with none it proposes nothing sendable; the vault rules say so.
  const d = JSON.parse(r.stdout).rounds[0].decisions.chaotic;
  assert.equal(d.hard.ok, false, "the off-chain hard rules reject it under the snapshot's config");
  assert.equal(d.outcome, "rejected_hard");
});

test("--send checks proposals against the snapshot's config, not the demo config: a vault that has not approved this runner gets no transaction", async () => {
  // Control: with the demo config (runner approved), chaotic's modest swap passes and is sent.
  const demo = await run([...CHAOTIC_SEND, "--vault-state", vaultStateFile({}, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(demo.code, 0, demo.stderr);
  assert.equal(demo.calls.length, 1, "the demo config accepts chaotic's swap");
  // Same state and proposal, but the real vault's owner approved a different runner. Only the
  // snapshot's config says so, so the swap is blocked only if --send uses that config.
  const config = { ...defaultVaultConfig("chaotic", { runner: "runner.x.testnet" }), runners: ["other.x.testnet"] };
  const r = await run([...CHAOTIC_SEND, "--vault-state", vaultStateFile({ config }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "the vault's real runner list must block the swap");
  assert.match(r.stdout, /ERR_NOT_RUNNER: runner\.x\.testnet is not an approved runner/);
  assert.doesNotMatch(r.stdout, /execute_swap/);
});

test("--send refuses a vault-state that does not name the target vault, or names another one", async () => {
  for (const [vault_id, why] of [[undefined, /needs "vault_id"/], ["other.x.testnet", /vault_id other\.x\.testnet is not the target vault vault\.x\.testnet/]]) {
    const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile({ vault_id })], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, why);
    assert.match(r.stderr, /Nothing was sent/);
    assert.deepEqual(r.calls, []);
  }
});

test("--send refuses a vault-state whose config strategy is not the --agent's", async () => {
  const config = defaultVaultConfig("chaotic", { runner: "runner.x.testnet" });
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile({ config })], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /config\.strategy chaotic is not --agent skeptic/);
  assert.deepEqual(r.calls, []);
});

test("--vault-state without --send is a usage error (2)", async () => {
  const r = await run(["--vault-state", vaultStateFile()], {});
  assert.equal(r.code, 2);
});

test("--send --i-approve --agent skeptic sends nothing: its pool 1 hedge is refused as off reference", async () => {
  const r = await run(["--send", "--i-approve", "--agent", "skeptic", ...VS()], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "no execute_swap for an off-peg pool");
  assert.match(r.stdout, /SENDING to testnet/);
  assert.match(r.stdout, /SOFT_OFF_REFERENCE: pool 1 quote is \+18490000 bps off the reference price/);
  assert.match(r.stdout, /outcome: rejected_soft/);
});

test("--send --i-approve --agent chaotic on testnet spawns only chaotic argv, all testnet", async () => {
  const r = await run([...CHAOTIC_SEND, ...VS("chaotic")], TESTNET_ENV, { hasNear: () => true, responder: chaoticModest });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.calls.length, 1, "chaotic should have sent its one swap");
  for (const c of r.calls) {
    assert.equal(c.bin, "near");
    assert.ok(c.args.includes("testnet"));
    assert.ok(c.args.includes("execute_swap"));
    assert.ok(c.args.includes("vault.x.testnet"));
    assert.ok(c.args.includes("runner.x.testnet"));
    assert.ok(!c.args.some((a) => /mainnet/i.test(a)));
  }
  assert.match(r.stdout, /SENDING to testnet/);
  assert.match(r.stdout, /reference: no reference price \(rft has none\)/);
});

test("--send argv count equals the chaotic executions in --json output", async () => {
  const r = await run([...CHAOTIC_SEND, "--json", ...VS("chaotic")], TESTNET_ENV, { hasNear: () => true, responder: chaoticModest });
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.dry_run, false);
  const shownExecs = doc.rounds.flatMap((x) => x.executions);
  assert.equal(shownExecs.length, 1);
  assert.ok(shownExecs.every((x) => x.agent === "chaotic"));
  assert.equal(r.calls.length, shownExecs.length);
  assert.equal(doc.sent.length, shownExecs.length);
});

test("a failing near exit status stops the run with exit 1", async () => {
  const r = await run([...CHAOTIC_SEND, ...VS("chaotic")], TESTNET_ENV, { hasNear: () => true, spawnStatus: 7, responder: chaoticModest });
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

const SEND = ["--send", "--i-approve", "--agent", "chaotic"];

test("M1: --send in mock mode uses the real clock, not the mock epoch", async () => {
  const r = await run([...SEND, "--json", ...VS("chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).rounds[0].now_ms, NOW_MS);
});

test("M1: --send refuses a vault-state whose spent.day is in the future", async () => {
  const day = Math.floor(NOW_MS / 86_400_000) + 1;
  const state = { ...initialState(), spent: { day, amounts: {} } };
  const r = await run([...SEND, "--vault-state", vaultStateFile({ state }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /spent\.day is in the future/);
  assert.deepEqual(r.calls, []);
});

test("M1: the daily cap is enforced off chain against the real day under --send", async () => {
  const day = Math.floor(NOW_MS / 86_400_000);
  const config = defaultVaultConfig("chaotic", { runner: "runner.x.testnet" });
  const amounts = Object.fromEntries(config.limits.map((l) => [l.token_id, l.daily_cap]));
  const state = { ...initialState(), spent: { day, amounts } };
  const r = await run([...SEND, "--vault-state", vaultStateFile({ state }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, [], "cap already spent today: nothing may be sent");
});

test("M2: --send refuses a vault-state without fetched_at or block_height", async () => {
  for (const o of [{ fetched_at: undefined }, { block_height: undefined }, { fetched_at: "not a date" }, { block_height: 0 }, { block_height: "5" }]) {
    const r = await run([...SEND, "--vault-state", vaultStateFile(o, "chaotic")], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 1, JSON.stringify(o));
    assert.match(r.stderr, /fetched_at/);
    assert.deepEqual(r.calls, []);
  }
});

test("M2: --send refuses a stale vault-state and one fetched in the future", async () => {
  const stale = await run([...SEND, "--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS - 11 * 60_000).toISOString() }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /stale/);
  const future = await run([...SEND, "--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS + 10 * 60_000).toISOString() }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(future.code, 1);
  assert.match(future.stderr, /in the future/);
  assert.deepEqual([...stale.calls, ...future.calls], []);
  const fresh = await run([...SEND, ...["--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS - 9 * 60_000).toISOString() }, "chaotic")]], TESTNET_ENV, { hasNear: () => true });
  assert.equal(fresh.code, 0, fresh.stderr);
});

test("L1: --send refuses vault === runner", async () => {
  const r = await run([...SEND, ...VS("chaotic")], { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: "vault.x.testnet" }, { hasNear: () => true });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /different accounts/);
  assert.deepEqual(r.calls, []);
});

test("L3: --send does not write simulated P&L into the ledger", async () => {
  const out = mkdtempSync(join(tmpdir(), "yield-cli-"));
  try {
    const code = await main([...SEND, ...VS("chaotic"), "--out", out], { env: TESTNET_ENV, log: () => {}, err: () => {}, spawner: () => 0, hasNear: () => true, now: () => NOW_MS });
    assert.equal(code, 0);
    assert.ok(!existsSync(join(out, "yield", "ledger.json")), "no ledger written under --send");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// --- raw get_state() as the Rust contract serializes it: [token, amount] pairs, U128 strings ---

const TODAY = Math.floor(NOW_MS / 86_400_000);

/** The documented get_state() JSON (contracts/yield-vault VaultState), funded like the demo state. */
function rawState(over = {}) {
  return {
    owner_id: "owner.x.testnet",
    nft_contract_id: "nft.x.testnet",
    token_id: "1",
    ref_exchange_id: "ref-finance-101.testnet",
    paused: false,
    swap_in_flight: false,
    recovery_in_flight: false,
    release_in_flight: false,
    day: TODAY,
    spent_today: [],
    balances: Object.entries(initialState().balances),
    stranded_on_ref: [],
    unverified_on_ref: [],
    swaps_executed: 0,
    ...over,
  };
}
const sendRaw = (state) => run([...SEND, "--vault-state", vaultStateFile({ state }, "chaotic")], TESTNET_ENV, { hasNear: () => true });

test("raw get_state(): a funded proposal within limits is accepted and one swap is sent", async () => {
  const r = await sendRaw(rawState());
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.length >= 1, "pairs-shaped balances must fund the proposal");
  assert.ok(r.calls.every((c) => c.args.includes("execute_swap")));
});

test("raw get_state(): spent_today already at the daily cap rejects with ERR_DAILY_CAP", async () => {
  const config = defaultVaultConfig("chaotic", { runner: "runner.x.testnet" });
  const spent_today = config.limits.map((l) => [l.token_id, l.daily_cap]);
  const r = await run([...SEND, "--json", "--vault-state", vaultStateFile({ state: rawState({ spent_today }) }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.match(r.stdout, /ERR_DAILY_CAP/);
});

test("raw get_state(): swap, recovery or release in flight each reject with ERR_SWAP_IN_FLIGHT", async () => {
  for (const flag of ["swap_in_flight", "recovery_in_flight", "release_in_flight"]) {
    const r = await run([...SEND, "--json", "--vault-state", vaultStateFile({ state: rawState({ [flag]: true }) }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 0, `${flag}: ${r.stderr}`);
    assert.deepEqual(r.calls, [], flag);
    assert.match(r.stdout, /ERR_SWAP_IN_FLIGHT/, flag);
  }
});

test("raw get_state(): paused rejects", async () => {
  const r = await sendRaw(rawState({ paused: true }));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls, []);
});

test("raw get_state(): an empty or short balances list rejects with ERR_INSUFFICIENT_BALANCE", async () => {
  for (const balances of [[], Object.entries(initialState().balances).map(([t]) => [t, "1"])]) {
    const r = await run([...SEND, "--json", "--vault-state", vaultStateFile({ state: rawState({ balances }) }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls, []);
    assert.match(r.stdout, /ERR_INSUFFICIENT_BALANCE/);
  }
});

test("raw get_state(): spent_today from a previous day does not count", async () => {
  const config = defaultVaultConfig("chaotic", { runner: "runner.x.testnet" });
  const spent_today = config.limits.map((l) => [l.token_id, l.daily_cap]);
  const r = await sendRaw(rawState({ day: TODAY - 1, spent_today }));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.calls.length >= 1, "yesterday's spend must not block today's swap");
});

test("raw get_state(): a day in the future is refused", async () => {
  const r = await sendRaw(rawState({ day: TODAY + 1 }));
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls, []);
});

test("mirror-shaped state: a snapshot missing paused, in_flight or spent is refused, never read as unpaused, idle and unspent", async () => {
  const full = initialState();
  const [tok] = Object.keys(full.balances);
  const day = Math.floor(NOW_MS / 86_400_000);
  const bad = [
    { balances: full.balances }, // the bare balances: every lock and the cap would default open
    { ...full, paused: undefined },
    { ...full, paused: "false" },
    { ...full, in_flight: undefined },
    { ...full, in_flight: 0 },
    { ...full, spent: undefined },
    { ...full, spent: { day } },
    { ...full, spent: { day: "1", amounts: {} } },
    { ...full, spent: { day, amounts: { [tok]: 5 } } },
    { ...full, spent: { day, amounts: [] } },
    { ...full, balances: undefined },
    { ...full, balances: [] },
    { ...full, balances: { [tok]: "-1" } },
    { ...full, balances: { [tok]: "340282366920938463463374607431768211456" } },
  ];
  for (const state of bad) {
    const r = await run([...SEND, "--vault-state", vaultStateFile({ state }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
    assert.equal(r.code, 1, `must refuse ${JSON.stringify(state).slice(0, 120)}`);
    assert.match(r.stderr, /--vault-state state\.\S+ (must|amount)/);
    assert.match(r.stderr, /Nothing was sent/);
    assert.deepEqual(r.calls, []);
  }
});

test("mirror-shaped state: a complete snapshot is still accepted and its daily spend still counts", async () => {
  const day = Math.floor(NOW_MS / 86_400_000);
  const ok = await run([...SEND, "--vault-state", vaultStateFile({ state: initialState() }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.calls.length >= 1, "a complete, funded mirror state must still send");
  const busy = await run([...SEND, "--vault-state", vaultStateFile({ state: { ...initialState(), in_flight: true, spent: { day, amounts: {} } } }, "chaotic")], TESTNET_ENV, { hasNear: () => true });
  assert.equal(busy.code, 0, busy.stderr);
  assert.deepEqual(busy.calls, [], "a swap in flight blocks the next one");
});

test("raw get_state(): malformed pairs, amounts, flags or duplicates are refused and nothing is sent", async () => {
  const [tok] = Object.keys(initialState().balances);
  const bad = [
    { balances: [[tok]] },
    { balances: [[tok, "1", "2"]] },
    { balances: [[tok, 5]] },
    { balances: [[tok, "-1"]] },
    { balances: [[tok, "1.5"]] },
    { balances: [[tok, "0x10"]] },
    { balances: [[tok, "01"]] },
    { balances: [[tok, "340282366920938463463374607431768211456"]] },
    { balances: [["", "1"]] },
    { balances: [[tok, "1"], [tok, "2"]] },
    { balances: { [tok]: "1" } },
    { spent_today: [[tok, "x"]] },
    { spent_today: "none" },
    { swap_in_flight: undefined },
    { recovery_in_flight: "false" },
    { release_in_flight: undefined },
    { paused: undefined },
    { day: "5" },
    { day: -1 },
  ];
  for (const o of bad) {
    const r = await sendRaw(rawState(o));
    assert.equal(r.code, 1, JSON.stringify(o));
    assert.match(r.stderr, /--vault-state state/, JSON.stringify(o));
    assert.deepEqual(r.calls, [], JSON.stringify(o));
  }
});
