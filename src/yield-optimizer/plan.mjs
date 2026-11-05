// Yield Optimizer: the fifth personality. DRY RUN ONLY.
//
// Reads a snapshot (snapshot.mjs: by default the same Ref testnet pools the four
// personality agents trade on), finds the pool whose price beats the mock reference
// price by the most, sizes a trade, clips it to the vault's limits, runs the vault's
// own check_rules mirror (src/yield/rules.mjs) as the final gate, and returns a plan:
// hold, or one `execute_swap` call with its exact args. Quotes come from
// src/yield/pools.mjs; the rules are src/yield/rules.mjs; this file holds neither copy.
// One reference guard keeps junk pools out: a pool whose spot price is further than
// max_ref_deviation_bps from the reference, either way, is distrusted, not chased, and
// gets `off_reference`. The spot price bounds the quote's edge (for a constant-product
// pool with fee >= 0 the quote beats the reference by at most the spot deviation), so
// a separate limit on the quote could never trip alone. A token with no mock reference
// price makes its candidates `no_reference_price`.
// It never signs, never sends, never reads keys and never uses the network.

import { EXECUTE_SWAP_GAS_CLI, EXECUTE_SWAP_TGAS } from "../yield/gas.mjs";
import { otherToken, quoteOut } from "../yield/pools.mjs";
import { checkProposal, dayOf, spentOn } from "../yield/rules.mjs";
import { rulesView } from "./snapshot.mjs";

/** The execute_swap prepaid gas, from the one source (src/yield/gas.mjs), in TGas. */
export const MIN_EXECUTE_GAS_TGAS = EXECUTE_SWAP_TGAS;

export const DRY_RUN_NOTICE = "DRY RUN: nothing was signed or sent.";

/** Personality defaults. Agent-side choices, not contract rules. */
export const DEFAULTS = Object.freeze({
  /** Slippage tolerance applied to the quote to get min_amount_out. */
  slippage_bps: 50,
  /**
   * Minimum edge over the reference price worth trading, measured at
   * min_amount_out (after fee, price impact and full slippage), so the
   * worst fill the vault would accept still beats holding by this much.
   */
  min_edge_bps: 25,
  /** Share of the token_in balance the agent wants to move in one trade, before clipping. */
  position_pct: 50,
  /**
   * Reference guard: a pool whose spot price (reserves, before fee) is further than this from
   * the mock reference price ratio, either way, is distrusted and never chosen (status
   * `off_reference`). The reference price is the only oracle here, so a gap this big is far more
   * likely junk liquidity, a depeg, a manipulated pool or a stale reference than a real
   * opportunity. 1000 bps = 10%. Real venue-to-venue spreads on liquid pairs are tens of bps.
   * The spot measure also bounds the quote's edge, so no separate quote limit is needed.
   */
  max_ref_deviation_bps: 1000,
});

/** Base units -> number of whole tokens (display and USD maths only). */
function toUnits(amount, decimals) {
  return Number(amount) / 10 ** decimals;
}

/** Base units -> "123.456789" with at most `frac` decimals, trailing zeros trimmed. */
export function formatUnits(amount, decimals, frac = 6) {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let rest = (abs % base).toString().padStart(decimals, "0").slice(0, frac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${rest ? `.${rest}` : ""}`;
}

const usd = (n) => n.toFixed(4);
const signedUsd = (n) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(4)}`;
const signedBps = (n) => `${n >= 0 ? "+" : "-"}${Math.abs(n) >= 1e9 ? Math.abs(n).toExponential(2) : Math.abs(n).toFixed(1)} bps`;

/** Mock reference value of an amount in USD; 0 for a token without a reference price (callers check first). */
function valueUsd(snap, token, amount) {
  const t = snap.tokens[token];
  return t && t.ref_price !== null ? toUnits(amount, t.decimals) * t.ref_price : 0;
}

const hasPrice = (snap, token) => snap.tokens[token]?.ref_price != null;

/** Edge of trading amountIn for amountOut against reference prices, in bps. */
function edgeBps(snap, tokenIn, amountIn, tokenOut, amountOut) {
  const vin = valueUsd(snap, tokenIn, amountIn);
  if (vin === 0) return -Infinity;
  return (valueUsd(snap, tokenOut, amountOut) / vin - 1) * 10_000;
}

/**
 * How far the pool's spot price (reserves, before fee) for selling `tokenIn` is from the
 * mock reference price ratio, in bps; null when either token has no reference price.
 */
function refDeviationBps(snap, pool, tokenIn) {
  const tokenOut = otherToken(pool, tokenIn);
  if (!hasPrice(snap, tokenIn) || !hasPrice(snap, tokenOut)) return null;
  const [rin, rout] = tokenIn === pool.token_a ? [pool.reserve_a, pool.reserve_b] : [pool.reserve_b, pool.reserve_a];
  const tIn = snap.tokens[tokenIn];
  const tOut = snap.tokens[tokenOut];
  const spot = toUnits(rout, tOut.decimals) / toUnits(rin, tIn.decimals);
  const ref = tIn.ref_price / tOut.ref_price;
  return (spot / ref - 1) * 10_000;
}

/**
 * Clips a wanted amount to what the vault's limits allow today:
 * max_trade, daily_cap minus spent_today (same UTC day), and the balance.
 * Returns { amount, clipped_by: [...], blocked_by }. A limit with nothing left
 * (e.g. today's daily_cap fully spent) does not clip to 0: it sets `blocked_by`
 * and leaves the amount as clipped so far, so check_rules reports that limit's
 * own error (ERR_DAILY_CAP, ERR_INSUFFICIENT_BALANCE). With no limit for
 * token_in nothing is clipped: the contract refuses that token (ERR_NO_LIMIT).
 */
export function clipToLimits(snap, tokenIn, wanted) {
  const { config, state } = snap.vault;
  const limit = config.limits.find((l) => l.token_id === tokenIn);
  if (!limit) return { amount: wanted, clipped_by: [], blocked_by: null };
  const view = rulesView(snap);
  const spent = spentOn(view.state, tokenIn, dayOf(view.nowMs));
  const capLeft = limit.daily_cap > spent ? limit.daily_cap - spent : 0n;
  const bal = state.balances.get(tokenIn) ?? 0n;
  let amount = wanted;
  const clipped_by = [];
  for (const [name, cap] of [["max_trade", limit.max_trade], ["daily_cap", capLeft], ["balance", bal]]) {
    if (amount <= cap) continue;
    if (cap === 0n) return { amount, clipped_by, blocked_by: name };
    amount = cap;
    clipped_by.push(name);
  }
  return { amount, clipped_by, blocked_by: null };
}

function proposalJson(p) {
  return {
    pool_id: p.pool_id,
    token_in: p.token_in,
    token_out: p.token_out,
    amount_in: p.amount_in.toString(),
    min_amount_out: p.min_amount_out.toString(),
  };
}

/**
 * Best first. A candidate that passes everything is "ok"; the others say which gate stopped them.
 * off_reference outranks below_min_edge so a pool whose selling side is junk reports that,
 * not its (thin) other side.
 */
const STATUS_ORDER = ["ok", "off_reference", "below_min_edge", "no_reference_price", "refused"];
const STATUS_RANK = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, STATUS_ORDER.length - i]));

/**
 * One candidate per market pool. Both directions are sized, clipped and checked
 * against the vault rules; the best one wins (so a direction the vault refuses never
 * hides the other). Ties on status go to the better edge.
 */
function evaluatePool(snap, pool, opts) {
  const cands = [pool.token_a, pool.token_b].map((token_in) => evaluateDirection(snap, pool, opts, token_in));
  const byEdge = (a, b) => (b.edge_bps > a.edge_bps ? 1 : b.edge_bps < a.edge_bps ? -1 : 0);
  cands.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || byEdge(a, b));
  return cands[0];
}

/** One pool sold into with `token_in`, sized, clipped and checked. Quotes come from src/yield/pools.mjs. */
function evaluateDirection(snap, pool, opts, token_in) {
  const token_out = otherToken(pool, token_in);
  const balance = snap.vault.state.balances.get(token_in) ?? 0n;
  const wanted = (balance * BigInt(opts.position_pct)) / 100n;
  const { amount: amount_in, clipped_by, blocked_by } = clipToLimits(snap, token_in, wanted);
  const expected_out = quoteOut(pool, token_in, amount_in);
  const min_amount_out = (expected_out * BigInt(10_000 - opts.slippage_bps)) / 10_000n;
  const proposal = { pool_id: pool.pool_id, token_in, token_out, amount_in, min_amount_out };
  const view = rulesView(snap);
  const { ok, reason } = checkProposal(proposal, view.config, view.state, snap.runner_id, view.nowMs);
  const check = { ok, reason };
  const ref_deviation_bps = refDeviationBps(snap, pool, token_in);
  const priced = ref_deviation_bps !== null;
  const edge = priced ? edgeBps(snap, token_in, amount_in, token_out, expected_out) : -Infinity;
  // The worst case the vault would accept: the trade fills at exactly min_amount_out.
  const worst = priced ? edgeBps(snap, token_in, amount_in, token_out, min_amount_out) : -Infinity;
  const unpriced = [token_in, token_out].filter((t) => !hasPrice(snap, t));
  let status;
  if (!check.ok) status = "refused";
  else if (!priced) status = "no_reference_price";
  else if (Math.abs(ref_deviation_bps) > opts.max_ref_deviation_bps) status = "off_reference";
  else if (!(worst >= opts.min_edge_bps)) status = "below_min_edge";
  else status = "ok";
  return { proposal, wanted, clipped_by, blocked_by, expected_out, edge_bps: edge, worst_edge_bps: worst, ref_deviation_bps, unpriced, check, status };
}

/** Portfolio value at reference prices, over every token the vault holds that has a price. */
function holdingsUsd(snap, balances) {
  let total = 0;
  for (const [t, a] of balances) total += valueUsd(snap, t, a);
  return total;
}

function pnl(snap, chosen) {
  const bal = snap.vault.state.balances;
  const hold = holdingsUsd(snap, bal);
  if (!chosen) return { hold_usd: hold, expected_usd: hold, worst_usd: hold };
  const p = chosen.proposal;
  const after = (out) => {
    const m = new Map(bal);
    m.set(p.token_in, (m.get(p.token_in) ?? 0n) - p.amount_in);
    m.set(p.token_out, (m.get(p.token_out) ?? 0n) + out);
    return holdingsUsd(snap, m);
  };
  return { hold_usd: hold, expected_usd: after(chosen.expected_out), worst_usd: after(p.min_amount_out) };
}

const STATUS_WORDS = {
  below_min_edge: (o) => `below the ${o.min_edge_bps} bps min edge`,
  off_reference: (o) => `off the mock reference price (spot more than ${o.max_ref_deviation_bps} bps away)`,
  no_reference_price: () => "without a mock reference price",
  refused: () => "refused by the vault rules",
};

/** Why nothing was chosen, naming every gate that stopped a candidate. */
function holdReason(candidates, o) {
  if (candidates.length === 0) return "snapshot has no pools";
  const parts = Object.keys(STATUS_WORDS)
    .map((st) => [st, candidates.filter((c) => c.status === st).length])
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${STATUS_WORDS[st](o)}`);
  return `no pool passes every gate (${parts.join(", ")})`;
}

const finiteOrNull = (x, digits) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null);

/**
 * Builds the plan. `opts` overrides DEFAULTS. Returns
 * { json, candidates, chosen } where `json` is the machine plan.
 */
export function buildPlan(snap, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const candidates = snap.pools.map((pool) => evaluatePool(snap, pool, o));
  const ok = candidates.filter((c) => c.status === "ok").sort((a, b) => b.edge_bps - a.edge_bps);
  const chosen = ok[0] ?? null;
  const v = pnl(snap, chosen);
  const bps = (x) => (v.hold_usd > 0 ? ((x - v.hold_usd) / v.hold_usd) * 10_000 : 0);
  const reason = chosen ? `best edge that passes every vault rule and the reference guard: pool ${chosen.proposal.pool_id}` : holdReason(candidates, o);
  const json = {
    dry_run: true,
    signed: false,
    sent: false,
    notice: DRY_RUN_NOTICE,
    agent: "yield-optimizer",
    snapshot: {
      exchange: snap.exchange,
      block_height: snap.block_height,
      source: snap.source,
      taken_at: snap.taken_at,
      now_ms: snap.now_ms,
      reference_prices: "mock_usd_price from the snapshot (mock reference price, not an oracle)",
    },
    vault_id: snap.vault_id,
    runner_id: snap.runner_id,
    utc_day: dayOf(snap.now_ms),
    params: { slippage_bps: o.slippage_bps, min_edge_bps: o.min_edge_bps, position_pct: o.position_pct, max_ref_deviation_bps: o.max_ref_deviation_bps },
    decision: chosen ? "swap" : "hold",
    reason,
    // The call a runner would make. Field names match lib.rs `execute_swap(proposal: SwapProposal)`.
    call: chosen
      ? {
          receiver_id: snap.vault_id,
          method_name: "execute_swap",
          args: { proposal: proposalJson(chosen.proposal) },
          gas_tgas: EXECUTE_SWAP_TGAS,
          gas: EXECUTE_SWAP_GAS_CLI,
          deposit_yocto: "0",
        }
      : null,
    // Same shape as the contract's check_proposal view: CheckResult { ok, reason }.
    check: chosen ? chosen.check : null,
    candidates: candidates.map((c) => ({
      proposal: proposalJson(c.proposal),
      wanted_amount_in: c.wanted.toString(),
      clipped_by: c.clipped_by,
      blocked_by: c.blocked_by,
      expected_amount_out: c.expected_out.toString(),
      edge_bps: finiteOrNull(c.edge_bps, 2),
      worst_case_edge_bps: finiteOrNull(c.worst_edge_bps, 2),
      ref_deviation_bps: finiteOrNull(c.ref_deviation_bps ?? NaN, 1),
      unpriced_tokens: c.unpriced,
      status: c.status,
      check: c.check,
    })),
    simulated_pnl_vs_hold: {
      basis: "mock reference prices (tokens without one are not valued); ignores gas, Ref storage and price moves after the snapshot",
      hold_usd: usd(v.hold_usd),
      after_swap_expected_usd: usd(v.expected_usd),
      after_swap_worst_case_usd: usd(v.worst_usd),
      expected_pnl_usd: usd(v.expected_usd - v.hold_usd),
      expected_pnl_bps: Number(bps(v.expected_usd).toFixed(2)),
      worst_case_pnl_usd: usd(v.worst_usd - v.hold_usd),
      worst_case_pnl_bps: Number(bps(v.worst_usd).toFixed(2)),
    },
  };
  return { json, candidates, chosen, pnl: v };
}

/** Why a candidate got its verdict, as one phrase (shared by the plan text and the demo). */
export function verdictText(c, snap, maxRefDeviationBps = DEFAULTS.max_ref_deviation_bps) {
  const sym = (t) => snap.tokens[t]?.symbol ?? t;
  switch (c.status) {
    case "ok":
      return "OK";
    case "below_min_edge":
      return "SKIP below min edge";
    case "off_reference":
      return `SKIP off reference: spot ${c.ref_deviation_bps >= 0 ? "+" : ""}${Math.round(c.ref_deviation_bps)} bps vs the mock reference price (limit ${maxRefDeviationBps} bps): distrusted, not traded (junk liquidity, depeg, manipulated pool or stale reference)`;
    case "no_reference_price":
      return `SKIP no mock reference price for ${c.unpriced.map(sym).join(", ")}`;
    default:
      return `REFUSED ${c.check.reason}`;
  }
}

/** Human-readable plan. Starts and ends with DRY RUN. */
export function renderPlan(snap, plan) {
  const sym = (token) => snap.tokens[token]?.symbol ?? token;
  const fmt = (token, amount) => {
    const t = snap.tokens[token];
    return t ? `${formatUnits(amount, t.decimals)} ${t.symbol}` : `${amount} (base units of ${token})`;
  };
  const j = plan.json;
  const lines = [];
  lines.push("DRY RUN - Yield Optimizer plan. Nothing is signed or sent.");
  const where = snap.block_height !== null ? `at block ${snap.block_height}` : snap.taken_at ? `taken ${snap.taken_at}` : "(no block height)";
  lines.push(`Snapshot: ${snap.exchange} pools ${where}${snap.source ? ` - ${snap.source}` : ""}`);
  lines.push(`Clock: ${new Date(snap.now_ms).toISOString()} (UTC day ${j.utc_day}). Prices: mock reference price from the snapshot, not an oracle.`);
  lines.push(`Vault: ${snap.vault_id}  runner: ${snap.runner_id}`);
  lines.push("Holdings (mock reference prices):");
  for (const [t, a] of snap.vault.state.balances) {
    const worth = hasPrice(snap, t) ? `$${usd(valueUsd(snap, t, a))}` : "no mock reference price";
    lines.push(`  ${fmt(t, a)}  (${worth})`);
  }
  lines.push(`Candidates, checked with the vault's check_rules (slippage ${j.params.slippage_bps} bps, min edge ${j.params.min_edge_bps} bps, spot at most ${j.params.max_ref_deviation_bps} bps off the reference):`);
  if (plan.candidates.length === 0) lines.push("  (none: the snapshot has no pools)");
  for (const c of plan.candidates) {
    const p = c.proposal;
    const notes = [];
    if (c.clipped_by.length) notes.push(`clipped from ${fmt(p.token_in, c.wanted)} by ${c.clipped_by.join(", ")}`);
    if (c.blocked_by) notes.push(`nothing left under ${c.blocked_by}`);
    const clip = notes.length ? ` (${notes.join("; ")})` : "";
    const edge = Number.isFinite(c.edge_bps) ? `${signedBps(c.edge_bps)} (worst ${signedBps(c.worst_edge_bps)})` : "n/a";
    lines.push(`  pool ${p.pool_id} ${sym(p.token_in)} -> ${sym(p.token_out)}: ${fmt(p.token_in, p.amount_in)}${clip}, edge ${edge}: ${verdictText(c, snap, j.params.max_ref_deviation_bps)}`);
  }
  if (plan.chosen) {
    const p = plan.chosen.proposal;
    lines.push(
      `Decision: SWAP ${fmt(p.token_in, p.amount_in)} -> at least ${fmt(p.token_out, p.min_amount_out)} on pool ${p.pool_id} (expected ${fmt(p.token_out, plan.chosen.expected_out)}).`,
    );
    const s = j.simulated_pnl_vs_hold;
    lines.push(
      `Simulated P&L vs holding: expected ${signedUsd(Number(s.expected_pnl_usd))} (${signedBps(s.expected_pnl_bps)}), worst case at min_amount_out ${signedUsd(Number(s.worst_case_pnl_usd))} (${signedBps(s.worst_case_pnl_bps)}), on $${s.hold_usd} held. Before gas.`,
    );
    lines.push(`Would call ${j.call.method_name} on ${j.call.receiver_id} with ${j.call.gas} and 0 yocto. Not sent.`);
  } else {
    lines.push(`Decision: HOLD - ${j.reason}. Simulated P&L vs holding: $0.0000.`);
  }
  lines.push(DRY_RUN_NOTICE);
  return lines.join("\n");
}
