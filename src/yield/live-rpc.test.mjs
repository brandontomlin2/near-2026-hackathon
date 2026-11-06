import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLivePlan, loadLiveConfig } from "./live-plan.mjs";
import { DEFAULT_RPC, MAX_REQUESTS, NO_CODE_HASH, RpcError, assertReadOnlyRequest, assertRpcUrl, createRpc, onlineChecks } from "./live-rpc.mjs";

const EXAMPLE = new URL("../../config/yield-vault.live.example.json", import.meta.url);
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const REF = "ref-finance-101.testnet";
const WNEAR = "wrap.testnet";
const RFT = "rft.tokenfactory.testnet";
const USDC = "usdc.fakes.testnet";
const USDT = "usdt.fakes.testnet";

const filled = () => {
  const c = loadLiveConfig(EXAMPLE);
  Object.assign(c, { placeholders: false, owner_id: "alice.testnet", vault_id: "vault.alice.testnet", runner_id: "run.alice.testnet", nft_contract_id: "nft.alice.testnet", token_id: "7" });
  c.public_keys = { vault: KEY, runner: KEY };
  return c;
};

/** The old personality-agent shape (chaotic vault, wNEAR -> rft on pool 0), to keep that path covered. */
const chaoticFilled = () => {
  const c = filled();
  delete c.vault_profile;
  Object.assign(c, { agent: "chaotic", deposit: { token_id: WNEAR, amount: "20000000000000000000000" } });
  c.swap = { pool_id: 0, token_in: WNEAR, token_out: RFT, amount_in: "10000000000000000000000", min_amount_out: "50000000" };
  return c;
};

/** A fake fetch over canned chain state. Records every request. `state` entries can be overridden per test. */
function fakeChain(over = {}) {
  const state = {
    accounts: { "wrap.testnet": { code_hash: "x", amount: "1" }, [REF]: { code_hash: "5Uk3VqDvSyGkS5pE8eWqjR9zVfXk2QxJf8cYhFZ9pQd1", amount: "1" }, "alice.testnet": { amount: (50n * 10n ** 24n).toString(), code_hash: NO_CODE_HASH } },
    views: {
      [`${REF}:storage_balance_bounds`]: { min: "1020000000000000000000", max: null },
      [`${REF}:get_whitelisted_tokens`]: [USDC, USDT, WNEAR, RFT, "nusdt.ft-fin.testnet"],
      // pool 747 reserves from src/yield/fixtures/ref-testnet-pools.json
      [`${REF}:get_pool`]: { token_account_ids: [USDC, USDT], amounts: ["4976689", "5108251"], pool_kind: "SIMPLE_POOL" },
      [`${USDC}:ft_metadata`]: { decimals: 6 },
      [`${USDT}:ft_metadata`]: { decimals: 6 },
      [`${WNEAR}:ft_metadata`]: { decimals: 24 },
      [`${RFT}:ft_metadata`]: { decimals: 6 },
      [`${USDC}:storage_balance_bounds`]: { min: "1250000000000000000000" },
      [`${USDT}:storage_balance_bounds`]: { min: "1250000000000000000000" },
      [`${WNEAR}:storage_balance_bounds`]: { min: "1250000000000000000000" },
      [`${RFT}:storage_balance_bounds`]: { min: "1250000000000000000000" },
    },
    ...over,
  };
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const p = body.params;
    if (p.request_type === "view_account") {
      const a = state.accounts[p.account_id];
      return a ? ok({ ...a, block_height: 1 }) : { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }) };
    }
    const key = `${p.account_id}:${p.method_name}`;
    if (!(key in state.views)) return { ok: true, status: 200, json: async () => ({ result: { error: `wasm execution failed: method ${p.method_name} not found` } }) };
    return ok({ result: [...Buffer.from(JSON.stringify(state.views[key]))], logs: [] });
  };
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", result }) });
  return { fetch, calls, state };
}

const run = async (config, chain) => {
  const rpc = createRpc({ fetch: chain.fetch });
  return { checks: await onlineChecks(config, buildLivePlan(config), rpc), rpc };
};
const find = (checks, re) => checks.find((c) => re.test(c.name));

test("assertReadOnlyRequest accepts only query/call_function|view_account with finality final", () => {
  const good = { method: "query", params: { request_type: "call_function", finality: "final", account_id: "a.testnet", method_name: "m", args_base64: "e30=" } };
  assert.doesNotThrow(() => assertReadOnlyRequest(good));
  assert.doesNotThrow(() => assertReadOnlyRequest({ method: "query", params: { request_type: "view_account", finality: "final", account_id: "a.testnet" } }));
  const bad = (mutate) => {
    const b = structuredClone(good);
    mutate(b);
    assert.throws(() => assertReadOnlyRequest(b), /refused: not a read-only RPC request/);
  };
  bad((b) => (b.method = "broadcast_tx_commit"));
  bad((b) => (b.method = "send_tx"));
  bad((b) => (b.params.request_type = "view_access_key"));
  bad((b) => (b.params.request_type = "view_state"));
  bad((b) => (b.params.finality = "optimistic"));
  bad((b) => delete b.params.finality);
  bad((b) => (b.params.block_id = "123"));
  bad((b) => (b.params.args_base64 = 5));
  assert.throws(() => assertReadOnlyRequest({ method: "query", params: { request_type: "view_account", finality: "final", account_id: "a", args_base64: "e30=" } }), /unexpected param/);
  assert.throws(() => assertReadOnlyRequest({}), /refused/);
});

test("assertRpcUrl: https only, never mainnet", () => {
  assert.equal(assertRpcUrl(DEFAULT_RPC), "https://test.rpc.fastnear.com/");
  assert.throws(() => assertRpcUrl("http://test.rpc.fastnear.com"), /https/);
  assert.throws(() => assertRpcUrl("https://rpc.mainnet.near.org"), /mainnet/);
  assert.throws(() => assertRpcUrl("https://example.com/MAINNET"), /mainnet/);
  for (const host of ["rpc.mainnet.near.org", "free.rpc.fastnear.com", "rpc.mainnet.fastnear.com", "mainnet.example.org"]) {
    assert.throws(() => assertRpcUrl(`https://${host}`), /mainnet/, host);
  }
  assert.throws(() => assertRpcUrl("nonsense"), /valid URL/);
  assert.throws(() => createRpc({ url: "http://x.test" }), /https/);
});

test("requests are exactly query/call_function with base64 args, content-type only, with a timeout signal", async () => {
  const chain = fakeChain();
  const rpc = createRpc({ fetch: chain.fetch });
  const out = await rpc.view(REF, "get_pool", { pool_id: 0 });
  assert.equal(out.pool_kind, "SIMPLE_POOL");
  await rpc.account(REF);
  const [call, acct] = chain.calls;
  assert.equal(call.url, "https://test.rpc.fastnear.com/");
  assert.deepEqual(call.body, { jsonrpc: "2.0", id: "yield-live", method: "query", params: { request_type: "call_function", finality: "final", account_id: REF, method_name: "get_pool", args_base64: Buffer.from('{"pool_id":0}').toString("base64") } });
  assert.deepEqual(acct.body.params, { request_type: "view_account", finality: "final", account_id: REF });
  for (const c of chain.calls) {
    assert.deepEqual(Object.keys(c.init.headers), ["content-type"]);
    assert.equal(c.init.method, "POST");
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  assert.equal(rpc.requests, 2);
});

test("unknown account resolves to null; other RPC errors throw; the request budget is enforced", async () => {
  const chain = fakeChain();
  const rpc = createRpc({ fetch: chain.fetch, maxRequests: 3 });
  assert.equal(await rpc.account("ghost.testnet"), null);
  await assert.rejects(rpc.view(REF, "no_such_method", {}), (e) => e instanceof RpcError);
  await rpc.account(REF);
  await assert.rejects(rpc.account(REF), /request budget of 3 exhausted/);
  assert.equal(MAX_REQUESTS, 20);
  const failing = createRpc({ fetch: async () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }); }, timeoutMs: 5 });
  await assert.rejects(failing.account(REF), /timeout after 5 ms/);
  const http = createRpc({ fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(http.account(REF), /HTTP 503/);
});

test("online checks all PASS against a consistent testnet, within the request budget", async () => {
  const { checks, rpc } = await run(filled(), fakeChain());
  const bad = checks.filter((c) => !["PASS", "MANUAL"].includes(c.status));
  assert.deepEqual(bad, []);
  assert.match(find(checks, /Ref exchange has code/).detail, /code_hash/);
  assert.match(find(checks, new RegExp(`token ${USDC}`)).detail, /decimals 6/);
  assert.match(find(checks, new RegExp(`token ${USDT}`)).detail, /decimals 6/);
  assert.equal(checks.filter((c) => /^online: token /.test(c.name)).length, 2, "only the swap pair is checked, not every token of every allowed pool");
  assert.match(find(checks, /Ref pool matches/).detail, /pool 747 tokens match, reserves \[4976689, 5108251\], amount_in is 1% of the token_in reserve/);
  assert.match(find(checks, /owner account funded/).detail, /balance 50 NEAR, needs 9\.505/);
  assert.ok(checks.some((c) => c.status === "MANUAL" && /not checkable read-only/.test(c.name)));
  assert.ok(rpc.requests <= MAX_REQUESTS, `${rpc.requests} requests`);
});

test("online checks: the placeholder example skips owner/vault/runner with a WARN", async () => {
  const { checks } = await run(loadLiveConfig(EXAMPLE), fakeChain());
  assert.match(find(checks, /owner account funded/).detail, /skipped: owner_id is a placeholder/);
  assert.equal(find(checks, /owner account funded/).status, "WARN");
  assert.match(find(checks, /vault_id not created/).detail, /skipped/);
  assert.equal(find(checks, /Ref exchange has code/).status, "PASS");
});

test("online checks: Ref without code, high storage bounds, missing whitelist", async () => {
  let chain = fakeChain();
  chain.state.accounts[REF] = { code_hash: NO_CODE_HASH, amount: "1" };
  assert.equal(find((await run(filled(), chain)).checks, /Ref exchange has code/).status, "FAIL");
  chain = fakeChain();
  delete chain.state.accounts[REF];
  assert.match(find((await run(filled(), chain)).checks, /Ref exchange has code/).detail, /does not exist/);
  chain = fakeChain();
  chain.state.views[`${REF}:storage_balance_bounds`] = { min: "600000000000000000000000" };
  assert.equal(find((await run(filled(), chain)).checks, /Ref storage_balance_bounds/).status, "FAIL");
  chain = fakeChain();
  chain.state.views[`${REF}:get_whitelisted_tokens`] = [USDC];
  const w = find((await run(filled(), chain)).checks, /whitelists/);
  assert.equal(w.status, "FAIL");
  assert.match(w.detail, new RegExp(USDT));
  assert.doesNotMatch(w.detail, new RegExp(USDC.replaceAll(".", "\\.")));
  // Tokens of the vault's other allowed pools are not needed: whitelisting just the pair passes.
  chain = fakeChain();
  chain.state.views[`${REF}:get_whitelisted_tokens`] = [USDC, USDT];
  assert.equal(find((await run(filled(), chain)).checks, /whitelists/).status, "PASS");
  // The old personality-agent shape checks wNEAR and rft instead.
  chain = fakeChain();
  chain.state.views[`${REF}:get_whitelisted_tokens`] = [WNEAR];
  const wc = find((await run(chaoticFilled(), chain)).checks, /whitelists/);
  assert.equal(wc.status, "FAIL");
  assert.match(wc.detail, new RegExp(RFT));
});

test("online checks: pool pair, empty reserves and a large swap", async () => {
  let chain = fakeChain();
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [USDT, USDC], amounts: ["5108251", "4976689"] };
  assert.equal(find((await run(filled(), chain)).checks, /Ref pool matches/).status, "PASS", "either order is fine");
  chain = fakeChain();
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [USDC, "nusdt.ft-fin.testnet"], amounts: ["1", "1"] };
  assert.equal(find((await run(filled(), chain)).checks, /Ref pool matches/).status, "FAIL");
  chain = fakeChain();
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [USDC, USDT], amounts: ["0", "5"] };
  assert.match(find((await run(filled(), chain)).checks, /Ref pool matches/).detail, /empty reserves/);
  chain = fakeChain();
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [USDC, USDT], amounts: ["5000000", "5000000"] }; // amount_in 50000 = 1% of the token_in reserve exactly
  const heavy = find((await run(filled(), chain)).checks, /Ref pool matches/);
  assert.equal(heavy.status, "PASS", "exactly 1% is not above 1%");
  chain.state.views[`${REF}:get_pool`].amounts[0] = "4900000";
  const over = find((await run(filled(), chain)).checks, /Ref pool matches/);
  assert.equal(over.status, "WARN");
  assert.match(over.detail, /above 1%/);
});

test("online checks: the old chaotic pool-0 shape still checks wNEAR / rft", async () => {
  const chain = fakeChain();
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [WNEAR, RFT], amounts: ["1000000000000000000000000000", "5000000000000"], pool_kind: "SIMPLE_POOL" };
  const { checks } = await run(chaoticFilled(), chain);
  assert.deepEqual(checks.filter((c) => !["PASS", "MANUAL"].includes(c.status)), []);
  assert.match(find(checks, new RegExp(`token ${WNEAR}`)).detail, /decimals 24/);
  assert.match(find(checks, new RegExp(`token ${RFT}`)).detail, /decimals 6/);
  assert.equal(find(checks, new RegExp(`token ${USDC}`)), undefined);
  assert.match(find(checks, /Ref pool matches/).detail, /pool 0 tokens match/);
  assert.match(find(checks, /owner account funded/).detail, /needs 9\.525/);
  chain.state.views[`${REF}:get_pool`] = { token_account_ids: [WNEAR, RFT], amounts: ["1000000000000000000000000", "5000000000000"] };
  assert.equal(find((await run(chaoticFilled(), chain)).checks, /Ref pool matches/).status, "PASS", "exactly 1% (0.01 of 1 NEAR)");
  chain.state.views[`${REF}:get_pool`].amounts[0] = "900000000000000000000000";
  assert.equal(find((await run(chaoticFilled(), chain)).checks, /Ref pool matches/).status, "WARN");
});

test("online checks: token storage bounds, owner funding and existing accounts", async () => {
  let chain = fakeChain();
  chain.state.views[`${USDT}:storage_balance_bounds`] = { min: "9000000000000000000000" };
  assert.equal(find((await run(filled(), chain)).checks, new RegExp(`token ${USDT}`)).status, "FAIL");
  assert.equal(find((await run(filled(), chain)).checks, new RegExp(`token ${USDC}`)).status, "PASS");
  chain = fakeChain();
  chain.state.accounts["alice.testnet"] = { amount: (9n * 10n ** 24n).toString() };
  assert.equal(find((await run(filled(), chain)).checks, /owner account funded/).status, "FAIL");
  chain = fakeChain();
  delete chain.state.accounts["alice.testnet"];
  assert.match(find((await run(filled(), chain)).checks, /owner account funded/).detail, /does not exist/);
  chain = fakeChain();
  chain.state.accounts["vault.alice.testnet"] = { amount: "1" };
  const v = find((await run(filled(), chain)).checks, /vault_id not created/);
  assert.equal(v.status, "FAIL");
  assert.match(v.detail, /already exists/);
  assert.equal(find((await run(filled(), chain)).checks, /runner_id not created/).status, "PASS");
  chain.state.accounts["run.alice.testnet"] = { amount: "1" };
  assert.equal(find((await run(filled(), chain)).checks, /runner_id not created/).status, "FAIL");
});

test("online checks: a failing request is a WARN, not a crash", async () => {
  const chain = fakeChain();
  const rpc = createRpc({ fetch: async () => { throw new Error("offline"); } });
  const checks = await onlineChecks(filled(), buildLivePlan(filled()), rpc);
  assert.ok(checks.filter((c) => c.status === "WARN").length >= 5);
  assert.match(checks[0].detail, /could not read: request failed: offline/);
  assert.equal(chain.calls.length, 0);
});

test("online identity check: an endpoint that does not know wrap.testnet is not a testnet RPC", async () => {
  const chain = fakeChain();
  delete chain.state.accounts["wrap.testnet"];
  const id = find((await run(filled(), chain)).checks, /RPC is testnet/);
  assert.equal(id.status, "FAIL");
  assert.match(id.detail, /not a testnet RPC/);
  assert.equal(find((await run(filled(), fakeChain())).checks, /RPC is testnet/).status, "PASS");
});
