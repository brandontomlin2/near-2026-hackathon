// Edge cases for the anchor builder and submitter: hostile parameter shapes,
// prototype-named keys in view results, the exact payload sent to the sender,
// and long sheets. Dry-run and injected-sender paths only; nothing signs or
// opens a connection.
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
import { hashSheet } from "./hash.mjs";

const base = { contractId: "personality.testnet", tokenId: "aloof", sheet: "A sheet.", network: "testnet" };
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AnchorError, `expected AnchorError, got ${err?.name}: ${err?.message}`);
    return err.code;
  }
  assert.fail("expected a throw");
};

test("prepareAnchor() with no argument fails on the contract id, with a coded error", () => {
  assert.equal(code(() => prepareAnchor()), "bad_config");
  assert.equal(code(() => prepareAnchor({})), "bad_config");
});

test("non-string sheets of every kind are bad_sheet; undefined means 'not given'", () => {
  for (const sheet of [null, 0, NaN, 1n, true, [], ["a"], {}, { toString: () => "text" }, new String("abc"), Buffer.from("abc")]) {
    assert.equal(code(() => prepareAnchor({ ...base, sheet })), "bad_sheet");
  }
});

test("a sheet and a sheetHash together, or neither, are refused even when null is passed", () => {
  const sheetHash = hashSheet("A sheet.");
  assert.equal(code(() => prepareAnchor({ ...base, sheetHash })), "bad_sheet");
  assert.equal(code(() => prepareAnchor({ ...base, sheet: undefined })), "bad_sheet");
  // null is a value, not "absent": it counts as given and then fails its own check.
  assert.equal(code(() => prepareAnchor({ ...base, sheet: undefined, sheetHash: null })), "bad_sheet");
  assert.equal(code(() => prepareAnchor({ ...base, sheet: null, sheetHash })), "bad_sheet");
});

test("sheetHash of the wrong type is refused rather than coerced to a string", () => {
  const hex = hashSheet("A sheet.");
  const bad = [123, 1n, [hex], { toString: () => hex }, new String(hex), Buffer.from(hex), true, ""];
  for (const sheetHash of bad) {
    assert.equal(code(() => prepareAnchor({ ...base, sheet: undefined, sheetHash })), "bad_sheet");
  }
});

test("account ids that are not strings are refused without a TypeError", () => {
  for (const contractId of [null, undefined, 42, 1n, [], ["a.testnet"], {}, { toString: () => "a.testnet" }, new String("a.testnet"), Symbol("a")]) {
    assert.equal(isValidAccountId(contractId), false);
    assert.equal(code(() => prepareAnchor({ ...base, contractId })), "bad_config");
  }
});

test("account ids with look-alike or control characters are refused", () => {
  for (const id of ["personality.testnet\n", " personality.testnet", "personality.testnet\u0000", "personalitу.testnet", "personality.test​net", "PERSONALITY.testnet", "ｐersonality.testnet", "a..b", ".a.b", "a.b."]) {
    assert.equal(isValidAccountId(id), false, JSON.stringify(id));
  }
});

test("token ids with a trailing newline, unicode digits or look-alikes are refused", () => {
  for (const tokenId of ["aloof\n", "aloоf", "١٢", "a b", "a.b", "a/b", "a\u0000", "ALOOF", "😀"]) {
    assert.equal(code(() => prepareAnchor({ ...base, tokenId })), "bad_token", JSON.stringify(tokenId));
  }
});

test("network values of the wrong type are refused with the network named in the message", () => {
  for (const network of [undefined, null, 1, ["testnet"], { toString: () => "testnet" }, new String("testnet")]) {
    assert.throws(() => prepareAnchor({ ...base, network }), { name: "AnchorError", code: "network_refused", message: /testnet only/ });
  }
});

test("gas of the wrong type or shape is refused; a plain number is not accepted", () => {
  for (const gas of [30000000000000, 1n, null, NaN, Infinity, [], ["1"], {}, "1e13", "0x10", "-1", " 1", "1 ", "1.0", "", "00", "１"]) {
    assert.equal(code(() => prepareAnchor({ ...base, gas })), "bad_config", JSON.stringify(String(gas)));
  }
  assert.equal(prepareAnchor({ ...base, gas: "1" }).gas, "1");
});

test("a very large decimal gas string is passed through untouched, with no numeric parsing", () => {
  const gas = "9".repeat(60);
  assert.equal(prepareAnchor({ ...base, gas }).gas, gas);
});

test("currentAnchor values that are not view results are bad_anchor, never a TypeError", () => {
  const hostile = [0, 1, NaN, "hash", "", true, false, 1n, [], ["x"], {}, { sheet_hash: undefined }, { sheet_hash: 7 }, { sheet_hash: {} }, { sheet_hash: ["h"] }, () => ({ sheet_hash: null }), Symbol("a")];
  for (const currentAnchor of hostile) {
    assert.equal(code(() => prepareAnchor({ ...base, currentAnchor })), "bad_anchor");
  }
});

test("currentAnchor is judged only by sheet_hash: extra or odd sibling fields change nothing", () => {
  const plain = prepareAnchor({ ...base, currentAnchor: { sheet_hash: null } });
  const noisy = prepareAnchor({ ...base, currentAnchor: { sheet_hash: null, memory_depth: -5, updated_at: 123, extra: [] } });
  assert.deepEqual(noisy, plain);
  const repeatPlain = prepareAnchor({ ...base, currentAnchor: { sheet_hash: "abc" } });
  const repeatNoisy = prepareAnchor({ ...base, currentAnchor: { sheet_hash: "abc", memory_depth: NaN, updated_at: null } });
  assert.deepEqual(repeatPlain, repeatNoisy);
  assert.equal(repeatPlain.firstAnchor, false);
});

test("a currentAnchor parsed from JSON with prototype-named keys is handled as data and pollutes nothing", () => {
  const view = JSON.parse('{"sheet_hash":null,"__proto__":{"polluted":true},"constructor":"x","prototype":1}');
  const prepared = prepareAnchor({ ...base, currentAnchor: view });
  assert.equal(prepared.firstAnchor, true);
  assert.equal(({}).polluted, undefined);
  assert.equal(prepared.polluted, undefined);
  assert.equal(prepared.args.polluted, undefined);
});

test("a view whose sheet_hash comes from the prototype chain still counts as a view result", () => {
  // The builder reads currentAnchor.sheet_hash with plain property access, so a
  // chain-inherited string is read like an own one. Pinned so a change is deliberate.
  const view = Object.create({ sheet_hash: "inherited" });
  assert.equal(prepareAnchor({ ...base, currentAnchor: view }).firstAnchor, false);
});

test("the params object is not mutated and an own __proto__ param is ignored", () => {
  const params = JSON.parse('{"contractId":"personality.testnet","tokenId":"aloof","sheet":"A sheet.","network":"testnet","__proto__":{"network":"mainnet"}}');
  const before = JSON.stringify(params);
  const prepared = prepareAnchor(params);
  assert.equal(JSON.stringify(params), before);
  assert.equal(prepared.network, "testnet");
  assert.equal(({}).network, undefined);
});

test("the payload is exactly the contract call: method, two args, deposit, gas, no extra keys", () => {
  const prepared = prepareAnchor({ ...base, currentAnchor: { sheet_hash: "old" } });
  assert.deepEqual(Object.keys(prepared).sort(), ["args", "contractId", "depositYocto", "firstAnchor", "gas", "methodName", "network", "sheetHash", "signing"]);
  assert.deepEqual(Object.keys(prepared.args).sort(), ["sheet_hash", "token_id"]);
  assert.equal(prepared.methodName, ANCHOR_METHOD);
  assert.equal(prepared.depositYocto, ANCHOR_DEPOSIT_YOCTO);
  assert.equal(prepared.gas, DEFAULT_GAS);
  assert.equal(prepared.args.sheet_hash, prepared.sheetHash);
  assert.equal(prepared.args.token_id, "aloof");
  assert.equal(prepared.signing, "required");
});

test("the payload is frozen: strict-mode writes, deletes and additions all throw", () => {
  const prepared = prepareAnchor(base);
  assert.throws(() => { prepared.gas = "1"; }, TypeError);
  assert.throws(() => { delete prepared.methodName; }, TypeError);
  assert.throws(() => { prepared.extra = 1; }, TypeError);
  assert.throws(() => { prepared.args.sheet_hash = "0".repeat(64); }, TypeError);
  assert.throws(() => { prepared.args.extra = 1; }, TypeError);
  assert.equal(prepared.args.sheet_hash, hashSheet("A sheet."));
});

test("the payload survives a JSON round trip and an unchanged re-submit of it still dry-runs", async () => {
  const prepared = prepareAnchor(base);
  const copy = JSON.parse(JSON.stringify(prepared));
  assert.deepEqual(copy, prepared);
  const result = await submitAnchor(copy);
  assert.equal(result.status, "dry-run");
  assert.equal(result.transactionHash, null);
});

test("the sheet text never reaches the payload, only its hash", () => {
  const secret = "SECRET-SHEET-WORDS unique-marker-53";
  const prepared = prepareAnchor({ ...base, sheet: secret });
  assert.ok(!JSON.stringify(prepared).includes("unique-marker-53"));
  assert.equal(prepared.sheetHash, hashSheet(secret));
});

test("a 3 MB sheet is accepted, anchors only its 64-char hash, and builds the same call each time", () => {
  const sheet = "A long, long sheet line with café and 😀.   \r\n".repeat(70_000);
  assert.ok(sheet.length > 3_000_000);
  const a = prepareAnchor({ ...base, sheet });
  const b = prepareAnchor({ ...base, sheet });
  assert.deepEqual(a, b);
  assert.match(a.args.sheet_hash, /^[0-9a-f]{64}$/);
  assert.ok(JSON.stringify(a).length < 1000);
  assert.equal(prepareAnchor({ ...base, sheet: undefined, sheetHash: a.sheetHash }).args.sheet_hash, a.args.sheet_hash);
});

test("a sheet differing only by Unicode form, line endings and trailing space anchors to the same hash", () => {
  const composed = prepareAnchor({ ...base, sheet: "café\nline two" });
  const noisy = prepareAnchor({ ...base, sheet: "  café  \r\nline two \r\n\r\n" });
  assert.equal(composed.sheetHash, noisy.sheetHash);
  const different = prepareAnchor({ ...base, sheet: "cafe\nline two" });
  assert.notEqual(composed.sheetHash, different.sheetHash);
});

test("submitAnchor dry-runs with no options, null options' siblings, or a non-boolean live, and returns the object it was given", async () => {
  const prepared = prepareAnchor(base);
  for (const opts of [undefined, {}, { live: false }, { live: "true" }, { live: 1 }, { live: {} }]) {
    const sent = [];
    const result = await submitAnchor(prepared, opts && { ...opts, send: async (p) => sent.push(p) });
    assert.equal(result.status, "dry-run");
    assert.equal(result.prepared, prepared);
    assert.deepEqual(sent, []);
  }
});

test("a dry run does not validate the prepared object, so only live: true gates a malformed one", async () => {
  for (const junk of [undefined, null, 5, "x", [], { network: "mainnet" }]) {
    const result = await submitAnchor(junk);
    assert.equal(result.status, "dry-run");
    assert.equal(result.prepared, junk);
    assert.equal(result.transactionHash, null);
  }
});

test("live submit of a missing or mainnet payload is refused before the sender is called", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
    return { transactionHash: "h" };
  };
  for (const junk of [undefined, null, 5, "testnet", [], {}, { network: "mainnet" }, { network: "Testnet" }]) {
    await assert.rejects(submitAnchor(junk, { live: true, send }), { name: "AnchorError", code: "network_refused" });
  }
  assert.equal(calls, 0);
});

test("live submit rejects every malformed sender result with bad_result and returns a good hash verbatim", async () => {
  const prepared = prepareAnchor(base);
  const replies = [undefined, null, "hash", 7, [], {}, { transactionHash: "" }, { transactionHash: 12 }, { transactionHash: null }, { transactionHash: ["h"] }, { tx: "h" }];
  for (const reply of replies) {
    await assert.rejects(submitAnchor(prepared, { live: true, send: async () => reply }), { name: "AnchorError", code: "bad_result" });
  }
  const ok = await submitAnchor(prepared, { live: true, send: async () => ({ transactionHash: "ABC123", extra: "ignored" }) });
  assert.deepEqual(ok, { status: "submitted", prepared, transactionHash: "ABC123" });
});

test("a sender that throws or rejects propagates its own error and is not reported as submitted", async () => {
  const prepared = prepareAnchor(base);
  await assert.rejects(submitAnchor(prepared, { live: true, send: async () => { throw new Error("rpc down"); } }), { name: "Error", message: "rpc down" });
  await assert.rejects(submitAnchor(prepared, { live: true, send: () => { throw new SyntaxError("sync boom"); } }), { name: "SyntaxError", message: "sync boom" });
  await assert.rejects(submitAnchor(prepared, { live: true, send: () => Promise.reject(new RangeError("later")) }), { name: "RangeError" });
});

test("a synchronous sender returning a good result is accepted, and it is called exactly once", async () => {
  const prepared = prepareAnchor(base);
  let calls = 0;
  const result = await submitAnchor(prepared, { live: true, send: () => { calls += 1; return { transactionHash: "sync-hash" }; } });
  assert.equal(calls, 1);
  assert.equal(result.transactionHash, "sync-hash");
});

test("regression: prepareAnchor(null) fails with the same coded bad_config as prepareAnchor(), not a raw TypeError", () => {
  assert.equal(code(() => prepareAnchor(null)), code(() => prepareAnchor()));
  assert.equal(code(() => prepareAnchor(null)), "bad_config");
});
