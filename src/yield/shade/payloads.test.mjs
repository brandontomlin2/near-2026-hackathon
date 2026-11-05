import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { buildShadePlan, renderShadePlan, SAMPLE_PROPOSAL } from "./plan.mjs";
import {
  RefusalError, buildExecuteSwapAction, buildMpcSignRequest, buildRunnerAuthorization, buildRunnerTx,
} from "./payloads.mjs";
import { VAULT_PROPOSAL_KEYS } from "../proposal.mjs";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
const lib = readFileSync(`${rootDir}contracts/yield-vault/src/lib.rs`, "utf8");
const evidence = readFileSync(`${rootDir}spikes/shade/evidence/testnet-mpc-views.txt`, "utf8");

const contractFns = new Map(); // name -> {payable}
for (const m of lib.matchAll(/((?:\s*#\[[^\]]*\]\s*)*)\s*pub fn (\w+)/g)) contractFns.set(m[2], { payable: /#\[payable\]/.test(m[1]) });
const structBody = /pub struct SwapProposal \{([^}]*)\}/.exec(lib)[1];
const proposalFields = [...structBody.matchAll(/pub (\w+):/g)].map((m) => m[1]);
const minGas = BigInt(/MIN_EXECUTE_GAS: Gas = Gas::from_tgas\((\d+)\)/.exec(lib)[1]) * 1_000_000_000_000n;

describe("contract shape", () => {
  const plan = buildShadePlan();
  it("parsed the contract sanely", () => {
    assert.ok(contractFns.has("execute_swap"));
    assert.deepEqual(proposalFields, ["pool_id", "token_in", "token_out", "amount_in", "min_amount_out"]);
    assert.equal(minGas, 280_000_000_000_000n);
  });
  it("every emitted vault method exists; execute_swap args are {proposal} with the struct fields", () => {
    const calls = [plan.execute_swap.methodName, plan.authorization.addRunner.methodName,
      plan.authorization.revocation.revokeRunner.methodName, plan.authorization.revocation.revokeAllRunners.methodName];
    for (const c of calls) assert.ok(contractFns.has(c), c);
    const action = plan.execute_swap.actions[0];
    assert.deepEqual(Object.keys(action.args), ["proposal"]);
    assert.deepEqual(Object.keys(action.args.proposal).sort(), [...proposalFields].sort());
    assert.deepEqual(plan.execute_swap.actions[0].args.proposal, SAMPLE_PROPOSAL);
  });
  it("gas and deposits match the contract", () => {
    assert.ok(BigInt(plan.execute_swap.actions[0].gas) >= minGas);
    assert.equal(plan.execute_swap.actions[0].deposit, "0");
    assert.equal(contractFns.get("execute_swap").payable, false);
    for (const c of [plan.authorization.addRunner, plan.authorization.revocation.revokeRunner, plan.authorization.revocation.revokeAllRunners]) {
      assert.equal(contractFns.get(c.methodName).payable, true);
      assert.equal(c.deposit, "1");
      assert.equal(c.receiverId, plan.accounts.vault.id);
    }
    assert.deepEqual(plan.authorization.addRunner.args, { runner_id: plan.accounts.executor.id });
    assert.deepEqual(plan.authorization.revocation.revokeAllRunners.args, {});
  });
  it("AddKey is a vault-only execute_swap function-call key with an explicit allowance", () => {
    const a = plan.authorization.executorAddKey.action;
    assert.equal(a.type, "AddKey");
    assert.equal(a.publicKey, plan.derivation.derived_key);
    assert.equal(a.permission.receiverId, plan.accounts.vault.id);
    assert.deepEqual(a.permission.methodNames, ["execute_swap"]);
    assert.match(a.permission.allowance, /^[1-9][0-9]*$/);
  });
});

describe("MPC sign request", () => {
  const plan = buildShadePlan();
  it("has the sign shape and hashes the tx bytes", () => {
    const s = plan.mpc.mpcSign;
    assert.equal(s.receiverId, "v1.signer-prod.testnet");
    assert.equal(s.methodName, "sign");
    assert.deepEqual(Object.keys(s.args), ["request"]);
    assert.deepEqual(Object.keys(s.args.request).sort(), ["domain_id", "path", "payload_v2"]);
    assert.equal(s.args.request.domain_id, 1);
    assert.deepEqual(Object.keys(s.args.request.payload_v2), ["Eddsa"]);
    assert.match(s.args.request.payload_v2.Eddsa, /^[0-9a-f]{64}$/);
    const bytes = Buffer.from(plan.execute_swap.unsignedTxBorshBase64, "base64");
    assert.equal(s.args.request.payload_v2.Eddsa, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(s.deposit, "1");
    assert.ok(BigInt(s.gas) >= 15_000_000_000_000n);
    assert.match(s.gasNote, /UNMEASURED/);
  });
  it("marks the agent-contract call unconfirmed", () => {
    const r = plan.mpc.agentRequestSignature;
    assert.equal(r.confirmed, false);
    assert.match(r.note, /UNCONFIRMED/);
    assert.equal(r.receiverId, plan.accounts.agentContract.id);
    assert.equal(plan.mpc.mpcSign.predecessor, plan.accounts.agentContract.id);
  });
  it("rejects a bad hash", () => {
    assert.throws(() => buildMpcSignRequest({ agentContract: "a.testnet", path: "p", txHash: "abcd" }));
  });
});

describe("derived key", () => {
  it("equals the on-chain value for (yield-agent.testnet, yield-vault-1)", () => {
    const onChain = /predecessor=yield-agent\.testnet path=yield-vault-1 domain_id=1: \{[^}]*"value": "(ed25519:[^"]+)"/.exec(evidence)[1];
    const plan = buildShadePlan({ agentContract: "yield-agent.testnet", path: "yield-vault-1" });
    assert.equal(plan.derivation.derived_key, onChain);
  });
});

describe("borsh sanity", () => {
  it("starts with the executor string and contains receiver and args bytes", () => {
    const plan = buildShadePlan();
    const bytes = Buffer.from(plan.execute_swap.unsignedTxBorshBase64, "base64");
    const ex = plan.accounts.executor.id;
    assert.equal(bytes.readUInt32LE(0), ex.length);
    assert.equal(bytes.subarray(4, 4 + ex.length).toString(), ex);
    assert.ok(bytes.includes(Buffer.from(plan.accounts.vault.id)));
    assert.ok(bytes.includes(Buffer.from(JSON.stringify({ proposal: SAMPLE_PROPOSAL }))));
    assert.ok(bytes.includes(Buffer.from("execute_swap")));
  });
  it("supplied nonce/blockHash change the bytes and drop the placeholder label", () => {
    const base = buildRunnerTx({ executor: "e.testnet", vault: "v.testnet", derivedKey: buildShadePlan().derivation.derived_key, proposal: SAMPLE_PROPOSAL });
    const real = buildRunnerTx({ executor: "e.testnet", vault: "v.testnet", derivedKey: buildShadePlan().derivation.derived_key, proposal: SAMPLE_PROPOSAL, nonce: 77n, blockHash: "8uFVJpEaF5Bwf1caRZSq7TDWgadPA7XYbQdASRAPUgAj" });
    assert.match(base.nonceNote, /PLACEHOLDER/);
    assert.equal(real.nonceNote, "caller supplied");
    assert.notEqual(base.txHashHex, real.txHashHex);
  });
});

describe("proposal validation", () => {
  it("rejects extra and missing keys, including rationale", () => {
    assert.throws(() => buildExecuteSwapAction({ ...SAMPLE_PROPOSAL, rationale: "x" }), /unexpected key/);
    const { pool_id, ...rest } = SAMPLE_PROPOSAL;
    assert.throws(() => buildExecuteSwapAction(rest), /missing key pool_id/);
    assert.deepEqual(Object.keys(buildExecuteSwapAction(SAMPLE_PROPOSAL).args.proposal), VAULT_PROPOSAL_KEYS);
  });
});

describe("refusals", () => {
  const cases = {
    "sign flag": { sign: true },
    "send flag": { send: true },
    "broadcast flag": { broadcast: true },
    privateKey: { privateKey: "FAKEKEY123" },
    secretKey: { secretKey: "FAKEKEY123" },
    seedPhrase: { seedPhrase: "fake words here" },
    "nested secret": { extra: { private_key: "FAKEKEY123" } },
    "network mainnet": { network: "mainnet" },
    "network other": { network: "localnet" },
    "nested network": { x: { network: "mainnet" } },
    ".near executor": { executor: "bob.near" },
    ".near token": { proposal: { ...SAMPLE_PROPOSAL, token_in: "wrap.near" } },
    "non-testnet account": { vault: "vault.example" },
  };
  for (const [name, opts] of Object.entries(cases)) {
    it(`refuses ${name}`, () => {
      assert.throws(() => buildShadePlan(opts), (e) => e instanceof RefusalError && !/FAKEKEY123|fake words/.test(e.message));
    });
  }
  it("refuses NEAR_NETWORK=mainnet", () => {
    assert.throws(() => buildShadePlan({ env: { NEAR_NETWORK: "mainnet" } }), RefusalError);
  });
  it("allows explicit testnet and falsy flags", () => {
    assert.doesNotThrow(() => buildShadePlan({ network: "testnet", sign: false, env: { NEAR_NETWORK: "testnet" } }));
  });
  it("builders refuse .near accounts directly", () => {
    assert.throws(() => buildRunnerAuthorization({ owner: "o.near", vault: "v.testnet", executor: "e.testnet", derivedKey: buildShadePlan().derivation.derived_key }), RefusalError);
  });
});

describe("plan envelope", () => {
  const plan = buildShadePlan();
  it("is a dry run, unsigned, unsent, testnet", () => {
    assert.equal(plan.dry_run, true);
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
    assert.equal(plan.network, "testnet");
    for (const p of [plan.execute_swap, plan.mpc.mpcSign, plan.mpc.agentRequestSignature, plan.authorization.addRunner,
      plan.authorization.executorAddKey, plan.authorization.revocation.deleteKey]) {
      assert.equal(p.signed, false);
      assert.equal(p.sent, false);
    }
    for (const a of Object.values(plan.accounts)) assert.equal(a.status, "placeholder, not deployed");
  });
  it("is deterministic and JSON round-trips", () => {
    const again = buildShadePlan();
    assert.deepEqual(again, plan);
    assert.equal(JSON.stringify(again), JSON.stringify(plan));
    assert.deepEqual(JSON.parse(renderShadePlan(plan)), plan);
  });
});
