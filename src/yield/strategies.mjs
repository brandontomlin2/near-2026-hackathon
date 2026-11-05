// Personality = strategy. The four seeded agents (src/traits/agents.mjs) each run one
// yield strategy. The params here are the soft, agent-level policy; the vault's
// VaultConfig (per-token limits, price floors, allowed_pools, runners) is the hard limit that
// holds whatever the agent or the model says.

import { AGENTS } from "../traits/agents.mjs";
import { MAX_REF_DEVIATION_BPS, STABLE_PEG_BPS, loadPoolFixture, otherToken, poolById, referenceRate } from "./pools.mjs";

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
// Pool 0 (wrap/rft) holds ~1496 wNEAR / ~141,674 rft (about 95 rft per wNEAR), so 10 wNEAR
// trades cost ~0.7% impact plus the 40 bps fee. The stable-pool sizes (nusdt/nusdc) stay tiny
// on purpose: pool 1's whole nusdt reserve is 0.237 nusdt at block 276332963, so any larger
// nusdt trade would drain it.
const CONFIG_TABLE = {
  aloof: { pools: [1], limits: { [NUSDT]: ["0.01", "0.03"], [NUSDC]: ["1", "3"] } },
  chaotic: { pools: [0], limits: { [WNEAR]: ["10", "30"], [RFT]: ["1000", "3000"] } },
  social: { pools: [0, 1], limits: { [WNEAR]: ["10", "20"], [RFT]: ["1000", "2000"], [NUSDT]: ["0.01", "0.02"], [NUSDC]: ["1", "2"] } },
  skeptic: { pools: [1], limits: { [NUSDT]: ["0.01", "0.02"], [NUSDC]: ["1", "2"] } },
};

const POOL_PAIRS = {
  0: { pool_id: 0, token_a: WNEAR, token_b: RFT },
  1: { pool_id: 1, token_a: NUSDT, token_b: NUSDC },
};

/**
 * Fallback margin below the snapshot's spot price that the price floor leaves, in bps (50%:
 * generous, a sanity floor, not a slippage rule). Used only for pairs with no reference price.
 */
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
 * min_amount_out * den >= amount_in * num on chain. Both are in base units, so decimals are
 * already accounted for, reduced by the gcd.
 *  - Pair with a reference price on both tokens (mock_usd_price): the floor comes from the
 *    reference, not from the pool, so a mispriced pool cannot lower it:
 *    referenceRate * (10000 - margin) / 10000, margin = STABLE_PEG_BPS (stable pair) or
 *    MAX_REF_DEVIATION_BPS (other priced pair).
 *  - Pair without a reference (e.g. wNEAR/rft, rft has no price): there is nothing independent
 *    to anchor to, so the floor is only a sanity floor under the snapshot's own spot price:
 *    reserve_out * (10000 - FLOOR_MARGIN_BPS) / (reserve_in * 10000). It guards against a pool
 *    that moves far from this snapshot, not against a pool that is already wrong.
 */
function floorRate(pool, tokenIn, fixture) {
  const ref = referenceRate(tokenIn, otherToken(pool, tokenIn), fixture);
  let num;
  let den;
  if (ref) {
    const margin = BigInt(fixture.tokens[pool.token_a]?.stable && fixture.tokens[pool.token_b]?.stable ? STABLE_PEG_BPS : MAX_REF_DEVIATION_BPS);
    num = ref.num * (10000n - margin);
    den = ref.den * 10000n;
  } else {
    const [rIn, rOut] = tokenIn === pool.token_a ? [BigInt(pool.reserve_a), BigInt(pool.reserve_b)] : [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
    num = rOut * (10000n - FLOOR_MARGIN_BPS);
    den = rIn * 10000n;
  }
  const g = gcd(num, den);
  return { num: (num / g).toString(), den: (den / g).toString() };
}

/** The limits entry for `tokenId` ({token_id, max_trade, daily_cap}), or undefined when the token cannot be sold. */
export function limitFor(config, tokenId) {
  return (config.limits ?? []).find((l) => l.token_id === tokenId);
}

/** The VaultConfig (v2) JSON for a strategy name, a table row ({ pools, limits }) and a runner. */
function buildVaultConfig(strategy, c, { runner, fixture }) {
  return {
    strategy,
    allowed_pools: c.pools.map((id) => {
      const pair = POOL_PAIRS[id];
      const pool = poolById(id, fixture);
      return { ...pair, min_rate_a_to_b: floorRate(pool, pair.token_a, fixture), min_rate_b_to_a: floorRate(pool, pair.token_b, fixture) };
    }),
    limits: Object.entries(c.limits).map(([token_id, [max, cap]]) => ({ token_id, max_trade: toBaseUnits(max, token_id, fixture), daily_cap: toBaseUnits(cap, token_id, fixture) })),
    runners: [runner],
  };
}

/**
 * Example VaultConfig (v2) for an agent (mirrors the contract's VaultConfig).
 * @returns {{ strategy: string, allowed_pools: object[], limits: object[], runners: string[] }}
 */
export function defaultVaultConfig(agentId, { runner = PLACEHOLDER_RUNNER, fixture = loadPoolFixture() } = {}) {
  strategyFor(agentId);
  return buildVaultConfig(agentId, CONFIG_TABLE[agentId], { runner, fixture });
}

// The Yield Optimizer planner is a rule-based fifth agent, not a fifth contract strategy: the
// vault's validate_config accepts only the four strategy names, so its vault config carries
// the closest one (aloof: a price-disciplined, small-size trader) and the planner's own
// identity lives in the plan ("agent": "yield-optimizer"). Pools 0 and 1 are the two pools
// the personality vaults can use; the floors come from the same floorRate maths.
export const PLANNER_STRATEGY = "aloof";
const PLANNER_TABLE = { pools: [0, 1], limits: { [WNEAR]: ["10", "20"], [RFT]: ["1000", "2000"], [NUSDT]: ["0.01", "0.02"], [NUSDC]: ["1", "2"] } };

/** VaultConfig (v2) for the Yield Optimizer planner's vault: pools 0 and 1, limits for wrap, rft, nusdt and nusdc. */
export function plannerVaultConfig({ runner = PLACEHOLDER_RUNNER, fixture = loadPoolFixture() } = {}) {
  return buildVaultConfig(PLANNER_STRATEGY, PLANNER_TABLE, { runner, fixture });
}

/** The strategy block that goes into the NFT's token metadata `extra` JSON. */
export function strategyMetadata(agentId) {
  const s = strategyFor(agentId);
  return { yield_strategy: { version: STRATEGY_VERSION, id: s.id, name: s.name, ...s.params, exchange: EXCHANGE } };
}
