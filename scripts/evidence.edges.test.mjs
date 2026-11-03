// Edge-case behaviour tests for scripts/evidence.mjs: tx file loading, view
// calls, testnet agent labelling, env handling and failure reporting.
// Everything is offline: testnet mode always gets a stub fetchImpl.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS, DEFAULT_RPC_URL, EvidenceError, loadTransactions, main, viewCall } from "./evidence.mjs";

const SCRIPT = fileURLToPath(new URL("./evidence.mjs", import.meta.url));
const DROP = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "EVIDENCE_TX_FILE", "NEAR_RPC_URL", "SWARM_ROUNDS"];

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evidence-edges-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function txFile(t, content) {
  const file = path.join(tempDir(t), "txs.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const b58 = (n) => "1".repeat(n);

/** Stub fetch response carrying a contract view result (JSON-encoded as bytes). */
const viewOk = (value) => ({
  ok: true,
  status: 200,
  json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(value))], block_height: 7, block_hash: "BLOCK" } }),
});
const httpFail = (status) => ({ ok: false, status, json: async () => ({}) });
const decodeArgs = (body) => JSON.parse(Buffer.from(JSON.parse(body).params.args_base64, "base64").toString("utf8"));

/** Fetch stub routing by view method; records every call. */
function stubFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const method = JSON.parse(init.body).params.method_name;
    calls.push({ url, method, args: decodeArgs(init.body) });
    return handlers[method](calls.at(-1));
  };
  fn.calls = calls;
  return fn;
}

async function runMain(t, env, fetchImpl) {
  const cwd = tempDir(t);
  const logs = [];
  const errs = [];
  t.mock.method(console, "log", (...a) => logs.push(a.join(" ")));
  t.mock.method(console, "error", (...a) => errs.push(a.join(" ")));
  const code = await main({ EVIDENCE_NETWORK: "testnet", ...env }, { cwd, fetchImpl });
  const file = path.join(cwd, "out/evidence.json");
  return { code, logs, errs, cwd, file, evidence: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}

// ---- loadTransactions ----

test("loadTransactions accepts {transactions}, bare strings and keeps extra fields", (t) => {
  const h = b58(44);
  assert.deepEqual(loadTransactions(txFile(t, { transactions: [h] })), [{ hash: h }]);
  assert.deepEqual(loadTransactions(txFile(t, [h, { hash: h, label: "mint", extra: { n: 1 } }])), [
    { hash: h },
    { hash: h, label: "mint", extra: { n: 1 } },
  ]);
});

test("loadTransactions rejects files that are not an array or {transactions: [...]}", (t) => {
  for (const content of ["{}", '"str"', "42", '{"transactions":"x"}', "null"]) {
    assert.throws(
      () => loadTransactions(txFile(t, content)),
      (err) => err instanceof EvidenceError && /tx file must be an array or \{transactions/.test(err.message),
      content,
    );
  }
});

test("loadTransactions validates hashes: base58, 32 to 64 chars", (t) => {
  const bad = [
    [[{ hash: null }], /invalid transaction hash: null/],
    [["0xabc"], /invalid transaction hash: "0xabc"/],
    [[b58(31)], /invalid transaction hash/],
    [[b58(65)], /invalid transaction hash/],
    [[{ label: "no hash" }], /invalid transaction hash: undefined|invalid transaction hash/],
  ];
  for (const [content, pattern] of bad) {
    assert.throws(() => loadTransactions(txFile(t, content)), (err) => err instanceof EvidenceError && pattern.test(err.message));
  }
  assert.equal(loadTransactions(txFile(t, [b58(32), b58(64)])).length, 2);
});

// ---- viewCall ----

test("viewCall records request details and the right outcome for each response shape", async () => {
  const args = { token_id: "t1", note: "é" };
  const rpcUrl = "https://rpc.example/x";
  const rpc = (json) => ({ ok: true, status: 200, json: async () => json });
  const cases = [
    { name: "http error", res: httpFail(500), error: /^HTTP 500$/, noResult: true, noResponse: true },
    { name: "rpc error object", res: rpc({ error: { code: -1 } }), error: /^RPC error: \{"code":-1\}$/, noResult: true },
    { name: "no result bytes", res: rpc({ result: {} }), error: /no result bytes/, noResult: true },
    { name: "contract error", res: rpc({ result: { result: [], error: "wasm trap" } }), error: /contract error: wasm trap/, noResult: true },
    { name: "non-JSON bytes", res: rpc({ result: { result: [...Buffer.from("not json")] } }), error: /JSON/, noResult: true },
    { name: "success", res: viewOk({ ok: 1 }), result: { ok: 1 }, block_height: 7, block_hash: "BLOCK" },
  ];
  for (const c of cases) {
    const rec = await viewCall({ fetchImpl: async () => c.res, rpcUrl, contract: "c.testnet", method: "m", args, extra: { agent: "Aloof" } });
    const label = c.name;
    assert.equal(rec.method, "m", label);
    assert.equal(rec.agent, "Aloof", label);
    assert.deepEqual(rec.args, args, label);
    assert.equal(rec.request.rpc_url, rpcUrl, label);
    assert.deepEqual(JSON.parse(Buffer.from(rec.request.params.args_base64, "base64").toString("utf8")), args, label);
    if (c.error) assert.match(rec.error, c.error, label);
    else assert.equal(rec.error, undefined, label);
    if (c.noResult) assert.equal("result" in rec, false, label);
    else {
      assert.deepEqual(rec.result, c.result, label);
      assert.equal(rec.block_height, c.block_height, label);
      assert.equal(rec.block_hash, c.block_hash, label);
    }
    if (c.noResponse) assert.equal("response" in rec, false, label);
    else assert.ok(rec.response, `${label}: raw response must be recorded`);
  }
});

test("viewCall turns a thrown fetch into record.error", async () => {
  const rec = await viewCall({ fetchImpl: async () => { throw new Error("offline"); }, rpcUrl: "u", contract: "c", method: "m", args: {} });
  assert.equal(rec.error, "offline");
  assert.equal("result" in rec, false);
});

// ---- testnet evidence via main ----

test("a non-array nft_tokens result makes exactly one fetch and exits 0", async (t) => {
  const f = stubFetch({ nft_tokens: () => viewOk({ not: "an array" }), sheet_anchor: () => assert.fail("must not be called") });
  const r = await runMain(t, { NEAR_ACCOUNT_ID: "alice.testnet" }, f);
  assert.equal(r.code, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(r.evidence.views.length, 1);
  assert.deepEqual(r.errs, []);
});

test("6 tokens produce only 4 sheet_anchor calls, and agents are labelled by title then position", async (t) => {
  const tokens = [
    { token_id: "t0", metadata: { title: "The Skeptic of the swarm" } },
    { token_id: "t1" },
    { token_id: "t2", metadata: { description: "a social butterfly" } },
    { token_id: "t3", metadata: { title: "plain" } },
    { token_id: "t4" },
    { token_id: "t5" },
  ];
  const f = stubFetch({ nft_tokens: () => viewOk(tokens), sheet_anchor: () => viewOk({ anchored: true }) });
  const r = await runMain(t, { NEAR_ACCOUNT_ID: "alice.testnet" }, f);
  assert.equal(r.code, 0);
  const anchors = f.calls.filter((c) => c.method === "sheet_anchor");
  assert.equal(anchors.length, AGENTS.length);
  assert.deepEqual(anchors.map((c) => c.args.token_id), ["t0", "t1", "t2", "t3"]);
  assert.equal(f.calls.length, 1 + AGENTS.length);
  // Title match wins over position; otherwise AGENTS[index].
  assert.deepEqual(r.evidence.views.slice(1).map((v) => v.agent), ["Skeptic", "Chaotic", "Social", "Skeptic"]);
});

test("NEAR_RPC_URL is used for fetch and recorded; empty falls back to the default", async (t) => {
  const handlers = { nft_tokens: () => viewOk([]) };
  const custom = stubFetch(handlers);
  const a = await runMain(t, { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_RPC_URL: "https://rpc.example/custom" }, custom);
  assert.equal(custom.calls[0].url, "https://rpc.example/custom");
  assert.equal(a.evidence.rpc_url, "https://rpc.example/custom");
  const dflt = stubFetch(handlers);
  const b = await runMain(t, { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_RPC_URL: "" }, dflt);
  assert.equal(dflt.calls[0].url, DEFAULT_RPC_URL);
  assert.equal(DEFAULT_RPC_URL, "https://rpc.testnet.near.org");
  assert.equal(b.evidence.rpc_url, DEFAULT_RPC_URL);
});

test("testnet account ids: alice.testnet and sub.alice.testnet pass; a bare 'near' is accepted by the current regex; alice.near is refused", async (t) => {
  for (const id of ["alice.testnet", "sub.alice.testnet", "near"]) {
    const f = stubFetch({ nft_tokens: () => viewOk([]) });
    const r = await runMain(t, { NEAR_ACCOUNT_ID: id }, f);
    assert.equal(r.code, 0, id);
    assert.equal(r.evidence.contract, id);
  }
  const f = stubFetch({});
  await assert.rejects(runMain(t, { NEAR_ACCOUNT_ID: "alice.near" }, f), /refusing a mainnet-looking account id/);
  assert.equal(f.calls.length, 0);
});

test("a failing sheet_anchor view exits 1, still writes the file and reports one stderr line", async (t) => {
  const f = stubFetch({ nft_tokens: () => viewOk([{ token_id: "t0" }]), sheet_anchor: () => httpFail(500) });
  const r = await runMain(t, { NEAR_ACCOUNT_ID: "alice.testnet" }, f);
  assert.equal(r.code, 1);
  assert.ok(r.evidence, "evidence file must still be written");
  assert.equal(r.evidence.views[1].error, "HTTP 500");
  assert.deepEqual(r.errs, ["view failed: sheet_anchor: HTTP 500"]);
  assert.match(r.logs.at(-1), /^wrote .*evidence\.json \(testnet\)$/);
});

// ---- mock mode ----

test("mock mode ignores NEAR_ACCOUNT_ID, EVIDENCE_TX_FILE and NEAR_RPC_URL and never fetches", async (t) => {
  const cwd = tempDir(t);
  t.mock.method(console, "log", () => {});
  const code = await main(
    { NEAR_ACCOUNT_ID: "alice.near", EVIDENCE_TX_FILE: "does-not-exist.json", NEAR_RPC_URL: "https://never.example" },
    { cwd, fetchImpl: () => assert.fail("mock mode must not fetch") },
  );
  assert.equal(code, 0);
  const ev = JSON.parse(fs.readFileSync(path.join(cwd, "out/evidence.json"), "utf8"));
  assert.equal(ev.mock, true);
  assert.equal(ev.contract, "mock-contract.testnet");
  assert.equal("rpc_url" in ev, false);
});

test("EVIDENCE_OUT (relative) is resolved against cwd; out/evidence.json is not created", (t) => {
  const cwd = tempDir(t);
  const env = { ...process.env, MOCK_INFERENCE: "1", EVIDENCE_OUT: "custom/ev.json" };
  for (const k of DROP) if (k !== "EVIDENCE_OUT") delete env[k];
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const out = path.join(cwd, "custom/ev.json");
  assert.ok(r.stdout.endsWith(`wrote ${out} (mock)\n`), r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).mock, true);
  assert.equal(fs.existsSync(path.join(cwd, "out")), false);
});
