// How far a proposal's pool quote is from the fixture's reference price, as plain data and one
// text line, shared by `npm run yield`, `npm run yield:demo` and the demo page. The numbers come
// from src/yield/pools.mjs (the same functions the SOFT_OFF_REFERENCE check uses); nothing here
// decides anything.

import { isStablePool, loadPoolFixture, maxReferenceDeviationBps, poolById, quoteOut, referenceDeviationBps } from "./pools.mjs";

const symbolOf = (token) => token.split(".")[0];

/**
 * @param {{ pool_id: number, token_in: string, amount_in: string|number|bigint }} proposal
 * @returns {{ reference_deviation_bps: number|null, max_reference_deviation_bps: number|null, pair_kind: "stable"|"priced"|null, unpriced_token: string|null }}
 *   all null when there is no pool, no reference price for the pair, or the quote is 0.
 */
export function referenceView(proposal, fixture = loadPoolFixture()) {
  const none = { reference_deviation_bps: null, max_reference_deviation_bps: null, pair_kind: null, unpriced_token: null };
  const pool = poolById(proposal.pool_id, fixture);
  if (!pool) return none;
  const max = maxReferenceDeviationBps(pool, fixture);
  if (max === null) {
    const unpriced = [pool.token_a, pool.token_b].find((t) => !fixture.tokens[t]?.mock_usd_price);
    return { ...none, unpriced_token: unpriced ? symbolOf(unpriced) : null };
  }
  let dev = null;
  try {
    if (BigInt(proposal.amount_in) > 0n && quoteOut(pool, proposal.token_in, proposal.amount_in) > 0n) dev = referenceDeviationBps(pool, proposal.token_in, proposal.amount_in, fixture);
  } catch {
    dev = null;
  }
  return { reference_deviation_bps: dev, max_reference_deviation_bps: max, pair_kind: isStablePool(pool, fixture) ? "stable" : "priced", unpriced_token: null };
}

/** One line for the text outputs (no leading label). */
export function referenceLine(view) {
  if (view.max_reference_deviation_bps === null) {
    return view.unpriced_token
      ? `no reference price (${view.unpriced_token} has none): the floor is a spot sanity floor`
      : "no reference price: the floor is a spot sanity floor";
  }
  if (view.reference_deviation_bps === null) return `pool gives no output, nothing to compare (limit ${view.max_reference_deviation_bps} bps, ${view.pair_kind} pair)`;
  const d = view.reference_deviation_bps;
  const over = Math.abs(d) > view.max_reference_deviation_bps;
  return `quote ${d > 0 ? "+" : ""}${d} bps vs mock_usd_price reference (limit ${view.max_reference_deviation_bps} bps, ${view.pair_kind} pair${over ? ": OFF REFERENCE" : ""})`;
}

/** Short table cell for a refused agent, e.g. "refused: off reference +18590000 bps"; null when not off reference. */
export function offReferenceNote(view) {
  const d = view.reference_deviation_bps;
  if (d === null || view.max_reference_deviation_bps === null || Math.abs(d) <= view.max_reference_deviation_bps) return null;
  return `${d > 0 ? "+" : ""}${d} bps vs reference (limit ${view.max_reference_deviation_bps})`;
}
