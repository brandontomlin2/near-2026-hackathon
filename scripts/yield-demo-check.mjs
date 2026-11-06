#!/usr/bin/env node
// Judge-screen check for the yield demo (the "yield demo" stage of scripts/verify.sh).
//
//   node scripts/yield-demo-check.mjs [--out DIR] [--timeout-ms N]
//
// Runs `node scripts/yield-demo.mjs --out DIR` (offline, mock) with a timeout, then reads
// DIR/plan.json, DIR/calls.json and DIR/index.html and fails unless the plan is a dry run with nothing signed
// or sent, exactly 1 call planned (the stable-pool agents are refused as off reference and chaotic is vetoed;
// the optimizer plans one small swap on pool 747, a shallow pair with a reference price), and the 4 vault-rule
// rejections match the contract. The planner's call must pass checkProposal, re-run here on the default
// snapshot's vault, and sit on a pool whose candidate has a reference price and status ok. It also fails
// when the demo tells two stories: more than one vault id across the agents, the planner vault and the calls,
// more than one gas string across the calls, or a planner that is not on the one shared snapshot. index.html
// must carry the DRY RUN notice and each rejection's contract message (HTML-escaped as rendered).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml } from "../src/viewer/render.mjs";
import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { EXECUTE_SWAP_GAS_CLI } from "../src/yield/gas.mjs";
import { checkProposal } from "../src/yield/rules.mjs";
import { defaultSnapshot, rulesView } from "../src/yield-optimizer/snapshot.mjs";

export const EXPECTED_MODE = "mock";
export const EXPECTED_AGENTS = 5;
export const EXPECTED_CALLS = 1;
/** On the committed snapshot the optimizer swaps on pool 747 (the only pool with a reference price and an edge). */
export const EXPECTED_PLANNER_DECISION = "swap";
export const PLANNER_STATUSES = ["ok", "off_reference", "below_min_edge", "no_reference_price", "refused"];
export const EXPECTED_SIGNED = 0;
export const EXPECTED_SENT = 0;
export const EXPECTED_REJECTIONS = 4;
export const EXPECTED_SCENARIO_IDS = ["max_trade", "daily_cap", "price_floor", "paused"];
export const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_OUT = "out/yield-demo";
const DEMO_SCRIPT = fileURLToPath(new URL("./yield-demo.mjs", import.meta.url));

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Problems found in a parsed plan.json and calls.json; an empty list means the demo is ok. */
export function checkYieldDemo(plan, calls) {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  if (!isObject(plan)) return ["plan.json is not a JSON object"];
  if (!isObject(calls)) problems.push("calls.json is not a JSON object");
  const callsFile = isObject(calls) ? calls : {};

  expect(plan.dry_run === true, `plan.json dry_run must be true (got ${JSON.stringify(plan.dry_run)})`);
  expect(plan.signed === false, `plan.json signed must be false (got ${JSON.stringify(plan.signed)})`);
  expect(plan.sent === false, `plan.json sent must be false (got ${JSON.stringify(plan.sent)})`);
  expect(plan.mode === EXPECTED_MODE, `plan.json mode must be "${EXPECTED_MODE}" (got ${JSON.stringify(plan.mode)})`);
  expect(plan.calls_planned === EXPECTED_CALLS, `plan.json calls_planned must be ${EXPECTED_CALLS} (got ${JSON.stringify(plan.calls_planned)})`);
  expect(plan.calls_signed === EXPECTED_SIGNED, `plan.json calls_signed must be ${EXPECTED_SIGNED} (got ${JSON.stringify(plan.calls_signed)})`);
  expect(plan.calls_sent === EXPECTED_SENT, `plan.json calls_sent must be ${EXPECTED_SENT} (got ${JSON.stringify(plan.calls_sent)})`);

  const agents = Array.isArray(plan.agents) ? plan.agents : null;
  expect(agents !== null && agents.length === EXPECTED_AGENTS, `plan.json agents must have ${EXPECTED_AGENTS} rows (got ${agents ? agents.length : JSON.stringify(plan.agents)})`);
  (agents ?? []).forEach((agent, i) => {
    if (!isObject(agent) || !isObject(agent.call)) return;
    expect(agent.call.signed === false, `plan.json agents[${i}].call.signed must be false`);
    expect(agent.call.sent === false, `plan.json agents[${i}].call.sent must be false`);
  });

  expect(callsFile.dry_run === true, `calls.json dry_run must be true (got ${JSON.stringify(callsFile.dry_run)})`);
  expect(callsFile.signed === false, `calls.json signed must be false (got ${JSON.stringify(callsFile.signed)})`);
  expect(callsFile.sent === false, `calls.json sent must be false (got ${JSON.stringify(callsFile.sent)})`);
  const list = Array.isArray(callsFile.calls) ? callsFile.calls : null;
  expect(list !== null && list.length === plan.calls_planned, `calls.json calls length must equal plan.json calls_planned (${JSON.stringify(plan.calls_planned)}; got ${list ? list.length : JSON.stringify(callsFile.calls)})`);
  (list ?? []).forEach((call, i) => {
    expect(isObject(call) && call.signed === false, `calls.json calls[${i}].signed must be false`);
    expect(isObject(call) && call.sent === false, `calls.json calls[${i}].sent must be false`);
  });

  // Pool 1 (nusdt/nusdc "stable") is far off its $1 peg: no personality agent may execute a pool 1 swap.
  const pool1 = (agents ?? []).filter((a) => isObject(a) && a.kind === "personality" && isObject(a.proposal) && a.proposal.pool_id === 1);
  expect(pool1.length > 0, "plan.json must have at least one personality agent proposing on pool 1 (the off-reference refusal is what the demo shows)");
  const plannerRow = (agents ?? []).find((a) => isObject(a) && a.kind === "planner");
  expect(plannerRow?.decision === EXPECTED_PLANNER_DECISION, `plan.json planner decision must be ${EXPECTED_PLANNER_DECISION} on the committed snapshot (got ${JSON.stringify(plannerRow?.decision)})`);
  problems.push(...checkPlannerCall(plannerRow, list ?? []));
  (agents ?? []).forEach((agent, i) => {
    if (!isObject(agent) || agent.kind !== "personality" || !isObject(agent.proposal) || agent.proposal.pool_id !== 1) return;
    const text = JSON.stringify([agent.rule_check, agent.strategy_check]);
    expect(agent.outcome === "refused", `plan.json agents[${i}] (${agent.agent}) proposed on pool 1 and must be refused (got ${JSON.stringify(agent.outcome)})`);
    expect(text.includes("SOFT_OFF_REFERENCE") || text.includes("ERR_PRICE_FLOOR"), `plan.json agents[${i}] (${agent.agent}) refusal must cite SOFT_OFF_REFERENCE or ERR_PRICE_FLOOR`);
    expect(isObject(agent.reference) && typeof agent.reference.reference_deviation_bps === "number", `plan.json agents[${i}] (${agent.agent}) must carry reference.reference_deviation_bps`);
  });

  problems.push(...checkOneStory(plan, callsFile));

  expect(plan.rule_rejections === EXPECTED_REJECTIONS, `plan.json rule_rejections must be ${EXPECTED_REJECTIONS} (got ${JSON.stringify(plan.rule_rejections)})`);
  const scenarios = isObject(plan.rule_scenarios) && Array.isArray(plan.rule_scenarios.scenarios) ? plan.rule_scenarios.scenarios : null;
  if (scenarios === null) {
    problems.push("plan.json rule_scenarios.scenarios is missing");
  } else {
    const ids = scenarios.map((s) => (isObject(s) ? s.id : undefined));
    expect(JSON.stringify(ids) === JSON.stringify(EXPECTED_SCENARIO_IDS), `plan.json rule_scenarios ids must be ${EXPECTED_SCENARIO_IDS.join(", ")} in order (got ${ids.join(", ") || "none"})`);
    scenarios.forEach((s, i) => {
      const label = `plan.json rule_scenarios.scenarios[${i}] (${isObject(s) ? s.id : "?"})`;
      if (!isObject(s)) { problems.push(`${label} is not an object`); return; }
      expect(s.outcome === "rejected", `${label} outcome must be "rejected" (got ${JSON.stringify(s.outcome)})`);
      expect(s.matches_contract === true, `${label} matches_contract must be true (got ${JSON.stringify(s.matches_contract)})`);
      expect(typeof s.contract_message === "string" && s.contract_message !== "", `${label} contract_message must be a non-empty string`);
      expect(s.contract_message === s.js_message, `${label} contract_message must equal js_message`);
      expect(typeof s.contract_message === "string" && typeof s.code === "string" && s.contract_message.startsWith(`${s.code}: `), `${label} contract_message must start with "<code>: "`);
    });
  }
  return problems;
}

/**
 * Problems with the planner's call: it must exist, be the one call in calls.json, pass checkProposal when
 * re-run here (not taken from the demo's own rule_check) against the default snapshot's planner vault, and
 * be on a pool whose candidate has a reference price (a number) and status ok.
 */
export function checkPlannerCall(planner, calls) {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  if (!isObject(planner)) return ["plan.json has no planner row to carry the call"];
  const proposal = planner.call?.args?.proposal;
  if (!isObject(proposal)) return ["the planner must carry an execute_swap call with args.proposal (it holds or has none)"];
  expect(planner.call.method_name === "execute_swap", `planner call method_name must be execute_swap (got ${JSON.stringify(planner.call.method_name)})`);
  expect(calls.some((c) => isObject(c) && JSON.stringify(c.args?.proposal) === JSON.stringify(proposal)), "calls.json must contain the planner's call");
  const snap = defaultSnapshot();
  const view = rulesView(snap);
  const rules = checkProposal(proposal, view.config, view.state, snap.runner_id, view.nowMs);
  expect(rules.ok, `the planner's call does not pass checkProposal on the default snapshot: ${rules.reason}`);
  const cands = (Array.isArray(planner.candidates) ? planner.candidates : []).filter((c) => isObject(c) && c.pool_id === proposal.pool_id);
  expect(cands.length > 0, `the planner's call is on pool ${proposal.pool_id}, which is not among its candidates`);
  for (const c of cands) {
    expect(typeof c.ref_deviation_bps === "number" && Number.isFinite(c.ref_deviation_bps), `the planner's call is on pool ${proposal.pool_id}, which has no reference price (ref_deviation_bps ${JSON.stringify(c.ref_deviation_bps)})`);
    expect(c.status === "ok", `the planner's call is on pool ${proposal.pool_id} whose candidate status is ${JSON.stringify(c.status)}, not ok`);
  }
  return problems;
}

/**
 * Problems when plan.json and calls.json do not tell one story: one vault id and one runner id for every agent
 * row, the planner vault and every call; one gas string across the calls; one snapshot shared by the agents and
 * the planner; a planner row with a decision, a reason and candidates that each carry a known status.
 */
export function checkOneStory(plan, calls) {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const agents = Array.isArray(plan.agents) ? plan.agents.filter(isObject) : [];
  const calls_ = Array.isArray(calls.calls) ? calls.calls.filter(isObject) : [];

  const vaults = new Set([
    ...agents.map((a) => a.vault_id),
    plan.personality_agents?.vault_id,
    plan.planner_vault?.vault_id,
    ...calls_.map((c) => c.receiver_id),
    ...agents.map((a) => a.call?.receiver_id),
  ].filter((v) => v !== undefined && v !== null));
  expect(vaults.size === 1, `plan.json and calls.json must name one vault id (got ${vaults.size}: ${[...vaults].join(", ") || "none"})`);
  const runners = new Set([
    ...agents.map((a) => a.runner_id),
    plan.personality_agents?.runner_id,
    plan.planner_vault?.runner_id,
    ...calls_.map((c) => c.signer_id),
  ].filter((v) => v !== undefined && v !== null));
  expect(runners.size === 1, `plan.json and calls.json must name one runner id (got ${runners.size}: ${[...runners].join(", ") || "none"})`);

  const gas = new Set([...calls_.map((c) => c.gas), ...agents.map((a) => a.call?.gas)].filter((v) => v !== undefined && v !== null));
  // With no call planned there is no gas string at all; with calls there must be exactly one, the shared figure.
  const wantGas = calls_.length > 0 ? 1 : 0;
  expect(gas.size === wantGas, `plan.json and calls.json must carry ${wantGas === 1 ? "one gas string" : "no gas string when no call is planned"} (got ${gas.size}: ${[...gas].join(", ") || "none"})`);
  for (const g of gas) expect(g === EXECUTE_SWAP_GAS_CLI, `gas ${JSON.stringify(g)} is not the shared execute_swap figure ${EXECUTE_SWAP_GAS_CLI} (src/yield/gas.mjs)`);

  expect(!("snapshots" in plan), "plan.json must have one snapshot, not a snapshots pair");
  expect(isObject(plan.snapshot) && plan.snapshot.shared_by_agents_and_planner === true, "plan.json snapshot must be shared_by_agents_and_planner: true");
  expect(isObject(plan.snapshot) && plan.snapshot.fetched === false, "plan.json snapshot.fetched must be false");

  const planner = agents.find((a) => a.kind === "planner");
  if (!planner) {
    problems.push("plan.json has no planner row");
  } else {
    expect(planner.decision === "hold" || planner.decision === "swap", `planner decision must be hold or swap (got ${JSON.stringify(planner.decision)})`);
    expect(typeof planner.reason === "string" && planner.reason !== "", "planner reason must be a non-empty string");
    expect(planner.decision !== "hold" || planner.call === null, "a planner that holds must carry no call");
    expect(planner.decision !== "swap" || (isObject(planner.call) && planner.outcome === "execute"), "a planner that swaps must carry its call and the outcome execute");
    const cands = Array.isArray(planner.candidates) ? planner.candidates : [];
    expect(cands.length > 0, "planner must list its candidates");
    cands.forEach((c, i) => expect(isObject(c) && PLANNER_STATUSES.includes(c.status), `planner candidates[${i}] has an unknown status ${JSON.stringify(isObject(c) ? c.status : c)}`));
    expect(planner.decision !== "swap" || cands.some((c) => c.status === "ok"), "a planner that swaps must have an ok candidate");
  }
  return problems;
}

export const VECTORS_FILE = fileURLToPath(new URL("../contracts/yield-vault/tests/rule-vectors.json", import.meta.url));

/**
 * Problems when a rule scenario's message is not the contract vector's `expect`. Read from the
 * vectors file here, independently of the demo, so the demo cannot vouch for itself.
 */
export function checkAgainstVectors(plan, vectors) {
  const cases = isObject(vectors) && Array.isArray(vectors.cases) ? vectors.cases : null;
  if (cases === null) return ["rule-vectors.json has no cases"];
  const scenarios = isObject(plan) && isObject(plan.rule_scenarios) && Array.isArray(plan.rule_scenarios.scenarios) ? plan.rule_scenarios.scenarios : [];
  const problems = [];
  for (const s of scenarios) {
    if (!isObject(s)) continue;
    const c = cases.find((x) => isObject(x) && x.name === s.vector);
    if (!c) problems.push(`rule scenario ${s.id} names vector ${JSON.stringify(s.vector)}, which is not in rule-vectors.json`);
    else if (c.expect === "" || c.expect !== s.contract_message) problems.push(`rule scenario ${s.id} message ${JSON.stringify(s.contract_message)} is not the contract vector's expect ${JSON.stringify(c.expect)}`);
  }
  return problems;
}

export const DRY_RUN_NOTICE = "DRY RUN: mock inference, committed fixtures, nothing was signed or sent.";

/** Problems found in the rendered index.html given the parsed plan.json. */
export function checkIndexHtml(html, plan) {
  if (typeof html !== "string") return ["index.html is not text"];
  const problems = [];
  if (!html.includes(escapeHtml(DRY_RUN_NOTICE))) problems.push("index.html is missing the DRY RUN notice");
  const scenarios = isObject(plan) && isObject(plan.rule_scenarios) && Array.isArray(plan.rule_scenarios.scenarios) ? plan.rule_scenarios.scenarios : [];
  for (const s of scenarios) {
    if (isObject(s) && typeof s.contract_message === "string" && !html.includes(escapeHtml(s.contract_message))) {
      problems.push(`index.html is missing the contract message for ${s.id}: ${s.contract_message}`);
    }
  }
  return problems;
}

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--timeout-ms") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--out") opts.out = value;
      else if (/^[1-9][0-9]*$/.test(value)) opts.timeoutMs = Number(value);
      else throw new Error(`--timeout-ms must be a positive integer (got ${JSON.stringify(value)})`);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}\nUsage: node scripts/yield-demo-check.mjs [--out DIR] [--timeout-ms N]`);
    }
  }
  return opts;
}

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: `cannot read ${file}: ${String(error.message).split("\n")[0]}` };
  }
}

function readText(file) {
  try {
    return { value: readFileSync(file, "utf8") };
  } catch (error) {
    return { error: `cannot read ${file}: ${String(error.message).split("\n")[0]}` };
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
  const out = assertSafeOutDir(opts.out);
  const run = spawnSync(process.execPath, [DEMO_SCRIPT, "--out", out], { encoding: "utf8", timeout: opts.timeoutMs });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error?.code === "ETIMEDOUT") {
    console.error(`FAIL: yield demo timed out after ${opts.timeoutMs / 1000}s`);
    return 1;
  }
  if (run.error) {
    console.error(`FAIL: yield demo could not run: ${run.error.message}`);
    return 1;
  }
  if (run.status !== 0) {
    console.error(`FAIL: yield demo exited with status ${run.status ?? run.signal}`);
    return 1;
  }
  const plan = readJson(join(out, "plan.json"));
  const calls = readJson(join(out, "calls.json"));
  const problems = [plan.error, calls.error].filter(Boolean);
  if (problems.length === 0) problems.push(...checkYieldDemo(plan.value, calls.value));
  const vectors = readJson(VECTORS_FILE);
  if (vectors.error) problems.push(vectors.error);
  else if (!plan.error) problems.push(...checkAgainstVectors(plan.value, vectors.value));
  const index = readText(join(out, "index.html"));
  if (index.error) problems.push(index.error);
  else problems.push(...checkIndexHtml(index.value, plan.value));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    return 1;
  }
  console.log(`yield demo: dry_run true, signed false, sent false; one vault${EXPECTED_CALLS > 0 ? ", one gas figure" : ", no gas figure (no call)"}; ${EXPECTED_CALLS} ${EXPECTED_CALLS === 1 ? "call" : "calls"} planned, ${EXPECTED_SIGNED} signed, ${EXPECTED_SENT} sent; ${EXPECTED_REJECTIONS} rule rejections match the contract`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
