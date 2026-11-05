import { test } from "node:test";
import assert from "node:assert/strict";

import { floorMinOut, loadPoolFixture } from "./pools.mjs";
import { HARD_RULE_ORDER, U128_MAX, checkProposal, dayOf, spentOn, validateVaultConfig } from "./rules.mjs";
import { NUSDC, NUSDT, RFT, WNEAR, PLACEHOLDER_RUNNER, defaultVaultConfig } from "./strategies.mjs";

const fixture = loadPoolFixture();
const NOW = Date.UTC(2026, 10, 3, 12);
const RUNNER = PLACEHOLDER_RUNNER;
const config = defaultVaultConfig("social", { runner: RUNNER, fixture });
const limit = (t) => config.limits.find((l) => l.token_id === t);
const pool = (id) => config.allowed_pools.find((p) => p.pool_id === id);

const freshState = () => ({
  paused: false,
  in_flight: false,
  spent: { day: 0, amounts: {} },
  balances: { [WNEAR]: "1" + "0".repeat(30), [RFT]: "1" + "0".repeat(15), [NUSDT]: "1000000000", [NUSDC]: "1000000000" },
});

/** A stable-pool proposal at exactly the price floor. */
function stableProposal(amount, overrides = {}) {
  const amountIn = String(amount);
  return { pool_id: 1, token_in: NUSDT, token_out: NUSDC, amount_in: amountIn, min_amount_out: floorMinOut(pool(1).min_rate_a_to_b, amountIn).toString(), ...overrides };
}

const check = (p, state = freshState(), nowMs = NOW) => checkProposal(p, config, state, RUNNER, nowMs);

test("a valid proposal at the price floor passes", () => {
  assert.deepEqual(check(stableProposal(5000)), { ok: true, code: null, reason: "" });
});

test("a proposal one unit below the pool's price floor is ERR_PRICE_FLOOR", () => {
  // nusdc -> nusdt: the reference floor is 0.99 * 10000 = 9900 base nusdt per base nusdc,
  // so 50 base nusdc needs min_out >= 495000 (a nusdt -> nusdc floor this tiny would round to 0).
  const p = { pool_id: 1, token_in: NUSDC, token_out: NUSDT, amount_in: "50", min_amount_out: "495000" };
  assert.equal(check(p).ok, true);
  const r = check({ ...p, min_amount_out: "494999" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ERR_PRICE_FLOOR");
});

test("the price floor uses the rate for the trade direction", () => {
  const amountIn = "50"; // nUSDC has 2 decimals: 0.50 nUSDC, under its 1 nUSDC max_trade
  const atFloor = floorMinOut(pool(1).min_rate_b_to_a, amountIn).toString();
  const p = { pool_id: 1, token_in: NUSDC, token_out: NUSDT, amount_in: amountIn, min_amount_out: atFloor };
  assert.equal(check(p).ok, true);
  // the a->b floor is far lower than b->a, so it must not be accepted in this direction
  const lowerAtoB = floorMinOut(pool(1).min_rate_a_to_b, amountIn).toString();
  assert.equal(check({ ...p, min_amount_out: lowerAtoB }).code, "ERR_PRICE_FLOOR");
});

test("a token with no limit is ERR_NO_LIMIT", () => {
  const noRft = { ...config, limits: config.limits.filter((l) => l.token_id !== RFT) };
  const amountIn = "1000";
  const p = { pool_id: 0, token_in: RFT, token_out: WNEAR, amount_in: amountIn, min_amount_out: floorMinOut(pool(0).min_rate_b_to_a, amountIn).toString() };
  assert.equal(checkProposal(p, config, freshState(), RUNNER, NOW).ok, true);
  const r = checkProposal(p, noRft, freshState(), RUNNER, NOW);
  assert.equal(r.code, "ERR_NO_LIMIT");
  assert.match(r.reason, new RegExp(RFT.replace(/\./g, "\\.")));
});

test("amount over that token's max_trade is ERR_MAX_TRADE; exactly max_trade passes", () => {
  const max = BigInt(limit(NUSDT).max_trade);
  assert.equal(check(stableProposal(max)).ok, true);
  assert.equal(check(stableProposal(max + 1n)).code, "ERR_MAX_TRADE");
});

test("max_trade is per token: a WNEAR amount is judged against WNEAR's limit, not NUSDT's", () => {
  const wmax = BigInt(limit(WNEAR).max_trade);
  const mk = (amt) => ({ pool_id: 0, token_in: WNEAR, token_out: RFT, amount_in: amt.toString(), min_amount_out: floorMinOut(pool(0).min_rate_a_to_b, amt).toString() });
  assert.ok(wmax > BigInt(limit(NUSDT).max_trade));
  assert.equal(check(mk(wmax)).ok, true);
  assert.equal(check(mk(wmax + 1n)).code, "ERR_MAX_TRADE");
});

test("daily cap is per token and independent across tokens", () => {
  const cap = BigInt(limit(NUSDT).daily_cap);
  const today = dayOf(NOW);
  const state = freshState();
  state.spent = { day: today, amounts: { [NUSDT]: cap.toString() } };
  // NUSDT is exhausted
  assert.equal(check(stableProposal(1), state).code, "ERR_DAILY_CAP");
  // NUSDC has its own counter and is untouched
  const amountIn = "50"; // 0.50 nUSDC at 2 decimals, under its max_trade
  const nusdc = { pool_id: 1, token_in: NUSDC, token_out: NUSDT, amount_in: amountIn, min_amount_out: floorMinOut(pool(1).min_rate_b_to_a, amountIn).toString() };
  assert.equal(check(nusdc, state).ok, true);
  // WNEAR is untouched too
  const wn = { pool_id: 0, token_in: WNEAR, token_out: RFT, amount_in: "1000", min_amount_out: floorMinOut(pool(0).min_rate_a_to_b, "1000").toString() };
  assert.equal(check(wn, state).ok, true);
});

test("daily cap accumulates, and a new UTC day resets every token", () => {
  const cap = BigInt(limit(NUSDT).daily_cap);
  const max = BigInt(limit(NUSDT).max_trade);
  const state = freshState();
  state.spent = { day: dayOf(NOW), amounts: { [NUSDT]: (cap - max + 1n).toString() } };
  assert.equal(check(stableProposal(max), state).code, "ERR_DAILY_CAP");
  assert.equal(check(stableProposal(max - 1n), state).ok, true);
  assert.equal(check(stableProposal(max), state, NOW + 86_400_000).ok, true);
});

test("hard rules are checked in the documented order", () => {
  const p = stableProposal(5000);
  const runnerFail = checkProposal(p, config, { ...freshState(), paused: true }, "someone.else.testnet", NOW);
  assert.equal(runnerFail.code, "ERR_NOT_RUNNER");
  assert.equal(check(p, { ...freshState(), paused: true, in_flight: true }).code, "ERR_PAUSED");
  assert.equal(check(p, { ...freshState(), in_flight: true }).code, "ERR_SWAP_IN_FLIGHT");
  assert.equal(check({ ...p, pool_id: 99 }).code, "ERR_POOL_NOT_ALLOWED");
  assert.equal(check({ ...p, token_out: WNEAR }).code, "ERR_TOKEN_NOT_IN_POOL");
  assert.equal(check({ ...p, amount_in: "0" }).code, "ERR_ZERO_AMOUNT");
  assert.equal(check({ ...p, min_amount_out: "0" }).code, "ERR_ZERO_MIN_OUT");
  const poor = { ...freshState(), balances: { ...freshState().balances, [NUSDT]: "1" } };
  assert.equal(check(p, poor).code, "ERR_INSUFFICIENT_BALANCE");
  // price floor beats a missing limit and an oversize amount
  const noLimits = { ...config, limits: [] };
  const lowball = { ...p, amount_in: "999999999", min_amount_out: "1" };
  assert.equal(checkProposal(lowball, noLimits, freshState(), RUNNER, NOW).code, "ERR_PRICE_FLOOR");
  assert.equal(checkProposal(p, noLimits, freshState(), RUNNER, NOW).code, "ERR_NO_LIMIT");
  for (const code of ["ERR_PRICE_FLOOR", "ERR_NO_LIMIT", "ERR_MAX_TRADE", "ERR_DAILY_CAP"]) assert.ok(HARD_RULE_ORDER.includes(code));
  assert.ok(HARD_RULE_ORDER.indexOf("ERR_PRICE_FLOOR") < HARD_RULE_ORDER.indexOf("ERR_NO_LIMIT"));
  assert.ok(HARD_RULE_ORDER.indexOf("ERR_NO_LIMIT") < HARD_RULE_ORDER.indexOf("ERR_MAX_TRADE"));
});

test("reasons are the contract's exact ERR_CODE: detail strings", () => {
  const p = stableProposal(5000);
  assert.equal(checkProposal(p, config, freshState(), "bob.testnet", NOW).reason, "ERR_NOT_RUNNER: bob.testnet is not an approved runner");
  assert.equal(check(p, { ...freshState(), paused: true }).reason, "ERR_PAUSED: vault is paused");
  assert.equal(check(p, { ...freshState(), in_flight: true }).reason, "ERR_SWAP_IN_FLIGHT: another swap is in flight");
  assert.equal(check({ ...p, pool_id: 99 }).reason, "ERR_POOL_NOT_ALLOWED: pool 99");
  assert.equal(check({ ...p, amount_in: "0" }).reason, "ERR_ZERO_AMOUNT: amount_in must be > 0");
  const max = BigInt(limit(NUSDT).max_trade);
  assert.equal(check(stableProposal(max + 1n)).reason, `ERR_MAX_TRADE: ${max + 1n} exceeds max_trade ${max}`);
});

test("a Ref recovery in flight blocks the swap, after the paused and swap-in-flight checks", () => {
  const p = stableProposal(5000);
  const r = check(p, { ...freshState(), recovery_in_flight: true });
  assert.deepEqual(r, { ok: false, code: "ERR_SWAP_IN_FLIGHT", reason: "ERR_SWAP_IN_FLIGHT: a Ref recovery is in flight" });
  assert.equal(check(p, { ...freshState(), recovery_in_flight: true, in_flight: true }).reason, "ERR_SWAP_IN_FLIGHT: another swap is in flight");
  assert.equal(check(p, { ...freshState(), recovery_in_flight: true, paused: true }).code, "ERR_PAUSED");
});

test("a daily total that overflows u128 is ERR_DAILY_CAP (checked_add)", () => {
  const huge = { ...config, limits: config.limits.map((l) => (l.token_id === NUSDT ? { ...l, daily_cap: U128_MAX.toString() } : l)) };
  const state = freshState();
  state.spent = { day: dayOf(NOW), amounts: { [NUSDT]: U128_MAX.toString() } };
  const r = checkProposal(stableProposal(5000), huge, state, RUNNER, NOW);
  assert.equal(r.code, "ERR_DAILY_CAP");
  assert.equal(r.reason, `ERR_DAILY_CAP: spent ${U128_MAX} + 5000 exceeds daily_cap ${U128_MAX}`);
});

test("rules accept BigInt amounts and rates as well as decimal strings", () => {
  const big = {
    ...config,
    allowed_pools: config.allowed_pools.map((q) => ({ ...q, min_rate_a_to_b: { num: BigInt(q.min_rate_a_to_b.num), den: BigInt(q.min_rate_a_to_b.den) }, min_rate_b_to_a: { num: BigInt(q.min_rate_b_to_a.num), den: BigInt(q.min_rate_b_to_a.den) } })),
    limits: config.limits.map((l) => ({ ...l, max_trade: BigInt(l.max_trade), daily_cap: BigInt(l.daily_cap) })),
  };
  const p = stableProposal(5000);
  const state = { ...freshState(), balances: { [NUSDT]: 1_000_000_000n } };
  assert.equal(checkProposal({ ...p, amount_in: 5000n, min_amount_out: BigInt(p.min_amount_out) }, big, state, RUNNER, NOW).ok, true);
});

test("spentOn counts only the stored day and only the named token", () => {
  const state = { spent: { day: 5, amounts: { a: "7" } } };
  assert.equal(spentOn(state, "a", 5), 7n);
  assert.equal(spentOn(state, "b", 5), 0n);
  assert.equal(spentOn(state, "a", 6), 0n);
  assert.equal(spentOn({}, "a", 5), 0n);
});

test("dayOf is the UTC day: ms -> the contract's ns / NS_PER_DAY", () => {
  assert.equal(dayOf(0), 0);
  assert.equal(dayOf(86_400_000 - 1), 0);
  assert.equal(dayOf(86_400_000), 1);
  assert.equal(dayOf(Date.UTC(2026, 10, 4, 12)), 20761);
});

const cfg = () => structuredClone(defaultVaultConfig("skeptic", { fixture }));

test("validateVaultConfig accepts the default configs", () => {
  for (const id of ["aloof", "chaotic", "social", "skeptic"]) assert.deepEqual(validateVaultConfig(defaultVaultConfig(id, { fixture })), []);
});

test("validateVaultConfig returns the contract's ERR_BAD_CONFIG messages", () => {
  const bad = {
    strategy: "yolo",
    allowed_pools: [{ pool_id: 1, token_a: "a", token_b: "a", min_rate_a_to_b: { num: "0", den: "1" }, min_rate_b_to_a: { num: "1", den: "0" } }],
    limits: [
      { token_id: NUSDT, max_trade: "10", daily_cap: "5" },
      { token_id: NUSDT, max_trade: "0", daily_cap: "5" },
    ],
    runners: ["r.testnet", "r.testnet"],
  };
  assert.deepEqual(validateVaultConfig(bad), [
    "ERR_BAD_CONFIG: strategy must be aloof, chaotic, social or skeptic",
    "ERR_BAD_CONFIG: daily_cap must be >= max_trade",
    "ERR_BAD_CONFIG: max_trade must be > 0",
    "ERR_BAD_CONFIG: duplicate limit token",
    "ERR_BAD_CONFIG: rate num and den must be > 0",
    "ERR_BAD_CONFIG: rate num and den must be > 0",
    "ERR_BAD_CONFIG: token_a must differ from token_b",
    "ERR_BAD_CONFIG: duplicate runner",
  ]);
});

test("validateVaultConfig: daily_cap equal to max_trade is fine; duplicate pool and zero den are not", () => {
  const c = cfg();
  c.limits[0].daily_cap = c.limits[0].max_trade;
  assert.deepEqual(validateVaultConfig(c), []);
  const d = cfg();
  d.allowed_pools.push({ ...d.allowed_pools[0] });
  assert.deepEqual(validateVaultConfig(d), ["ERR_BAD_CONFIG: duplicate pool"]);
  const z = cfg();
  z.allowed_pools[0].min_rate_b_to_a = { num: "1", den: "0" };
  assert.deepEqual(validateVaultConfig(z), ["ERR_BAD_CONFIG: rate num and den must be > 0"]);
});

test("regression: nUSDC has 2 decimals in the fixture and a whole-token limit scales by 10^2", () => {
  assert.equal(fixture.tokens[NUSDC].decimals, 2);
  assert.equal(fixture.tokens[NUSDT].decimals, 6);
  // social: nUSDC max_trade "1" whole token = 100 base units, daily_cap "2" = 200 (not 10^6 / 2*10^6)
  assert.equal(limit(NUSDC).max_trade, "100");
  assert.equal(limit(NUSDC).daily_cap, "200");
});
