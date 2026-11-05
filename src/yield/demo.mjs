// The yield demo, as data: one mock round of the four personality agents plus the
// Yield Optimizer planner as the fifth, every proposal checked by the one JS copy of the
// vault rules (src/yield/rules.mjs, through runRound and buildPlan), and the unsigned
// execute_swap calls that would follow. Nothing here signs, sends, reads a key or touches
// the network: the inference client is the offline mock and both snapshots are committed fixtures.
//
// This file only assembles and renders. Pool maths, rules, the mock responder, the argv
// builder and the planner all stay in their own modules.

import { createInferenceClient } from "../inference/client.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { buildPlan, formatUnits, renderPlan } from "../yield-optimizer/plan.mjs";
import { AGENT_IDS, runRound } from "./debate.mjs";
import { createLedger } from "./ledger.mjs";
import { MOCK_EPOCH_MS, yieldMockResponder } from "./mock.mjs";
import { loadPoolFixture } from "./pools.mjs";
import { ruleScenarios } from "./rule-scenarios.mjs";
import { DEPOSIT, GAS, METHOD, buildExecuteSwapArgv, formatCommand } from "./send.mjs";
import { PLACEHOLDER_RUNNER, PLACEHOLDER_VAULT, defaultVaultConfig } from "./strategies.mjs";

export const POOL_FIXTURE_PATH = "src/yield/fixtures/ref-testnet-pools.json";
export const PLANNER_ID = "yield-optimizer";
export const PLANNER_NAME = "Yield Optimizer";

const symbolOf = (token) => token.split(".")[0];

/** "500 nusdt" style amount from base units, using the Ref fixture's decimals. */
function fmtRef(fixture, token, amount) {
  const t = fixture.tokens[token];
  return t ? `${formatUnits(BigInt(amount), t.decimals)} ${symbolOf(token)}` : `${amount} (base units of ${token})`;
}

/** The mock inference client: empty env, so it can never see a key or pick the live mode. */
export function createDemoClient() {
  return createInferenceClient({ env: {}, responder: yieldMockResponder });
}

/** The SwapProposal fields the vault takes, in contract order, no rationale. */
const swapProposal = (p) => ({ pool_id: p.pool_id, token_in: p.token_in, token_out: p.token_out, amount_in: String(p.amount_in), min_amount_out: String(p.min_amount_out) });

const OUTCOME = { execute: "execute", vetoed: "vetoed", rejected_hard: "refused", rejected_soft: "refused", none: "skipped", invalid: "skipped" };

/**
 * Run the demo.
 * @param {{ rhea: object, rheaSource: string }} args rhea: a parsed Rhea snapshot (parseSnapshot); rheaSource: its label for the plan
 */
export async function runDemo({ rhea, rheaSource }) {
  const fixture = loadPoolFixture();
  const vault = PLACEHOLDER_VAULT;
  const runner = PLACEHOLDER_RUNNER;
  const configs = Object.fromEntries(AGENT_IDS.map((id) => [id, defaultVaultConfig(id, { runner })]));
  // The same fresh per-agent state `npm run yield` starts from.
  const { states } = createLedger({ fixture });
  const record = await runRound({ client: createDemoClient(), configs, states, fixture, round: 1, nowMs: MOCK_EPOCH_MS, runnerId: runner });

  const agents = [];
  const calls = [];
  for (const id of AGENT_IDS) {
    const d = record.decisions[id];
    const name = AGENTS.find((a) => a.id === id).name;
    const row = {
      agent: id,
      name,
      kind: "personality",
      vault_id: vault,
      runner_id: runner,
      status: d.status,
      proposal: d.proposal ? { ...swapProposal(d.proposal), rationale: d.proposal.rationale } : null,
      summary: d.proposal ? `pool ${d.proposal.pool_id}: ${fmtRef(fixture, d.proposal.token_in, d.proposal.amount_in)} -> min ${fmtRef(fixture, d.proposal.token_out, d.proposal.min_amount_out)}` : "no proposal",
      rule_check: d.hard ? { ok: d.hard.ok, code: d.hard.code, reason: d.hard.reason } : null,
      strategy_check: d.soft ? { ok: d.soft.ok, violations: d.soft.violations } : null,
      veto: d.veto,
      error: d.error,
      outcome: OUTCOME[d.outcome] ?? "skipped",
      call: null,
    };
    if (d.outcome === "execute") {
      const proposal = swapProposal(d.proposal);
      const argv = buildExecuteSwapArgv({ vault, runner, proposal });
      row.call = {
        agent: id,
        receiver_id: vault,
        method_name: METHOD,
        signer_id: runner,
        args: { proposal },
        gas: GAS,
        deposit: DEPOSIT,
        signed: false,
        sent: false,
        command: formatCommand(argv),
      };
      calls.push(row.call);
    }
    agents.push(row);
  }

  const plan = buildPlan(rhea);
  const planner = plannerRow(rhea, plan);
  agents.push(planner);
  if (planner.call) calls.push(planner.call);

  const scenarios = ruleScenarios();
  const doc = {
    demo: "yield-demo",
    mode: "mock",
    dry_run: true,
    signed: false,
    sent: false,
    notice: "DRY RUN: mock inference, committed fixtures, nothing was signed or sent.",
    snapshots: {
      ref_pools: {
        file: POOL_FIXTURE_PATH,
        exchange: fixture.exchange,
        block_height: fixture._block_height,
        source: fixture._source,
        fetched: false,
      },
      rhea: {
        file: rheaSource,
        exchange: rhea.exchange,
        taken_at: rhea.taken_at,
        source: rhea.source,
        fetched: false,
      },
    },
    personality_agents: { vault_id: vault, runner_id: runner, now_ms: record.now_ms, consensus: record.consensus },
    agents,
    // Proposals the on-chain rules reject, from the contract's own vectors. They add no calls.
    rule_scenarios: scenarios,
    rule_rejections: scenarios.scenarios.length,
    calls_planned: calls.length,
    calls_signed: 0,
    calls_sent: 0,
  };
  return { doc, calls: callsDoc(calls), plan, rhea, fixture };
}

/** calls.json: only the unsigned vault calls the run plans. */
export function callsDoc(calls) {
  return { dry_run: true, signed: false, sent: false, calls };
}

function plannerRow(rhea, plan) {
  const j = plan.json;
  const sym = (t) => rhea.tokens[t]?.symbol ?? t;
  const fmt = (t, a) => (rhea.tokens[t] ? `${formatUnits(BigInt(a), rhea.tokens[t].decimals)} ${sym(t)}` : `${a} (base units of ${t})`);
  const c = plan.chosen;
  const p = c?.proposal;
  const call = j.call
    ? {
        agent: PLANNER_ID,
        receiver_id: j.call.receiver_id,
        method_name: j.call.method_name,
        signer_id: j.runner_id,
        args: j.call.args,
        gas: `${j.call.gas_tgas}.0 Tgas`,
        deposit: DEPOSIT,
        signed: false,
        sent: false,
      }
    : null;
  return {
    agent: PLANNER_ID,
    name: PLANNER_NAME,
    kind: "planner",
    vault_id: j.vault_id,
    runner_id: j.runner_id,
    status: c ? "proposed" : "hold",
    proposal: j.call ? j.call.args.proposal : null,
    summary: p ? `pool ${p.pool_id}: ${fmt(p.token_in, p.amount_in)} -> min ${fmt(p.token_out, p.min_amount_out)}` : "no proposal (hold)",
    rule_check: j.check ? { ok: j.check.ok, code: j.check.ok ? null : j.check.reason.split(":")[0], reason: j.check.reason } : null,
    strategy_check: null,
    veto: null,
    error: null,
    outcome: c ? "execute" : "skipped",
    decision: j.decision,
    reason: j.reason,
    candidates: j.candidates.map((cd) => ({
      proposal: cd.proposal,
      summary: `pool ${cd.proposal.pool_id}: ${fmt(cd.proposal.token_in, cd.proposal.amount_in)} -> min ${fmt(cd.proposal.token_out, cd.proposal.min_amount_out)}`,
      status: cd.status,
      rule_check: { ok: cd.check.ok, code: cd.check.ok ? null : cd.check.reason.split(":")[0], reason: cd.check.reason },
    })),
    simulated_pnl_vs_hold: j.simulated_pnl_vs_hold,
    call,
  };
}

const ruleCell = (r) => (r ? (r.ok ? "OK" : (r.code ?? r.reason)) : "-");

/** The one-screen summary (under 25 lines). `paths` is a list of already-formatted file paths, or empty. */
export function renderSummary({ doc }, paths = []) {
  const rows = [["agent", "proposal", "vault rules", "outcome"]];
  const notes = [];
  for (const a of doc.agents) {
    rows.push([a.agent, a.summary, ruleCell(a.rule_check), a.outcome]);
    if (a.kind === "planner") {
      for (const c of a.candidates) {
        if (c.status === "ok" && a.proposal && sameProposal(c.proposal, a.proposal)) continue;
        notes.push(c);
      }
    }
  }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd();
  const lines = [
    "YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent",
    `snapshots: committed fixtures, not fetched (Ref pools at block ${doc.snapshots.ref_pools.block_height}; Rhea snapshot taken ${doc.snapshots.rhea.taken_at})`,
    "",
    line(rows[0]),
    ...rows.slice(1).map(line),
  ];
  // Say why a proposal that passed the vault rules still does not execute (a veto), so the table reads on its own.
  for (const a of doc.agents) if (a.veto) lines.push(`  ${a.agent} vetoed by ${a.veto.by}: ${a.veto.reason}`);
  for (const c of notes) lines.push(`  optimizer candidate ${c.summary}: ${c.status === "ok" ? "OK" : c.status === "refused" ? `REFUSED ${c.rule_check.reason}` : c.status}`);
  lines.push(...ruleLines(doc.rule_scenarios));
  lines.push("", `${doc.calls_planned} unsigned execute_swap calls planned, ${doc.calls_signed} signed, ${doc.calls_sent} sent`);
  for (const p of paths) lines.push(`wrote ${p}`);
  return lines.join("\n");
}

/** Raw base units (the vector proposals carry no token decimals), short token symbols. */
const rawProposal = (p) => `pool ${p.pool_id}: ${p.amount_in} ${symbolOf(p.token_in)} -> min ${p.min_amount_out} ${symbolOf(p.token_out)}`;

function scenarioContext(s) {
  if (s.id === "daily_cap") return ` (spent today ${s.state.spent_today?.[s.proposal.token_in] ?? 0})`;
  if (s.id === "paused") return " (vault paused)";
  return "";
}

/** The rule-breaker block of the summary: header plus one REJECTED line per scenario, columns aligned. */
function ruleLines(rs) {
  const what = rs.scenarios.map((s) => `${rawProposal(s.proposal)}${scenarioContext(s)}`);
  const w1 = Math.max(...rs.scenarios.map((s) => s.label.length));
  const w2 = Math.max(...what.map((x) => x.length));
  return [
    `on-chain rules, vectors from ${rs.source} (same message as the Rust ${rs.contract_fn}):`,
    ...rs.scenarios.map((s, i) => `  ${s.label.padEnd(w1)}  ${what[i].padEnd(w2)}  REJECTED ${s.contract_message}`),
  ];
}

function sameProposal(a, b) {
  return a.pool_id === b.pool_id && a.token_in === b.token_in && a.amount_in === b.amount_in && a.min_amount_out === b.min_amount_out;
}

/** Per-agent detail, after the summary. */
export function renderDetails({ doc, plan, rhea }) {
  const lines = ["== details =="];
  for (const a of doc.agents.filter((x) => x.kind === "personality")) {
    lines.push("", `[${a.agent}] ${a.name}`);
    if (a.error) lines.push(`  invalid reply (${a.error.code}): ${a.error.message}; ignored`);
    else if (!a.proposal) lines.push(`  no proposal (${a.status === "abstained" ? "abstained" : "none"})`);
    else {
      const p = a.proposal;
      lines.push(`  proposal: pool ${p.pool_id} ${p.token_in} -> ${p.token_out}, amount_in ${p.amount_in}, min_amount_out ${p.min_amount_out}`);
      lines.push(`  in human units: ${a.summary}`);
      lines.push(`  why: ${p.rationale}`);
      lines.push(`  vault rules (off chain): ${a.rule_check.ok ? "OK" : a.rule_check.reason}`);
      lines.push(`  strategy checks: ${a.strategy_check.ok ? "OK" : a.strategy_check.violations.map((v) => `${v.code}: ${v.reason}`).join("; ")}`);
    }
    if (a.veto) lines.push(`  VETOED by ${a.veto.by}: ${a.veto.reason}`);
    lines.push(`  outcome: ${a.outcome}`);
    if (a.call) {
      lines.push("  DRY RUN, not sent:");
      lines.push(`    args: ${JSON.stringify(a.call.args)}`);
      lines.push(`    ${a.call.command}`);
    }
  }
  const pl = doc.agents.find((x) => x.kind === "planner");
  lines.push("", `[${PLANNER_ID}] ${PLANNER_NAME}: rule-based planner over the Rhea snapshot`);
  lines.push(...renderPlan(rhea, plan).split("\n").map((l) => `  ${l}`));
  lines.push(`  outcome: ${pl.outcome}`);
  if (pl.call) {
    lines.push("  DRY RUN, not sent:");
    lines.push(`    args: ${JSON.stringify(pl.call.args)}`);
  }
  return lines.join("\n");
}

/** `--calls` output: only the unsigned calls, one block each. */
export function renderCalls(calls) {
  if (calls.length === 0) return "no calls planned (DRY RUN: nothing signed, nothing sent)";
  return calls
    .map((c, i) => {
      const l = [
        `call ${i + 1} of ${calls.length} (${c.agent})`,
        `  receiver: ${c.receiver_id}`,
        `  method: ${c.method_name}`,
        `  signer: ${c.signer_id}`,
        `  args: ${JSON.stringify(c.args)}`,
        `  gas: ${c.gas}`,
        `  deposit: ${c.deposit}`,
        `  signed: ${c.signed}`,
        `  sent: ${c.sent}`,
      ];
      if (c.command) l.push(`  command: ${c.command}`);
      return l.join("\n");
    })
    .join("\n\n");
}
