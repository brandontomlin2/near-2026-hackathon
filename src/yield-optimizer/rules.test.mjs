// Behaviour tests for the off-chain check_rules mirror (rules.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSnapshot } from "./snapshot.mjs";
import { checkRules, dayOf, meetsFloor, NS_PER_DAY, spentOn, U128_MAX, validateConfig } from "./rules.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/rhea-testnet-snapshot.json", import.meta.url));
const snapshot = () => parseSnapshot(JSON.parse(readFileSync(FIXTURE, "utf8")));

const WNEAR = "wrap.testnet";
const USDC = "usdc.fixture.testnet";
const DAI = "dai.fixture.testnet";

/** Fresh vault + a valid wNEAR -> USDC proposal on pool 17 (100 wNEAR for 300 USDC, exactly the floor). */
function setup() {
  const snap = snapshot();
  const vault = structuredClone(snap.vault);
  const proposal = {
    pool_id: 17,
    token_in: WNEAR,
    token_out: USDC,
    amount_in: 10n ** 26n,
    min_amount_out: 300_000_000n,
  };
  return { snap, vault, runner: snap.runner_id, nowNs: snap.now_ns, proposal };
}

const check = (s, over = {}, vaultFn) => {
  if (vaultFn) vaultFn(s.vault);
  return checkRules(s.vault, { ...s.proposal, ...over }, s.runner, s.nowNs);
};

describe("checkRules", () => {
  it("returns {ok:true, reason:''} for a valid proposal", () => {
    assert.deepEqual(check(setup()), { ok: true, reason: "" });
  });

  it("ERR_NOT_RUNNER for an unapproved caller", () => {
    const s = setup();
    const r = checkRules(s.vault, s.proposal, "mallory.testnet", s.nowNs);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^ERR_NOT_RUNNER: mallory\.testnet/);
  });

  it("ERR_PAUSED when the vault is paused", () => {
    const r = check(setup(), {}, (v) => (v.state.paused = true));
    assert.equal(r.ok, false);
    assert.match(r.reason, /^ERR_PAUSED/);
  });

  it("ERR_SWAP_IN_FLIGHT for a swap in flight", () => {
    const r = check(setup(), {}, (v) => (v.state.swap_in_flight = true));
    assert.match(r.reason, /^ERR_SWAP_IN_FLIGHT: another swap/);
  });

  it("ERR_SWAP_IN_FLIGHT for a recovery in flight", () => {
    const r = check(setup(), {}, (v) => (v.state.recovery_in_flight = true));
    assert.match(r.reason, /^ERR_SWAP_IN_FLIGHT: a Ref recovery/);
  });

  it("ERR_POOL_NOT_ALLOWED for a pool outside the allow-list", () => {
    const r = check(setup(), { pool_id: 99 });
    assert.match(r.reason, /^ERR_POOL_NOT_ALLOWED: pool 99/);
  });

  it("ERR_TOKEN_NOT_IN_POOL when the tokens are not the pool pair", () => {
    assert.match(check(setup(), { token_out: DAI }).reason, /^ERR_TOKEN_NOT_IN_POOL/);
    assert.match(check(setup(), { token_out: WNEAR }).reason, /^ERR_TOKEN_NOT_IN_POOL/);
  });

  it("ERR_ZERO_AMOUNT and ERR_ZERO_MIN_OUT", () => {
    assert.match(check(setup(), { amount_in: 0n }).reason, /^ERR_ZERO_AMOUNT/);
    assert.match(check(setup(), { min_amount_out: 0n }).reason, /^ERR_ZERO_MIN_OUT/);
  });

  it("ERR_PRICE_FLOOR: exact boundary passes, one less fails", () => {
    // Floor a->b is 3_000_000 / 1e24: min_out * 1e24 >= amount_in * 3e6.
    const s = setup();
    assert.deepEqual(check(s, { min_amount_out: 300_000_000n }), { ok: true, reason: "" });
    const r = check(s, { min_amount_out: 299_999_999n });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^ERR_PRICE_FLOOR: min_amount_out 299999999 below floor 3000000\/1000000000000000000000000/);
  });

  it("ERR_PRICE_FLOOR uses the reverse rate for b -> a", () => {
    // Floor b->a is 3e17/1: 1 USDC unit in needs >= 3e17 wNEAR-yocto out.
    const s = setup();
    const rev = { token_in: USDC, token_out: WNEAR, amount_in: 100_000_000n };
    assert.equal(check(s, { ...rev, min_amount_out: 100_000_000n * 300_000_000_000_000_000n }).ok, true);
    assert.match(
      check(s, { ...rev, min_amount_out: 100_000_000n * 300_000_000_000_000_000n - 1n }).reason,
      /^ERR_PRICE_FLOOR/,
    );
  });

  it("ERR_NO_LIMIT for a token without a limit", () => {
    // Pool 23 reverse direction sells DAI, which has no limit. 1 DAI for 0.98 USDC meets the floor exactly.
    const r = check(setup(), { pool_id: 23, token_in: DAI, token_out: USDC, amount_in: 10n ** 18n, min_amount_out: 980_000n });
    assert.match(r.reason, new RegExp(`^ERR_NO_LIMIT: no limit for ${DAI}`));
  });

  it("ERR_MAX_TRADE: amount == max_trade passes, +1 fails", () => {
    const max = 2n * 10n ** 26n;
    const s = setup();
    assert.equal(check(s, { amount_in: max, min_amount_out: 10n ** 12n }).ok, true);
    const r = check(s, { amount_in: max + 1n, min_amount_out: 10n ** 12n });
    assert.match(r.reason, /^ERR_MAX_TRADE: 200000000000000000000000001 exceeds max_trade 200000000000000000000000000/);
  });

  it("ERR_DAILY_CAP: spent_today on the same day counts; exactly the cap passes", () => {
    const s = setup();
    // cap 5e26; spent 3e26 + 2e26 == cap passes.
    s.vault.state.spent_today.set(WNEAR, 3n * 10n ** 26n);
    const big = { amount_in: 2n * 10n ** 26n, min_amount_out: 10n ** 12n };
    assert.equal(check(s, big).ok, true);
    s.vault.state.spent_today.set(WNEAR, 3n * 10n ** 26n + 1n);
    assert.match(check(s, big).reason, /^ERR_DAILY_CAP: spent 300000000000000000000000001 \+ 200000000000000000000000000 exceeds daily_cap 500000000000000000000000000/);
  });

  it("ERR_DAILY_CAP: spent_today is ignored when state.day is an older day (reset)", () => {
    const s = setup();
    s.vault.state.spent_today.set(WNEAR, 5n * 10n ** 26n); // fully spent
    assert.match(check(s).reason, /^ERR_DAILY_CAP/);
    s.vault.state.day = dayOf(s.nowNs) - 1n;
    assert.deepEqual(check(s), { ok: true, reason: "" });
  });

  it("ERR_INSUFFICIENT_BALANCE when the vault holds less than amount_in", () => {
    const s = setup();
    s.vault.state.balances.set(WNEAR, 10n ** 25n);
    assert.match(check(s).reason, /^ERR_INSUFFICIENT_BALANCE: have 10000000000000000000000000 need 100000000000000000000000000/);
    s.vault.state.balances.delete(WNEAR);
    assert.match(check(s).reason, /^ERR_INSUFFICIENT_BALANCE: have 0 /);
  });

  it("reports the earlier rule when two rules fail", () => {
    const s = setup();
    s.vault.state.paused = true; // ERR_PAUSED
    s.vault.state.balances.set(WNEAR, 0n); // ERR_INSUFFICIENT_BALANCE
    assert.match(check(s).reason, /^ERR_PAUSED/);
    // Price floor (earlier) beats max_trade (later).
    const t = setup();
    assert.match(check(t, { amount_in: 3n * 10n ** 26n, min_amount_out: 1n }).reason, /^ERR_PRICE_FLOOR/);
    // Max trade (earlier) beats daily cap and balance (later).
    t.vault.state.balances.set(WNEAR, 0n);
    assert.match(check(t, { amount_in: 3n * 10n ** 26n, min_amount_out: 10n ** 12n }).reason, /^ERR_MAX_TRADE/);
  });

  it("an overflowing spent + amount is ERR_DAILY_CAP (checked_add)", () => {
    const s = setup();
    s.vault.state.spent_today.set(WNEAR, U128_MAX);
    s.vault.config.limits[0].daily_cap = U128_MAX;
    assert.match(check(s).reason, /^ERR_DAILY_CAP/);
  });
});

describe("validateConfig", () => {
  const cfg = () => structuredClone(snapshot().vault.config);

  it("accepts the fixture config", () => {
    assert.equal(validateConfig(cfg()), null);
  });

  it("rejects an unknown strategy", () => {
    const c = cfg();
    c.strategy = "yolo";
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: strategy must be/);
  });

  it("accepts every known strategy", () => {
    for (const s of ["aloof", "chaotic", "social", "skeptic"]) {
      const c = cfg();
      c.strategy = s;
      assert.equal(validateConfig(c), null);
    }
  });

  it("rejects max_trade of zero", () => {
    const c = cfg();
    c.limits[0].max_trade = 0n;
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: max_trade must be > 0/);
  });

  it("rejects daily_cap below max_trade (equal is fine)", () => {
    const c = cfg();
    c.limits[0].daily_cap = c.limits[0].max_trade;
    assert.equal(validateConfig(c), null);
    c.limits[0].daily_cap = c.limits[0].max_trade - 1n;
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: daily_cap must be >= max_trade/);
  });

  it("rejects a duplicate limit token", () => {
    const c = cfg();
    c.limits.push({ ...c.limits[0] });
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: duplicate limit token/);
  });

  it("rejects a zero rate numerator or denominator", () => {
    for (const [field, key] of [["min_rate_a_to_b", "num"], ["min_rate_a_to_b", "den"], ["min_rate_b_to_a", "num"], ["min_rate_b_to_a", "den"]]) {
      const c = cfg();
      c.allowed_pools[0][field][key] = 0n;
      assert.match(validateConfig(c), /^ERR_BAD_CONFIG: rate num and den must be > 0/, `${field}.${key}`);
    }
  });

  it("rejects token_a equal to token_b", () => {
    const c = cfg();
    c.allowed_pools[0].token_b = c.allowed_pools[0].token_a;
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: token_a must differ from token_b/);
  });

  it("rejects a duplicate pool", () => {
    const c = cfg();
    c.allowed_pools[1].pool_id = c.allowed_pools[0].pool_id;
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: duplicate pool/);
  });

  it("rejects a duplicate runner", () => {
    const c = cfg();
    c.runners.push(c.runners[0]);
    assert.match(validateConfig(c), /^ERR_BAD_CONFIG: duplicate runner/);
  });
});

describe("helpers", () => {
  it("dayOf floors to the UTC day", () => {
    assert.equal(dayOf(0n), 0n);
    assert.equal(dayOf(NS_PER_DAY - 1n), 0n);
    assert.equal(dayOf(NS_PER_DAY), 1n);
    assert.equal(dayOf(snapshot().now_ns), 20761n);
  });

  it("meetsFloor is min_out*den >= amount_in*num", () => {
    const rate = { num: 3n, den: 2n };
    assert.equal(meetsFloor(10n, 15n, rate), true);
    assert.equal(meetsFloor(10n, 14n, rate), false);
  });

  it("spentOn returns 0 for an older stored day, 0 for an unknown token", () => {
    const state = { day: 5n, spent_today: new Map([["a", 7n]]) };
    assert.equal(spentOn(state, 5n, "a"), 7n);
    assert.equal(spentOn(state, 5n, "b"), 0n);
    assert.equal(spentOn(state, 6n, "a"), 0n);
  });
});
