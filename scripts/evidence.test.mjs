import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashSheet } from "../src/anchor/hash.mjs";
import { runMemoryLoop } from "../src/memory/loop.mjs";
import { runSwarm } from "../src/swarm/runner.mjs";
import { AGENTS, EvidenceError, loadTransactions, main, mockEvidence } from "./evidence.mjs";

const HASH = "9RQvQyNqF3Jb4cX1hHq7yZkVwP2mT8uLs5aDnEoGfBxC";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "evidence-test-"));
const rpcOk = (value) => ({
  ok: true,
  json: async () => ({
    jsonrpc: "2.0",
    id: "evidence",
    result: { block_height: 7, block_hash: "BLOCK", logs: [], result: [...Buffer.from(JSON.stringify(value))] },
  }),
});

function stubFetch(calls) {
  const tokens = AGENTS.map((a, i) => ({ token_id: String(i + 1), owner_id: "dev.testnet", metadata: { title: a } }));
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const args = JSON.parse(Buffer.from(body.params.args_base64, "base64"));
    calls.push({ url, method: body.params.method_name, args, account: body.params.account_id });
    if (body.params.method_name === "nft_tokens") return rpcOk(tokens);
    return rpcOk({ sheet_hash: "ab".repeat(32), memory_depth: 2, updated_at: "5" });
  };
}

test("mock mode writes labeled placeholders and no real-looking hashes", async () => {
  const dir = tmp();
  const code = await main({}, { cwd: dir, fetchImpl: () => assert.fail("no network in mock") });
  assert.equal(code, 0);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8"));
  assert.equal(ev.mock, true);
  assert.deepEqual(ev, await mockEvidence());
  for (const tx of ev.transactions) {
    assert.equal(tx.mock, true);
    assert.match(tx.hash, /^MOCK-/);
    assert.doesNotMatch(tx.hash, /^[1-9A-HJ-NP-Za-km-z]{32,}$/);
  }
  assert.equal(ev.views.length, 8);
  assert.ok(ev.views.every((v) => v.mock === true));
});

test("mock evidence carries the full memory loop, linked to the swarm final hash", async () => {
  const ev = await mockEvidence();
  const loop = ev.memory_loop;
  assert.equal(loop.mock, true);
  assert.match(loop.label, /^MOCK/);
  assert.deepEqual(loop.flow, ["swarm", "summary sheet hash", "anchor_sheet dry-run per token", "final round hash"]);
  const expected = (await runSwarm({ rounds: 5, seed: 1 })).roundHashes.at(-1);
  assert.equal(loop.swarm.final_round_hash, expected);
  assert.equal(loop.tokens.length, 4);
  for (const t of loop.tokens) {
    assert.equal(t.anchor.status, "dry-run");
    assert.equal(t.anchor.transaction_hash, null);
    assert.equal(t.anchor.args.sheet_hash, t.sheet.sheet_hash);
    assert.equal(t.anchor.linked_round_hash, expected);
  }
  assert.deepEqual(ev.views.filter((v) => v.method === "sheet_anchor").map((v) => v.args.token_id), loop.tokens.map((t) => t.token_id));
});

test("mock evidence hashes the same stand-in sheets npm run swarm writes, so the two agree hash for hash", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = tmp();
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  delete env.NEAR_AI_API_KEY;
  await promisify(execFile)(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "swarm.mjs"), "--rounds", "5", "--seed", "1", "--out", dir], { env });
  const ev = await mockEvidence();
  for (const t of ev.memory_loop.tokens) {
    const written = JSON.parse(fs.readFileSync(path.join(dir, "sheets", `${t.token_id}.json`), "utf8"));
    assert.equal(t.sheet.sheet_hash, written.sheetHash, `${t.token_id}: evidence and npm run swarm anchor different sheets`);
    assert.equal(t.sheet.sheet_hash, hashSheet(written.sheet));
    assert.match(written.sheet, /Public enemy #1:/, `${t.token_id}: the evidence sheet is a character sheet, not a generic mock line`);
    assert.deepEqual(t.sheets.map((s) => s.sheet_hash), (await Promise.all(t.sheets.map(async (s) =>
      JSON.parse(fs.readFileSync(path.join(dir, "sheets", `${t.token_id}.round-${s.round}.json`), "utf8")).sheetHash))));
  }
});

test("mock runs are byte-identical, print the MOCK banner and never fetch", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  const outs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const dir = tmp();
      assert.equal(await main({}, { cwd: dir, fetchImpl: () => assert.fail("no network in mock") }), 0);
      outs.push(fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8"));
    }
  } finally {
    console.log = origLog;
  }
  assert.equal(outs[0], outs[1]);
  const printed = lines.join("\n");
  assert.match(printed, /MOCK EVIDENCE - NOT ON-CHAIN PROOF/);
  assert.match(printed, /dry-run only: nothing signed, nothing sent, no chain queried/);
});

test("testnet mode makes only view calls and records responses and tx hashes", async () => {
  const dir = tmp();
  const txFile = path.join(dir, "txs.json");
  fs.writeFileSync(txFile, JSON.stringify([{ hash: HASH, label: "mint" }]));
  const calls = [];
  const code = await main(
    { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet", EVIDENCE_TX_FILE: txFile },
    { cwd: dir, fetchImpl: stubFetch(calls) },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls.map((c) => c.method), ["nft_tokens", ...Array(4).fill("sheet_anchor")]);
  assert.ok(calls.every((c) => c.account === "dev.testnet" && c.url.includes("testnet")));
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8"));
  assert.equal(ev.network, "testnet");
  assert.equal(ev.mock, false);
  assert.deepEqual(ev.transactions, [{ hash: HASH, label: "mint" }]);
  assert.deepEqual(ev.views.slice(1).map((v) => v.agent), AGENTS);
  assert.equal(ev.views[1].result.memory_depth, 2);
  assert.equal(ev.views[1].block_height, 7);
  assert.ok(ev.views[1].response.result.result.length > 0);
});

test("a failing view is recorded and exits nonzero", async () => {
  const dir = tmp();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { name: "HANDLER_ERROR" } }) });
  const origErr = console.error;
  console.error = () => {};
  const code = await main(
    { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet" },
    { cwd: dir, fetchImpl },
  ).finally(() => {
    console.error = origErr;
  });
  assert.equal(code, 1);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8"));
  assert.match(ev.views[0].error, /RPC error/);
});

test("rejects bad input", async () => {
  const dir = tmp();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify(["not-a-hash"]));
  assert.throws(() => loadTransactions(bad), EvidenceError);
  await assert.rejects(main({ EVIDENCE_NETWORK: "testnet" }, { cwd: dir }), /NEAR_ACCOUNT_ID/);
  await assert.rejects(main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "x.near" }, { cwd: dir }), /mainnet/);
  await assert.rejects(main({ EVIDENCE_NETWORK: "mainnet" }, { cwd: dir }), /must be mock or testnet/);
});

test("evidence covers every sheet, each with its own anchor dry-run", async () => {
  const ev = await mockEvidence();
  const { swarm, tokens } = ev.memory_loop;
  assert.ok(swarm.every >= 1);
  for (const t of tokens) {
    assert.ok(t.sheets.length >= 1);
    assert.equal(t.sheets.at(-1).sheet_hash, t.sheet.sheet_hash);
    for (const s of t.sheets) {
      assert.equal(s.anchor.args.sheet_hash, s.sheet_hash);
      assert.equal(s.anchor.status, "dry-run");
      assert.equal(s.anchor.linked_round_hash, swarm.round_hashes[s.round - 1]);
    }
  }
});

test("one sheet hash: sheet record, anchor_sheet dry-run args and evidence.json agree", async () => {
  const swarm = await runSwarm({ rounds: 5, seed: 1 });
  // No client: the loop's default sheet writer (the counting stand-in), which is what mock evidence uses.
  const loop = await runMemoryLoop({ swarm });
  const ev = await mockEvidence();
  assert.equal(ev.memory_loop.tokens.length, loop.tokens.length);
  for (const [i, t] of loop.tokens.entries()) {
    const e = ev.memory_loop.tokens[i];
    assert.equal(t.sheet.sheetHash, hashSheet(t.sheet.sheet));
    assert.equal(t.anchor.args.sheet_hash, t.sheet.sheetHash);
    assert.equal(e.anchor.args.sheet_hash, t.sheet.sheetHash);
    assert.equal(e.sheet.sheet_hash, t.sheet.sheetHash);
  }
});
