// The yield demo, as data: one mock round of the four personality agents plus the
// Yield Optimizer planner as the fifth, every proposal checked by the one JS copy of the
// vault rules (src/yield/rules.mjs, through runRound and buildPlan), and the unsigned
// execute_swap calls that would follow. Nothing here signs, sends, reads a key or touches
// the network: the inference client is the offline mock and the one market snapshot (Ref
// testnet pools, shared by the agents and the planner) is a committed fixture.
//
// This file only assembles and renders. Pool maths, rules, the mock responder, the argv
// builder and the planner all stay in their own modules.

import { createInferenceClient } from "../inference/client.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { buildPlan, formatUnits, renderPlan, verdictText } from "../yield-optimizer/plan.mjs";
import { loadSnapshot } from "../yield-optimizer/snapshot.mjs";
import { AGENT_IDS, runRound } from "./debate.mjs";
import { createLedger } from "./ledger.mjs";
import { MOCK_EPOCH_MS, yieldMockResponder } from "./mock.mjs";
import { loadPoolFixture } from "./pools.mjs";
import { offReferenceNote, referenceLine, referenceView } from "./reference-view.mjs";
import { ruleScenarios, scenarioSummary } from "./rule-scenarios.mjs";
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
 * @param {{ snapshot?: object, snapshotFile?: string | null }} [args] snapshot: the planner's parsed snapshot
 *   (loadSnapshot / parseSnapshot); the default is the shared Ref snapshot the agents trade on, with the demo
 *   vault. snapshotFile: the --snapshot path it came from, null for the committed default.
 */
export async function runDemo({ snapshot = loadSnapshot(null), snapshotFile = null } = {}) {
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
      reference: d.proposal ? referenceView(d.proposal, fixture) : null,
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

  const plan = buildPlan(snapshot);
  const planner = plannerRow(snapshot, plan);
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
    // One market. The planner reads the same Ref pools the four agents trade on unless --snapshot says otherwise.
    snapshot: {
      file: snapshotFile ?? POOL_FIXTURE_PATH,
      exchange: snapshot.exchange,
      block_height: snapshot.block_height,
      taken_at: snapshot.taken_at,
      source: snapshot.source,
      fetched: false,
      shared_by_agents_and_planner: snapshotFile === null,
    },
    personality_agents: { vault_id: vault, runner_id: runner, now_ms: record.now_ms, consensus: record.consensus, configs },
    // The vault config the planner checks against (rates as num/den strings). Same vault and runner ids as the agents by default.
    planner_vault: { vault_id: snapshot.vault_id, runner_id: snapshot.runner_id, same_as_agents: snapshot.vault_id === vault && snapshot.runner_id === runner, config: jsonConfig(snapshot.vault.config) },
    agents,
    // Proposals the on-chain rules reject, from the contract's own vectors. They add no calls.
    rule_scenarios: scenarios,
    rule_rejections: scenarios.scenarios.length,
    calls_planned: calls.length,
    calls_signed: 0,
    calls_sent: 0,
  };
  return { doc, calls: callsDoc(calls), plan, snapshot, fixture };
}

/** A vault config with every number (BigInt included) as a string, so it is plain JSON. */
function jsonConfig(config) {
  return JSON.parse(JSON.stringify(config, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** calls.json: only the unsigned vault calls the run plans. */
export function callsDoc(calls) {
  return { dry_run: true, signed: false, sent: false, calls };
}

function plannerRow(snapshot, plan) {
  const j = plan.json;
  const fmt = (t, a) => (snapshot.tokens[t] ? `${formatUnits(BigInt(a), snapshot.tokens[t].decimals)} ${snapshot.tokens[t].symbol}` : `${a} (base units of ${t})`);
  const proposalText = (p) => `pool ${p.pool_id}: ${fmt(p.token_in, p.amount_in)} -> min ${fmt(p.token_out, p.min_amount_out)}`;
  const c = plan.chosen;
  let call = null;
  if (j.call) {
    // The same argv builder and gas figure as the personality agents' calls (send.mjs).
    const argv = buildExecuteSwapArgv({ vault: j.vault_id, runner: j.runner_id, proposal: j.call.args.proposal });
    call = {
      agent: PLANNER_ID,
      receiver_id: j.call.receiver_id,
      method_name: j.call.method_name,
      signer_id: j.runner_id,
      args: j.call.args,
      gas: GAS,
      deposit: DEPOSIT,
      signed: false,
      sent: false,
      command: formatCommand(argv),
    };
  }
  return {
    agent: PLANNER_ID,
    name: PLANNER_NAME,
    kind: "planner",
    vault_id: j.vault_id,
    runner_id: j.runner_id,
    status: c ? "proposed" : "hold",
    proposal: j.call ? j.call.args.proposal : null,
    summary: c ? proposalText(c.proposal) : "HOLD: no pool passes every gate",
    rule_check: j.check ? { ok: j.check.ok, code: j.check.ok ? null : j.check.reason.split(":")[0], reason: j.check.reason } : null,
    strategy_check: null,
    reference: null,
    veto: null,
    error: null,
    outcome: c ? "execute" : "hold",
    decision: j.decision,
    reason: j.reason,
    params: j.params,
    candidates: plan.candidates.map((cd, i) => ({
      proposal: j.candidates[i].proposal,
      summary: proposalText(cd.proposal),
      pool_id: cd.proposal.pool_id,
      pair: `${snapshot.tokens[cd.proposal.token_in].symbol} -> ${snapshot.tokens[cd.proposal.token_out].symbol}`,
      status: cd.status,
      ref_deviation_bps: j.candidates[i].ref_deviation_bps,
      edge_bps: j.candidates[i].edge_bps,
      verdict: verdictText(cd, snapshot, j.params.max_ref_deviation_bps),
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
    rows.push([a.agent, a.summary, ruleCell(a.rule_check), outcomeCell(a)]);
    if (a.kind === "planner") notes.push(...plannerNotes(a));
  }
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2].padEnd(widths[2])}  ${r[3]}`.trimEnd();
  const lines = [
    "YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent",
    snapshotLine(doc),
    "",
    line(rows[0]),
    ...rows.slice(1).map(line),
  ];
  // Say why a proposal that passed the vault rules still does not execute (a veto), so the table reads on its own.
  for (const a of doc.agents) if (a.veto) lines.push(`  ${a.agent} vetoed by ${a.veto.by}: ${a.veto.reason}`);
  lines.push(...notes);
  lines.push(...ruleLines(doc.rule_scenarios));
  lines.push("", `${doc.calls_planned} unsigned execute_swap ${doc.calls_planned === 1 ? "call" : "calls"} planned, ${doc.calls_signed} signed, ${doc.calls_sent} sent`);
  for (const p of paths) lines.push(`wrote ${p}`);
  return lines.join("\n");
}

/**
 * The summary table's outcome cell. A refusal names its cause in the table itself, e.g.
 * "refused: SOFT_OFF_REFERENCE +18590000 bps vs reference (limit 100)", so it reads without the details.
 */
function outcomeCell(a) {
  if (a.outcome !== "refused") return a.outcome;
  if (a.rule_check && !a.rule_check.ok) return `refused: ${a.rule_check.code ?? a.rule_check.reason}`;
  const codes = (a.strategy_check?.violations ?? []).map((v) => v.code);
  const note = codes.includes("SOFT_OFF_REFERENCE") && a.reference ? offReferenceNote(a.reference) : null;
  return `refused: ${codes.join(", ")}${note ? ` ${note}` : ""}`;
}

/** Why a personality agent's proposal was refused: the hard rule that fails, else its strategy violations. */
export function refusalReason(a) {
  if (a.rule_check && !a.rule_check.ok) return a.rule_check.reason;
  return a.strategy_check?.violations?.map((v) => `${v.code}: ${v.reason}`).join("; ") ?? "refused";
}

/** The rule-breaker block of the summary: header plus one REJECTED line per scenario, columns aligned. */
function ruleLines(rs) {
  const what = rs.scenarios.map(scenarioSummary);
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

/** The one-line "which market" statement of the summary. */
function snapshotLine(doc) {
  const s = doc.snapshot;
  if (!s.shared_by_agents_and_planner) return `snapshot: ${s.file} (--snapshot: the planner uses this market and vault, the four agents still use ${POOL_FIXTURE_PATH})`;
  return `snapshot: one committed Ref testnet snapshot at block ${s.block_height}, not fetched, shared by the four agents and the optimizer (vault ${doc.planner_vault.vault_id})`;
}

/** The spot deviation that put a candidate off reference. */
const spotText = (c) => `spot ${c.ref_deviation_bps >= 0 ? "+" : ""}${Math.round(c.ref_deviation_bps)} bps`;

/** Summary lines explaining every planner candidate that was not chosen, grouped by why (a chosen swap is already in the table). */
function plannerNotes(a) {
  const groups = new Map();
  for (const c of a.candidates) {
    if (c.status === "ok" && a.proposal && sameProposal(c.proposal, a.proposal)) continue;
    const key = c.status === "refused" ? `refused ${c.rule_check.code}` : c.status;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const lines = [];
  lines.push(a.call ? `  optimizer swap on pool ${a.proposal.pool_id}, ${a.candidates.length - 1} other pools not chosen:` : `  optimizer HOLD, ${a.candidates.length} pools checked, none usable:`);
  for (const [key, cs] of groups) {
    const what = {
      off_reference: `off reference (spot limit ${a.params.max_ref_deviation_bps} bps vs the mock reference price)`,
      no_reference_price: "no mock reference price",
      below_min_edge: `below the ${a.params.min_edge_bps} bps min edge`,
      ok: "passes but a better pool won",
    }[key] ?? key.replace("refused ", "refused by the vault rules, ");
    const items = cs.length === 1 && key.startsWith("refused") ? [`pool ${cs[0].pool_id}: ${cs[0].rule_check.reason}`] : cs.map((c) => (c.status === "off_reference" ? `pool ${c.pool_id} ${c.pair} ${spotText(c)}` : `pool ${c.pool_id} ${c.pair}`));
    lines.push(`    ${what}: ${key.startsWith("refused") && cs.length > 1 ? `pools ${cs.map((c) => c.pool_id).join(", ")}` : items.join("; ")}`);
  }
  return lines;
}

/** Per-agent detail, after the summary. */
export function renderDetails({ doc, plan, snapshot }) {
  const lines = ["== details =="];
  for (const a of doc.agents.filter((x) => x.kind === "personality")) {
    lines.push("", `[${a.agent}] ${a.name}`);
    if (a.error) lines.push(`  invalid reply (${a.error.code}): ${a.error.message}; ignored`);
    else if (!a.proposal) lines.push(`  no proposal (${a.status === "abstained" ? "abstained" : "none"})`);
    else {
      const p = a.proposal;
      lines.push(`  proposal: pool ${p.pool_id} ${p.token_in} -> ${p.token_out}, amount_in ${p.amount_in}, min_amount_out ${p.min_amount_out}`);
      lines.push(`  in human units: ${a.summary}`);
      lines.push(`  reference: ${referenceLine(a.reference)}`);
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
  lines.push("", `[${PLANNER_ID}] ${PLANNER_NAME}: rule-based planner over the shared Ref snapshot`);
  lines.push(...renderPlan(snapshot, plan).split("\n").map((l) => `  ${l}`));
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
