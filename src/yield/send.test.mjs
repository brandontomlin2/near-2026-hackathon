import { test } from "node:test";
import assert from "node:assert/strict";

import { RefusalError, assertNotMainnet, assertSendAllowed, buildExecuteSwapArgv, formatCommand, isMainnetAccountId } from "./send.mjs";

const GOOD = { NEAR_NETWORK: "testnet", YIELD_VAULT_ACCOUNT_ID: "vault.x.testnet", YIELD_RUNNER_ACCOUNT_ID: "runner.x.testnet" };
const OK = { approve: true, agent: "skeptic" };

const PROPOSAL = {
  pool_id: 1,
  token_in: "nusdt.ft-fin.testnet",
  token_out: "nusdc.ft-fin.testnet",
  amount_in: "10000",
  min_amount_out: "9900",
  rationale: "it's a 'quoted' rationale",
};

function refusal(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof RefusalError, `expected RefusalError, got ${e}`);
    return e;
  }
  assert.fail("expected a RefusalError");
}

test("assertNotMainnet refuses NEAR_NETWORK=mainnet in any case or padding", () => {
  for (const v of ["mainnet", "MAINNET", "  Mainnet  ", "\tmainnet\n"]) {
    const e = refusal(() => assertNotMainnet({ NEAR_NETWORK: v }));
    assert.equal(e.exitCode, 1);
  }
});

test("assertNotMainnet refuses vault or runner ids ending in .near", () => {
  refusal(() => assertNotMainnet({ ...GOOD, YIELD_VAULT_ACCOUNT_ID: "vault.near" }));
  refusal(() => assertNotMainnet({ ...GOOD, YIELD_RUNNER_ACCOUNT_ID: "runner.NEAR" }));
  refusal(() => assertNotMainnet({ ...GOOD, YIELD_RUNNER_ACCOUNT_ID: " runner.near " }));
});

test("assertNotMainnet passes for testnet and for an empty env", () => {
  assertNotMainnet(GOOD);
  assertNotMainnet({});
  assertNotMainnet({ NEAR_NETWORK: "testnet" });
});

test("assertSendAllowed passes with everything set", () => {
  assertSendAllowed(GOOD, OK);
});

test("assertSendAllowed refuses without approve (exit 2) and without agent (exit 2)", () => {
  assert.equal(refusal(() => assertSendAllowed(GOOD, { approve: false, agent: "skeptic" })).exitCode, 2);
  assert.equal(refusal(() => assertSendAllowed(GOOD, { approve: true, agent: undefined })).exitCode, 2);
  assert.equal(refusal(() => assertSendAllowed(GOOD, { approve: true, agent: "" })).exitCode, 2);
});

test("assertSendAllowed refuses when NEAR_NETWORK is unset or not testnet", () => {
  const { NEAR_NETWORK, ...unset } = GOOD;
  assert.equal(refusal(() => assertSendAllowed(unset, OK)).exitCode, 1);
  for (const v of ["", "localnet", "Testnet", "mainnet"]) refusal(() => assertSendAllowed({ ...GOOD, NEAR_NETWORK: v }, OK));
});

test("assertSendAllowed refuses missing, invalid or non-.testnet vault and runner ids", () => {
  for (const name of ["YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]) {
    const bad = [undefined, "", "Not Valid!", "x", "vault.example.com", "vault.testnet.evil", "vault.near"];
    for (const v of bad) {
      const env = { ...GOOD, [name]: v };
      if (v === undefined) delete env[name];
      refusal(() => assertSendAllowed(env, OK));
    }
  }
});

test("refusal messages never contain the account id values", () => {
  const secretVault = "secretvault.example.com";
  const secretRunner = "secretrunner.x.near";
  const cases = [
    { ...GOOD, YIELD_VAULT_ACCOUNT_ID: secretVault },
    { ...GOOD, YIELD_RUNNER_ACCOUNT_ID: secretRunner },
    { ...GOOD, YIELD_VAULT_ACCOUNT_ID: secretVault, NEAR_NETWORK: "mainnet" },
    { ...GOOD, YIELD_VAULT_ACCOUNT_ID: "bad id", YIELD_RUNNER_ACCOUNT_ID: "bad runner" },
  ];
  for (const env of cases) {
    const e = refusal(() => assertSendAllowed(env, OK));
    for (const v of [env.YIELD_VAULT_ACCOUNT_ID, env.YIELD_RUNNER_ACCOUNT_ID]) assert.ok(!e.message.includes(v), `message leaks ${v}: ${e.message}`);
  }
});

test("buildExecuteSwapArgv targets testnet execute_swap with the vault, runner and proposal json", () => {
  const argv = buildExecuteSwapArgv({ vault: "vault.x.testnet", runner: "runner.x.testnet", proposal: PROPOSAL });
  assert.ok(argv.includes("execute_swap"));
  assert.ok(argv.includes("vault.x.testnet"));
  assert.ok(argv.includes("runner.x.testnet"));
  assert.equal(argv[argv.indexOf("network-config") + 1], "testnet");
  assert.equal(argv[argv.indexOf("sign-as") + 1], "runner.x.testnet");
  assert.ok(!argv.some((a) => /mainnet/i.test(a)));
  const args = JSON.parse(argv[argv.indexOf("json-args") + 1]);
  assert.deepEqual(Object.keys(args), ["proposal"]);
  assert.equal(args.proposal.pool_id, 1);
  assert.equal(args.proposal.amount_in, "10000");
  assert.equal(args.proposal.min_amount_out, "9900");
  assert.ok(!("rationale" in args.proposal), "rationale is not a vault arg");
});

test("formatCommand shell-quotes the json args and leaves plain words bare", () => {
  const argv = buildExecuteSwapArgv({ vault: "vault.x.testnet", runner: "runner.x.testnet", proposal: { ...PROPOSAL } });
  const cmd = formatCommand(argv);
  assert.ok(cmd.startsWith("near contract call-function as-transaction vault.x.testnet execute_swap json-args '"));
  const json = JSON.stringify({ proposal: { pool_id: 1, token_in: PROPOSAL.token_in, token_out: PROPOSAL.token_out, amount_in: "10000", min_amount_out: "9900" } });
  assert.ok(cmd.includes(`'${json}'`));
  assert.ok(cmd.includes("prepaid-gas '280.0 Tgas'"));
  assert.equal(formatCommand(["a", "it's"]), "near a 'it'\\''s'");
});

test("L1: assertSendAllowed refuses vault === runner", () => {
  const same = { ...GOOD, YIELD_RUNNER_ACCOUNT_ID: GOOD.YIELD_VAULT_ACCOUNT_ID };
  assert.match(refusal(() => assertSendAllowed(same, OK)).message, /different accounts/);
});

test("isMainnetAccountId is the shared .near predicate", () => {
  assert.equal(isMainnetAccountId("a.near"), true);
  assert.equal(isMainnetAccountId(" A.NEAR "), true);
  assert.equal(isMainnetAccountId("a.testnet"), false);
  assert.equal(isMainnetAccountId("near"), false);
  assert.equal(isMainnetAccountId("a.near.testnet"), false);
  assert.equal(isMainnetAccountId(undefined), false);
});
