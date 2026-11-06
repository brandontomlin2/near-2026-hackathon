import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_WALLET,
  GRANT_DEPOSIT_YOCTO,
  WalletError,
  createWalletLedger,
  nearToYocto,
  prepareWalletCall,
  simulateDemoWallets,
  toYocto,
} from "./wallet.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";

const base = { contractId: "personality-nft.demo.testnet", network: "testnet", tokenId: "chaotic" };
const code = (c) => (err) => err instanceof WalletError && err.code === c;

test("nearToYocto and toYocto convert exactly", () => {
  assert.equal(nearToYocto("1"), "1000000000000000000000000");
  assert.equal(nearToYocto("0.001"), "1000000000000000000000");
  assert.equal(nearToYocto("0.000000000000000000000001"), "1");
  assert.throws(() => nearToYocto("-1"), code("bad_amount"));
  assert.throws(() => nearToYocto("1e3"), code("bad_amount"));
  assert.equal(toYocto("42"), 42n);
  for (const bad of ["", "01", "-1", "1.5", 1, null, (1n << 128n).toString()]) {
    assert.throws(() => toYocto(bad), code("bad_amount"), String(bad));
  }
});

test("prepareWalletCall builds each method with the contract's deposit rules", () => {
  const dep = prepareWalletCall({ ...base, kind: "deposit", amountYocto: "5", memo: "tip" });
  assert.deepEqual(
    { m: dep.methodName, a: dep.args, d: dep.depositYocto, s: dep.signing },
    { m: "wallet_deposit", a: { token_id: "chaotic", memo: "tip" }, d: "5", s: "required" },
  );
  const send = prepareWalletCall({ ...base, kind: "send", receiverId: "bob.demo.testnet", amountYocto: "7" });
  assert.deepEqual([send.methodName, send.depositYocto], ["wallet_send", "1"]);
  assert.deepEqual(send.args, { token_id: "chaotic", receiver_id: "bob.demo.testnet", amount: "7" });
  const grant = prepareWalletCall({ ...base, kind: "setAgent", agentId: "runner.testnet", payeeId: "infer.testnet", allowanceYocto: "100" });
  assert.deepEqual([grant.methodName, grant.depositYocto], ["wallet_set_agent", GRANT_DEPOSIT_YOCTO]);
  assert.deepEqual(grant.args, { token_id: "chaotic", agent_id: "runner.testnet", payee_id: "infer.testnet", allowance: "100" });
  const pay = prepareWalletCall({ ...base, kind: "agentPay", amountYocto: "3", memo: "inference" });
  assert.deepEqual([pay.methodName, pay.depositYocto], ["wallet_agent_pay", "0"]);
  const revoke = prepareWalletCall({ ...base, kind: "revokeAgent" });
  assert.deepEqual([revoke.methodName, revoke.depositYocto, revoke.args], ["wallet_revoke_agent", "1", { token_id: "chaotic" }]);
  assert.ok(Object.isFrozen(pay) && Object.isFrozen(pay.args));
});

test("prepareWalletCall refuses mainnet, bad ids, zero amounts and the contract as receiver", () => {
  assert.throws(() => prepareWalletCall({ ...base, network: "mainnet", kind: "deposit", amountYocto: "1" }), code("network_refused"));
  assert.throws(() => prepareWalletCall({ ...base, tokenId: "Bad.Id", kind: "deposit", amountYocto: "1" }), code("bad_token"));
  assert.throws(() => prepareWalletCall({ ...base, contractId: "x", kind: "deposit", amountYocto: "1" }), code("bad_account"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "deposit", amountYocto: "0" }), code("bad_amount"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "agentPay", amountYocto: "0" }), code("bad_amount"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "send", receiverId: base.contractId, amountYocto: "1" }), code("bad_account"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "setAgent", agentId: "a.testnet", payeeId: base.contractId, allowanceYocto: "1" }), code("bad_account"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "deposit", amountYocto: "1", memo: "x".repeat(257) }), code("bad_memo"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "steal" }), code("bad_kind"));
  assert.throws(() => prepareWalletCall({ ...base, kind: "deposit", amountYocto: "1", gas: "30 Tgas" }), code("bad_config"));
});

test("ledger mirrors the contract: owner spends, agent pays within allowance and balance", () => {
  const l = createWalletLedger({ owners: { chaotic: "alice.testnet" } });
  assert.equal(l.deposit("chaotic", "100"), "100");
  assert.throws(() => l.send("chaotic", "eve.testnet", "1"), code("not_owner"));
  assert.equal(l.send("chaotic", "alice.testnet", "10"), "90");
  assert.throws(() => l.agentPay("chaotic", "runner.testnet", "1"), code("no_grant"));
  l.setAgent("chaotic", "alice.testnet", { agentId: "runner.testnet", payeeId: "infer.testnet", allowanceYocto: "30" });
  assert.throws(() => l.agentPay("chaotic", "eve.testnet", "1"), code("not_agent"));
  assert.throws(() => l.agentPay("chaotic", "runner.testnet", "31"), code("allowance"));
  assert.deepEqual(l.agentPay("chaotic", "runner.testnet", "30"), { balance: "60", payeeId: "infer.testnet" });
  assert.throws(() => l.agentPay("chaotic", "runner.testnet", "1"), code("allowance"));
  l.setAgent("chaotic", "alice.testnet", { agentId: "runner.testnet", payeeId: "infer.testnet", allowanceYocto: "1000" });
  assert.throws(() => l.agentPay("chaotic", "runner.testnet", "61"), code("insufficient"));
  assert.throws(() => l.send("chaotic", "alice.testnet", "0"), code("bad_amount"));
  assert.throws(() => l.deposit("ghost", "1"), code("unknown_token"));
  assert.equal(l.view("ghost"), null);
});

test("ledger: the wallet moves with the token and the old owner's grant stops", () => {
  const l = createWalletLedger({ owners: { chaotic: "alice.testnet" } });
  l.deposit("chaotic", "50");
  l.setAgent("chaotic", "alice.testnet", { agentId: "runner.testnet", payeeId: "infer.testnet", allowanceYocto: "50" });
  l.transfer("chaotic", "alice.testnet", "bob.testnet");
  assert.deepEqual(l.view("chaotic"), { token_id: "chaotic", owner_id: "bob.testnet", balance: "50", agent: null });
  assert.throws(() => l.agentPay("chaotic", "runner.testnet", "1"), code("stale_grant"));
  assert.throws(() => l.send("chaotic", "alice.testnet", "1"), code("not_owner"));
  assert.equal(l.send("chaotic", "bob.testnet", "50"), "0");
});

test("demo wallets: every token pays for its own inference, replies earn tips, wallets move on transfer", async () => {
  const run = await runSwarm({ rounds: 6, seed: 1 });
  const sheetRounds = Object.fromEntries(AGENTS.map((a) => [a.id, [3, 6]]));
  const w = simulateDemoWallets({ contractId: base.contractId, agents: AGENTS, events: run.events, sheetRounds, rounds: 6 });
  assert.equal(w.signed, false);
  assert.ok(w.calls.every((c) => c.status === "dry-run" && c.transactionHash === null));
  const replies = new Map(AGENTS.map((a) => [a.id, 0]));
  const byId = new Map(run.events.map((e) => [e.id, e]));
  for (const e of run.events) if (e.kind === "reply") replies.set(byId.get(e.replyTo).agentId, replies.get(byId.get(e.replyTo).agentId) + 1);
  for (const t of w.tokens) {
    const spoken = run.events.filter((e) => e.agentId === t.tokenId).length;
    assert.equal(t.paidCount, spoken + 2, t.tokenId);
    assert.equal(BigInt(t.inferenceYocto), BigInt(DEMO_WALLET.postPriceYocto) * BigInt(spoken) + 2n * BigInt(DEMO_WALLET.sheetPriceYocto));
    assert.equal(t.tipCount, replies.get(t.tokenId), t.tokenId);
    assert.equal(BigInt(t.balanceYocto), BigInt(t.startYocto) + BigInt(t.tipsYocto) - BigInt(t.inferenceYocto));
    assert.equal(BigInt(t.allowanceLeftYocto), BigInt(DEMO_WALLET.allowanceYocto) - BigInt(t.inferenceYocto));
    assert.equal(t.entries.at(-1).balanceYocto, t.balanceYocto);
    assert.deepEqual(t.afterTransfer, { owner: "bob.demo.testnet", balanceYocto: t.balanceYocto, agentActive: false, staleGrantRefused: true });
  }
  // The most replied-to token earns more in tips than its thinking costs.
  const chaotic = w.tokens.find((t) => t.tokenId === "chaotic");
  assert.ok(BigInt(chaotic.tipsYocto) > BigInt(chaotic.inferenceYocto));
  // Same inputs, same bytes.
  const again = simulateDemoWallets({ contractId: base.contractId, agents: AGENTS, events: run.events, sheetRounds, rounds: 6 });
  assert.equal(JSON.stringify(again), JSON.stringify(w));
});
