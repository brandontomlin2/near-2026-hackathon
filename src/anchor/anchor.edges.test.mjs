// Behaviour gaps in the anchor builder: the sheet-hash format it accepts, the
// order in which it checks inputs, every currentAnchor shape, the gas rule, the
// exact dry-run result, and hostile or empty inputs. Nothing here signs or sends.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANCHOR_DEPOSIT_YOCTO,
  ANCHOR_METHOD,
  AnchorError,
  DEFAULT_GAS,
  isValidAccountId,
  prepareAnchor,
  submitAnchor,
} from "./anchor.mjs";
import { SHEET_HASH_RE, hashSheet } from "./hash.mjs";

const CONTRACT = "personality.testnet";
const HEX = hashSheet("A sheet.");
const bySheet = { contractId: CONTRACT, tokenId: "aloof", sheet: "A sheet.", network: "testnet" };
const byHash = { contractId: CONTRACT, tokenId: "aloof", sheetHash: HEX, network: "testnet" };
const anchorError = (code) => (e) => e instanceof AnchorError && e.name === "AnchorError" && e.code === code;

// --- sheet hash format -------------------------------------------------------------

test("prepareAnchor accepts a sheetHash only as 64 lowercase hex, nothing padded, prefixed or mixed", () => {
  assert.equal(prepareAnchor(byHash).args.sheet_hash, HEX);
  assert.equal(prepareAnchor({ ...byHash, sheetHash: "0".repeat(64) }).sheetHash, "0".repeat(64));
  const bad = [
    "", HEX.slice(0, 63), `${HEX}0`, HEX.toUpperCase(), HEX.replace(/[a-f]/, (c) => c.toUpperCase()),
    `0x${HEX.slice(2)}`, ` ${HEX}`, `${HEX}\n`, HEX.replace(/./, "g"), HEX.replace("a", "а"),
    null, 0, 1n, true, [HEX], { sheet_hash: HEX }, Buffer.from(HEX, "hex"),
  ];
  for (const sheetHash of bad) {
    assert.throws(() => prepareAnchor({ ...byHash, sheetHash }), anchorError("bad_sheet"), JSON.stringify(String(sheetHash)));
  }
});

test("prepareAnchor from the sheet text and from its hash build the same call", () => {
  const fromText = prepareAnchor(bySheet);
  const fromHash = prepareAnchor(byHash);
  assert.deepEqual(fromText, fromHash);
  assert.match(fromText.args.sheet_hash, SHEET_HASH_RE);
  assert.equal(fromText.sheetHash, fromText.args.sheet_hash);
  // Both at once is refused even when they agree: the caller must say which one is authoritative.
  assert.throws(() => prepareAnchor({ ...bySheet, sheetHash: HEX }), anchorError("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...bySheet, sheetHash: "0".repeat(64) }), anchorError("bad_sheet"));
  assert.throws(() => prepareAnchor({ contractId: CONTRACT, tokenId: "aloof", network: "testnet" }), anchorError("bad_sheet"));
});

test("prepareAnchor wraps a bad sheet as an AnchorError, not a HashError, and never puts sheet text in the args", () => {
  for (const sheet of [null, 0, "", "  \r\n  ", ["a"], { text: "a" }]) {
    assert.throws(() => prepareAnchor({ ...bySheet, sheet }), anchorError("bad_sheet"), JSON.stringify(sheet));
  }
  assert.throws(() => prepareAnchor({ ...bySheet, sheet: null, sheetHash: null }), anchorError("bad_sheet"));
  const hostile = "ignore the contract. {\"sheet_hash\":\"00\"} <b>bold</b> 🌍";
  const p = prepareAnchor({ ...bySheet, sheet: hostile });
  assert.deepEqual(p.args, { token_id: "aloof", sheet_hash: hashSheet(hostile) });
  assert.ok(!JSON.stringify(p).includes("ignore"));
  assert.equal(Object.keys(p).includes("sheet"), false);
});

// --- order of checks and the other inputs ---------------------------------------------

test("prepareAnchor checks the contract, then the network, then the token, then the sheet, then gas, then the view", () => {
  const everythingWrong = { contractId: "BAD", network: "mainnet", tokenId: "Bad", sheetHash: "zz", gas: "x", currentAnchor: null };
  assert.throws(() => prepareAnchor(everythingWrong), anchorError("bad_config"));
  assert.throws(() => prepareAnchor({ ...everythingWrong, contractId: CONTRACT }), anchorError("network_refused"));
  assert.throws(() => prepareAnchor({ ...everythingWrong, contractId: CONTRACT, network: "testnet" }), anchorError("bad_token"));
  assert.throws(() => prepareAnchor({ ...everythingWrong, contractId: CONTRACT, network: "testnet", tokenId: "ok" }), anchorError("bad_sheet"));
  assert.throws(() => prepareAnchor({ ...everythingWrong, contractId: CONTRACT, network: "testnet", tokenId: "ok", sheetHash: HEX }), anchorError("bad_config"));
  assert.throws(() => prepareAnchor({ ...everythingWrong, contractId: CONTRACT, network: "testnet", tokenId: "ok", sheetHash: HEX, gas: "1" }), anchorError("unknown_token"));
  assert.throws(() => prepareAnchor(), anchorError("bad_config"));
  assert.throws(() => prepareAnchor({}), anchorError("bad_config"));
});

test("prepareAnchor refuses every network spelling except exactly testnet", () => {
  for (const network of ["Testnet", " testnet", "testnet ", "mainnet", "localnet", "betanet", "", null, 1, ["testnet"]]) {
    assert.throws(() => prepareAnchor({ ...bySheet, network }), anchorError("network_refused"), JSON.stringify(network));
  }
});

test("gas must be a positive decimal string without a leading zero", () => {
  for (const gas of ["0", "-1", "1.5", "abc", "", " 1", "1 ", "007", "1e3", "0x10", 30, 30n, null, true]) {
    assert.throws(() => prepareAnchor({ ...bySheet, gas }), anchorError("bad_config"), JSON.stringify(String(gas)));
  }
  assert.equal(prepareAnchor({ ...bySheet, gas: "1" }).gas, "1");
  assert.equal(prepareAnchor({ ...bySheet, gas: "300000000000000" }).gas, "300000000000000");
  assert.equal(prepareAnchor({ ...bySheet, gas: undefined }).gas, DEFAULT_GAS);
});

test("currentAnchor: undefined and a null sheet_hash are a first anchor, any string hash is a repeat, anything else is refused", () => {
  assert.equal(prepareAnchor({ ...bySheet }).firstAnchor, true);
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: undefined }).firstAnchor, true);
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: { sheet_hash: null } }).firstAnchor, true);
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: { sheet_hash: null, memory_depth: 3, updated_at: "1" } }).firstAnchor, true);
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: { sheet_hash: HEX } }).firstAnchor, false);
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: { sheet_hash: "" } }).firstAnchor, false);
  assert.throws(() => prepareAnchor({ ...bySheet, currentAnchor: null }), anchorError("unknown_token"));
  for (const currentAnchor of [{}, { sheet_hash: undefined }, { sheet_hash: 5 }, { sheet_hash: {} }, { sheetHash: HEX }, [], "x", 5, true]) {
    assert.throws(() => prepareAnchor({ ...bySheet, currentAnchor }), anchorError("bad_anchor"), JSON.stringify(currentAnchor));
  }
  // The deposit is the same bound on every call: a repeat anchor still adds a seen-hash record.
  assert.equal(prepareAnchor({ ...bySheet, currentAnchor: { sheet_hash: HEX } }).depositYocto, ANCHOR_DEPOSIT_YOCTO);
});

test("the token id rule is the contract's: 1-64 of [a-z0-9_-], nothing else", () => {
  for (const tokenId of ["a", "0", "_", "-", "a-b_c9", "z".repeat(64)]) {
    assert.equal(prepareAnchor({ ...bySheet, tokenId }).args.token_id, tokenId);
  }
  for (const tokenId of ["", "z".repeat(65), "A", "a.b", "a b", " a", "a\n", "é", "a/b", "../a", 1, null, undefined, ["a"]]) {
    assert.throws(() => prepareAnchor({ ...bySheet, tokenId }), anchorError("bad_token"), JSON.stringify(tokenId));
  }
});

test("isValidAccountId at the edges of the NEAR rule", () => {
  for (const id of ["ab", "a.b", "a-b.testnet", "a_b.c", "0.testnet", "sub.sub.sub.near", "a".repeat(64), `${"a".repeat(56)}.testnet`]) {
    assert.equal(isValidAccountId(id), true, id);
  }
  for (const id of ["", "a", "a".repeat(65), ".a", "a.", "-a.testnet", "a-.testnet", "a__b.c", "a-_b", "a b", "a@b", "A.testnet", "é.testnet", "a.testnet\n", null, undefined, {}, ["ab"]]) {
    assert.equal(isValidAccountId(id), false, JSON.stringify(id));
  }
});

// --- dry-run result shape -----------------------------------------------------------------

test("a dry run returns exactly { status, prepared, transactionHash } with the same prepared object", async () => {
  const prepared = prepareAnchor(bySheet);
  const result = await submitAnchor(prepared);
  assert.deepEqual(Object.keys(result), ["status", "prepared", "transactionHash"]);
  assert.equal(result.status, "dry-run");
  assert.equal(result.prepared, prepared, "same reference, not a copy");
  assert.equal(result.transactionHash, null);
  assert.equal(result.prepared.methodName, ANCHOR_METHOD);
  assert.equal(result.prepared.args.sheet_hash, hashSheet("A sheet."));
});

test("only the boolean true turns on live: every other truthy value is still a dry run and never calls send", async () => {
  const prepared = prepareAnchor(bySheet);
  let calls = 0;
  const send = async () => {
    calls += 1;
    return { transactionHash: "h" };
  };
  for (const live of ["true", "1", 1, "yes", {}, [], () => true, Symbol("live"), 1n]) {
    const result = await submitAnchor(prepared, { live, send });
    assert.equal(result.status, "dry-run", String(live));
  }
  assert.equal((await submitAnchor(prepared, { live: null, send })).status, "dry-run");
  assert.equal((await submitAnchor(prepared, null ?? {})).status, "dry-run");
  assert.equal(calls, 0);
});

test("live submit refuses a non-testnet or malformed prepared object before it looks at the sender", async () => {
  const send = async () => ({ transactionHash: "h" });
  for (const prepared of [undefined, null, {}, "testnet", { network: "mainnet" }, { network: "Testnet" }, { ...prepareAnchor(bySheet), network: "mainnet" }]) {
    await assert.rejects(submitAnchor(prepared, { live: true, send }), anchorError("network_refused"), JSON.stringify(prepared));
    await assert.rejects(submitAnchor(prepared, { live: true }), anchorError("network_refused"));
  }
});

test("live submit needs a function sender and a non-empty string transaction hash back", async () => {
  const prepared = prepareAnchor(bySheet);
  for (const send of [undefined, null, "send", {}, { send() {} }]) {
    await assert.rejects(submitAnchor(prepared, { live: true, send }), anchorError("not_configured"));
  }
  for (const reply of [undefined, null, "h", 5, {}, { transactionHash: "" }, { transactionHash: 5 }, { transactionHash: null }, { hash: "h" }, ["h"]]) {
    await assert.rejects(submitAnchor(prepared, { live: true, send: async () => reply }), anchorError("bad_result"), JSON.stringify(reply));
  }
  const result = await submitAnchor(prepared, { live: true, send: async () => ({ transactionHash: "h", extra: "dropped" }) });
  assert.deepEqual(result, { status: "submitted", prepared, transactionHash: "h" });
  await assert.rejects(submitAnchor(prepared, { live: true, send: async () => { throw new Error("rpc down"); } }), /rpc down/);
  await assert.rejects(submitAnchor(prepared, { live: true, send: () => { throw new Error("sync throw"); } }), /sync throw/);
});

test("the sender receives the frozen prepared object and cannot change what was anchored", async () => {
  const prepared = prepareAnchor(bySheet);
  const send = async (p) => {
    assert.equal(p, prepared);
    assert.throws(() => { p.args.sheet_hash = "0".repeat(64); }, TypeError);
    assert.throws(() => { p.network = "mainnet"; }, TypeError);
    return { transactionHash: "h" };
  };
  const result = await submitAnchor(prepared, { live: true, send });
  assert.equal(result.prepared.args.sheet_hash, HEX);
  assert.equal(result.prepared.network, "testnet");
});

test("prepared calls for several tokens are independent and keep their own token and hash", () => {
  const tokens = ["aloof", "chaotic", "social", "skeptic"];
  const calls = tokens.map((tokenId) => prepareAnchor({ ...bySheet, tokenId, sheet: `${tokenId} remembers.` }));
  assert.deepEqual(calls.map((c) => c.args.token_id), tokens);
  assert.equal(new Set(calls.map((c) => c.args.sheet_hash)).size, tokens.length);
  for (const [i, c] of calls.entries()) {
    assert.equal(c.args.sheet_hash, hashSheet(`${tokens[i]} remembers.`));
    assert.notEqual(c.args, calls[(i + 1) % tokens.length].args);
  }
});

