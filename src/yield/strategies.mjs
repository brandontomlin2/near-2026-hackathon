// Personality = strategy. The four seeded agents (src/traits/agents.mjs) each run one
// yield strategy. The params here are the soft, agent-level policy; the vault's
// VaultConfig (per-token limits, price floors, allowed_pools, runners) is the hard limit that
// holds whatever the agent or the model says.

import { AGENTS } from "../traits/agents.mjs";
import { loadPoolFixture, poolById } from "./pools.mjs";

export const STRATEGY_VERSION = 1;
export const WNEAR = "wrap.testnet";
export const NUSDT = "nusdt.ft-fin.testnet";
export const NUSDC = "nusdc.ft-fin.testnet";
export const RFT = "rft.tokenfactory.testnet";
export const EXCHANGE = "ref-finance-101.testnet";
export const PLACEHOLDER_RUNNER = "runner.yield-demo.testnet";
export const PLACEHOLDER_VAULT = "vault.yield-demo.testnet";

/**
 * @typedef {object} StrategyParams
 * @property {boolean} stable_only only stable/stable pools
 * @property {string[] | null} token_in_allow input tokens the strategy trades, null = any
 * @property {number} size_bps largest proposal as bps of the vault's max_trade for token_in
 * @property {number} slippage_bps widest slippage allowance the strategy accepts
 * @property {boolean} follows_consensus adopts the majority of the other agents' proposals
 * @property {{ veto_size_bps: number, veto_slippage_bps: number, hedge_size_bps: number } | null} audit
 */

/** @type {Record<string, { id: string, name: string, description: string, params: StrategyParams }>} */
const STRATEGY_TABLE = {
  aloof: {
    id: "aloof",
    name: "Conservative",
    description: "Stable pairs only, tiny size, tight slippage. Moves rarely and never chases.",
    params: { stable_only: true, token_in_allow: [NUSDT, NUSDC], size_bps: 500, slippage_bps: 30, follows_consensus: false, audit: null },
  },
  chaotic: {
    id: "chaotic",
    name: "Degen momentum",
    description: "Chases volatile momentum with large size and loose slippage; only the vault's max_trade and daily_cap stop it.",
    params: { stable_only: false, token_in_allow: [WNEAR], size_bps: 10000, slippage_bps: 300, follows_consensus: false, audit: null },
  },
  social: {
    id: "social",
    name: "Consensus follower",
    description: "Adopts the majority of the other agents' proposals (the median size of the winning group).",
    params: { stable_only: false, token_in_allow: null, size_bps: 10000, slippage_bps: 100, follows_consensus: true, audit: null },
  },
  skeptic: {
    id: "skeptic",
    name: "Auditor / risk-off",
    description: "Vetoes proposals that sit close to the vault limits or allow loose slippage; otherwise proposes a small hedge back to stable.",
    params: {
      stable_only: true,
      token_in_allow: [NUSDT, NUSDC],
      size_bps: 1000,
      slippage_bps: 30,
      follows_consensus: false,
      audit: { veto_size_bps: 8000, veto_slippage_bps: 200, hedge_size_bps: 1000 },
    },
  },
};

export const STRATEGIES = Object.freeze(
  Object.fromEntries(AGENTS.map((a) => [a.id, Object.freeze({ ...STRATEGY_TABLE[a.id], params: Object.freeze(STRATEGY_TABLE[a.id].params) })])),
);

export function strategyFor(agentId) {
  const s = STRATEGIES[agentId];
  if (!s) throw new Error(`no strategy for agent ${JSON.stringify(agentId)}`);
  return s;
}

// Per-agent vault configs (config v2). Limits are per token_in, in that token's own base
// units, so one vault can trade several tokens without mixing decimals. A token without an
// entry in `limits` cannot be sold. max_trade / daily_cap below are in whole tokens and are
// scaled with the fixture's token decimals.
const CONFIG_TABLE = {
  aloof: { pools: [1], limits: { [NUSDT]: ["0.01", "0.03"], [NUSDC]: ["0.01", "0.03"] } },
  chaotic: { pools: [0], limits: { [WNEAR]: ["1", "3"], [RFT]: ["10", "30"] } },
  social: { pools: [0, 1], limits: { [WNEAR]: ["1", "2"], [RFT]: ["10", "20"], [NUSDT]: ["0.01", "0.02"], [NUSDC]: ["0.01", "0.02"] } },
  skeptic: { pools: [1], limits: { [NUSDT]: ["0.01", "0.02"], [NUSDC]: ["0.01", "0.02"] } },
};

const POOL_PAIRS = {
  0: { pool_id: 0, token_a: WNEAR, token_b: RFT },
  1: { pool_id: 1, token_a: NUSDT, token_b: NUSDC },
};

/** Margin below the snapshot's spot price that the price floor leaves, in bps (50%: generous, a sanity floor, not a slippage rule). */
export const FLOOR_MARGIN_BPS = 5000n;

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));

/** Whole-token decimal string ("0.01") to base units for `token`, using the fixture's decimals. */
function toBaseUnits(whole, token, fixture) {
  const decimals = fixture.tokens[token].decimals;
  const [int, frac = ""] = whole.split(".");
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals))).toString();
}

/**
 * Price floor for selling `tokenIn` in `pool`, as {num, den} decimal strings with
 * min_amount_out * den >= amount_in * num on chain. Derived from the snapshot's spot price
 * (reserve_out / reserve_in, no fee, no impact) minus FLOOR_MARGIN_BPS:
 *   num / den = reserve_out * (10000 - margin) / (reserve_in * 10000)
 * reduced by the gcd. Both are in base units, so the decimals are already accounted for.
 */
function floorRate(pool, tokenIn) {
  const [rIn, rOut] = tokenIn === pool.token_a ? [BigInt(pool.reserve_a), BigInt(pool.reserve_b)] : [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
  const num = rOut * (10000n - FLOOR_MARGIN_BPS);
  const den = rIn * 10000n;
  const g = gcd(num, den);
  return { num: (num / g).toString(), den: (den / g).toString() };
}

/** The limits entry for `tokenId` ({token_id, max_trade, daily_cap}), or undefined when the token cannot be sold. */
export function limitFor(config, tokenId) {
  return (config.limits ?? []).find((l) => l.token_id === tokenId);
}

/**
 * Example VaultConfig (v2) for an agent (mirrors the contract's VaultConfig).
 * @returns {{ strategy: string, allowed_pools: object[], limits: object[], runners: string[] }}
 */
export function defaultVaultConfig(agentId, { runner = PLACEHOLDER_RUNNER, fixture = loadPoolFixture() } = {}) {
  strategyFor(agentId);
  const c = CONFIG_TABLE[agentId];
  return {
    strategy: agentId,
    allowed_pools: c.pools.map((id) => {
      const pair = POOL_PAIRS[id];
      const pool = poolById(id, fixture);
      return { ...pair, min_rate_a_to_b: floorRate(pool, pair.token_a), min_rate_b_to_a: floorRate(pool, pair.token_b) };
    }),
    limits: Object.entries(c.limits).map(([token_id, [max, cap]]) => ({ token_id, max_trade: toBaseUnits(max, token_id, fixture), daily_cap: toBaseUnits(cap, token_id, fixture) })),
    runners: [runner],
  };
}

/** The strategy block that goes into the NFT's token metadata `extra` JSON. */
export function strategyMetadata(agentId) {
  const s = strategyFor(agentId);
  return { yield_strategy: { version: STRATEGY_VERSION, id: s.id, name: s.name, ...s.params, exchange: EXCHANGE } };
}
