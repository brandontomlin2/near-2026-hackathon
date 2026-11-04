// Pool snapshot helpers: the checked-in Ref/Rhea testnet fixture and constant-product quotes.
// All amounts are BigInt internally and decimal strings at the edges (the vault takes U128 strings).

import { readFileSync } from "node:fs";

export const U128_MAX = (1n << 128n) - 1n;

const FIXTURE_URL = new URL("./fixtures/ref-testnet-pools.json", import.meta.url);
let cached;

/** The decoded testnet snapshot (see the fixture's _source, _block_height and _note). */
export function loadPoolFixture() {
  cached ??= JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
  return cached;
}

/** @param {number} poolId */
export function poolById(poolId, fixture = loadPoolFixture()) {
  return fixture.pools.find((p) => p.pool_id === poolId);
}

/** A pool is a "stable pair" when both of its tokens are marked stable in the fixture. */
export function isStablePool(pool, fixture = loadPoolFixture()) {
  return Boolean(fixture.tokens[pool.token_a]?.stable && fixture.tokens[pool.token_b]?.stable);
}

/**
 * Constant-product output for an exact input, as Ref's simple pool computes it:
 *   out = reserve_out * in * (10000 - fee) / (reserve_in * 10000 + in * (10000 - fee))
 * @returns {bigint} 0n when the token is not in the pool, a reserve is empty or in is 0.
 */
export function quoteOut(pool, tokenIn, amountIn) {
  const aIn = BigInt(amountIn);
  let reserveIn;
  let reserveOut;
  if (tokenIn === pool.token_a) [reserveIn, reserveOut] = [BigInt(pool.reserve_a), BigInt(pool.reserve_b)];
  else if (tokenIn === pool.token_b) [reserveIn, reserveOut] = [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
  else return 0n;
  if (aIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const net = aIn * BigInt(10000 - pool.total_fee);
  return (reserveOut * net) / (reserveIn * 10000n + net);
}

/** The other token of the pool, or undefined when tokenIn is not in it. */
export function otherToken(pool, tokenIn) {
  if (tokenIn === pool.token_a) return pool.token_b;
  if (tokenIn === pool.token_b) return pool.token_a;
  return undefined;
}

/**
 * min_amount_out for a quote with a slippage allowance in bps. Rounded up, so the
 * slippage it implies (rounded down, see slippageBps) never exceeds the allowance.
 * @returns {bigint}
 */
export function minOutFor(pool, tokenIn, amountIn, allowanceBps) {
  return (quoteOut(pool, tokenIn, amountIn) * BigInt(10000 - allowanceBps) + 9999n) / 10000n;
}

/**
 * Slippage a proposal tolerates relative to the current quote, in whole bps (rounded down).
 * 0 when min_out is at or above the quote; null when there is no quote.
 * @returns {number | null}
 */
export function slippageBps(pool, proposal) {
  const quote = quoteOut(pool, proposal.token_in, proposal.amount_in);
  if (quote === 0n) return null;
  const minOut = BigInt(proposal.min_amount_out);
  if (minOut >= quote) return 0;
  const diff = (quote - minOut) * 10000n;
  return Number(diff / quote);
}

/** Smallest min_amount_out that satisfies an on-chain floor {num, den}: ceil(amount_in * num / den). */
export function floorMinOut(rate, amountIn) {
  const n = BigInt(amountIn) * BigInt(rate.num);
  const d = BigInt(rate.den);
  return (n + d - 1n) / d;
}
