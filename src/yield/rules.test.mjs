import { test } from "node:test";
import assert from "node:assert/strict";

import { floorMinOut, loadPoolFixture } from "./pools.mjs";
import { HARD_RULE_ORDER, checkProposal, dayOf, validateVaultConfig } from "./rules.mjs";
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
  assert.deepEqual(check(stableProposal(5000)), { ok: true, code: null, reason: "ok" });
});

test("a proposal one unit below the pool's price floor is ERR_PRICE_FLOOR", () => {
  const p = stableProposal(5000);
  const r = check({ ...p, min_amount_out: (BigInt(p.min_amount_out) - 1n).toString() });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ERR_PRICE_FLOOR");
  assert.equal(check({ ...p, min_amount_out: (BigInt(p.min_amount_out) - 1n).toString() }).code, "ERR_PRICE_FLOOR");
});

test("the price floor uses the rate for the trade direction", () => {
  const amountIn = "5000";
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
  const amountIn = "5000";
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

test("validateVaultConfig accepts the default configs and flags bad limits and rates", () => {
  for (const id of ["aloof", "chaotic", "social", "skeptic"]) assert.deepEqual(validateVaultConfig(defaultVaultConfig(id, { fixture })), []);
  const bad = {
    allowed_pools: [{ pool_id: 1, min_rate_a_to_b: { num: "0", den: "1" }, min_rate_b_to_a: { num: "1", den: "1" } }],
    limits: [
      { token_id: NUSDT, max_trade: "10", daily_cap: "5" },
      { token_id: NUSDT, max_trade: "0", daily_cap: "5" },
    ],
  };
  const problems = validateVaultConfig(bad);
  assert.ok(problems.some((m) => m.includes("min_rate_a_to_b")));
  assert.ok(problems.some((m) => m.includes("duplicate limit")));
  assert.ok(problems.some((m) => m.includes("max_trade is zero")));
  assert.ok(problems.some((m) => m.includes("exceeds daily_cap")));
});

test("validateVaultConfig mirrors the contract's strategy, pool and runner checks", () => {
  const good = defaultVaultConfig("skeptic", { fixture });
  const pool = good.allowed_pools[0];
  assert.ok(validateVaultConfig({ ...good, strategy: "yolo" }).some((m) => m.startsWith("strategy must be one of")));
  assert.ok(validateVaultConfig({ ...good, allowed_pools: [pool, pool] }).some((m) => m.includes(`duplicate pool ${pool.pool_id}`)));
  assert.ok(validateVaultConfig({ ...good, allowed_pools: [{ ...pool, token_b: pool.token_a }] }).some((m) => m.includes("token_a must differ")));
  assert.ok(validateVaultConfig({ ...good, runners: ["r.testnet", "r.testnet"] }).includes("duplicate runner"));
});
