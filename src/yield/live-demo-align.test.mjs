// The live testnet plan's one swap must be the swap `npm run yield:demo` plans and prints: the demo is what a
// judge reads, the live run is what executes. Offline: runDemo is the pure planner over committed fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PLANNER_ID, runDemo } from "./demo.mjs";
import { buildLivePlan, loadContractSpec, loadLiveConfig, validateLiveConfig, validatePlan, vaultConfigFor } from "./live-plan.mjs";
import { checkProposal } from "./rules.mjs";

const EXAMPLE = new URL("../../config/yield-vault.live.example.json", import.meta.url);
const spec = loadContractSpec();
const example = () => loadLiveConfig(EXAMPLE);

const demo = await runDemo();
const demoCall = demo.calls.calls.find((c) => c.agent === PLANNER_ID);
assert.ok(demoCall, "the demo plans an execute_swap for the Yield Optimizer");
const demoProposal = demoCall.args.proposal;

test("the example config's swap equals the proposal the offline demo plans", () => {
  const c = example();
  assert.equal(c.vault_profile, "yield-optimizer");
  assert.equal(c.agent, "aloof");
  assert.deepEqual(c.swap, demoProposal);
  assert.equal(demoCall.method_name, "execute_swap");
});

test("the live plan's execute_swap step carries that same proposal", () => {
  const plan = buildLivePlan(example());
  const step = plan.steps.find((s) => s.id === "execute-swap");
  const call = step.actions.find((a) => a.type === "FunctionCall");
  assert.equal(call.method_name, demoCall.method_name);
  assert.deepEqual(call.args.proposal, demoProposal);
  assert.deepEqual(call.args, demoCall.args);
});

test("deposit.token_id is the swap's token_in, and the live swap passes the vault hard rules", () => {
  const c = example();
  assert.equal(c.deposit.token_id, c.swap.token_in);
  assert.ok(BigInt(c.deposit.amount) >= BigInt(c.swap.amount_in));
  const vc = vaultConfigFor(c);
  const state = { balances: { [c.deposit.token_id]: c.deposit.amount } };
  const hard = checkProposal(c.swap, vc, state, c.runner_id, Date.now());
  assert.deepEqual(hard, { ok: true, code: null, reason: "" });
  // The demo's own vault accepts it too: same proposal, same rules, same pool set.
  assert.deepEqual(vc.allowed_pools.map((p) => p.pool_id), [0, 1, 747]);
});

test("the example config and its plan validate against contracts/yield-vault/src/lib.rs", () => {
  assert.deepEqual(validateLiveConfig(example(), { allowPlaceholders: true }), []);
  assert.deepEqual(validatePlan(buildLivePlan(example()), spec.methods, { minGas: spec.minGas }), []);
});
