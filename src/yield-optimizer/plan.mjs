// Yield Optimizer: the fifth personality. DRY RUN ONLY.
//
// Reads a snapshot (snapshot.mjs), finds the pool whose price beats the
// reference price by the most, sizes a trade, clips it to the vault's limits,
// runs the vault's own check_rules mirror (src/yield/rules.mjs) as the final gate, and
// returns a plan: hold, or one `execute_swap` call with its exact args.
// It never signs, never sends, never reads keys and never uses the network.

import { checkProposal, dayOf, spentOn } from "../yield/rules.mjs";
import { rulesView } from "./snapshot.mjs";

/** lib.rs `MIN_EXECUTE_GAS` (280 TGas), checked by `execute_swap` after `check_rules`. */
export const MIN_EXECUTE_GAS_TGAS = 280;

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
});

const FEE_DIVISOR = 10_000n;

/**
 * Ref (Rhea) SIMPLE_POOL constant-product quote with the fee taken from the
 * input, in base units: out = in*(D-fee)*R_out / (R_in*D + in*(D-fee)), D = 10000.
 */
export function quoteOut(amountIn, reserveIn, reserveOut, feeBps) {
  const inWithFee = amountIn * (FEE_DIVISOR - BigInt(feeBps));
  return (inWithFee * reserveOut) / (reserveIn * FEE_DIVISOR + inWithFee);
}

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
const signedBps = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)} bps`;

function valueUsd(snap, token, amount) {
  const t = snap.tokens[token];
  return t ? toUnits(amount, t.decimals) * t.price_usd : 0;
}

/** Edge of trading amountIn for amountOut against reference prices, in bps. */
function edgeBps(snap, tokenIn, amountIn, tokenOut, amountOut) {
  const vin = valueUsd(snap, tokenIn, amountIn);
  if (vin === 0) return -Infinity;
  return (valueUsd(snap, tokenOut, amountOut) / vin - 1) * 10_000;
}

/** Spot edge (an infinitesimal trade after fee) for selling `i` into the pool. */
function spotEdgeBps(snap, pool, i) {
  const [rin, rout] = [pool.reserves[i], pool.reserves[1 - i]];
  const [tin, tout] = [pool.token_account_ids[i], pool.token_account_ids[1 - i]];
  const tIn = snap.tokens[tin];
  const tOut = snap.tokens[tout];
  const price = (toUnits(rout, tOut.decimals) / toUnits(rin, tIn.decimals)) * (1 - pool.total_fee / 10_000);
  return ((price * tOut.price_usd) / tIn.price_usd - 1) * 10_000;
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

const STATUS_RANK = { ok: 2, below_min_edge: 1, refused: 0 };

/**
 * One candidate per market pool. Both directions are sized, clipped and checked
 * against the vault rules; the best one that passes wins (so a direction the
 * vault refuses never hides the other). Ties on status go to the better spot edge.
 */
function evaluatePool(snap, pool, opts) {
  const cands = [0, 1].map((i) => ({ c: evaluateDirection(snap, pool, opts, i), spot: spotEdgeBps(snap, pool, i) }));
  cands.sort((a, b) => STATUS_RANK[b.c.status] - STATUS_RANK[a.c.status] || b.spot - a.spot);
  return cands[0].c;
}

/** One pool sold into in direction `i` (0 = first token in), sized, clipped and checked. */
function evaluateDirection(snap, pool, opts, i) {
  const token_in = pool.token_account_ids[i];
  const token_out = pool.token_account_ids[1 - i];
  const balance = snap.vault.state.balances.get(token_in) ?? 0n;
  const wanted = (balance * BigInt(opts.position_pct)) / 100n;
  const { amount: amount_in, clipped_by, blocked_by } = clipToLimits(snap, token_in, wanted);
  const expected_out = quoteOut(amount_in, pool.reserves[i], pool.reserves[1 - i], pool.total_fee);
  const min_amount_out = (expected_out * BigInt(10_000 - opts.slippage_bps)) / 10_000n;
  const proposal = { pool_id: pool.pool_id, token_in, token_out, amount_in, min_amount_out };
  const view = rulesView(snap);
  const { ok, reason } = checkProposal(proposal, view.config, view.state, snap.runner_id, view.nowMs);
  const check = { ok, reason };
  const edge = edgeBps(snap, token_in, amount_in, token_out, expected_out);
  // The worst case the vault would accept: the trade fills at exactly min_amount_out.
  const worst = edgeBps(snap, token_in, amount_in, token_out, min_amount_out);
  let status;
  if (!check.ok) status = "refused";
  else if (!(worst >= opts.min_edge_bps)) status = "below_min_edge";
  else status = "ok";
  return { proposal, wanted, clipped_by, blocked_by, expected_out, edge_bps: edge, worst_edge_bps: worst, check, status };
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
  let reason;
  if (chosen) reason = `best edge that passes every vault rule: pool ${chosen.proposal.pool_id}`;
  else if (candidates.length === 0) reason = "snapshot has no pools";
  else if (candidates.some((c) => c.status === "below_min_edge")) reason = `no allowed trade beats the reference price by ${o.min_edge_bps} bps at min_amount_out`;
  else reason = "every candidate is refused by the vault rules";
  const json = {
    dry_run: true,
    signed: false,
    sent: false,
    notice: DRY_RUN_NOTICE,
    agent: "yield-optimizer",
    snapshot: { exchange: snap.exchange, taken_at: snap.taken_at, source: snap.source },
    vault_id: snap.vault_id,
    runner_id: snap.runner_id,
    utc_day: dayOf(rulesView(snap).nowMs),
    params: { slippage_bps: o.slippage_bps, min_edge_bps: o.min_edge_bps, position_pct: o.position_pct },
    decision: chosen ? "swap" : "hold",
    reason,
    // The call a runner would make. Field names match lib.rs `execute_swap(proposal: SwapProposal)`.
    call: chosen
      ? {
          receiver_id: snap.vault_id,
          method_name: "execute_swap",
          args: { proposal: proposalJson(chosen.proposal) },
          gas_tgas: MIN_EXECUTE_GAS_TGAS,
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
      edge_bps: Number.isFinite(c.edge_bps) ? Number(c.edge_bps.toFixed(2)) : null,
      worst_case_edge_bps: Number.isFinite(c.worst_edge_bps) ? Number(c.worst_edge_bps.toFixed(2)) : null,
      status: c.status,
      check: c.check,
    })),
    simulated_pnl_vs_hold: {
      basis: "snapshot reference prices; ignores gas, Ref storage and price moves after the snapshot",
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

/** Human-readable plan. Starts and ends with DRY RUN. */
export function renderPlan(snap, plan) {
  const fmt = (token, amount) => {
    const t = snap.tokens[token];
    return t ? `${formatUnits(amount, t.decimals)} ${t.symbol}` : `${amount} (base units of ${token})`;
  };
  const sym = (token) => snap.tokens[token]?.symbol ?? token;
  const j = plan.json;
  const lines = [];
  lines.push("DRY RUN - Yield Optimizer plan. Nothing is signed or sent.");
  lines.push(`Snapshot: ${snap.exchange} pools at ${snap.taken_at} (UTC day ${j.utc_day})${snap.source ? ` - ${snap.source}` : ""}`);
  lines.push(`Vault: ${snap.vault_id}  runner: ${snap.runner_id}`);
  lines.push("Holdings (reference prices):");
  for (const [t, a] of snap.vault.state.balances) {
    lines.push(`  ${fmt(t, a)}  ($${usd(valueUsd(snap, t, a))})`);
  }
  lines.push(`Candidates, checked with the vault's check_rules (slippage ${j.params.slippage_bps} bps, min edge ${j.params.min_edge_bps} bps):`);
  if (plan.candidates.length === 0) lines.push("  (none: the snapshot has no pools)");
  for (const c of plan.candidates) {
    const p = c.proposal;
    const notes = [];
    if (c.clipped_by.length) notes.push(`clipped from ${fmt(p.token_in, c.wanted)} by ${c.clipped_by.join(", ")}`);
    if (c.blocked_by) notes.push(`nothing left under ${c.blocked_by}`);
    const clip = notes.length ? ` (${notes.join("; ")})` : "";
    const edge = Number.isFinite(c.edge_bps)
      ? `${signedBps(c.edge_bps)} (worst ${signedBps(c.worst_edge_bps)})`
      : "n/a";
    const verdict =
      c.status === "ok" ? "OK" : c.status === "below_min_edge" ? "SKIP below min edge" : `REFUSED ${c.check.reason}`;
    lines.push(`  pool ${p.pool_id} ${sym(p.token_in)} -> ${sym(p.token_out)}: ${fmt(p.token_in, p.amount_in)}${clip}, edge ${edge}: ${verdict}`);
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
    lines.push(`Would call ${j.call.method_name} on ${j.call.receiver_id} with ${j.call.gas_tgas} TGas and 0 yocto. Not sent.`);
  } else {
    lines.push(`Decision: HOLD - ${j.reason}. Simulated P&L vs holding: $0.0000.`);
  }
  lines.push(DRY_RUN_NOTICE);
  return lines.join("\n");
}
