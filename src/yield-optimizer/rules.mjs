// Off-chain mirror of the yield-vault contract's swap rules.
//
// Source of truth: contracts/yield-vault/src/lib.rs on the unmerged branch
// claude/yield-vault (read with `git show claude/yield-vault:contracts/yield-vault/src/lib.rs`).
// This file copies no Rust; it re-implements the same checks, in the same
// order, with the same `ERR_CODE: detail` strings, so a dry-run plan fails
// here for the same reason `execute_swap` would panic on chain.
//
// All amounts are BigInt base units (the contract's u128 / U128).

/** lib.rs `NS_PER_DAY`. */
export const NS_PER_DAY = 86_400n * 1_000_000_000n;
/** lib.rs `STRATEGIES`; `validate_config` rejects any other strategy. */
export const STRATEGIES = Object.freeze(["aloof", "chaotic", "social", "skeptic"]);
/** lib.rs `MIN_EXECUTE_GAS` (270 TGas), checked by `execute_swap` after `check_rules`. */
export const MIN_EXECUTE_GAS_TGAS = 270;
/** Largest value a u128 / U128 can hold. */
export const U128_MAX = (1n << 128n) - 1n;

/** lib.rs `day_of`: UTC calendar day of a block timestamp in nanoseconds. */
export function dayOf(timestampNs) {
  return timestampNs / NS_PER_DAY;
}

/** lib.rs `meets_floor`: `min_out * rate.den >= amount_in * rate.num` (BigInt cannot overflow). */
export function meetsFloor(amountIn, minOut, rate) {
  return minOut * rate.den >= amountIn * rate.num;
}

/**
 * lib.rs `validate_config`. The contract panics on the first failure; this
 * returns that message, or null when the config is valid.
 */
export function validateConfig(c) {
  if (!STRATEGIES.includes(c.strategy)) {
    return "ERR_BAD_CONFIG: strategy must be aloof, chaotic, social or skeptic";
  }
  for (const [i, l] of c.limits.entries()) {
    if (!(l.max_trade > 0n)) return "ERR_BAD_CONFIG: max_trade must be > 0";
    if (!(l.daily_cap >= l.max_trade)) return "ERR_BAD_CONFIG: daily_cap must be >= max_trade";
    if (c.limits.slice(0, i).some((q) => q.token_id === l.token_id)) {
      return "ERR_BAD_CONFIG: duplicate limit token";
    }
  }
  for (const [i, p] of c.allowed_pools.entries()) {
    for (const r of [p.min_rate_a_to_b, p.min_rate_b_to_a]) {
      if (!(r.num > 0n && r.den > 0n)) return "ERR_BAD_CONFIG: rate num and den must be > 0";
    }
    if (p.token_a === p.token_b) return "ERR_BAD_CONFIG: token_a must differ from token_b";
    if (c.allowed_pools.slice(0, i).some((q) => q.pool_id === p.pool_id)) {
      return "ERR_BAD_CONFIG: duplicate pool";
    }
  }
  for (const [i, r] of c.runners.entries()) {
    if (c.runners.slice(0, i).includes(r)) return "ERR_BAD_CONFIG: duplicate runner";
  }
  return null;
}

/** lib.rs `spent_on`: spend of `token` on `nowDay`, 0 if the stored day is older (the UTC-day reset). */
export function spentOn(state, nowDay, token) {
  if (nowDay === state.day) return state.spent_today.get(token) ?? 0n;
  return 0n;
}

/**
 * lib.rs `check_rules` (shared by `execute_swap` and the `check_proposal`
 * view). Returns the contract's `CheckResult` shape: `{ ok, reason }`, with
 * `reason` empty when ok, else `ERR_CODE: detail`.
 *
 * vault = { config, state } as parsed by snapshot.mjs; proposal is a
 * SwapProposal with BigInt amounts; nowNs is the block timestamp to assume.
 */
export function checkRules(vault, p, runner, nowNs) {
  const err = (reason) => ({ ok: false, reason });
  const { config, state } = vault;
  if (!config.runners.includes(runner)) {
    return err(`ERR_NOT_RUNNER: ${runner} is not an approved runner`);
  }
  if (state.paused) return err("ERR_PAUSED: vault is paused");
  if (state.swap_in_flight) return err("ERR_SWAP_IN_FLIGHT: another swap is in flight");
  if (state.recovery_in_flight) return err("ERR_SWAP_IN_FLIGHT: a Ref recovery is in flight");
  const pool = config.allowed_pools.find((a) => a.pool_id === p.pool_id);
  if (!pool) return err(`ERR_POOL_NOT_ALLOWED: pool ${p.pool_id}`);
  const fwd = p.token_in === pool.token_a && p.token_out === pool.token_b;
  const rev = p.token_in === pool.token_b && p.token_out === pool.token_a;
  if (!(fwd || rev)) {
    return err(`ERR_TOKEN_NOT_IN_POOL: tokens must be the pair of pool ${p.pool_id}`);
  }
  if (p.amount_in === 0n) return err("ERR_ZERO_AMOUNT: amount_in must be > 0");
  if (p.min_amount_out === 0n) return err("ERR_ZERO_MIN_OUT: min_amount_out must be > 0");
  const rate = fwd ? pool.min_rate_a_to_b : pool.min_rate_b_to_a;
  if (!meetsFloor(p.amount_in, p.min_amount_out, rate)) {
    return err(
      `ERR_PRICE_FLOOR: min_amount_out ${p.min_amount_out} below floor ${rate.num}/${rate.den} of amount_in ${p.amount_in}`,
    );
  }
  const limit = config.limits.find((l) => l.token_id === p.token_in);
  if (!limit) return err(`ERR_NO_LIMIT: no limit for ${p.token_in}`);
  if (p.amount_in > limit.max_trade) {
    return err(`ERR_MAX_TRADE: ${p.amount_in} exceeds max_trade ${limit.max_trade}`);
  }
  const spent = spentOn(state, dayOf(nowNs), p.token_in);
  // The contract uses checked_add on u128; an overflow is also ERR_DAILY_CAP.
  const total = spent + p.amount_in;
  if (total > U128_MAX || total > limit.daily_cap) {
    return err(`ERR_DAILY_CAP: spent ${spent} + ${p.amount_in} exceeds daily_cap ${limit.daily_cap}`);
  }
  const bal = state.balances.get(p.token_in) ?? 0n;
  if (bal < p.amount_in) return err(`ERR_INSUFFICIENT_BALANCE: have ${bal} need ${p.amount_in}`);
  return { ok: true, reason: "" };
}
