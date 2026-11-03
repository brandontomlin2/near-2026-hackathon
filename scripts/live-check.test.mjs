import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "./live-check.mjs";

const ENV = { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" };
const exists = async () => ({ json: async () => ({ result: { amount: "1" } }) });
const missing = async () => ({ json: async () => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }) });
const offline = async () => { throw new Error("network down"); };
const noFetch = async () => { throw new Error("fetch must not be called"); };
const text = (r) => r.lines.join("\n");

test("ready when wasm built, env set, accounts exist", async () => {
  const r = await check(ENV, { statWasm: () => 1234, fetch: exists, wasm: "/w.wasm" });
  assert.equal(r.ready, true);
  assert.match(text(r), /wasm built: \/w\.wasm \(1234 bytes\)/);
  assert.match(text(r), /ready: yes/);
});

test("missing wasm and env give a checklist and not ready, without echoing values", async () => {
  const r = await check({}, {
    statWasm: () => { throw new Error("ENOENT"); }, fetch: noFetch, wasm: "/w.wasm",
  });
  assert.equal(r.ready, false);
  assert.match(text(r), /wasm not found at \/w\.wasm\. Run npm run build:contract first\./);
  assert.match(text(r), /NEAR_ACCOUNT_ID is not set/);
  assert.match(text(r), /NEAR_CONTRACT_ACCOUNT_ID is not set/);
  assert.match(text(r), /skipped: no valid account env vars/);
});

test("invalid account id and wrong network are flagged and values never printed", async () => {
  const r = await check(
    { NEAR_ACCOUNT_ID: "BAD VALUE!", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet", NEAR_NETWORK: "mainnet-secret" },
    { statWasm: () => 1, fetch: exists },
  );
  assert.equal(r.ready, false);
  assert.ok(!text(r).includes("BAD VALUE"));
  assert.ok(!text(r).includes("mainnet-secret"));
  assert.ok(!text(r).includes("nft.alice.testnet"));
  assert.match(text(r), /NEAR_NETWORK must be unset or testnet/);
});

test("--offline skips the account existence check without calling fetch, and says so", async () => {
  const r = await check(ENV, { statWasm: () => 1, fetch: noFetch, offline: true });
  assert.equal(r.ready, true);
  assert.match(text(r), /\[skip\] account existence check skipped: --offline/);
  assert.ok(!text(r).includes("alice.testnet"));
});

test("offline RPC skips the existence check cleanly and stays ready", async () => {
  const r = await check(ENV, { statWasm: () => 1, fetch: offline });
  assert.equal(r.ready, true);
  assert.match(text(r), /RPC unreachable/);
});

test("owner account missing on chain is not ready; fresh contract account is only a note", async () => {
  const r = await check(ENV, { statWasm: () => 1, fetch: missing });
  assert.equal(r.ready, false);
  assert.match(text(r), /NEAR_ACCOUNT_ID does not exist/);
  assert.match(text(r), /\[note\] NEAR_CONTRACT_ACCOUNT_ID does not exist/);
});

test("non-unknown-account RPC error skips the existence check, stays ready, and never prints values", async () => {
  const limited = async () => ({ json: async () => ({ error: { message: "rate limited" } }) });
  const r = await check(ENV, { statWasm: () => 1, fetch: limited });
  assert.equal(r.ready, true);
  assert.match(text(r), /RPC unreachable/);
  assert.ok(!text(r).includes("alice.testnet"));
});

test("RPC body with neither error nor result is treated as a missing account", async () => {
  const empty = async () => ({ json: async () => ({}) });
  const r = await check(ENV, { statWasm: () => 1, fetch: empty });
  assert.equal(r.ready, false);
  assert.match(text(r), /NEAR_ACCOUNT_ID does not exist/);
});
