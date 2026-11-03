import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ANCHOR_METHOD,
  AnchorError,
  DEFAULT_GAS,
  FIRST_ANCHOR_DEPOSIT_YOCTO,
  anchorConfigFromEnv,
  anchorViewRequest,
  isValidAccountId,
  prepareAnchor,
  submitAnchor,
} from "./anchor.mjs";
import { SHEET_HASH_RE, canonicalJson, hashSheet, normalizeSheet, sha256Hex } from "./hash.mjs";

const CONTRACT = "personality.testnet";
const SHEET = "Aloof. Speaks rarely.\nNever answers twice.";
const base = { contractId: CONTRACT, tokenId: "aloof", sheet: SHEET, network: "testnet" };

function codeOf(code) {
  return (err) => err.code === code;
}

test("hashSheet matches sha256 of the normalized text", () => {
  const expected = createHash("sha256").update("hello\n", "utf8").digest("hex");
  assert.equal(hashSheet("hello"), expected);
  assert.match(hashSheet("hello"), SHEET_HASH_RE);
});

test("hashSheet ignores CRLF and trailing whitespace", () => {
  const a = hashSheet("one\ntwo\n");
  assert.equal(hashSheet("one\r\ntwo\r\n"), a);
  assert.equal(hashSheet("one\rtwo"), a);
  assert.equal(hashSheet("one   \ntwo\t\n\n\n"), a);
  assert.equal(hashSheet("\n\none\ntwo"), a);
  assert.notEqual(hashSheet("one\nthree"), a);
});

test("normalizeSheet applies NFC and ends with one newline", () => {
  assert.equal(normalizeSheet("é"), "é\n");
  assert.equal(normalizeSheet("a\n\n\n"), "a\n");
});

test("hashSheet rejects empty and non-string sheets", () => {
  assert.throws(() => hashSheet(""), codeOf("bad_sheet"));
  assert.throws(() => hashSheet(" \r\n\t "), codeOf("bad_sheet"));
  assert.throws(() => hashSheet(42), codeOf("bad_sheet"));
  assert.throws(() => hashSheet(undefined), codeOf("bad_sheet"));
});

test("sha256Hex is lowercase 64 hex", () => {
  assert.match(sha256Hex("x"), SHEET_HASH_RE);
});

test("canonicalJson sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: { d: 1, c: [3, { z: 1, y: 2 }] }, a: null }), '{"a":null,"b":{"c":[3,{"y":2,"z":1}],"d":1}}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
});

test("canonicalJson rejects undefined and non-finite numbers", () => {
  assert.throws(() => canonicalJson(undefined));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(NaN));
  assert.throws(() => canonicalJson(Infinity));
});

test("isValidAccountId", () => {
  assert.equal(isValidAccountId("a.testnet"), true);
  assert.equal(isValidAccountId("a"), false);
  assert.equal(isValidAccountId("Bad.testnet"), false);
  assert.equal(isValidAccountId("a..b"), false);
  assert.equal(isValidAccountId(5), false);
  assert.equal(isValidAccountId("a".repeat(65)), false);
});

test("prepareAnchor hashes the sheet and shapes the call", () => {
  const p = prepareAnchor({ ...base, currentAnchor: { sheet_hash: null, memory_depth: 0, updated_at: "0" } });
  assert.equal(p.args.sheet_hash, hashSheet(SHEET));
  assert.equal(p.args.token_id, "aloof");
  assert.equal(p.sheetHash, hashSheet(SHEET));
  assert.equal(p.methodName, ANCHOR_METHOD);
  assert.equal(p.network, "testnet");
  assert.equal(p.contractId, CONTRACT);
  assert.equal(p.gas, DEFAULT_GAS);
  assert.equal(p.signing, "required");
  assert.equal(p.firstAnchor, true);
  assert.equal(prepareAnchor({ ...base, gas: "5", currentAnchor: undefined }).gas, "5");
});

test("deposit rules", () => {
  const first = prepareAnchor({ ...base, currentAnchor: { sheet_hash: null } });
  assert.equal(first.depositYocto, FIRST_ANCHOR_DEPOSIT_YOCTO);
  const again = prepareAnchor({ ...base, currentAnchor: { sheet_hash: "a".repeat(64) } });
  assert.equal(again.depositYocto, FIRST_ANCHOR_DEPOSIT_YOCTO); // every anchor adds a seen-hash record
  assert.equal(again.firstAnchor, false);
  assert.equal(prepareAnchor({ ...base }).depositYocto, FIRST_ANCHOR_DEPOSIT_YOCTO);
  assert.throws(() => prepareAnchor({ ...base, currentAnchor: null }), codeOf("unknown_token"));
});

test("prepareAnchor refuses non-testnet networks", () => {
  assert.throws(() => prepareAnchor({ ...base, network: "mainnet" }), codeOf("network_refused"));
  assert.throws(() => prepareAnchor({ ...base, network: undefined }), codeOf("network_refused"));
});

test("prepareAnchor validates contract, token and sheet inputs", () => {
  assert.throws(() => prepareAnchor({ ...base, contractId: "BAD" }), codeOf("bad_config"));
  assert.throws(() => prepareAnchor({ ...base, tokenId: "Bad Token" }), codeOf("bad_token"));
  assert.throws(() => prepareAnchor({ ...base, tokenId: "" }), codeOf("bad_token"));
  const hex = hashSheet(SHEET);
  const noSheet = { contractId: CONTRACT, tokenId: "aloof", network: "testnet" };
  assert.equal(prepareAnchor({ ...noSheet, sheetHash: hex }).args.sheet_hash, hex);
  assert.throws(() => prepareAnchor({ ...noSheet, sheetHash: hex.toUpperCase() }), codeOf("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...noSheet, sheetHash: "abc" }), codeOf("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...noSheet, sheet: SHEET, sheetHash: hex }), codeOf("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...noSheet }), codeOf("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...noSheet, sheet: "  " }), codeOf("bad_sheet"));
});

test("prepared call is JSON-serializable and frozen", () => {
  const p = prepareAnchor(base);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
  assert.throws(() => {
    p.args.token_id = "x";
  }, TypeError);
  assert.throws(() => {
    p.depositYocto = "1";
  }, TypeError);
  assert.equal(p.args.token_id, "aloof");
});

test("anchorViewRequest shape", () => {
  assert.deepEqual(anchorViewRequest({ contractId: CONTRACT, tokenId: "social" }), {
    contractId: CONTRACT,
    methodName: "sheet_anchor",
    args: { token_id: "social" },
  });
  assert.throws(() => anchorViewRequest({ contractId: "X", tokenId: "social" }), codeOf("bad_config"));
  assert.throws(() => anchorViewRequest({ contractId: CONTRACT, tokenId: "S!" }), codeOf("bad_token"));
});

test("submitAnchor is a dry run by default and never sends", async () => {
  const prepared = prepareAnchor(base);
  const send = () => {
    throw new Error("send must not be called");
  };
  const result = await submitAnchor(prepared, { send });
  assert.deepEqual(result, { status: "dry-run", prepared, transactionHash: null });
  assert.equal((await submitAnchor(prepared, { live: false, send })).status, "dry-run");
  assert.equal((await submitAnchor(prepared)).status, "dry-run");
});

test("submitAnchor live needs an injected sender", async () => {
  const prepared = prepareAnchor(base);
  await assert.rejects(submitAnchor(prepared, { live: true }), codeOf("not_configured"));
});

test("submitAnchor live uses the injected sender", async () => {
  const prepared = prepareAnchor(base);
  const seen = [];
  const send = async (p) => {
    seen.push(p);
    return { transactionHash: "fake-hash" };
  };
  const result = await submitAnchor(prepared, { live: true, send });
  assert.deepEqual(result, { status: "submitted", prepared, transactionHash: "fake-hash" });
  assert.equal(seen.length, 1);
  await assert.rejects(submitAnchor(prepared, { live: true, send: async () => ({}) }), codeOf("bad_result"));
});

test("submitAnchor live refuses a mainnet prepared object", async () => {
  const send = async () => ({ transactionHash: "h" });
  await assert.rejects(
    submitAnchor({ ...prepareAnchor(base), network: "mainnet" }, { live: true, send }),
    codeOf("network_refused"),
  );
});

test("anchorConfigFromEnv", () => {
  assert.deepEqual(anchorConfigFromEnv({}), { live: false, network: undefined, contractId: undefined });
  assert.equal(anchorConfigFromEnv({ ANCHOR_LIVE: "1" }).live, true);
  assert.equal(anchorConfigFromEnv({ ANCHOR_LIVE: " TRUE " }).live, true);
  assert.equal(anchorConfigFromEnv({ ANCHOR_LIVE: "0" }).live, false);
  assert.equal(anchorConfigFromEnv({ ANCHOR_LIVE: "false" }).live, false);
  assert.equal(anchorConfigFromEnv({ ANCHOR_LIVE: "" }).live, false);
  assert.throws(() => anchorConfigFromEnv({ ANCHOR_LIVE: "yes" }), (e) => e instanceof AnchorError && e.code === "bad_config");
  const cfg = anchorConfigFromEnv({
    NEAR_NETWORK: "testnet",
    NEAR_NFT_CONTRACT_ID: CONTRACT,
    NEAR_SECRET_KEY: "fake-not-a-real-credential",
  });
  assert.deepEqual(Object.keys(cfg).sort(), ["contractId", "live", "network"]);
  assert.equal(cfg.network, "testnet");
  assert.equal(cfg.contractId, CONTRACT);
  assert.ok(!JSON.stringify(cfg).includes("fake-not-a-real-credential"));
});

// Token id rules must match the contract's validate_token_id
// (contracts/personality-nft/src/lib.rs): 1-64 bytes of [a-z0-9_-].
test("anchorViewRequest token id charset and length match the contract", () => {
  const ok = ["a", "agent_0-z9", "a".repeat(64)];
  for (const tokenId of ok) {
    assert.equal(anchorViewRequest({ contractId: CONTRACT, tokenId }).args.token_id, tokenId);
  }
  const bad = ["", "a".repeat(65), "Aloof", "a.b", "a b", "café", "a/b"];
  for (const tokenId of bad) {
    assert.throws(() => anchorViewRequest({ contractId: CONTRACT, tokenId }), (e) => e.code === "bad_token", JSON.stringify(tokenId));
  }
});

test("contract source declares the same token id rules as the JS builder", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../contracts/personality-nft/src/lib.rs", import.meta.url), "utf8");
  assert.match(src, /MAX_TOKEN_ID_LEN: usize = 64;/);
  assert.match(src, /b\.is_ascii_lowercase\(\) \|\| b\.is_ascii_digit\(\) \|\| b == b'_' \|\| b == b'-'/);
});

test("the official sheet hash definition is pinned", () => {
  // sha256 of "Café one\ntwo\n": NFC, LF endings, trailing spaces and edge blank lines removed, one final newline.
  const pinned = "049238c7e9dcd9a7829c45c1ab6ab8fe64f1c1a9ea66fd00655ae162ac445217";
  assert.equal(hashSheet("Café one  \r\ntwo\r\n\r\n"), pinned);
  assert.equal(hashSheet("Café one\ntwo"), pinned);
  assert.equal(hashSheet("Café one\ntwo\n"), pinned);
  assert.notEqual(hashSheet("Café one\n\ntwo"), pinned);
});
