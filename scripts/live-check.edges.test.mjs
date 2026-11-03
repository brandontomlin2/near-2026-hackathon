import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { check, RPC_URL } from "./live-check.mjs";
import { defaultWasmPath } from "./testnet-deploy.mjs";
import { runOffline } from "./test-helpers/run-offline.mjs";

const SCRIPT = fileURLToPath(new URL("./live-check.mjs", import.meta.url));
const ENV = { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" };
const exists = async () => ({ json: async () => ({ result: { amount: "1" } }) });
const missing = async () => ({ json: async () => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }) });
const text = (r) => r.lines.join("\n");

function spyFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl();
  };
  fn.calls = calls;
  return fn;
}

test("CLI with no account env: not ready, no network attempted, no stderr", async () => {
  const r = await runOffline([SCRIPT], { env: {} });
  assert.equal(r.code, 1);
  assert.deepEqual(r.violations, []);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /\[todo\] NEAR_ACCOUNT_ID is not set/);
  assert.match(
    r.stdout,
    /\[todo\] NEAR_CONTRACT_ACCOUNT_ID is not set \(deploy --send will not default it to NEAR_ACCOUNT_ID\)/,
  );
  assert.match(r.stdout, /\[skip\] account existence check skipped: no valid account env vars set/);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), "ready: no. Fix the [todo] items above.");
  assert.match(lines[0], /^\[(ok| {2}|todo)\s*\]?.*wasm/);
  assert.match(lines[0], /\.wasm/);
});

test("empty wasm file is a todo with the build hint", async () => {
  const r = await check(ENV, { statWasm: () => 0, fetch: exists, wasm: "/w.wasm" });
  assert.equal(r.ready, false);
  assert.ok(r.lines.includes("[todo] wasm is empty at /w.wasm. Run npm run build:contract first."));
});

test("same account for owner and contract, missing on chain: both lines are todo, two RPC calls", async () => {
  const f = spyFetch(missing);
  const r = await check(
    { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "alice.testnet" },
    { statWasm: () => 1, fetch: f, wasm: "/w.wasm" },
  );
  assert.equal(r.ready, false);
  assert.ok(r.lines.includes("[todo] NEAR_ACCOUNT_ID does not exist on testnet; create it outside this repo"));
  assert.ok(r.lines.includes("[todo] NEAR_CONTRACT_ACCOUNT_ID does not exist on testnet; create it outside this repo"));
  assert.ok(!text(r).includes("[note]"));
  assert.equal(f.calls.length, 2);
});

test("RPC error text containing 'does not exist' counts as missing", async () => {
  const f = async () => ({ json: async () => ({ error: { data: "account alice.testnet does not exist while viewing" } }) });
  const r = await check(ENV, { statWasm: () => 1, fetch: f });
  assert.equal(r.ready, false);
  assert.match(text(r), /\[todo\] NEAR_ACCOUNT_ID does not exist on testnet/);
  assert.match(text(r), /\[note\] NEAR_CONTRACT_ACCOUNT_ID does not exist/);
  assert.ok(!text(r).includes("RPC unreachable"));
});

test("only valid accounts are viewed, with the exact RPC request shape", async () => {
  const f = spyFetch(async () => ({ json: async () => ({ result: {} }) }));
  const r = await check(
    { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "BAD VALUE!" },
    { statWasm: () => 1, fetch: f },
  );
  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.url, "https://rpc.testnet.near.org");
  assert.equal(RPC_URL, "https://rpc.testnet.near.org");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.body.method, "query");
  assert.equal(call.body.params.request_type, "view_account");
  assert.equal(call.body.params.finality, "final");
  assert.equal(call.body.params.account_id, "alice.testnet");
  assert.equal(r.ready, false);
  assert.ok(!text(r).includes("alice.testnet"));
  assert.ok(!text(r).includes("BAD VALUE"));
});

test("NEAR_NETWORK=testnet is ok; empty string counts as unset", async () => {
  for (const NEAR_NETWORK of ["testnet", ""]) {
    const r = await check({ ...ENV, NEAR_NETWORK }, { statWasm: () => 1, fetch: exists });
    assert.ok(r.lines.includes("[ok]   NEAR_NETWORK is unset or testnet"), `NEAR_NETWORK=${JSON.stringify(NEAR_NETWORK)}`);
    assert.equal(r.ready, true);
  }
});

test("a non-JSON RPC body is treated as unreachable and stays ready", async () => {
  const f = async () => ({ json: async () => { throw new SyntaxError("Unexpected token <"); } });
  const r = await check(ENV, { statWasm: () => 1, fetch: f });
  assert.equal(r.ready, true);
  const skips = r.lines.filter((l) => l.startsWith("[skip]"));
  assert.equal(skips.length, 2);
  for (const s of skips) assert.match(s, /RPC unreachable \(offline\?\)$/);
});

test("ready case prints exactly 7 lines in stable order", async () => {
  const r = await check(ENV, { statWasm: () => 10, fetch: exists, wasm: "/w.wasm" });
  assert.equal(r.ready, true);
  assert.deepEqual(r.lines, [
    "[ok]   wasm built: /w.wasm (10 bytes)",
    "[ok]   NEAR_ACCOUNT_ID is set",
    "[ok]   NEAR_CONTRACT_ACCOUNT_ID is set",
    "[ok]   NEAR_NETWORK is unset or testnet",
    "[ok]   NEAR_ACCOUNT_ID exists on testnet",
    "[ok]   NEAR_CONTRACT_ACCOUNT_ID exists on testnet",
    "ready: yes. Next: npm run live-proof (dry run), then the owner hosts the four SVGs and adds --send --i-approve --media-base <url>.",
  ]);
});

// Privacy audit L-4: `npm run live:check` output lands in pull requests. The wasm line
// must name the repo-relative path, never the absolute one with the home directory.
test("CLI from the repo root prints the repo-relative wasm path and no home directory", async () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const r = await runOffline([SCRIPT], { env: {}, cwd: repoRoot });
  const [wasmLine] = r.stdout.split("\n");
  assert.match(wasmLine, /^\[(ok|todo)\] +wasm (built|not found at|is empty at)[: ]+contracts\/personality-nft\/target\/near\/personality_nft\.wasm[ .]/);
  assert.ok(!r.stdout.includes(homedir()), `home directory leaked: ${wasmLine}`);
  assert.ok(!r.stdout.includes(repoRoot.replace(/\/$/, "")), `absolute repo path leaked: ${wasmLine}`);
});

test("check() without an injected wasm uses the same default the deploy CLI prints", async () => {
  const r = await check(ENV, { statWasm: () => 7, fetch: exists });
  assert.equal(r.lines[0], `[ok]   wasm built: ${defaultWasmPath()} (7 bytes)`);
});
