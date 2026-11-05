// H1: the vault's floor and the strategy's peg check come from the reference price (mock_usd_price),
// not from the pool being judged. Expected values below are worked out by hand from reserves and decimals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createInferenceClient } from "../inference/client.mjs";
import { AGENT_IDS, runRound } from "./debate.mjs";
import { createLedger } from "./ledger.mjs";
import { yieldMockResponder } from "./mock.mjs";
import {
  MAX_REF_DEVIATION_BPS,
  STABLE_PEG_BPS,
  loadPoolFixture,
  maxReferenceDeviationBps,
  poolById,
  quoteOut,
  referenceDeviationBps,
  referenceOut,
  referenceRate,
  spotDeviationBps,
} from "./pools.mjs";
import { checkProposal, checkStrategy, validateVaultConfig } from "./rules.mjs";
import { NUSDC, NUSDT, PLACEHOLDER_RUNNER, RFT, WNEAR, defaultVaultConfig } from "./strategies.mjs";

const fixture = loadPoolFixture();
const pool1 = poolById(1, fixture);
const pool0 = poolById(0, fixture);

// A synthetic nusdt/nusdc pool on the fixture's tokens. reserve_a is nusdt base units (6 dp), reserve_b nusdc (2 dp).
const synth = (reserve_a, reserve_b, total_fee = 0) => ({ pool_id: 1, pool_kind: "SIMPLE_POOL", token_a: NUSDT, token_b: NUSDC, reserve_a: String(reserve_a), reserve_b: String(reserve_b), total_fee });
const synthFixture = (pool) => ({ ...fixture, pools: [pool] });
// A config whose limits do not get in the way of 1 USDT-sized trades.
const bigConfig = (agent) => {
  const c = defaultVaultConfig(agent, { fixture });
  return { ...c, limits: c.limits.map((l) => ({ ...l, max_trade: "1000000000000", daily_cap: "10000000000000" })) };
};

test("referenceRate: 1 base nusdt = 1e-6 USD = 1e-4 base nusdc, and back", () => {
  assert.deepEqual(referenceRate(NUSDT, NUSDC, fixture), { num: 1n, den: 10000n });
  assert.deepEqual(referenceRate(NUSDC, NUSDT, fixture), { num: 10000n, den: 1n });
  // wNEAR $3 (24 dp) -> nusdc $1 (2 dp): 3e-24 USD per base unit = 3e-22 base nusdc
  assert.deepEqual(referenceRate(WNEAR, NUSDC, fixture), { num: 3n, den: 10n ** 22n });
});

test("referenceRate / referenceOut / referenceDeviationBps are null when a token has no price", () => {
  assert.equal(referenceRate(WNEAR, RFT, fixture), null);
  assert.equal(referenceOut(WNEAR, RFT, "1000", fixture), null);
  assert.equal(referenceDeviationBps(pool0, WNEAR, "1000000000000000000000000", fixture), null);
  assert.equal(spotDeviationBps(pool0, WNEAR, fixture), null);
  assert.equal(maxReferenceDeviationBps(pool0, fixture), null);
});

test("referenceOut rounds down: 1 USDT of nusdt is 100 base nusdc, 500 base nusdt is dust (0)", () => {
  assert.equal(referenceOut(NUSDT, NUSDC, "1000000", fixture), 100n);
  assert.equal(referenceOut(NUSDT, NUSDC, "500", fixture), 0n);
  assert.equal(referenceOut(NUSDC, NUSDT, "100", fixture), 1000000n);
});

test("pool 1 is ~99.9% off peg: the dust trade is millions of bps above the reference, the reverse is ~-99.9%", () => {
  // 500 base nusdt, fee 20: 44411*500*9980 / (237316*10000 + 500*9980) = 93 (floor of ~93.4). Reference 0.05 base nusdc.
  assert.equal(quoteOut(pool1, NUSDT, "500"), 93n);
  // (93 / 0.05 - 1) * 10000 = (1860 - 1) * 10000
  assert.equal(referenceDeviationBps(pool1, NUSDT, "500", fixture), 18_590_000);
  // 500 base nusdc (5.00 USD), reference 500 * 10000 = 5,000,000 base nusdt; the pool gives 2636: 2636/5e6 - 1 = -0.9994728
  assert.equal(quoteOut(pool1, NUSDC, "500"), 2636n);
  assert.equal(referenceDeviationBps(pool1, NUSDC, "500", fixture), -9994); // -99.94728% truncated toward zero
  // spot: 44411 / 237316 = 0.18713 base nusdc per base nusdt vs 1e-4: +186,999 %  -> (0.187137/1e-4 - 1)*1e4
  assert.equal(spotDeviationBps(pool1, NUSDT, fixture), Number(((44411n * 10000n - 237316n) * 10000n) / 237316n));
  assert.ok(spotDeviationBps(pool1, NUSDT, fixture) > 18_000_000);
  assert.equal(spotDeviationBps(pool1, NUSDC, fixture), -9994); // 237316/44411 = 5.343 vs 10000 -> -0.99947
});

test("a synthetic on-peg stable pool (1,000,000 USDT : 1,000,000 USDC, fee 20 bps) is within the bound", () => {
  const pool = synth(1_000_000_000_000n, 100_000_000n, 20);
  // 10 USDT = 1e7 base: out = 1e8*1e7*9980 / (1e12*1e4 + 1e7*9980) = 997.99 -> 997 vs reference 1000 base nusdc: -30 bps
  assert.equal(quoteOut(pool, NUSDT, "10000000"), 997n);
  assert.equal(referenceDeviationBps(pool, NUSDT, "10000000", fixture), -30);
  assert.equal(spotDeviationBps(pool, NUSDT, fixture), 0);
  assert.equal(maxReferenceDeviationBps(pool, fixture), STABLE_PEG_BPS);
  assert.ok(Math.abs(referenceDeviationBps(pool, NUSDT, "10000000", fixture)) <= STABLE_PEG_BPS);
});

test("the bounds are 100 bps for a stable pair and 1000 bps for other priced pairs", () => {
  assert.equal(STABLE_PEG_BPS, 100);
  assert.equal(MAX_REF_DEVIATION_BPS, 1000);
  assert.equal(maxReferenceDeviationBps(pool1, fixture), 100);
  const wnearUsdc = poolById(6, fixture); // wNEAR (priced, volatile) / nusdc (priced)
  assert.equal(maxReferenceDeviationBps(wnearUsdc, fixture), 1000);
});

// --- checkStrategy: the guard fires only off peg --------------------------------------------

const proposalFor = (pool, amountIn, tokenIn = NUSDT) => {
  const quote = quoteOut(pool, tokenIn, amountIn);
  return { pool_id: 1, token_in: tokenIn, token_out: tokenIn === NUSDT ? NUSDC : NUSDT, amount_in: String(amountIn), min_amount_out: ((quote * 9980n + 9999n) / 10000n).toString() };
};

test("pool 1 on the real fixture is refused with SOFT_OFF_REFERENCE for every agent that may trade it", () => {
  const p = { pool_id: 1, token_in: NUSDT, token_out: NUSDC, amount_in: "500", min_amount_out: "93" };
  for (const agent of ["aloof", "skeptic", "social"]) {
    const r = checkStrategy(p, agent, bigConfig(agent), fixture, { consensus: p });
    const v = r.violations.find((x) => x.code === "SOFT_OFF_REFERENCE");
    assert.ok(v, agent);
    assert.equal(v.reason, "pool 1 quote is +18590000 bps off the reference price (limit 100 bps for a stable pair)");
  }
});

test("an on-peg stable pool with a sensible proposal passes every soft check (the guard is not always on)", () => {
  const pool = synth(1_000_000_000_000n, 100_000_000n, 20);
  const f = synthFixture(pool);
  const cfg = bigConfig("aloof");
  const r = checkStrategy(proposalFor(pool, 10_000_000n), "aloof", cfg, f);
  assert.deepEqual(r, { ok: true, violations: [] });
});

// Exact-boundary pools: fee 0, reserve_in 1e15 base nusdt, trade A = 1e8 base nusdt (100 USDT), reference out
// A * 1e-4 = 10000 base nusdc. With out = rb * A / (ra + A), rb = Q * (ra + A) / A = Q * 10_000_001 gives quote Q exactly.
const RA = 1_000_000_000_000_000n;
const A = "100000000";
const poolWithQuote = (q) => synth(RA, q * 10_000_001n);

test("boundary: a quote exactly +100 bps off the reference passes, +101 bps fails", () => {
  const cfg = bigConfig("aloof");
  const at = poolWithQuote(10_100n); // 10100 / 10000 = +100 bps
  const beyond = poolWithQuote(10_101n); // +101 bps
  assert.equal(quoteOut(at, NUSDT, A), 10_100n);
  assert.equal(referenceDeviationBps(at, NUSDT, A, fixture), 100);
  assert.equal(referenceDeviationBps(beyond, NUSDT, A, fixture), 101);
  const codes = (pool) => checkStrategy(proposalFor(pool, A), "aloof", cfg, synthFixture(pool)).violations.map((v) => v.code);
  assert.ok(!codes(at).includes("SOFT_OFF_REFERENCE"));
  assert.ok(codes(beyond).includes("SOFT_OFF_REFERENCE"));
});

test("an under-priced stable pool (-101 bps) is refused too: the check is two-sided", () => {
  const cfg = bigConfig("aloof");
  const pool = poolWithQuote(9_899n); // 9899 / 10000 = -101 bps
  assert.equal(referenceDeviationBps(pool, NUSDT, A, fixture), -101);
  const v = checkStrategy(proposalFor(pool, A), "aloof", cfg, synthFixture(pool)).violations.find((x) => x.code === "SOFT_OFF_REFERENCE");
  assert.equal(v.reason, "pool 1 quote is -101 bps off the reference price (limit 100 bps for a stable pair)");
  assert.ok(!checkStrategy(proposalFor(poolWithQuote(9_900n), A), "aloof", cfg, synthFixture(poolWithQuote(9_900n))).violations.some((x) => x.code === "SOFT_OFF_REFERENCE"));
});

test("pool 0 (rft unpriced) has no reference check", () => {
  const cfg = defaultVaultConfig("chaotic", { fixture });
  const amountIn = "100000000000000000000000";
  const quote = quoteOut(pool0, WNEAR, amountIn);
  const p = { pool_id: 0, token_in: WNEAR, token_out: RFT, amount_in: amountIn, min_amount_out: ((quote * 9700n) / 10000n).toString() };
  const r = checkStrategy(p, "chaotic", cfg, fixture);
  assert.ok(!r.violations.some((v) => v.code === "SOFT_OFF_REFERENCE"), JSON.stringify(r));
});

// --- the vault floor comes from the reference ----------------------------------------------

test("defaultVaultConfig pool 1 floors are the reference rate x 0.99, and the config is valid", () => {
  const cfg = defaultVaultConfig("aloof", { fixture });
  assert.deepEqual(validateVaultConfig(cfg), []);
  const p = cfg.allowed_pools.find((x) => x.pool_id === 1);
  // 1 base nusdt = 1e-4 base nusdc -> 0.99e-4 = 99 / 1,000,000
  assert.deepEqual(p.min_rate_a_to_b, { num: "99", den: "1000000" });
  // 1 base nusdc = 1e4 base nusdt -> 9900 / 1
  assert.deepEqual(p.min_rate_b_to_a, { num: "9900", den: "1" });
});

test("pool 0 keeps the 50% spot sanity floor (no reference for rft)", () => {
  const cfg = defaultVaultConfig("chaotic", { fixture });
  const p = cfg.allowed_pools.find((x) => x.pool_id === 0);
  const rIn = BigInt(pool0.reserve_a);
  const rOut = BigInt(pool0.reserve_b);
  // num/den = rOut/rIn / 2, compared by cross-multiplication so gcd reduction does not matter
  assert.equal(BigInt(p.min_rate_a_to_b.num) * rIn * 2n, BigInt(p.min_rate_a_to_b.den) * rOut);
});

test("a nusdc -> nusdt min_out taken from pool 1's quote fails the hard floor (ERR_PRICE_FLOOR)", () => {
  const cfg = defaultVaultConfig("aloof", { runner: PLACEHOLDER_RUNNER, fixture });
  const quote = quoteOut(pool1, NUSDC, "10"); // 10 base nusdc = 0.10 USD; the pool pays 52 base nusdt (0.000052 USD)
  const p = { pool_id: 1, token_in: NUSDC, token_out: NUSDT, amount_in: "10", min_amount_out: quote.toString() };
  const state = { spent: { day: 0, amounts: {} }, balances: { [NUSDC]: "1000" } };
  const r = checkProposal(p, cfg, state, PLACEHOLDER_RUNNER, Date.UTC(2026, 10, 3));
  assert.equal(r.code, "ERR_PRICE_FLOOR");
  assert.match(r.reason, /floor 9900\/1 of amount_in 10/);
});

// --- end to end ------------------------------------------------------------------------------

test("5 mock rounds: no agent trades on pool 1; stable agents are refused with SOFT_OFF_REFERENCE or ERR_PRICE_FLOOR", async () => {
  const RUNNER = PLACEHOLDER_RUNNER;
  const EPOCH = Date.UTC(2026, 10, 3);
  const client = createInferenceClient({ env: {}, responder: yieldMockResponder });
  const configs = Object.fromEntries(AGENT_IDS.map((id) => [id, defaultVaultConfig(id, { runner: RUNNER })]));
  const ledger = createLedger({ fixture });
  const records = [];
  for (let round = 1; round <= 5; round++) {
    const rec = await runRound({ client, configs, states: ledger.states, fixture, round, nowMs: EPOCH + (round - 1) * 3_600_000, runnerId: RUNNER });
    ledger.record(rec);
    records.push(rec);
  }
  for (const [id, a] of Object.entries(ledger.book.agents)) {
    assert.ok(a.trades.every((t) => t.proposal.pool_id !== 1), `${id} traded on pool 1`);
  }
  for (const rec of records) assert.ok(rec.executions.every((x) => x.proposal.pool_id !== 1));
  for (const id of ["aloof", "skeptic"]) {
    for (const rec of records) {
      const d = rec.decisions[id];
      assert.ok(["rejected_soft", "rejected_hard"].includes(d.outcome), `${id} round ${rec.round}: ${d.outcome}`);
      const text = JSON.stringify(d);
      assert.ok(text.includes("SOFT_OFF_REFERENCE") || text.includes("ERR_PRICE_FLOOR"), `${id} round ${rec.round}`);
    }
  }
  // chaotic is unchanged: pool 0 still produces ERR_PRICE_FLOOR in the schedule's below-floor round
  assert.ok(JSON.stringify(records[4].decisions.chaotic).includes("ERR_PRICE_FLOOR"));
});
