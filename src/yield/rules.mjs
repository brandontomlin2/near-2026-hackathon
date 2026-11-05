// Off-chain mirror of the yield-vault's hard rules (contracts/yield-vault), same error
// codes and same order (config v2, see HARD_RULE_ORDER), so a proposal that would revert
// on chain is never sent. Limits are per token_in in that token's own base units, and the
// price floor min_amount_out * den >= amount_in * num is computed in BigInt (no overflow).
// Strategy soft checks (agent policy, not enforced on chain) are reported separately.

import { isStablePool, maxReferenceDeviationBps, poolById, quoteOut, referenceDeviationBps, slippageBps } from "./pools.mjs";
import { limitFor, strategyFor } from "./strategies.mjs";

/** Hard rule error codes in the order the vault checks them. */
export const HARD_RULE_ORDER = Object.freeze([
  "ERR_NOT_RUNNER",
  "ERR_PAUSED",
  "ERR_SWAP_IN_FLIGHT",
  "ERR_POOL_NOT_ALLOWED",
  "ERR_TOKEN_NOT_IN_POOL",
  "ERR_ZERO_AMOUNT",
  "ERR_ZERO_MIN_OUT",
  "ERR_PRICE_FLOOR",
  "ERR_NO_LIMIT",
  "ERR_MAX_TRADE",
  "ERR_DAILY_CAP",
  "ERR_INSUFFICIENT_BALANCE",
]);

/** The contract's STRATEGIES. */
export const VAULT_STRATEGIES = Object.freeze(["aloof", "chaotic", "social", "skeptic"]);

const DAY_SECONDS = 86400;

/** day = floor(unix_seconds / 86400), the contract's day_of (block_timestamp ns / NS_PER_DAY) taken from milliseconds */
export function dayOf(nowMs) {
  return Math.floor(nowMs / 1000 / DAY_SECONDS);
}

/** Units of `token` spent on UTC day `today`; a different stored day counts as 0 (rollover resets all tokens). */
export function spentOn(state, token, today) {
  return state.spent && state.spent.day === today ? BigInt(state.spent.amounts?.[token] ?? "0") : 0n;
}

/** Largest value a u128 can hold; the contract's checked_add on the daily total fails above it. */
export const U128_MAX = (1n << 128n) - 1n;

/**
 * Config v2 validation, mirroring the contract's validate_config with its exact
 * ERR_BAD_CONFIG messages: strategy is one of the four, per limit max_trade > 0,
 * daily_cap >= max_trade and a unique token, per pool nonzero rates, token_a != token_b
 * and a unique pool_id, unique runners. The contract panics on the first failure; this
 * returns every failure in the order the contract would meet them (empty = valid), so
 * problems[0] is the contract's panic message.
 */
export function validateVaultConfig(config) {
  const problems = [];
  if (!VAULT_STRATEGIES.includes(config.strategy)) problems.push("ERR_BAD_CONFIG: strategy must be aloof, chaotic, social or skeptic");
  const limits = config.limits ?? [];
  limits.forEach((l, i) => {
    if (BigInt(l.max_trade) === 0n) problems.push("ERR_BAD_CONFIG: max_trade must be > 0");
    if (BigInt(l.daily_cap) < BigInt(l.max_trade)) problems.push("ERR_BAD_CONFIG: daily_cap must be >= max_trade");
    if (limits.slice(0, i).some((q) => q.token_id === l.token_id)) problems.push("ERR_BAD_CONFIG: duplicate limit token");
  });
  const pools = config.allowed_pools ?? [];
  pools.forEach((p, i) => {
    for (const r of [p.min_rate_a_to_b, p.min_rate_b_to_a]) {
      if (!r || BigInt(r.num) === 0n || BigInt(r.den) === 0n) problems.push("ERR_BAD_CONFIG: rate num and den must be > 0");
    }
    if (p.token_a === p.token_b) problems.push("ERR_BAD_CONFIG: token_a must differ from token_b");
    if (pools.slice(0, i).some((q) => q.pool_id === p.pool_id)) problems.push("ERR_BAD_CONFIG: duplicate pool");
  });
  const runners = config.runners ?? [];
  runners.forEach((r, i) => {
    if (runners.slice(0, i).includes(r)) problems.push("ERR_BAD_CONFIG: duplicate runner");
  });
  return problems;
}

/**
 * @typedef {object} VaultState
 * @property {boolean} [paused]
 * @property {boolean} [in_flight] a swap is already in flight
 * @property {boolean} [recovery_in_flight] a Ref recovery is in flight
 * @property {{ day: number, amounts: Record<string, string | bigint> }} [spent] per token_in units spent on `day`
 * @property {Record<string, string | bigint>} [balances] vault balance per token
 */

/** True for a canonical decimal u128 string (no sign, space, prefix, leading zero) or a BigInt in range. */
function isU128Amount(v) {
  if (typeof v === "bigint") return v >= 0n && v <= U128_MAX;
  return typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) <= U128_MAX;
}

/**
 * Hard rules: the one JavaScript copy of the contract's check_rules (lib.rs), same checks in
 * the same order with the contract's exact `ERR_CODE: detail` strings, so a proposal that
 * would panic on chain is never sent. Amounts and rates may be decimal strings or BigInt.
 * contracts/yield-vault/tests/rule-vectors.json pins this file to the Rust.
 * @returns {{ ok: boolean, code: string | null, reason: string }} reason is "" when ok
 */
export function checkProposal(proposal, config, state, runnerId, nowMs) {
  const fail = (code, detail) => ({ ok: false, code, reason: `${code}: ${detail}` });
  // The contract parses amounts as near-sdk U128 (canonical decimal string of a u128) before
  // check_rules runs, so non-canonical input is rejected first. Mirror that at the very top;
  // ERR_BAD_AMOUNT is an off-chain-only code (the contract fails at JSON parsing, not in check_rules).
  // It is stricter than near-sdk U128 parsing (which may accept e.g. "+5" or "01"), so it never
  // accepts what the contract refuses; the shared vectors use canonical strings, so none moves.
  // BigInt in [0, U128_MAX] is accepted (in-process callers); numbers and other types are not.
  for (const field of ["amount_in", "min_amount_out"]) {
    if (!isU128Amount(proposal?.[field])) return fail("ERR_BAD_AMOUNT", `${field} must be a canonical decimal u128 string`);
  }
  if (!config.runners.includes(runnerId)) return fail("ERR_NOT_RUNNER", `${runnerId} is not an approved runner`);
  if (state.paused) return fail("ERR_PAUSED", "vault is paused");
  if (state.in_flight) return fail("ERR_SWAP_IN_FLIGHT", "another swap is in flight");
  if (state.recovery_in_flight) return fail("ERR_SWAP_IN_FLIGHT", "a Ref recovery is in flight");
  const pool = config.allowed_pools.find((p) => p.pool_id === proposal.pool_id);
  if (!pool) return fail("ERR_POOL_NOT_ALLOWED", `pool ${proposal.pool_id}`);
  const fwd = proposal.token_in === pool.token_a && proposal.token_out === pool.token_b;
  const rev = proposal.token_in === pool.token_b && proposal.token_out === pool.token_a;
  if (!(fwd || rev)) return fail("ERR_TOKEN_NOT_IN_POOL", `tokens must be the pair of pool ${proposal.pool_id}`);
  const amountIn = BigInt(proposal.amount_in);
  if (amountIn === 0n) return fail("ERR_ZERO_AMOUNT", "amount_in must be > 0");
  const minOut = BigInt(proposal.min_amount_out);
  if (minOut === 0n) return fail("ERR_ZERO_MIN_OUT", "min_amount_out must be > 0");
  const rate = fwd ? pool.min_rate_a_to_b : pool.min_rate_b_to_a;
  const num = BigInt(rate.num);
  const den = BigInt(rate.den);
  if (minOut * den < amountIn * num) {
    return fail("ERR_PRICE_FLOOR", `min_amount_out ${minOut} below floor ${num}/${den} of amount_in ${amountIn}`);
  }
  const limit = limitFor(config, proposal.token_in);
  if (!limit) return fail("ERR_NO_LIMIT", `no limit for ${proposal.token_in}`);
  const maxTrade = BigInt(limit.max_trade);
  if (amountIn > maxTrade) return fail("ERR_MAX_TRADE", `${amountIn} exceeds max_trade ${maxTrade}`);
  const spent = spentOn(state, proposal.token_in, dayOf(nowMs));
  const dailyCap = BigInt(limit.daily_cap);
  const total = spent + amountIn;
  if (total > U128_MAX || total > dailyCap) {
    return fail("ERR_DAILY_CAP", `spent ${spent} + ${amountIn} exceeds daily_cap ${dailyCap}`);
  }
  const balance = BigInt(state.balances?.[proposal.token_in] ?? "0");
  if (balance < amountIn) return fail("ERR_INSUFFICIENT_BALANCE", `have ${balance} need ${amountIn}`);
  return { ok: true, code: null, reason: "" };
}

/**
 * Strategy-level soft checks. Not enforced by the vault: they say whether the proposal
 * respects the agent's own policy. Every violation is reported, in a fixed order:
 * SOFT_UNKNOWN_POOL (alone), SOFT_NOT_STABLE, SOFT_TOKEN_NOT_ALLOWED, SOFT_TOO_LARGE,
 * SOFT_OFF_CONSENSUS / SOFT_TOO_LARGE (consensus size), SOFT_OFF_REFERENCE, then
 * SOFT_NO_LIQUIDITY or SOFT_SLIPPAGE.
 * SOFT_OFF_REFERENCE applies to every agent: the pool's quote is more than the pair's bound
 * (STABLE_PEG_BPS / MAX_REF_DEVIATION_BPS) from the mock_usd_price reference. SOFT_SLIPPAGE stays
 * the tolerance against the live quote; the two together (quote near reference, min_out near
 * quote) plus the on-chain reference-derived floor bound the price against the reference.
 * @returns {{ ok: boolean, violations: { code: string, reason: string }[] }}
 */
export function checkStrategy(proposal, agentId, config, fixture, { consensus = null } = {}) {
  const { params } = strategyFor(agentId);
  const violations = [];
  const add = (code, reason) => violations.push({ code, reason });
  const pool = poolById(proposal.pool_id, fixture);
  if (!pool) {
    add("SOFT_UNKNOWN_POOL", `pool ${proposal.pool_id} is not in the pool snapshot`);
    return { ok: false, violations };
  }
  if (params.stable_only && !isStablePool(pool, fixture)) add("SOFT_NOT_STABLE", `${agentId} trades stable pairs only; pool ${pool.pool_id} is not one`);
  if (params.token_in_allow && !params.token_in_allow.includes(proposal.token_in)) {
    add("SOFT_TOKEN_NOT_ALLOWED", `${agentId} does not trade ${proposal.token_in} as input`);
  }
  const limit = limitFor(config, proposal.token_in);
  const cap = limit ? (BigInt(limit.max_trade) * BigInt(params.size_bps)) / 10000n : 0n;
  if (!params.follows_consensus && BigInt(proposal.amount_in) > cap) {
    add("SOFT_TOO_LARGE", `amount_in ${proposal.amount_in} is above ${agentId}'s size limit ${cap} (${params.size_bps} bps of ${proposal.token_in}'s max_trade)`);
  }
  if (params.follows_consensus && consensus) {
    const same = consensus.pool_id === proposal.pool_id && consensus.token_in === proposal.token_in && consensus.token_out === proposal.token_out;
    if (!same) add("SOFT_OFF_CONSENSUS", `${agentId} follows the swarm; the consensus is pool ${consensus.pool_id} ${consensus.token_in} -> ${consensus.token_out}`);
    else if (BigInt(proposal.amount_in) > BigInt(consensus.amount_in)) add("SOFT_TOO_LARGE", `amount_in ${proposal.amount_in} is above the consensus size ${consensus.amount_in}`);
  }
  const maxDev = maxReferenceDeviationBps(pool, fixture);
  if (maxDev !== null && BigInt(proposal.amount_in) > 0n && quoteOut(pool, proposal.token_in, proposal.amount_in) > 0n) {
    const dev = referenceDeviationBps(pool, proposal.token_in, proposal.amount_in, fixture);
    if (dev !== null && Math.abs(dev) > maxDev) {
      const kind = isStablePool(pool, fixture) ? "a stable pair" : "a priced pair";
      add("SOFT_OFF_REFERENCE", `pool ${pool.pool_id} quote is ${dev > 0 ? "+" : ""}${dev} bps off the reference price (limit ${maxDev} bps for ${kind})`);
    }
  }
  if (quoteOut(pool, proposal.token_in, proposal.amount_in) === 0n) {
    add("SOFT_NO_LIQUIDITY", "the pool snapshot gives no output for this input");
  } else {
    const slip = slippageBps(pool, proposal);
    if (slip !== null && slip > params.slippage_bps) add("SOFT_SLIPPAGE", `slippage ${slip} bps is above ${agentId}'s limit of ${params.slippage_bps} bps`);
  }
  return { ok: violations.length === 0, violations };
}

/** Both layers for one proposal. `sendable` needs the hard rules only. */
export function evaluateProposal(proposal, agentId, config, state, runnerId, nowMs, fixture, ctx = {}) {
  const hard = checkProposal(proposal, config, state, runnerId, nowMs);
  const soft = checkStrategy(proposal, agentId, config, fixture, ctx);
  return { hard, soft, sendable: hard.ok && soft.ok };
}
