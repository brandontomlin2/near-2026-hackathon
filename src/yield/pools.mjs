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

// ---- Reference prices ------------------------------------------------------------------
// The fixture's tokens carry a mock_usd_price (a decimal string such as "1.00") or null. It is
// the one price that does not come from the pool being judged, so it is what a pool's quote is
// compared against. Everything below is BigInt rational maths (no floats feed a rule).

/** A stable pair may sit at most this far from its $1 peg (bps) before the strategy refuses it. */
export const STABLE_PEG_BPS = 100;
/** Any other pair whose tokens both have a reference price: the widest quote deviation (bps) accepted. */
export const MAX_REF_DEVIATION_BPS = 1000;

const gcdBig = (a, b) => (b === 0n ? a : gcdBig(b, a % b));

/** "3.00" -> {n: 300n, d: 100n}; null when the token has no usable price. */
function parsePrice(text) {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [int, frac = ""] = text.split(".");
  const n = BigInt(int + frac);
  return n === 0n ? null : { n, d: 10n ** BigInt(frac.length) };
}

/**
 * Reference exchange rate from `tokenIn` to `tokenOut` in base units:
 * {num, den} (BigInt, reduced) = base units of tokenOut per base unit of tokenIn at the fixture's
 * mock_usd_price. E.g. nusdt (6 decimals) -> nusdc (2 decimals) at $1/$1 is 1/10000
 * (1 base nusdt = 1e-6 USD = 1e-4 base nusdc). Null when either token has no reference price.
 * @returns {{ num: bigint, den: bigint } | null}
 */
export function referenceRate(tokenIn, tokenOut, fixture = loadPoolFixture()) {
  const tIn = fixture.tokens[tokenIn];
  const tOut = fixture.tokens[tokenOut];
  const pIn = parsePrice(tIn?.mock_usd_price);
  const pOut = parsePrice(tOut?.mock_usd_price);
  if (!pIn || !pOut) return null;
  // (pIn.n/pIn.d / 10^dIn) / (pOut.n/pOut.d / 10^dOut)
  const num = pIn.n * pOut.d * 10n ** BigInt(tOut.decimals);
  const den = pOut.n * pIn.d * 10n ** BigInt(tIn.decimals);
  const g = gcdBig(num, den);
  return { num: num / g, den: den / g };
}

/**
 * Output of an exact input at the reference rate, rounded down. Null without a reference.
 * Note this is 0n for dust (the 500 base nusdt trade is worth 0.05 base nusdc);
 * use referenceDeviationBps, which does not round, to compare against it.
 * @returns {bigint | null}
 */
export function referenceOut(tokenIn, tokenOut, amountIn, fixture = loadPoolFixture()) {
  const r = referenceRate(tokenIn, tokenOut, fixture);
  return r ? (BigInt(amountIn) * r.num) / r.den : null;
}

/**
 * How far the pool's quote for `amountIn` of `tokenIn` is from the reference output, as signed
 * whole bps truncated toward zero: (quote / ref - 1) * 10000. Computed on the unrounded
 * reference (quote * den vs amountIn * num), so dust trades whose reference is under one base
 * unit still get a correct, very large deviation. A pool that gives 0 out is -10000.
 * Null when there is no reference price, the token is not in the pool or amountIn is 0.
 * @returns {number | null}
 */
export function referenceDeviationBps(pool, tokenIn, amountIn, fixture = loadPoolFixture()) {
  const tokenOut = otherToken(pool, tokenIn);
  const aIn = BigInt(amountIn);
  if (!tokenOut || aIn <= 0n) return null;
  const r = referenceRate(tokenIn, tokenOut, fixture);
  if (!r) return null;
  const quote = quoteOut(pool, tokenIn, aIn);
  const ref = aIn * r.num;
  return Number(((quote * r.den - ref) * 10000n) / ref);
}

/**
 * Same comparison for the pool's spot price (reserve_out / reserve_in: no fee, no price impact)
 * in the direction selling `tokenIn`. Null without a reference or with an empty reserve.
 * @returns {number | null}
 */
export function spotDeviationBps(pool, tokenIn, fixture = loadPoolFixture()) {
  const tokenOut = otherToken(pool, tokenIn);
  if (!tokenOut) return null;
  const r = referenceRate(tokenIn, tokenOut, fixture);
  if (!r) return null;
  const [rIn, rOut] = tokenIn === pool.token_a ? [BigInt(pool.reserve_a), BigInt(pool.reserve_b)] : [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
  if (rIn <= 0n || rOut <= 0n) return null;
  const ref = rIn * r.num;
  return Number(((rOut * r.den - ref) * 10000n) / ref);
}

/**
 * Widest |deviation| from the reference a pool's quote may have: STABLE_PEG_BPS when both tokens
 * are stable and priced, MAX_REF_DEVIATION_BPS when both are priced but not both stable, null
 * when either token has no reference price (such a pair is not checked against a reference).
 * @returns {number | null}
 */
export function maxReferenceDeviationBps(pool, fixture = loadPoolFixture()) {
  if (!referenceRate(pool.token_a, pool.token_b, fixture)) return null;
  return isStablePool(pool, fixture) ? STABLE_PEG_BPS : MAX_REF_DEVIATION_BPS;
}
