#!/usr/bin/env node
// Judge-screen check for the yield demo (the "yield demo" stage of scripts/verify.sh).
//
//   node scripts/yield-demo-check.mjs [--out DIR] [--timeout-ms N]
//
// Runs `node scripts/yield-demo.mjs --out DIR` (offline, mock) with a timeout, then reads
// DIR/plan.json, DIR/calls.json and DIR/index.html and fails unless the plan is a dry run with nothing signed
// or sent, 4 calls planned, and the 4 vault-rule rejections match the contract. index.html must
// carry the DRY RUN notice and each rejection's contract message (HTML-escaped as rendered).

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml } from "../src/viewer/render.mjs";
import { assertSafeOutDir } from "../src/util/outdir.mjs";

export const EXPECTED_MODE = "mock";
export const EXPECTED_AGENTS = 5;
export const EXPECTED_CALLS = 4;
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
  console.log(`yield demo: dry_run true, signed false, sent false; ${EXPECTED_CALLS} calls planned, ${EXPECTED_SIGNED} signed, ${EXPECTED_SENT} sent; ${EXPECTED_REJECTIONS} rule rejections match the contract`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
