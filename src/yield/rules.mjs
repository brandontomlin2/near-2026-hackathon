// Off-chain mirror of the yield-vault's hard rules (contracts/yield-vault), same error
// codes and same order (config v2, see HARD_RULE_ORDER), so a proposal that would revert
// on chain is never sent. Limits are per token_in in that token's own base units, and the
// price floor min_amount_out * den >= amount_in * num is computed in BigInt (no overflow).
// Strategy soft checks (agent policy, not enforced on chain) are reported separately.

import { isStablePool, poolById, quoteOut, slippageBps } from "./pools.mjs";
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

/** day = floor(unix_seconds / 86400) */
export function dayOf(nowMs) {
  return Math.floor(nowMs / 1000 / DAY_SECONDS);
}

/** Units of `token` spent on UTC day `today`; a different stored day counts as 0 (rollover resets all tokens). */
export function spentOn(state, token, today) {
  return state.spent && state.spent.day === today ? BigInt(state.spent.amounts?.[token] ?? "0") : 0n;
}

/**
 * Config v2 validation, mirroring the contract's validate_config: strategy is one of the
 * four, nonzero rates, token_a != token_b, unique pools, runners and limit tokens,
 * max_trade > 0 and max_trade <= daily_cap. Returns a list of problems (empty = valid).
 */
export function validateVaultConfig(config) {
  const problems = [];
  if (!VAULT_STRATEGIES.includes(config.strategy)) problems.push(`strategy must be one of ${VAULT_STRATEGIES.join(", ")}`);
  const poolIds = new Set();
  for (const p of config.allowed_pools ?? []) {
    if (poolIds.has(p.pool_id)) problems.push(`duplicate pool ${p.pool_id}`);
    poolIds.add(p.pool_id);
    if (p.token_a === p.token_b) problems.push(`pool ${p.pool_id} token_a must differ from token_b`);
    for (const key of ["min_rate_a_to_b", "min_rate_b_to_a"]) {
      const r = p[key];
      if (!r || BigInt(r.num) === 0n || BigInt(r.den) === 0n) problems.push(`pool ${p.pool_id} ${key} must have nonzero num and den`);
    }
  }
  const seen = new Set();
  for (const l of config.limits ?? []) {
    if (seen.has(l.token_id)) problems.push(`duplicate limit for ${l.token_id}`);
    seen.add(l.token_id);
    if (BigInt(l.max_trade) === 0n) problems.push(`${l.token_id} max_trade is zero`);
    if (BigInt(l.max_trade) > BigInt(l.daily_cap)) problems.push(`${l.token_id} max_trade exceeds daily_cap`);
  }
  const runners = config.runners ?? [];
  if (new Set(runners).size !== runners.length) problems.push("duplicate runner");
  return problems;
}

/**
 * @typedef {object} VaultState
 * @property {boolean} [paused]
 * @property {boolean} [in_flight] a swap is already in flight
 * @property {{ day: number, amounts: Record<string, string> }} [spent] per token_in units spent on `day` (decimal strings)
 * @property {Record<string, string>} [balances] vault balance per token (decimal strings)
 */

/**
 * Hard rules, mirroring the on-chain check_proposal(proposal, runner_id) -> { ok, reason }.
 * @returns {{ ok: boolean, code: string | null, reason: string }}
 */
export function checkProposal(proposal, config, state, runnerId, nowMs) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!config.runners.includes(runnerId)) return fail("ERR_NOT_RUNNER", `${runnerId} is not in the vault's runners`);
  if (state.paused) return fail("ERR_PAUSED", "the vault is paused");
  if (state.in_flight) return fail("ERR_SWAP_IN_FLIGHT", "another swap is in flight");
  const pool = config.allowed_pools.find((p) => p.pool_id === proposal.pool_id);
  if (!pool) return fail("ERR_POOL_NOT_ALLOWED", `pool ${proposal.pool_id} is not in allowed_pools`);
  const pairOk = proposal.token_in !== proposal.token_out
    && ((proposal.token_in === pool.token_a && proposal.token_out === pool.token_b)
      || (proposal.token_in === pool.token_b && proposal.token_out === pool.token_a));
  if (!pairOk) return fail("ERR_TOKEN_NOT_IN_POOL", `token_in and token_out must be the two different tokens of pool ${pool.pool_id}`);
  const amountIn = BigInt(proposal.amount_in);
  if (amountIn === 0n) return fail("ERR_ZERO_AMOUNT", "amount_in is zero");
  const minOut = BigInt(proposal.min_amount_out);
  if (minOut === 0n) return fail("ERR_ZERO_MIN_OUT", "min_amount_out is zero");
  const rate = proposal.token_in === pool.token_a ? pool.min_rate_a_to_b : pool.min_rate_b_to_a;
  if (minOut * BigInt(rate.den) < amountIn * BigInt(rate.num)) {
    return fail("ERR_PRICE_FLOOR", `min_amount_out ${minOut} for amount_in ${amountIn} is below the pool's minimum rate ${rate.num}/${rate.den}`);
  }
  const limit = limitFor(config, proposal.token_in);
  if (!limit) return fail("ERR_NO_LIMIT", `${proposal.token_in} has no entry in limits`);
  const maxTrade = BigInt(limit.max_trade);
  if (amountIn > maxTrade) return fail("ERR_MAX_TRADE", `amount_in ${amountIn} exceeds max_trade ${maxTrade} for ${proposal.token_in}`);
  const spent = spentOn(state, proposal.token_in, dayOf(nowMs));
  const dailyCap = BigInt(limit.daily_cap);
  if (spent + amountIn > dailyCap) return fail("ERR_DAILY_CAP", `spent today ${spent} + ${amountIn} exceeds daily_cap ${dailyCap} for ${proposal.token_in}`);
  const balance = BigInt(state.balances?.[proposal.token_in] ?? "0");
  if (balance < amountIn) return fail("ERR_INSUFFICIENT_BALANCE", `vault holds ${balance} of ${proposal.token_in}, needs ${amountIn}`);
  return { ok: true, code: null, reason: "ok" };
}

/**
 * Strategy-level soft checks. Not enforced by the vault: they say whether the proposal
 * respects the agent's own policy. Every violation is reported, in a fixed order.
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
