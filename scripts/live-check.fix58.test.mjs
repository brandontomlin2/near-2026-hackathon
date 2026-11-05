import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "./live-check.mjs";

const ENV = { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" };
const text = (r) => r.lines.join("\n");
const httpError = (status) => async () => ({ ok: false, status, json: async () => ({}) });

for (const status of [503, 429]) {
  test(`HTTP ${status} with an empty JSON body is an RPC error with the status, not a missing account`, async () => {
    const r = await check(ENV, { statWasm: () => 1, fetch: httpError(status) });
    assert.match(text(r), new RegExp(`RPC error \\(HTTP ${status}\\)`));
    assert.ok(!/does not exist/.test(text(r)), text(r));
    assert.equal(r.ready, true);
  });
}

test("a real UNKNOWN_ACCOUNT RPC response on HTTP 200 is still reported as missing", async () => {
  const missing = async () => ({
    ok: true, status: 200, json: async () => ({ error: { cause: { name: "UNKNOWN_ACCOUNT" } } }),
  });
  const r = await check(ENV, { statWasm: () => 1, fetch: missing });
  assert.equal(r.ready, false);
  assert.match(text(r), /NEAR_ACCOUNT_ID does not exist/);
  assert.ok(!/RPC error/.test(text(r)));
});
