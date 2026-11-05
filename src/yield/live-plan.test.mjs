import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_TX_GAS, TGAS, buildLivePlan, formatNear, loadContractSpec, loadLiveConfig, parseContractMethods, parseMinGas, parseNear,
  validateLiveConfig, validatePlan,
} from "./live-plan.mjs";
import { RefusalError } from "./send.mjs";

const EXAMPLE = new URL("../../config/yield-vault.live.example.json", import.meta.url);
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const spec = loadContractSpec();
const example = () => loadLiveConfig(EXAMPLE);
const planOf = () => structuredClone(buildLivePlan(example()));
const validate = (plan) => validatePlan(plan, spec.methods, { minGas: spec.minGas });
const stepOf = (plan, id) => plan.steps.find((s) => s.id === id);
const callOf = (plan, id) => stepOf(plan, id).actions.find((a) => a.type === "FunctionCall");

test("amounts: NEAR strings convert to yocto with BigInt", () => {
  assert.equal(parseNear("0.1"), 10n ** 23n);
  assert.equal(parseNear("6"), 6n * 10n ** 24n);
  assert.equal(parseNear("0.000000000000000000000001"), 1n);
  assert.equal(formatNear(10n ** 23n), "0.1");
  assert.equal(formatNear(3n * 10n ** 24n), "3");
  for (const bad of ["1e3", "-1", "0.1.2", "", "0.0000000000000000000000001", 1]) assert.throws(() => parseNear(bad));
});

test("parseContractMethods reads the real lib.rs", () => {
  const m = parseContractMethods(readFileSync(new URL("../../contracts/yield-vault/src/lib.rs", import.meta.url), "utf8"));
  const swap = m.get("execute_swap");
  assert.deepEqual([swap.private, swap.payable, swap.view, swap.args], [false, false, false, ["proposal"]]);
  const w = m.get("withdraw");
  assert.equal(w.payable, true);
  assert.equal(w.oneYocto, true);
  assert.deepEqual(w.args, ["token_id", "amount"]);
  assert.equal(m.get("on_swap").private, true);
  assert.equal(m.get("get_state").view, true);
  assert.equal(m.get("get_state").payable, false);
  assert.deepEqual(m.get("withdraw_ref_storage").optional, ["amount"]);
  assert.equal(m.get("register_on_ref").depositRequired, true);
  assert.equal(m.get("register_on_ref").oneYocto, false);
  assert.equal(m.get("new").init, true);
  assert.deepEqual(m.get("ft_on_transfer").args, ["sender_id", "amount", "msg"]);
  assert.equal(m.has("held"), false, "methods of non-#[near] impl blocks are not contract methods");
});

test("parseMinGas reads the MIN_* constants in yocto-gas", () => {
  assert.equal(spec.minGas.MIN_EXECUTE_GAS, 280n * TGAS);
  assert.equal(spec.minGas.MIN_WITHDRAW_GAS, 80n * TGAS);
  assert.equal(parseMinGas("pub const MIN_X_GAS: Gas = Gas::from_tgas(7);").MIN_X_GAS, 7n * TGAS);
  assert.equal(parseMinGas("// pub const MIN_X_GAS: Gas = Gas::from_tgas(7);").MIN_X_GAS, undefined);
});

test("parser ignores braces and keywords inside strings and comments", () => {
  const src = `#[near]\nimpl YieldVault {\n  /// pub fn fake(&self) {}\n  #[payable]\n  pub fn real(&mut self, a: Option<U128>, #[allow(unused)] b: String) { let _ = "}{ pub fn nope(&self)"; }\n  pub fn other(&self) {}\n}`;
  const m = parseContractMethods(src);
  assert.deepEqual([...m.keys()], ["real", "other"]);
  assert.deepEqual(m.get("real").args, ["a", "b"]);
  assert.deepEqual(m.get("real").optional, ["a"]);
});

test("plan: deploy and init are one transaction signed by the vault", () => {
  const plan = buildLivePlan(example());
  const s = stepOf(plan, "deploy-init");
  assert.equal(s.signer_id, plan.vault_id);
  assert.equal(s.receiver_id, plan.vault_id);
  assert.deepEqual(s.actions.map((a) => a.type), ["DeployContract", "FunctionCall"]);
  assert.equal(s.actions[1].method_name, "new");
  assert.deepEqual(Object.keys(s.actions[1].args), ["owner_id", "nft_contract_id", "token_id", "ref_exchange_id", "config"]);
  assert.deepEqual(s.actions[1].args.config.runners, [plan.runner_id]);
  assert.match(s.near_cli, /^near contract deploy \S+ use-file \S+yield_vault\.wasm with-init-call new json-args '/);
});

test("plan: execute_swap is signed by the runner with 300 TGas and no deposit", () => {
  const plan = buildLivePlan(example());
  const s = stepOf(plan, "execute-swap");
  assert.equal(s.signer_id, plan.runner_id);
  assert.equal(s.actions[0].gas, String(300n * TGAS));
  assert.equal(s.actions[0].deposit_yocto, "0");
  assert.match(s.near_cli, /sign-as runner\.\S+ network-config testnet sign-with-keychain send$/);
});

test("plan: phases are in order and every step has a near_cli string and expectation", () => {
  const plan = buildLivePlan(example());
  const order = ["setup", "fund", "swap", "withdraw", "rollback"];
  const seen = plan.steps.map((s) => s.phase).filter((p) => p !== "check");
  const idx = seen.map((p) => order.indexOf(p));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual([...new Set(plan.steps.map((s) => s.phase))].sort(), ["check", "fund", "rollback", "setup", "swap", "withdraw"]);
  for (const s of plan.steps) {
    assert.match(s.near_cli, /^near (contract|account) /);
    assert.ok(s.expect && s.cost_near !== undefined);
    assert.equal(Boolean(s.view), s.actions[0].type === "ViewCall");
  }
  assert.equal(plan.unsigned, true);
  const ids = plan.steps.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "step ids are unique");
  assert.ok(ids.indexOf("storage-deposit") < ids.indexOf("deposit-into-vault"));
  assert.ok(ids.indexOf("register-on-ref") < ids.indexOf("execute-swap"));
  assert.deepEqual(ids.slice(-2), ["delete-vault", "delete-runner"]);
});

test("plan: rollback steps and withdraw amounts", () => {
  const plan = buildLivePlan(example());
  const cfg = example();
  assert.equal(callOf(plan, "withdraw-out").args.amount, cfg.swap.min_amount_out);
  assert.equal(callOf(plan, "withdraw-rest").args.amount, (BigInt(cfg.deposit.amount) - BigInt(cfg.swap.amount_in)).toString());
  assert.equal(stepOf(plan, "delete-vault").actions[0].beneficiary_id, plan.owner_id);
  assert.equal(stepOf(plan, "delete-runner").signer_id, plan.runner_id);
  assert.deepEqual(callOf(plan, "withdraw-ref-storage").args, {});
});

test("every vault method in the plan exists and the example validates clean", () => {
  const plan = buildLivePlan(example());
  for (const s of plan.steps.filter((x) => x.receiver_id === plan.vault_id)) {
    for (const a of s.actions.filter((x) => x.method_name)) assert.ok(spec.methods.has(a.method_name), a.method_name);
  }
  assert.deepEqual(validate(plan), []);
  assert.deepEqual(validateLiveConfig(example(), { allowPlaceholders: true }), []);
});

test("placeholders are problems unless allowed", () => {
  const p = validateLiveConfig(example());
  assert.ok(p.some((x) => /placeholder not filled in: owner_id/.test(x)));
  assert.ok(p.some((x) => /placeholder not filled in: public_keys\.vault/.test(x)));
});

test("mutation: renamed method", () => {
  const plan = planOf();
  callOf(plan, "execute-swap").method_name = "execute_swapp";
  assert.ok(validate(plan).some((p) => /execute_swapp does not exist/.test(p)));
});

test("mutation: dropped and extra args", () => {
  let plan = planOf();
  delete callOf(plan, "withdraw-out").args.amount;
  assert.ok(validate(plan).some((p) => /withdraw: missing argument amount/.test(p)));
  plan = planOf();
  callOf(plan, "withdraw-out").args.extra = "1";
  assert.ok(validate(plan).some((p) => /unexpected argument extra/.test(p)));
  plan = planOf();
  delete callOf(plan, "withdraw-ref-storage").args.amount; // Option<U128>: may be omitted
  assert.deepEqual(validate(plan), []);
});

test("mutation: gas below MIN_WITHDRAW_GAS, and above the per-transaction limit", () => {
  let plan = planOf();
  callOf(plan, "withdraw-out").gas = String(79n * TGAS);
  assert.ok(validate(plan).some((p) => /below MIN_WITHDRAW_GAS/.test(p)));
  plan = planOf();
  callOf(plan, "execute-swap").gas = String(279n * TGAS);
  assert.ok(validate(plan).some((p) => /below MIN_EXECUTE_GAS/.test(p)));
  plan = planOf();
  callOf(plan, "execute-swap").gas = String(MAX_TX_GAS + 1n);
  assert.ok(validate(plan).some((p) => /per-transaction limit/.test(p)));
  plan = planOf();
  callOf(plan, "execute-swap").gas = String(MAX_TX_GAS); // exactly 1 PGas is allowed
  assert.ok(!validate(plan).some((p) => /limit/.test(p)));
});

test("mutation: deposits above the limits", () => {
  let plan = planOf();
  stepOf(plan, "create-vault").actions[1].deposit_yocto = parseNear("9").toString();
  assert.ok(validate(plan).some((p) => /max_deposit_near_per_tx/.test(p)));
  plan = planOf();
  plan.limits.max_total_yocto = parseNear("8").toString();
  assert.ok(validate(plan).some((p) => /max_total_near/.test(p)));
});

test("mutation: 1-yocto rules and payable rules", () => {
  let plan = planOf();
  callOf(plan, "withdraw-out").deposit_yocto = "2";
  assert.ok(validate(plan).some((p) => /withdraw: needs exactly 1 yoctoNEAR, got 2/.test(p)));
  plan = planOf();
  callOf(plan, "execute-swap").deposit_yocto = "1";
  assert.ok(validate(plan).some((p) => /not #\[payable\]/.test(p)));
  plan = planOf();
  callOf(plan, "register-on-ref").deposit_yocto = "0";
  assert.ok(validate(plan).some((p) => /register_on_ref: needs a deposit > 0/.test(p)));
  plan = planOf();
  callOf(plan, "deposit-into-vault").deposit_yocto = "0";
  assert.ok(validate(plan).some((p) => /ft_transfer_call: needs exactly 1/.test(p)));
});

test("mutation: calling a #[private] callback, a view as a tx, a tx as a view", () => {
  let plan = planOf();
  const c = callOf(plan, "execute-swap");
  c.method_name = "on_swap";
  c.args = { swap_id: 0, out: {} };
  assert.ok(validate(plan).some((p) => /on_swap is #\[private\]/.test(p)));
  plan = planOf();
  callOf(plan, "pause").method_name = "get_state";
  assert.ok(validate(plan).some((p) => /get_state is a view method/.test(p)));
  plan = planOf();
  stepOf(plan, "view-state").actions[0].method_name = "pause";
  assert.ok(validate(plan).some((p) => /pause is not a view/.test(p)));
});

test("mutation: wrong signer, unknown external method, bad U128", () => {
  let plan = planOf();
  stepOf(plan, "execute-swap").signer_id = plan.owner_id;
  assert.ok(validate(plan).some((p) => /execute_swap: must be signed by runner/.test(p)));
  plan = planOf();
  callOf(plan, "storage-deposit").method_name = "storage_depositt";
  assert.ok(validate(plan).some((p) => /unknown method storage_depositt/.test(p)));
  plan = planOf();
  callOf(plan, "withdraw-out").args.amount = 5;
  assert.ok(validate(plan).some((p) => /amount must be a decimal string/.test(p)));
});

test("config: structural problems", () => {
  const bad = (mutate, re) => {
    const c = example();
    mutate(c);
    assert.ok(validateLiveConfig(c, { allowPlaceholders: true }).some((p) => re.test(p)), re.toString());
  };
  bad((c) => (c.vault_id = "vault.other.testnet"), /vault_id must be a sub-account/);
  bad((c) => (c.runner_id = c.vault_id), /runner_id must differ from vault_id/);
  bad((c) => (c.agent = "bold"), /agent must be one of/);
  bad((c) => (c.network = "localnet"), /network must be/);
  bad((c) => (c.owner_id = "Owner"), /owner_id must be a valid/);
  bad((c) => (c.surprise = 1), /unknown field surprise/);
  bad((c) => (c.swap.amount_in = "20000000000000000000000"), /amount_in exceeds deposit|hard rules/);
  bad((c) => (c.swap.amount_in = "2000000000000000000000000"), /ERR_MAX_TRADE|exceeds deposit/);
  bad((c) => (c.swap.min_amount_out = "1"), /ERR_PRICE_FLOOR/);
  bad((c) => (c.funding.vault_initial_near = "1.5e3"), /not a NEAR amount/);
  bad((c) => (c.public_keys.vault = "ed25519:abc"), /public_keys\.vault is not a 32-byte/);
  bad((c) => (c.deposit.token_id = "nusdt.ft-fin.testnet"), /in no allowed pool/);
});

test("a filled config with real-looking values validates and uses the given ids", () => {
  const c = example();
  Object.assign(c, { placeholders: false, owner_id: "alice.testnet", vault_id: "vault.alice.testnet", runner_id: "run.alice.testnet", nft_contract_id: "nft.alice.testnet", token_id: "7" });
  c.public_keys = { vault: KEY, runner: KEY };
  assert.deepEqual(validateLiveConfig(c), []);
  const plan = buildLivePlan(c);
  assert.equal(stepOf(plan, "create-vault").actions[2].public_key, KEY);
  assert.deepEqual(validate(plan), []);
});

test("refused: .near ids and mainnet", () => {
  for (const f of ["owner_id", "nft_contract_id"]) {
    const c = example();
    c[f] = "alice.near";
    assert.throws(() => validateLiveConfig(c, { allowPlaceholders: true }), RefusalError);
  }
  const c = example();
  c.network = "mainnet";
  assert.throws(() => validateLiveConfig(c, { allowPlaceholders: true }), /mainnet/);
});

test("refused: private-key-looking fields and values", () => {
  let c = example();
  c.private_key = "x";
  assert.throws(() => validateLiveConfig(c, { allowPlaceholders: true }), (e) => e instanceof RefusalError && !e.message.includes('"x"'));
  for (const name of ["seed_phrase", "secret", "owner_mnemonic"]) {
    c = example();
    c.funding[name] = "x";
    assert.throws(() => validateLiveConfig(c, { allowPlaceholders: true }), RefusalError, name);
  }
  c = example();
  c.public_keys.vault = `ed25519:${"1".repeat(64)}`; // decodes to 64 bytes: a secret key
  assert.throws(() => validateLiveConfig(c, { allowPlaceholders: true }), /longer than a public key/);
  c = example();
  c.public_keys.vault = KEY;
  assert.doesNotThrow(() => validateLiveConfig(c, { allowPlaceholders: true }));
});
