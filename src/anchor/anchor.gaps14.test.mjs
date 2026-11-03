// Behaviour of src/anchor that the existing anchor tests leave implicit: the
// code each refusal carries.

import assert from "node:assert/strict";
import test from "node:test";

import { AnchorError, prepareAnchor, submitAnchor } from "./anchor.mjs";
import { HashError, canonicalJson, hashSheet, normalizeSheet } from "./hash.mjs";

const base = { contractId: "nft.testnet", tokenId: "aloof", sheet: "hello", network: "testnet" };
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AnchorError, String(e));
    return e.code;
  }
  assert.fail("expected a throw");
};

test("each prepareAnchor refusal carries its documented code", () => {
  assert.equal(codeOf(() => prepareAnchor({ ...base, contractId: "Bad Id" })), "bad_config");
  assert.equal(codeOf(() => prepareAnchor({ ...base, network: "mainnet" })), "network_refused");
  assert.equal(codeOf(() => prepareAnchor({ ...base, tokenId: "UPPER" })), "bad_token");
  assert.equal(codeOf(() => prepareAnchor({ ...base, sheet: undefined })), "bad_sheet");
  assert.equal(codeOf(() => prepareAnchor({ ...base, sheet: "  \n" })), "bad_sheet");
  assert.equal(codeOf(() => prepareAnchor({ ...base, gas: "0" })), "bad_config");
  assert.equal(codeOf(() => prepareAnchor({ ...base, currentAnchor: null })), "unknown_token");
  assert.equal(codeOf(() => prepareAnchor({ ...base, currentAnchor: "x" })), "bad_anchor");
});

test("submitAnchor refusals carry their codes: not_configured without a sender, bad_result for a malformed reply, network_refused for a non-testnet object", async () => {
  const prepared = prepareAnchor(base);
  const code = async (p, opts) => {
    try {
      await submitAnchor(p, opts);
    } catch (e) {
      assert.ok(e instanceof AnchorError);
      return e.code;
    }
    return assert.fail("expected a rejection");
  };
  assert.equal(await code(prepared, { live: true }), "not_configured");
  assert.equal(await code(prepared, { live: true, send: async () => ({}) }), "bad_result");
  assert.equal(await code({ ...prepared, network: "mainnet" }, { live: true, send: async () => ({ transactionHash: "h" }) }), "network_refused");
});

test("HashError codes: bad_sheet for a non-string or empty sheet, bad_json for a non-JSON value", () => {
  for (const fn of [() => normalizeSheet(5), () => hashSheet(" \n "), () => hashSheet(undefined)]) {
    assert.throws(fn, (e) => e instanceof HashError && e.code === "bad_sheet");
  }
  for (const v of [undefined, () => 1, 1n, Symbol("s"), Number.NaN]) {
    assert.throws(() => canonicalJson(v), (e) => e instanceof HashError && e.code === "bad_json");
  }
});
