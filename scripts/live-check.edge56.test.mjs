// Refusal and offline-path edges for scripts/live-check.mjs not pinned by live-check.test.mjs,
// live-check.edges.test.mjs or live-check.gaps14.test.mjs. No test touches the network: RPC
// is an injected fetch, and CLI runs go through the no-network preload guard.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { check, RPC_URL } from "./live-check.mjs";
import { runOffline } from "./test-helpers/run-offline.mjs";

const SCRIPT = fileURLToPath(new URL("./live-check.mjs", import.meta.url));
const ENV = { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" };
const text = (r) => r.lines.join("\n");

function spyFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl(calls.length);
  };
  fn.calls = calls;
  return fn;
}
const exists = () => ({ json: async () => ({ result: { amount: "1" } }) });

function cliDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "live-check-edge56-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("CLI --offline with both accounts set makes no network attempt and says why the check was skipped", async (t) => {
  const r = await runOffline([SCRIPT, "--offline"], { env: ENV, cwd: cliDir(t) });
  assert.deepEqual(r.violations, []);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^\[skip\] account existence check skipped: --offline$/m);
  assert.doesNotMatch(r.stdout, /RPC|alice/);
  // the wasm is not built in a temp cwd, so the verdict is "not ready", exit 1
  assert.equal(r.code, r.stdout.includes("ready: yes") ? 0 : 1);
});

test("CLI online with both accounts set: the only attempted request is fetch to the testnet RPC, and it degrades to a skip", async (t) => {
  const r = await runOffline([SCRIPT], { env: ENV, cwd: cliDir(t) });
  assert.equal(r.stderr, "", "a blocked/failed RPC must not print a stack trace");
  assert.equal(r.violations.length, 2, r.violations.join("\n"));
  for (const v of r.violations) assert.match(v, /^NO_NETWORK violation: fetch https:\/\/rpc\.testnet\.near\.org$/);
  assert.equal((r.stdout.match(/RPC unreachable \(offline\?\)$/gm) ?? []).length, 2);
  assert.equal(r.code, r.stdout.includes("ready: yes") ? 0 : 1);
});

test("CLI: a mainnet NEAR_NETWORK is refused (exit 1) and the only RPC ever attempted is the testnet one", async (t) => {
  const r = await runOffline([SCRIPT], { env: { ...ENV, NEAR_NETWORK: "mainnet" }, cwd: cliDir(t) });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^\[todo\] NEAR_NETWORK must be unset or testnet$/m);
  assert.doesNotMatch(r.stdout, /mainnet/);
  for (const v of r.violations) assert.match(v, /fetch https:\/\/rpc\.testnet\.near\.org$/);
});

test("CLI: invalid account env values exit 1, are never echoed, and trigger no network call", async (t) => {
  const bad = { NEAR_ACCOUNT_ID: "Not Valid!!", NEAR_CONTRACT_ACCOUNT_ID: "x".repeat(65) };
  const r = await runOffline([SCRIPT], { env: bad, cwd: cliDir(t) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.violations, []);
  assert.equal((r.stdout.match(/is set but not a valid NEAR account id \(value not shown\)/g) ?? []).length, 2);
  assert.doesNotMatch(r.stdout, /Not Valid|xxxxx/);
  assert.match(r.stdout, /\[skip\] account existence check skipped: no valid account env vars set/);
});

test("CLI: --offline combined with an unknown argument still exits 2 with an empty stdout", async (t) => {
  for (const args of [["--offline", "--bogus"], ["--offline=true"], ["--Offline"]]) {
    const r = await runOffline([SCRIPT, ...args], { env: ENV, cwd: cliDir(t) });
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    assert.match(r.stderr, /^live-check: unknown argument ".+"; the only option is --offline \(see --help\)\n$/);
    assert.deepEqual(r.violations, [], "no RPC before the argument error");
  }
});

test("repeating --offline is accepted and still skips the network", async (t) => {
  const r = await runOffline([SCRIPT, "--offline", "--offline"], { env: ENV, cwd: cliDir(t) });
  assert.notEqual(r.code, 2);
  assert.deepEqual(r.violations, []);
});

test("NEAR_NETWORK is compared exactly: other casings, padding and mainnet values are refused, and only the testnet RPC is used", async () => {
  for (const NEAR_NETWORK of ["Testnet", "TESTNET", " testnet", "testnet ", "mainnet", "near", "localnet"]) {
    const f = spyFetch(exists);
    const r = await check({ ...ENV, NEAR_NETWORK }, { statWasm: () => 1, fetch: f });
    const label = JSON.stringify(NEAR_NETWORK);
    assert.equal(r.ready, false, label);
    assert.ok(r.lines.includes("[todo] NEAR_NETWORK must be unset or testnet"), label);
    assert.ok(f.calls.every((c) => c.url === RPC_URL), label);
  }
});

test("account env values that are blank, padded, upper-case or over 64 chars are rejected without any RPC call", async () => {
  for (const value of [" ", "alice.testnet\n", " alice.testnet", "Alice.testnet", "a".repeat(65), "-alice.testnet", "alice..testnet"]) {
    const f = spyFetch(exists);
    const r = await check({ NEAR_ACCOUNT_ID: value, NEAR_CONTRACT_ACCOUNT_ID: value }, { statWasm: () => 1, fetch: f });
    const label = JSON.stringify(value);
    assert.equal(r.ready, false, label);
    assert.equal(f.calls.length, 0, label);
    assert.ok(r.lines.includes("[todo] NEAR_ACCOUNT_ID is set but not a valid NEAR account id (value not shown)"), label);
    assert.ok(r.lines.includes("[skip] account existence check skipped: no valid account env vars set"), label);
  }
});

test("each account is checked independently: one RPC failure does not hide the other result", async () => {
  const f = spyFetch((n) => {
    if (n === 1) return exists();
    throw new TypeError("fetch failed");
  });
  const r = await check(ENV, { statWasm: () => 1, fetch: f });
  assert.equal(f.calls.length, 2);
  assert.equal(r.ready, true);
  assert.ok(r.lines.includes("[ok]   NEAR_ACCOUNT_ID exists on testnet"));
  assert.ok(r.lines.includes("[skip] account existence check skipped for NEAR_CONTRACT_ACCOUNT_ID: RPC unreachable (offline?)"));
});

test("a null JSON body is treated as an unreachable RPC, not a crash and not a missing account", async () => {
  const r = await check(ENV, { statWasm: () => 1, fetch: async () => ({ json: async () => null }) });
  assert.equal(r.ready, true);
  assert.equal(r.lines.filter((l) => l.includes("RPC unreachable")).length, 2);
  assert.ok(!text(r).includes("does not exist"));
});

test("an RPC error given as a bare string or lower-case code still maps to a missing account", async () => {
  for (const error of ["UNKNOWN_ACCOUNT", "unknown_account", "Account does not exist"]) {
    const r = await check(
      { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "alice.testnet" },
      { statWasm: () => 1, fetch: async () => ({ json: async () => ({ error }) }) },
    );
    assert.equal(r.ready, false, error);
    assert.ok(r.lines.includes("[todo] NEAR_ACCOUNT_ID does not exist on testnet; create it outside this repo"), error);
  }
});

test("the RPC request carries a timeout signal so an unreachable host cannot hang the checklist", async () => {
  const f = spyFetch(exists);
  await check(ENV, { statWasm: () => 1, fetch: f });
  assert.equal(f.calls.length, 2);
  for (const c of f.calls) {
    assert.ok(c.init.signal instanceof AbortSignal);
    assert.equal(c.init.signal.aborted, false);
  }
});

test("without an injected fetch and without a global fetch the existence check is skipped, not crashed", async () => {
  const saved = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const r = await check(ENV, { statWasm: () => 1 });
    assert.ok(r.lines.includes("[skip] account existence check skipped: no fetch available"));
    assert.equal(r.ready, true);
  } finally {
    globalThis.fetch = saved;
  }
});

test("a wasm stat that throws anything (permission error, non-Error value) is a todo with the build hint, not a crash", async () => {
  for (const thrown of [Object.assign(new Error("EACCES"), { code: "EACCES" }), "boom", null]) {
    const r = await check(ENV, {
      statWasm: () => { throw thrown; },
      fetch: async () => assert.fail("not reached for the wasm line"),
      offline: true,
      wasm: "/w.wasm",
    });
    assert.equal(r.ready, false);
    assert.equal(r.lines[0], "[todo] wasm not found at /w.wasm. Run npm run build:contract first.");
  }
});
