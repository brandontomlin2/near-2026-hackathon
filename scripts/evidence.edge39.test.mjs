// edge39: user-visible edge paths of scripts/evidence.mjs (CLI and main()).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "./evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "evidence.mjs");

function run(args, { cwd, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of ["EVIDENCE_NETWORK", "EVIDENCE_OUT", "EVIDENCE_TX_FILE", "NEAR_CONTRACT_ACCOUNT_ID", "NEAR_ACCOUNT_ID", "NEAR_RPC_URL"]) delete base[k];
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, env: { ...base, ...env }, timeout: 120000 });
}

describe("evidence.mjs CLI edges", () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence edge39-")); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("--help and -h print usage, exit 0, write nothing", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run([flag], { cwd: dir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^Usage: node scripts\/evidence\.mjs/);
      assert.match(r.stdout, /EVIDENCE_NETWORK/);
      assert.equal(r.stderr, "");
    }
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("an unknown argument exits 2 with one line and writes nothing", () => {
    const r = run(["--bogus"], { cwd: dir });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stderr, /^evidence: unknown argument "--bogus"; this script takes no options \(see --help\)/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("bad EVIDENCE_NETWORK exits 2 with a clear message", () => {
    const r = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "mainnet" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /EVIDENCE_NETWORK must be mock or testnet, got mainnet \(see --help\)/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("testnet without a contract account exits 2 naming the variable", () => {
    const r = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /NEAR_CONTRACT_ACCOUNT_ID \(or NEAR_ACCOUNT_ID\) is required for testnet evidence/);
    assert.doesNotMatch(r.stderr, /undefined/);
  });

  it("testnet refuses a mainnet account and a mainnet RPC without echoing the RPC value", () => {
    const a = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.near" } });
    assert.equal(a.status, 2);
    const b = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.testnet", NEAR_RPC_URL: "https://rpc.mainnet.near.org/KEYSENTINEL" } });
    assert.equal(b.status, 2);
    assert.doesNotMatch(b.stderr, /KEYSENTINEL/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("an unparsable NEAR_RPC_URL exits 2 without echoing it", () => {
    const r = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.testnet", NEAR_RPC_URL: "not a url SENTINEL" } });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /SENTINEL/);
    assert.match(r.stderr, /NEAR_RPC_URL/);
  });

  for (const [name, content, re] of [
    ["empty", "", /cannot read tx file/],
    ["malformed JSON", "{oops", /cannot read tx file/],
    ["a JSON object without transactions", "{}", /tx file must be an array/],
    ["a bad hash", '["not-a-hash!"]', /invalid transaction hash/],
    ["an entry with no hash", '[{"label":"x"}]', /invalid transaction hash: undefined/],
  ]) {
    it(`EVIDENCE_TX_FILE ${name} exits 2 and writes no evidence`, () => {
      const f = path.join(dir, "tx.json");
      fs.writeFileSync(f, content);
      const r = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.testnet", EVIDENCE_TX_FILE: f } });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, re);
      assert.equal(fs.existsSync(path.join(dir, "out")), false);
    });
  }

  it("a missing EVIDENCE_TX_FILE exits 2", () => {
    const r = run([], { cwd: dir, env: { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.testnet", EVIDENCE_TX_FILE: path.join(dir, "nope.json") } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read tx file/);
  });

  it("EVIDENCE_OUT that is an existing directory exits 1 with a clean message", () => {
    const d = path.join(dir, "adir");
    fs.mkdirSync(d);
    const r = run([], { cwd: dir, env: { EVIDENCE_OUT: d } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^evidence: cannot write /);
    assert.doesNotMatch(r.stderr, /undefined|\n\s+at /);
  });

  it("EVIDENCE_OUT under a regular file exits 1 with a clean message", () => {
    const f = path.join(dir, "afile");
    fs.writeFileSync(f, "x");
    const r = run([], { cwd: dir, env: { EVIDENCE_OUT: path.join(f, "e.json") } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^evidence: cannot write /);
    assert.doesNotMatch(r.stderr, /undefined|\n\s+at /);
  });

  it("mock mode: banner, wrote line, exit 0, mock hashes, no real-looking tx", () => {
    const r = run([], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /MOCK EVIDENCE - NOT ON-CHAIN PROOF/);
    assert.match(r.stdout, /wrote .*out[\\/]evidence\.json \(mock\)\n$/);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
    assert.equal(ev.mock, true);
    assert.equal(ev.network, "mock");
    assert.deepEqual(ev.transactions.map((t) => t.hash), ["MOCK-deploy", "MOCK-mint", "MOCK-anchor_sheet"]);
    assert.equal(ev.views.length, 8);
  });
});

describe("evidence main() with a stubbed fetch", () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence main39-")); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { EVIDENCE_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "foo.testnet" };

  it("an RPC outage is recorded, main returns 1, evidence is still written", async () => {
    const fetchImpl = async () => { throw new Error("connect ECONNREFUSED"); };
    const code = await main(env, { fetchImpl, cwd: dir });
    assert.equal(code, 1);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
    assert.equal(ev.mock, false);
    assert.match(ev.views[0].error, /ECONNREFUSED/);
  });

  it("an empty token list yields one view, exit 0", async () => {
    const bytes = [...Buffer.from("[]")];
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ result: { result: bytes, block_height: 1, block_hash: "h" } }) });
    const code = await main(env, { fetchImpl, cwd: dir });
    assert.equal(code, 0);
    const ev = JSON.parse(fs.readFileSync(path.join(dir, "out", "evidence.json"), "utf8"));
    assert.equal(ev.views.length, 1);
    assert.deepEqual(ev.views[0].result, []);
  });

  it("an HTTP 500 is reported as a failed view", async () => {
    const code = await main(env, { fetchImpl: async () => ({ ok: false, status: 500 }), cwd: dir });
    assert.equal(code, 1);
  });
});
