import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashSheet } from "../src/anchor/hash.mjs";
import { createMockClient } from "../src/inference/client.mjs";
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

test("RPC URL credentials, path, query and fragment never reach evidence.json; only the origin is recorded", async () => {
  const dir = tmp();
  const calls = [];
  // Review M-2: the key sits in the path for the common paid providers (Alchemy /v2/<key>,
  // Infura /v3/<key>, QuickNode /<token>/), so the path must go too, not only userinfo and query.
  const secretUrl = "https://user:hunter2@near-testnet.rpc.example:8443/v2/PATH-KEY/?apiKey=SECRET-KEY#frag";
  const code = await main(
    { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet", NEAR_RPC_URL: secretUrl },
    { cwd: dir, fetchImpl: stubFetch(calls) },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((c) => c.url === secretUrl), "the request itself still goes to the full URL");
  const raw = fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8");
  for (const secret of ["hunter2", "PATH-KEY", "/v2", "SECRET-KEY", "apiKey", "frag", "user:"]) {
    assert.ok(!raw.includes(secret), `${secret} leaked into evidence.json`);
  }
  const ev = JSON.parse(raw);
  assert.equal(ev.rpc_url, "https://near-testnet.rpc.example:8443", "origin only: scheme, host and a non-default port");
  assert.ok(ev.views.every((v) => v.request.rpc_url === "https://near-testnet.rpc.example:8443"));
});

test("provider-style URLs with the key in the path record the origin only", async () => {
  const cases = [
    ["https://near-testnet.g.alchemy.com/v2/ALCHEMY-KEY", "https://near-testnet.g.alchemy.com"],
    ["https://near-testnet.infura.example/v3/INFURA-KEY", "https://near-testnet.infura.example"],
    ["https://cool-name.near-testnet.quiknode.example/QUICK-TOKEN/", "https://cool-name.near-testnet.quiknode.example"],
  ];
  for (const [url, origin] of cases) {
    const dir = tmp();
    const calls = [];
    const code = await main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet", NEAR_RPC_URL: url }, { cwd: dir, fetchImpl: stubFetch(calls) });
    assert.equal(code, 0, url);
    assert.ok(calls.every((c) => c.url === url), `${url}: the request goes to the full URL`);
    const raw = fs.readFileSync(path.join(dir, "out/evidence.json"), "utf8");
    assert.ok(!/KEY|TOKEN/.test(raw), `${url}: the path key leaked into evidence.json`);
    assert.equal(JSON.parse(raw).rpc_url, origin, url);
  }
});

test("the contract account comes from NEAR_CONTRACT_ACCOUNT_ID, with NEAR_ACCOUNT_ID as the fallback", async () => {
  // Review (judge screen 12, item 4): deploy treats NEAR_ACCOUNT_ID as the signer and
  // NEAR_CONTRACT_ACCOUNT_ID as the contract; evidence must query the same account.
  const split = tmp();
  const splitCalls = [];
  let code = await main(
    { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "owner.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.owner.testnet" },
    { cwd: split, fetchImpl: stubFetch(splitCalls) },
  );
  assert.equal(code, 0);
  assert.ok(splitCalls.every((c) => c.account === "nft.owner.testnet"), "every view queries the contract account, never the signer");
  assert.equal(JSON.parse(fs.readFileSync(path.join(split, "out/evidence.json"), "utf8")).contract, "nft.owner.testnet");

  const fallback = tmp();
  const fallbackCalls = [];
  code = await main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "owner.testnet", NEAR_CONTRACT_ACCOUNT_ID: "" }, { cwd: fallback, fetchImpl: stubFetch(fallbackCalls) });
  assert.equal(code, 0);
  assert.ok(fallbackCalls.every((c) => c.account === "owner.testnet"), "unset or empty NEAR_CONTRACT_ACCOUNT_ID falls back to NEAR_ACCOUNT_ID");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fallback, "out/evidence.json"), "utf8")).contract, "owner.testnet");

  // The error names the variable the value came from; the signer being valid does not rescue a bad contract.
  const noFetch = () => assert.fail("must refuse before fetching");
  await assert.rejects(
    main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "owner.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.near" }, { cwd: tmp(), fetchImpl: noFetch }),
    (err) => err instanceof EvidenceError && /^NEAR_CONTRACT_ACCOUNT_ID must be a named \.testnet account/.test(err.message) && !err.message.includes("nft.near"),
  );
  await assert.rejects(
    main({ EVIDENCE_NETWORK: "testnet" }, { cwd: tmp(), fetchImpl: noFetch }),
    (err) => err instanceof EvidenceError && err.message === "NEAR_CONTRACT_ACCOUNT_ID (or NEAR_ACCOUNT_ID) is required for testnet evidence",
  );
});

test("testnet mode refuses non-testnet RPC endpoints and account ids before any fetch, without echoing them", async () => {
  const dir = tmp();
  const noFetch = () => assert.fail("must refuse before fetching");
  const base = { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet" };
  const refused = (value) => (err) => err instanceof EvidenceError && !err.message.includes(value);
  for (const url of [
    "https://rpc.mainnet.near.org",
    "https://rpc.near.org",
    "http://rpc.testnet.near.org",
    "https://rpc.testnet.near.org.mainnet.example",
    "https://mainnet-testnet.example",
    "not a url",
  ]) {
    await assert.rejects(main({ ...base, NEAR_RPC_URL: url }, { cwd: dir, fetchImpl: noFetch }), refused(url), `url ${JSON.stringify(url)}`);
  }
  for (const id of ["x.near", "dev.testnet.near", "ab".repeat(32), "dev.testnet ", "DEV.testnet", "dev.testnet.evil"]) {
    await assert.rejects(main({ ...base, NEAR_ACCOUNT_ID: id }, { cwd: dir, fetchImpl: noFetch }), refused(id), `id ${JSON.stringify(id)}`);
  }
  // The bare top-level account is refused too (the word "testnet" legitimately appears in the message).
  await assert.rejects(main({ ...base, NEAR_ACCOUNT_ID: "testnet" }, { cwd: dir, fetchImpl: noFetch }), EvidenceError);
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
  const loop = await runMemoryLoop({ swarm, client: createMockClient() });
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
