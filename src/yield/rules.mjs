// Off-chain mirror of the yield-vault's hard rules (contracts/yield-vault), same error
// codes and same order, so a proposal that would revert on chain is never sent.
// Strategy soft checks (agent policy, not enforced on chain) are reported separately.

import { U128_MAX, minOutFor, otherToken, poolById, quoteOut, slippageBps, isStablePool } from "./pools.mjs";
import { strategyFor } from "./strategies.mjs";

/** Hard rule error codes in the order the vault checks them. */
export const HARD_RULE_ORDER = Object.freeze([
  "ERR_NOT_RUNNER",
  "ERR_PAUSED",
  "ERR_POOL_NOT_ALLOWED",
  "ERR_TOKEN_NOT_IN_POOL",
  "ERR_ZERO_AMOUNT",
  "ERR_ZERO_MIN_OUT",
  "ERR_MAX_TRADE",
  "ERR_DAILY_CAP",
  "ERR_INSUFFICIENT_BALANCE",
  "ERR_SWAP_IN_FLIGHT",
]);

const DAY_SECONDS = 86400;

/** day = floor(unix_seconds / 86400) */
export function dayOf(nowMs) {
  return Math.floor(nowMs / 1000 / DAY_SECONDS);
}

/**
 * @typedef {object} VaultState
 * @property {boolean} [paused]
 * @property {boolean} [in_flight] a swap is already in flight
 * @property {{ day: number, amount: string }} [spent] input-token units spent on `day`
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
  const pool = config.allowed_pools.find((p) => p.pool_id === proposal.pool_id);
  if (!pool) return fail("ERR_POOL_NOT_ALLOWED", `pool ${proposal.pool_id} is not in allowed_pools`);
  const pairOk = proposal.token_in !== proposal.token_out
    && ((proposal.token_in === pool.token_a && proposal.token_out === pool.token_b)
      || (proposal.token_in === pool.token_b && proposal.token_out === pool.token_a));
  if (!pairOk) return fail("ERR_TOKEN_NOT_IN_POOL", `token_in and token_out must be the two different tokens of pool ${pool.pool_id}`);
  const amountIn = BigInt(proposal.amount_in);
  if (amountIn === 0n) return fail("ERR_ZERO_AMOUNT", "amount_in is zero");
  if (BigInt(proposal.min_amount_out) === 0n) return fail("ERR_ZERO_MIN_OUT", "min_amount_out is zero");
  const maxTrade = BigInt(config.max_trade);
  if (amountIn > maxTrade) return fail("ERR_MAX_TRADE", `amount_in ${amountIn} exceeds max_trade ${maxTrade}`);
  const today = dayOf(nowMs);
  const spent = state.spent && state.spent.day === today ? BigInt(state.spent.amount) : 0n;
  const dailyCap = BigInt(config.daily_cap);
  if (spent + amountIn > dailyCap) return fail("ERR_DAILY_CAP", `spent today ${spent} + ${amountIn} exceeds daily_cap ${dailyCap}`);
  const balance = BigInt(state.balances?.[proposal.token_in] ?? "0");
  if (balance < amountIn) return fail("ERR_INSUFFICIENT_BALANCE", `vault holds ${balance} of ${proposal.token_in}, needs ${amountIn}`);
  if (state.in_flight) return fail("ERR_SWAP_IN_FLIGHT", "another swap is in flight");
  return { ok: true, code: null, reason: "ok" };
}

/**
 * Strategy-level soft checks. Not enforced by the vault: they say whether the proposal
 * respects the agent's own policy. Every violation is reported, in a fixed order.
 * @returns {{ ok: boolean, violations: { code: string, reason: string }[] }}
 */
export function checkStrategy(proposal, agentId, config, fixture) {
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
  const cap = (BigInt(config.max_trade) * BigInt(params.size_bps)) / 10000n;
  if (!params.follows_consensus && BigInt(proposal.amount_in) > cap) {
    add("SOFT_TOO_LARGE", `amount_in ${proposal.amount_in} is above ${agentId}'s size limit ${cap} (${params.size_bps} bps of max_trade)`);
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
export function evaluateProposal(proposal, agentId, config, state, runnerId, nowMs, fixture) {
  const hard = checkProposal(proposal, config, state, runnerId, nowMs);
  const soft = checkStrategy(proposal, agentId, config, fixture);
  return { hard, soft, sendable: hard.ok && soft.ok };
}

export { minOutFor, otherToken };
export { U128_MAX };
