// Invariant behind the single off-reference limit: for a constant-product pool with fee >= 0,
// the quote's edge over the reference price never exceeds the pool's spot deviation in the
// selling direction, so "quote edge > L" implies "|spot deviation| > L" for every L.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { quoteOut, otherToken } from "../yield/pools.mjs";
import { buildPlan } from "./plan.mjs";
import { loadSnapshot, parseSnapshot } from "./snapshot.mjs";

const SCENARIO = fileURLToPath(new URL("./fixtures/scenario.hand-built.json", import.meta.url));
const units = (amount, decimals) => Number(amount) / 10 ** decimals;

/** Quote edge and spot deviation in bps for selling `amountIn` of tokenIn into pool, or null when unpriced. */
function measures(tokens, pool, tokenIn, amountIn) {
  const tokenOut = otherToken(pool, tokenIn);
  const tIn = tokens[tokenIn];
  const tOut = tokens[tokenOut];
  if (tIn?.ref_price == null || tOut?.ref_price == null) return null;
  const [rin, rout] = tokenIn === pool.token_a ? [pool.reserve_a, pool.reserve_b] : [pool.reserve_b, pool.reserve_a];
  const out = quoteOut(pool, tokenIn, amountIn);
  const ref = tIn.ref_price / tOut.ref_price;
  const spot = units(rout, tOut.decimals) / units(rin, tIn.decimals);
  const dev = (spot / ref - 1) * 10_000;
  const edge = (units(out, tOut.decimals) * tOut.ref_price / (units(amountIn, tIn.decimals) * tIn.ref_price) - 1) * 10_000;
  return { edge, dev };
}


function sizes(reserveIn) {
  const r = BigInt(reserveIn);
  return [1_000n, r / 1_000_000n, r / 100_000n, r / 1000n, r / 100n, r / 10n, r / 4n, r / 2n].filter((a) => a > 0n);
}

function assertInvariant(tokens, pool, label) {
  let n = 0;
  for (const tokenIn of [pool.token_a, pool.token_b]) {
    const reserveIn = tokenIn === pool.token_a ? pool.reserve_a : pool.reserve_b;
    for (const amountIn of sizes(reserveIn)) {
      const m = measures(tokens, pool, tokenIn, amountIn);
      if (!m) continue;
      n++;
      const slack = 1e-9 * Math.max(1, Math.abs(m.dev));
      assert.ok(m.edge <= Math.abs(m.dev) + slack, `${label} pool ${pool.pool_id} sell ${tokenIn} amount ${amountIn}: edge ${m.edge} > |spot dev| ${Math.abs(m.dev)}`);
    }
  }
  return n;
}

describe("quote edge never exceeds spot deviation (constant product, fee >= 0)", () => {
  it("every pool, both directions, many sizes: default snapshot and hand-built scenario", () => {
    let n = 0;
    for (const [label, snap] of [["default", loadSnapshot(null)], ["hand-built", loadSnapshot(SCENARIO)]]) {
      for (const pool of snap.pools) n += assertInvariant(snap.tokens, pool, label);
    }
    assert.ok(n > 50, `checked ${n} cases`);
  });

  it("synthetic pools: reserves, fees 0..100 bps, sizes tiny..50%, prices above and below reference", () => {
    const raw = JSON.parse(readFileSync(SCENARIO, "utf8"));
    const base = parseSnapshot(raw);
    const tokens = base.tokens;
    const pool0 = base.pools[0];
    const [ta, tb] = [pool0.token_a, pool0.token_b];
    let n = 0;
    for (const priceMult of [1, 3, 1.5, 1.1, 1.01, 0.99, 0.9, 0.5, 0.1, 0.01]) {
      for (const scale of [10n ** 6n, 10n ** 12n, 10n ** 18n, 10n ** 24n]) {
        for (const fee of [0, 1, 5, 30, 100]) {
          const reserve_a = scale * 1000n;
          const reserve_b = BigInt(Math.round(Number(scale) * 1000 * priceMult));
          n += assertInvariant(tokens, { ...pool0, pool_id: 1, token_a: ta, token_b: tb, reserve_a, reserve_b, total_fee: fee }, `synthetic x${priceMult} fee ${fee}`);
        }
      }
    }
    assert.ok(n > 1000, `checked ${n} cases`);
  });
});

describe("candidate statuses are pinned (captured before the quote limit was merged into the spot limit)", () => {
  const statuses = (snap) => buildPlan(snap).json.candidates.map((c) => [c.proposal.pool_id, c.proposal.token_in, c.status]);
  it("default snapshot: pool 1 off_reference, pool 747 ok", () => {
    const plan = buildPlan(loadSnapshot(null));
    assert.deepEqual(statuses(loadSnapshot(null)), [
      [0, "wrap.testnet", "no_reference_price"],
      [1, "nusdt.ft-fin.testnet", "off_reference"],
      [2, "wrap.testnet", "refused"],
      [5, "banana.ft-fin.testnet", "refused"],
      [6, "wrap.testnet", "refused"],
      [8, "rft.tokenfactory.testnet", "refused"],
      [747, "usdc.fakes.testnet", "ok"],
    ]);
    assert.equal(plan.json.call.args.proposal.pool_id, 747);
  });
  it("hand-built scenario: pool 17 ok, 23 and 99 refused", () => {
    assert.deepEqual(statuses(loadSnapshot(SCENARIO)), [
      [17, "wnear.fixture.testnet", "ok"],
      [23, "dai.fixture.testnet", "refused"],
      [99, "wnear.fixture.testnet", "refused"],
    ]);
  });
});
