// Personality = strategy. The four seeded agents (src/traits/agents.mjs) each run one
// yield strategy. The params here are the soft, agent-level policy; the vault's
// VaultConfig (max_trade, daily_cap, allowed_pools, runners) is the hard limit that
// holds whatever the agent or the model says.

import { AGENTS } from "../traits/agents.mjs";

export const STRATEGY_VERSION = 1;
export const WNEAR = "wrap.testnet";
export const NUSDT = "nusdt.ft-fin.testnet";
export const NUSDC = "nusdc.ft-fin.testnet";
export const EXCHANGE = "ref-finance-101.testnet";
export const PLACEHOLDER_RUNNER = "runner.yield-demo.testnet";
export const PLACEHOLDER_VAULT = "vault.yield-demo.testnet";

/**
 * @typedef {object} StrategyParams
 * @property {boolean} stable_only only stable/stable pools
 * @property {string[] | null} token_in_allow input tokens the strategy trades, null = any
 * @property {number} size_bps largest proposal as bps of the vault's max_trade
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

// Per-agent vault configs. max_trade and daily_cap are in token_in units, so each
// config is written for one input-token family (stable 6-decimal units, or wNEAR yocto).
const CONFIG_TABLE = {
  aloof: { pools: [1], max_trade: "10000", daily_cap: "30000" },
  chaotic: { pools: [0], max_trade: "1000000000000000000000000", daily_cap: "3000000000000000000000000" },
  social: { pools: [0, 1], max_trade: "1000000000000000000000000", daily_cap: "2000000000000000000000000" },
  skeptic: { pools: [1], max_trade: "10000", daily_cap: "20000" },
};

const POOL_PAIRS = {
  0: { pool_id: 0, token_a: WNEAR, token_b: "rft.tokenfactory.testnet" },
  1: { pool_id: 1, token_a: NUSDT, token_b: NUSDC },
};

/**
 * Example VaultConfig for an agent (mirrors the contract's VaultConfig).
 * @returns {{ strategy: string, allowed_pools: object[], max_trade: string, daily_cap: string, runners: string[] }}
 */
export function defaultVaultConfig(agentId, { runner = PLACEHOLDER_RUNNER } = {}) {
  strategyFor(agentId);
  const c = CONFIG_TABLE[agentId];
  return {
    strategy: agentId,
    allowed_pools: c.pools.map((id) => ({ ...POOL_PAIRS[id] })),
    max_trade: c.max_trade,
    daily_cap: c.daily_cap,
    runners: [runner],
  };
}

/** The strategy block that goes into the NFT's token metadata `extra` JSON. */
export function strategyMetadata(agentId) {
  const s = strategyFor(agentId);
  return { yield_strategy: { version: STRATEGY_VERSION, id: s.id, name: s.name, ...s.params, exchange: EXCHANGE } };
}
