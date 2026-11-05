// Tests for scripts/yield-demo-check.mjs (the "yield demo" stage of scripts/verify.sh).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { VECTORS_FILE, checkAgainstVectors, checkIndexHtml, checkYieldDemo } from "./yield-demo-check.mjs";

const CHECK = fileURLToPath(new URL("./yield-demo-check.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.sh", import.meta.url));
const IDS = ["max_trade", "daily_cap", "price_floor", "paused"];

const VAULT = "vault.yield-demo.testnet";
const RUNNER = "runner.yield-demo.testnet";

/** An unsigned call as the demo would write it, for the cases that add one. */
const CALL = Object.freeze({ signed: false, sent: false, method: "execute_swap", receiver_id: VAULT, signer_id: RUNNER, gas: "280.0 Tgas" });

function fixture() {
  const row = (extra = {}) => ({ kind: "personality", vault_id: VAULT, runner_id: RUNNER, ...extra });
  const plan = {
    demo: "yield-demo", mode: "mock", dry_run: true, signed: false, sent: false,
    snapshot: { shared_by_agents_and_planner: true, fetched: false },
    personality_agents: { vault_id: VAULT, runner_id: RUNNER },
    planner_vault: { vault_id: VAULT, runner_id: RUNNER },
    // The real demo: the pool 1 agents are refused as off reference, chaotic is vetoed and the optimizer holds.
    agents: [
      row({ agent: "aloof", proposal: { pool_id: 1 }, outcome: "refused", rule_check: { ok: true }, strategy_check: { ok: false, violations: [{ code: "SOFT_OFF_REFERENCE" }] }, reference: { reference_deviation_bps: 18590000 }, call: null }),
      row({ agent: "chaotic", proposal: { pool_id: 0 }, outcome: "vetoed", call: null }),
      row({ agent: "social", proposal: null, outcome: "skipped", call: null }),
      row({ agent: "skeptic", proposal: { pool_id: 1 }, outcome: "refused", rule_check: { ok: false, code: "ERR_PRICE_FLOOR" }, strategy_check: { ok: false, violations: [] }, reference: { reference_deviation_bps: -9994 }, call: null }),
      { agent: "yield-optimizer", kind: "planner", vault_id: VAULT, runner_id: RUNNER, decision: "hold", reason: "no pool passes every gate", call: null, candidates: [{ status: "off_reference" }, { status: "refused" }] },
    ],
    calls_planned: 0, calls_signed: 0, calls_sent: 0, rule_rejections: 4,
    rule_scenarios: {
      scenarios: IDS.map((id) => ({
        id, outcome: "rejected", code: `E_${id}`, contract_message: `E_${id}: nope`, js_message: `E_${id}: nope`, matches_contract: true,
      })),
    },
  };
  const calls = { dry_run: true, signed: false, sent: false, calls: [] };
  return { plan, calls };
}

function mutated(mutate) {
  const f = structuredClone(fixture());
  mutate(f.plan, f.calls);
  return checkYieldDemo(f.plan, f.calls);
}

test("a valid plan and calls file has no problems", () => {
  const { plan, calls } = fixture();
  assert.deepEqual(checkYieldDemo(plan, calls), []);
});

const CASES = [
  ["plan dry_run false", (p) => { p.dry_run = false; }, /dry_run/],
  ["plan signed true", (p) => { p.signed = true; }, /plan\.json signed/],
  ["plan sent true", (p) => { p.sent = true; }, /plan\.json sent/],
  ["plan mode live", (p) => { p.mode = "live"; }, /mode/],
  ["a pool 1 personality proposal that executes", (p) => { p.agents[0].outcome = "execute"; }, /aloof.*must be refused/],
  ["a pool 1 refusal that cites no reference or floor", (p) => { p.agents[0].strategy_check.violations = [{ code: "SOFT_SLIPPAGE" }]; }, /aloof.*SOFT_OFF_REFERENCE or ERR_PRICE_FLOOR/],
  ["a pool 1 refusal without the deviation number", (p) => { delete p.agents[0].reference; }, /aloof.*reference_deviation_bps/],
  ["calls_planned 1", (p) => { p.calls_planned = 1; }, /calls_planned must be 0/],
  ["calls_signed 1", (p) => { p.calls_signed = 1; }, /calls_signed/],
  ["calls_sent 1", (p) => { p.calls_sent = 1; }, /calls_sent/],
  ["four agents", (p) => { p.agents.pop(); }, /agents/],
  ["agent call signed", (p) => { p.agents[1].call = { ...CALL, signed: true }; }, /agents\[1\]\.call\.signed/],
  ["agent call sent", (p) => { p.agents[2].call = { ...CALL, sent: true }; }, /agents\[2\]\.call\.sent/],
  ["calls.json dry_run false", (p, c) => { c.dry_run = false; }, /calls\.json dry_run/],
  ["calls.json signed true", (p, c) => { c.signed = true; }, /calls\.json signed/],
  ["calls.json sent true", (p, c) => { c.sent = true; }, /calls\.json sent/],
  ["calls.json length mismatch", (p, c) => { c.calls.push({ ...CALL }); }, /calls length/],
  ["calls.json call signed", (p, c) => { c.calls = [{ ...CALL, signed: true }]; }, /calls\[0\]\.signed/],
  ["calls.json call sent", (p, c) => { c.calls = [{ ...CALL }, { ...CALL }, { ...CALL, sent: true }]; }, /calls\[2\]\.sent/],
  ["rule_rejections 3", (p) => { p.rule_rejections = 3; }, /rule_rejections/],
  ["scenario matches_contract false", (p) => { p.rule_scenarios.scenarios[1].matches_contract = false; }, /daily_cap.*matches_contract/],
  ["scenario outcome accepted", (p) => { p.rule_scenarios.scenarios[0].outcome = "accepted"; }, /max_trade.*outcome/],
  ["message mismatch", (p) => { p.rule_scenarios.scenarios[2].js_message = "E_price_floor: different"; }, /price_floor.*contract_message must equal js_message/],
  ["message without code prefix", (p) => { const s = p.rule_scenarios.scenarios[3]; s.contract_message = s.js_message = "paused"; }, /paused.*start with/],
  ["empty message", (p) => { const s = p.rule_scenarios.scenarios[0]; s.contract_message = s.js_message = ""; }, /max_trade.*non-empty/],
  ["missing scenario", (p) => { p.rule_scenarios.scenarios.pop(); }, /rule_scenarios ids/],
  ["scenarios out of order", (p) => { p.rule_scenarios.scenarios.reverse(); }, /rule_scenarios ids/],
  ["agent row on another vault id", (p) => { p.agents[0] = { ...p.agents[0], vault_id: "yield-vault.fixture.testnet" }; }, /one vault id \(got 2/],
  ["planner vault on another vault id", (p) => { p.planner_vault = { vault_id: "yield-vault.fixture.testnet", runner_id: RUNNER }; }, /one vault id \(got 2/],
  ["a call to another vault", (p, c) => { c.calls = [{ ...CALL }, { ...CALL, receiver_id: "other.testnet" }]; }, /one vault id \(got 2/],
  ["planner on another runner", (p) => { p.planner_vault = { vault_id: VAULT, runner_id: "yield-runner.fixture.testnet" }; }, /one runner id \(got 2/],
  ["a call with another gas string", (p, c) => { c.calls = [{ ...CALL }, { ...CALL }, { ...CALL, gas: "300.0 Tgas" }]; }, /one gas string \(got 2: 280\.0 Tgas, 300\.0 Tgas\)/],
  ["an agent call with another gas string", (p, c) => { c.calls = [{ ...CALL }]; p.agents[0].call = { ...CALL, gas: "280 TGas" }; }, /one gas string \(got 2/],
  ["one call with a gas figure that is not the shared one", (p, c) => { c.calls = [{ ...CALL, gas: "300.0 Tgas" }]; }, /"300\.0 Tgas" is not the shared execute_swap figure 280\.0 Tgas/],
  ["no call but an agent row carries a gas string", (p) => { p.agents[1].call = { ...CALL }; }, /no gas string when no call is planned \(got 1: 280\.0 Tgas\)/],
  ["a snapshots pair", (p) => { p.snapshots = { ref_pools: {}, rhea: {} }; }, /one snapshot, not a snapshots pair/],
  ["snapshot not shared", (p) => { p.snapshot.shared_by_agents_and_planner = false; }, /shared_by_agents_and_planner/],
  ["no planner row", (p) => { p.agents[4].kind = "personality"; }, /no planner row/],
  ["planner without a reason", (p) => { p.agents[4].reason = ""; }, /planner reason/],
  ["planner holds but carries a call", (p) => { p.agents[4].call = { signed: false, sent: false, gas: "280.0 Tgas" }; }, /holds must carry no call/],
  ["planner candidate with an unknown status", (p) => { p.agents[4].candidates[0].status = "great"; }, /candidates\[0\] has an unknown status/],
  ["planner swaps with no ok candidate", (p) => { p.agents[4].decision = "swap"; p.agents[4].call = null; }, /swaps must have an ok candidate/],
  ["rule_scenarios absent", (p) => { delete p.rule_scenarios; }, /rule_scenarios\.scenarios is missing/],
];

for (const [name, mutate, pattern] of CASES) {
  test(`checkYieldDemo reports: ${name}`, () => {
    const problems = mutated(mutate);
    assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  });
}

test("checkYieldDemo rejects non-object input instead of throwing", () => {
  assert.ok(checkYieldDemo(null, {}).length > 0);
  assert.ok(checkYieldDemo(fixture().plan, null).some((p) => /calls\.json/.test(p)));
});

const NOTICE = "DRY RUN: mock inference, committed fixtures, nothing was signed or sent.";
const pageFor = (plan) => `<p>${NOTICE}</p>${plan.rule_scenarios.scenarios.map((s) => `<code>${s.contract_message.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code>`).join("")}`;

test("checkIndexHtml accepts a page with the notice and every message", () => {
  const { plan } = fixture();
  assert.deepEqual(checkIndexHtml(pageFor(plan), plan), []);
});

test("checkIndexHtml reports a missing notice and a missing contract message", () => {
  const { plan } = fixture();
  assert.ok(checkIndexHtml(pageFor(plan).replace(NOTICE, "hello"), plan).some((p) => /DRY RUN notice/.test(p)));
  const missing = checkIndexHtml(pageFor(plan).replace("E_paused: nope", "x"), plan);
  assert.ok(missing.some((p) => /paused/.test(p)), JSON.stringify(missing));
  assert.ok(checkIndexHtml(null, plan).length > 0);
});

function runCheck(args) {
  return spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 180000 });
}

test("CLI: a tiny --timeout-ms fails with the timeout message", () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-demo-check-"));
  try {
    const r = runCheck(["--out", join(dir, "out"), "--timeout-ms", "1"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /^FAIL: yield demo timed out after 0\.001s$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: rejects a bad --timeout-ms and unknown arguments", () => {
  assert.equal(runCheck(["--timeout-ms", "abc"]).status, 1);
  const r = runCheck(["--bogus"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument/);
});

// Needs plan.json to carry rule_rejections and rule_scenarios (the yield-demo rule scenarios work).
test("CLI: the real demo passes and prints the success line", () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-demo-check-"));
  try {
    const r = runCheck(["--out", join(dir, "out")]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      r.stdout.split("\n").includes("yield demo: dry_run true, signed false, sent false; one vault, no gas figure (no call); 0 calls planned, 0 signed, 0 sent; 4 rule rejections match the contract"),
      r.stdout,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: the real demo run leaves an index.html carrying the notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-demo-check-"));
  try {
    const out = join(dir, "out");
    assert.equal(runCheck(["--out", out]).status, 0);
    assert.ok(readFileSync(join(out, "index.html"), "utf8").includes(NOTICE));
    assert.deepEqual(checkIndexHtml(readFileSync(join(out, "index.html"), "utf8"), JSON.parse(readFileSync(join(out, "plan.json"), "utf8"))), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify.sh runs the yield demo check after the yield stage and expects its row", () => {
  const text = readFileSync(VERIFY, "utf8");
  const yieldAt = text.indexOf('planned "yield" "yield" mock');
  const demoAt = text.indexOf('planned "yield demo" "yield:demo:check" mock');
  assert.ok(yieldAt > 0 && demoAt > yieldAt, "yield demo stage must follow the yield stage");
  assert.match(text, /"round hash" "yield" "yield demo" "yield shade" "yield live" "vault tests"/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["yield:demo:check"], "node scripts/yield-demo-check.mjs");
});

test("checkAgainstVectors: messages are compared with the vectors file, not with the demo's own fields", () => {
  const vectors = JSON.parse(readFileSync(VECTORS_FILE, "utf8"));
  const name = "ERR_PAUSED: vault is paused";
  const expect = vectors.cases.find((c) => c.name === name).expect;
  const plan = { rule_scenarios: { scenarios: [{ id: "paused", vector: name, contract_message: expect, js_message: expect, matches_contract: true }] } };
  assert.deepEqual(checkAgainstVectors(plan, vectors), []);
  // A demo that agrees with itself (contract_message === js_message, matches_contract true) but not with the contract.
  const forged = structuredClone(plan);
  forged.rule_scenarios.scenarios[0].contract_message = forged.rule_scenarios.scenarios[0].js_message = "ERR_PAUSED: vault paused";
  assert.match(checkAgainstVectors(forged, vectors).join("\n"), /paused message "ERR_PAUSED: vault paused" is not the contract vector's expect "ERR_PAUSED: vault is paused"/);
  const unknown = structuredClone(plan);
  unknown.rule_scenarios.scenarios[0].vector = "no such vector";
  assert.match(checkAgainstVectors(unknown, vectors).join("\n"), /not in rule-vectors\.json/);
  assert.deepEqual(checkAgainstVectors(plan, {}), ["rule-vectors.json has no cases"]);
});
