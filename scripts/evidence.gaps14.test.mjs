// Behaviour tests for scripts/evidence.mjs that the existing evidence tests do not
// pin: testnet-mode stdout and file shape, tx file handling through main(), the
// usage text, the exit-code split between user and runtime errors, and what a
// failed run leaves on disk. All offline: testnet mode gets a stub fetch, CLI
// runs are mock-mode or fail before any request.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS, DEFAULT_RPC_URL, EvidenceError, loadTransactions, main } from "./evidence.mjs";

const SCRIPT = fileURLToPath(new URL("./evidence.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));
const HASH = "9RQvQyNqF3Jb4cX1hHq7yZkVwP2mT8uLs5aDnEoGfBxC";

const tmp = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "evidence-gaps14-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const rpcOk = (value) => ({
  ok: true,
  json: async () => ({ result: { block_height: 1, block_hash: "B", result: [...Buffer.from(JSON.stringify(value))] } }),
});
const okFetch = () => async (url, init) => {
  const m = JSON.parse(init.body).params.method_name;
  return rpcOk(m === "nft_tokens" ? AGENTS.map((a, i) => ({ token_id: String(i), metadata: { title: a } })) : { sheet_hash: "ab".repeat(32) });
};

// Captures console.log / console.error while main() runs.
async function captured(fn) {
  const logs = [];
  const errs = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  try {
    return { result: await fn(), logs, errs };
  } finally {
    [console.log, console.error] = [log, err];
  }
}

function cli(args, { cwd, env = {} }) {
  const base = { PATH: process.env.PATH, HOME: cwd, NODE_OPTIONS: `--import ${NO_NETWORK}` };
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd, env: { ...base, ...env } });
}

test("testnet main prints one 'wrote <abs path> (testnet)' line and no MOCK banner; mock prints the banner then '(mock)'", async (t) => {
  const dir = tmp(t);
  const net = await captured(() => main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet" }, { cwd: dir, fetchImpl: okFetch() }));
  assert.equal(net.result, 0);
  assert.deepEqual(net.logs, [`wrote ${path.join(dir, "out", "evidence.json")} (testnet)`]);
  assert.deepEqual(net.errs, []);

  const mock = await captured(() => main({}, { cwd: dir, fetchImpl: () => assert.fail("no network") }));
  assert.equal(mock.result, 0);
  assert.equal(mock.logs.length, 2);
  assert.match(mock.logs[0], /^#{64}\n# MOCK EVIDENCE - NOT ON-CHAIN PROOF\s+#\n.*\n#{64}$/);
  assert.equal(mock.logs[1], `wrote ${path.join(dir, "out", "evidence.json")} (mock)`);
});

test("testnet evidence file records contract, default rpc_url, an ISO generated_at and the five views in call order", async (t) => {
  const dir = tmp(t);
  const before = Date.now();
  await captured(() => main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet" }, { cwd: dir, fetchImpl: okFetch() }));
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
  assert.equal(ev.contract, "dev.testnet");
  assert.equal(ev.rpc_url, DEFAULT_RPC_URL);
  assert.match(ev.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(ev.generated_at) >= before - 1000);
  assert.deepEqual(ev.transactions, [], "no EVIDENCE_TX_FILE means an empty list, not a missing key");
  assert.deepEqual(ev.views.map((v) => v.method), ["nft_tokens", "sheet_anchor", "sheet_anchor", "sheet_anchor", "sheet_anchor"]);
  assert.deepEqual(ev.views.slice(1).map((v) => v.args.token_id), ["0", "1", "2", "3"]);
  assert.deepEqual(ev.views[0].args, { from_index: "0", limit: AGENTS.length });
});

test("a tx file wrapped as {transactions: []} yields an empty list and keeps hash/label objects as written", async (t) => {
  const dir = tmp(t);
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, JSON.stringify({ transactions: [] }));
  assert.deepEqual(loadTransactions(empty), []);
  const wrapped = path.join(dir, "wrapped.json");
  fs.writeFileSync(wrapped, JSON.stringify({ network: "testnet", contract: "x.testnet", transactions: [{ label: "deploy", hash: HASH }, HASH] }));
  await captured(() => main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet", EVIDENCE_TX_FILE: wrapped }, { cwd: dir, fetchImpl: okFetch() }));
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
  assert.deepEqual(ev.transactions, [{ label: "deploy", hash: HASH }, { hash: HASH }]);
});

test("loadTransactions names the bad value: a null, number or object-without-hash entry reports 'undefined'; a bad string is quoted", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "t.json");
  for (const [entry, shown] of [[null, "undefined"], [5, "undefined"], [{ label: "x" }, "undefined"], ["short", '"short"'], [{ hash: 42 }, "42"]]) {
    fs.writeFileSync(file, JSON.stringify([entry]));
    assert.throws(() => loadTransactions(file), (e) => e instanceof EvidenceError && e.message === `invalid transaction hash: ${shown}`, JSON.stringify(entry));
  }
});

test("loadTransactions reports a missing file and invalid JSON as 'cannot read tx file <path>: ...'", (t) => {
  const dir = tmp(t);
  const missing = path.join(dir, "nope.json");
  assert.throws(() => loadTransactions(missing), (e) => e instanceof EvidenceError && e.message.startsWith(`cannot read tx file ${missing}: `));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{not json");
  assert.throws(() => loadTransactions(bad), (e) => e instanceof EvidenceError && e.message.startsWith(`cannot read tx file ${bad}: `));
});

test("a bad tx file aborts the run before any request and leaves no evidence file", async (t) => {
  const dir = tmp(t);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify(["nope"]));
  let fetched = 0;
  await assert.rejects(
    main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet", EVIDENCE_TX_FILE: bad }, { cwd: dir, fetchImpl: async () => { fetched += 1; return rpcOk([]); } }),
    EvidenceError,
  );
  assert.equal(fetched, 0);
  assert.ok(!fs.existsSync(path.join(dir, "out")));
});

test("--help documents every environment variable, the default output path and the exit codes; stdout only, exit 0", (t) => {
  const dir = tmp(t);
  const r = cli(["--help"], { cwd: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  for (const name of ["EVIDENCE_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_RPC_URL", "EVIDENCE_TX_FILE", "EVIDENCE_OUT"]) assert.match(r.stdout, new RegExp(`^  ${name} `, "m"));
  assert.ok(r.stdout.includes(DEFAULT_RPC_URL));
  assert.match(r.stdout, /Exits 0 on success, 1 when a view call failed\./);
  assert.deepEqual(fs.readdirSync(dir), [], "help writes nothing");
});

test("a user error exits 2 with '(see --help)'; a runtime failure exits 1 without it", (t) => {
  const dir = tmp(t);
  const user = cli([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet" } });
  assert.equal(user.status, 2);
  assert.equal(user.stderr, "evidence: NEAR_ACCOUNT_ID is required for testnet evidence (see --help)\n");
  assert.equal(user.stdout, "");
  assert.ok(!fs.existsSync(path.join(dir, "out")));

  fs.writeFileSync(path.join(dir, "afile"), "x");
  const runtime = cli([], { cwd: dir, env: { EVIDENCE_OUT: "afile/e.json" } });
  assert.equal(runtime.status, 1);
  assert.doesNotMatch(runtime.stderr, /see --help/);
});

test("process-level mock run: exit 0, writes to EVIDENCE_OUT (nested dirs created), one 'wrote' line after the banner, nothing in out/", (t) => {
  const dir = tmp(t);
  const r = cli([], { cwd: dir, env: { EVIDENCE_OUT: "deep/er/ev.json" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), `wrote ${path.join(dir, "deep/er/ev.json")} (mock)`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "deep/er/ev.json"), "utf8")).network, "mock");
  assert.ok(!fs.existsSync(path.join(dir, "out")));
});

test("view failures: each is one 'view failed: <method>: <error>' stderr line, the file is still written, exit 1; a good view adds none", async (t) => {
  const dir = tmp(t);
  const fetchImpl = async (url, init) => {
    const m = JSON.parse(init.body).params.method_name;
    if (m === "nft_tokens") return rpcOk([{ token_id: "t0", metadata: { title: "Aloof" } }]);
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const run = await captured(() => main({ EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "dev.testnet" }, { cwd: dir, fetchImpl }));
  assert.equal(run.result, 1);
  assert.deepEqual(run.errs, ["view failed: sheet_anchor: HTTP 503"]);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
  assert.equal(ev.views[0].error, undefined);
  assert.equal(ev.views[1].error, "HTTP 503");
  assert.equal(ev.views[1].agent, "Aloof");
});
