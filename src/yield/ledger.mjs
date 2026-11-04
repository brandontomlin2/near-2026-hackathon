// Per-agent track record. Mock fills are priced off the pool snapshot: the constant-product
// output (fee and price impact included) against the spot rate, then marked by a
// deterministic drift standing in for the next price move. P&L is in micro-USD at the
// fixture's mock reference prices ("ref USD"), so it can be summed across tokens.
// This is the record that makes an agent NFT worth something to the next owner: how it
// traded, what it was stopped from doing, and what it earned under the same hard limits.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadPoolFixture, otherToken, poolById, quoteOut } from "./pools.mjs";
import { AGENT_IDS } from "./debate.mjs";
import { dayOf } from "./rules.mjs";

export const LEDGER_FILE = ["yield", "ledger.json"];
const DRIFT_BPS = { stable: 3, wrap: 250, other: 400 };

export function ledgerPath(outDir) {
  return join(outDir, ...LEDGER_FILE);
}

/** Micro-USD per whole token as a [numerator, denominator] pair, or null when unpriced. */
function usdMicroPerBase(token, fixture) {
  const t = fixture.tokens[token];
  if (!t || t.mock_usd_price == null) return null;
  const [whole, frac = ""] = t.mock_usd_price.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  return [micro, 10n ** BigInt(t.decimals)];
}

/** Mock reference value of an amount, in micro-USD; unpriced tokens are priced through the pool partner at spot. */
export function valueMicroUsd(token, amount, pool, fixture) {
  const direct = usdMicroPerBase(token, fixture);
  if (direct) return (BigInt(amount) * direct[0]) / direct[1];
  const other = otherToken(pool, token);
  const otherPrice = other && usdMicroPerBase(other, fixture);
  if (!otherPrice) return 0n;
  const [rIn, rOut] = token === pool.token_a ? [BigInt(pool.reserve_a), BigInt(pool.reserve_b)] : [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
  if (rIn === 0n) return 0n;
  return (((BigInt(amount) * rOut) / rIn) * otherPrice[0]) / otherPrice[1];
}

/** Deterministic mock price move of `token` over the next step, in bps (signed). */
export function driftBps(seed, round, token, fixture) {
  const vol = fixture.tokens[token]?.stable ? DRIFT_BPS.stable : token === "wrap.testnet" ? DRIFT_BPS.wrap : DRIFT_BPS.other;
  const h = createHash("sha256").update(`${seed}|${round}|${token}`).digest();
  const unit = h.readUInt16BE(0) / 65535; // 0..1
  return Math.round((unit * 2 - 1) * vol);
}

/**
 * Mock fill of a proposal against the snapshot.
 * @returns {{ amount_out: string, pnl_micro_usd: string, drift_bps: number, cost_bps: number } | null} null when the pool has no output
 */
export function mockFill(proposal, { fixture = loadPoolFixture(), seed = 0, round = 1 } = {}) {
  const pool = poolById(proposal.pool_id, fixture);
  if (!pool) return null;
  const out = quoteOut(pool, proposal.token_in, proposal.amount_in);
  if (out < BigInt(proposal.min_amount_out) || out === 0n) return null; // the swap would revert on min_amount_out
  const [rIn, rOut] = proposal.token_in === pool.token_a ? [BigInt(pool.reserve_a), BigInt(pool.reserve_b)] : [BigInt(pool.reserve_b), BigInt(pool.reserve_a)];
  const fair = (BigInt(proposal.amount_in) * rOut) / rIn;
  if (fair === 0n) return null;
  const ratioPpm = (out * 1_000_000n) / fair;
  const drift = driftBps(seed, round, proposal.token_out, fixture);
  const value = valueMicroUsd(proposal.token_in, proposal.amount_in, pool, fixture);
  const marked = ratioPpm * BigInt(10000 + drift);
  const pnl = (value * (marked - 10_000_000_000n)) / 10_000_000_000n;
  return { amount_out: out.toString(), pnl_micro_usd: pnl.toString(), drift_bps: drift, cost_bps: Number(1_000_000n - ratioPpm) / 100 };
}

/** Default vault state for a mock run: funded for every token, nothing spent. */
export function initialState() {
  return {
    paused: false,
    in_flight: false,
    spent: { day: 0, amount: "0" },
    balances: {
      "wrap.testnet": "1000000000000000000000000000",
      "rft.tokenfactory.testnet": "1000000000000",
      "nusdt.ft-fin.testnet": "1000000000",
      "nusdc.ft-fin.testnet": "1000000000",
    },
  };
}

export function createLedger({ seed = 0, fixture = loadPoolFixture(), agents = AGENT_IDS, data } = {}) {
  const book = data ?? {
    version: 1,
    mock: true,
    unit: "micro-USD at mock reference prices",
    seed,
    pool_snapshot_block: fixture._block_height,
    agents: Object.fromEntries(agents.map((id) => [id, { rounds: 0, proposals: 0, invalid: 0, vetoes: 0, rejected: 0, trades: [], vetoed: [], pnl_micro_usd: "0", vetoed_counterfactual_micro_usd: "0" }])),
  };
  const states = Object.fromEntries(Object.keys(book.agents).map((id) => [id, initialState()]));

  return {
    book,
    states,
    /** Apply a decision record from runRound: update state, trades, vetoes, P&L. */
    record(round) {
      const day = dayOf(round.now_ms);
      for (const d of Object.values(round.decisions)) {
        const a = book.agents[d.agent];
        if (!a) continue;
        a.rounds += 1;
        if (d.status === "invalid") a.invalid += 1;
        if (d.proposal) a.proposals += 1;
        if (d.outcome === "rejected_hard" || d.outcome === "rejected_soft") a.rejected += 1;
        if (d.outcome === "vetoed") {
          a.vetoes += 1;
          const cf = mockFill(d.proposal, { fixture, seed: book.seed, round: round.round });
          a.vetoed.push({ round: round.round, proposal: d.proposal, reason: d.veto.reason, counterfactual_micro_usd: cf?.pnl_micro_usd ?? "0" });
          a.vetoed_counterfactual_micro_usd = (BigInt(a.vetoed_counterfactual_micro_usd) + BigInt(cf?.pnl_micro_usd ?? "0")).toString();
        }
        if (d.outcome === "execute") {
          const fill = mockFill(d.proposal, { fixture, seed: book.seed, round: round.round });
          if (!fill) {
            a.rejected += 1; // would revert on min_amount_out: counted, no state change
            continue;
          }
          const st = states[d.agent];
          const before = st.spent.day === day ? BigInt(st.spent.amount) : 0n;
          st.spent = { day, amount: (before + BigInt(d.proposal.amount_in)).toString() };
          st.balances[d.proposal.token_in] = (BigInt(st.balances[d.proposal.token_in]) - BigInt(d.proposal.amount_in)).toString();
          st.balances[d.proposal.token_out] = (BigInt(st.balances[d.proposal.token_out] ?? "0") + BigInt(fill.amount_out)).toString();
          a.trades.push({ round: round.round, proposal: d.proposal, amount_out: fill.amount_out, pnl_micro_usd: fill.pnl_micro_usd, drift_bps: fill.drift_bps, cost_bps: fill.cost_bps });
          a.pnl_micro_usd = (BigInt(a.pnl_micro_usd) + BigInt(fill.pnl_micro_usd)).toString();
        }
      }
    },
    scoreboard() {
      return Object.entries(book.agents)
        .map(([id, a]) => ({ agent: id, rounds: a.rounds, trades: a.trades.length, vetoes: a.vetoes, rejected: a.rejected, invalid: a.invalid, pnl_micro_usd: a.pnl_micro_usd }))
        .sort((x, y) => (BigInt(y.pnl_micro_usd) > BigInt(x.pnl_micro_usd) ? 1 : BigInt(y.pnl_micro_usd) < BigInt(x.pnl_micro_usd) ? -1 : x.agent.localeCompare(y.agent)));
    },
    async save(outDir) {
      const path = ledgerPath(outDir);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(book, null, 2)}\n`);
      return path;
    },
  };
}

export async function loadLedgerData(outDir) {
  return JSON.parse(await readFile(ledgerPath(outDir), "utf8"));
}

/** "-0.000123" style USD from micro-USD. */
export function formatUsd(microString) {
  const v = BigInt(microString);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : v > 0n ? "+" : ""}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

export function formatScoreboard(rows) {
  const lines = ["scoreboard (mock fills at mock reference prices; P&L in ref USD)", "  agent    rounds trades vetoes rejected invalid  P&L"];
  for (const r of rows) {
    lines.push(`  ${r.agent.padEnd(8)} ${String(r.rounds).padStart(6)} ${String(r.trades).padStart(6)} ${String(r.vetoes).padStart(6)} ${String(r.rejected).padStart(8)} ${String(r.invalid).padStart(7)}  ${formatUsd(r.pnl_micro_usd)}`);
  }
  return lines.join("\n");
}
