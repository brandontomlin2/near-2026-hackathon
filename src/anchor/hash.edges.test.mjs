// Behaviour gaps in the hashing helpers: canonicalJson independence from key
// insertion order at every depth, hashSheet stability across unicode forms and
// unicode whitespace, and the exact set of inputs the sheet-hash regex accepts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { HashError, SHEET_HASH_RE, canonicalJson, hashSheet, normalizeSheet, sha256Hex } from "./hash.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// --- canonicalJson and key order ----------------------------------------------

test("canonicalJson gives one string for every insertion order, at every depth", () => {
  const a = { z: { y: [1, { x: 1, w: 2 }], v: "s" }, u: true, t: null };
  const b = { t: null, u: true, z: { v: "s", y: [1, { w: 2, x: 1 }] } };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"t":null,"u":true,"z":{"v":"s","y":[1,{"w":2,"x":1}]}}');
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});

test("canonicalJson sorts integer-like keys as strings, so {9,10} and {10,9} hash alike", () => {
  assert.equal(canonicalJson({ 9: 1, 10: 2, b: 0 }), '{"10":2,"9":1,"b":0}');
  assert.equal(canonicalJson({ b: 0, 10: 2, 9: 1 }), canonicalJson({ 9: 1, 10: 2, b: 0 }));
});

test("canonicalJson orders unicode keys by code unit and keeps array order", () => {
  assert.equal(canonicalJson({ "é": 1, z: 2 }), '{"z":2,"é":1}');
  assert.equal(canonicalJson({ z: 2, "é": 1 }), '{"z":2,"é":1}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson({ a: [{}, [], ""] }), '{"a":[{},[],""]}');
});

test("canonicalJson keeps booleans, negative zero and string escapes exactly as JSON does", () => {
  assert.equal(canonicalJson(true), "true");
  assert.equal(canonicalJson(false), "false");
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(1e21), "1e+21");
  assert.equal(canonicalJson("tab\tnl\n \"q\""), JSON.stringify("tab\tnl\n \"q\""));
  assert.equal(canonicalJson("\ud800"), '"\\ud800"', "a lone surrogate is escaped, never emitted raw");
  assert.equal(canonicalJson("é"), '"é"');
});

test("canonicalJson rejects every non-JSON value with a coded HashError", () => {
  const bad = [undefined, () => {}, Symbol("s"), 10n, Number.NaN, -Number.POSITIVE_INFINITY, [undefined], { a: [1, () => {}] }, { a: { b: 1n } }];
  for (const value of bad) {
    assert.throws(() => canonicalJson(value), (e) => e instanceof HashError && e.code === "bad_json", String(value));
  }
});

// --- hashSheet across unicode ----------------------------------------------------

test("hashSheet is pinned for a unicode sheet with CRLF, trailing spaces and emoji", () => {
  const pinned = "3d85ba608492be5e976bd3acf1074434865398a6dc8ff398cdda5ad99d518fbf";
  assert.equal(hashSheet("Café ☕ 世界\r\n  🌍 line two  \n"), pinned);
  assert.equal(hashSheet("Café ☕ 世界\n  🌍 line two"), pinned);
  assert.equal(pinned, sha("Café ☕ 世界\n  🌍 line two\n"));
});

test("hashSheet treats composed and decomposed spellings alike, but not compatibility forms", () => {
  assert.equal(hashSheet("Café"), hashSheet("Café"));
  assert.equal(hashSheet("한"), hashSheet("한"), "Hangul jamo compose under NFC");
  assert.equal(hashSheet("Å"), hashSheet("Å"), "the Angstrom sign canonically composes to Å");
  assert.notEqual(hashSheet("ﬁ"), hashSheet("fi"), "NFC keeps the ligature");
  assert.notEqual(hashSheet("①"), hashSheet("1"));
  assert.notEqual(hashSheet("Ａ"), hashSheet("A"), "full-width letters stay distinct");
});

test("hashSheet strips unicode whitespace and a BOM at the edges but keeps it inside a line", () => {
  const base = hashSheet("a");
  assert.equal(hashSheet("a "), base, "trailing no-break space");
  assert.equal(hashSheet("a　"), base, "trailing ideographic space");
  assert.equal(hashSheet("﻿a"), base, "leading byte-order mark");
  assert.equal(hashSheet(" a "), base, "em spaces at both ends");
  assert.notEqual(hashSheet("a b"), hashSheet("a b"), "an inner no-break space is content");
  assert.notEqual(hashSheet("a\u0000"), base, "NUL is content, not whitespace");
  assert.notEqual(hashSheet("a​"), base, "a zero-width space is content");
});

test("hashSheet keeps blank lines between paragraphs, empties whitespace-only lines and is case sensitive", () => {
  assert.notEqual(hashSheet("a\n\nb"), hashSheet("a\nb"));
  assert.equal(hashSheet("a\n   \nb"), hashSheet("a\n\nb"));
  assert.equal(hashSheet("a\rb"), hashSheet("a\nb"));
  assert.equal(hashSheet("a\r\n\rb"), hashSheet("a\n\nb"));
  assert.notEqual(hashSheet("a  b"), hashSheet("a b"));
  assert.notEqual(hashSheet("Abc"), hashSheet("abc"));
  assert.equal(normalizeSheet("  x  \n\n  y\t\n\n"), "x\n\n  y\n");
});

test("hashSheet is independent of how the same text is built, and distinct for a one-character change", () => {
  const words = ["I", "watch.", "I", "wait."];
  const joined = words.join(" ");
  assert.equal(hashSheet(joined), hashSheet(`${words.slice(0, 2).join(" ")} ${words.slice(2).join(" ")}`));
  assert.equal(hashSheet(joined), hashSheet([...joined].join("")));
  assert.notEqual(hashSheet(joined), hashSheet(joined.replace("wait", "wait.")));
  assert.equal(hashSheet(joined), sha(`${joined}\n`));
  assert.equal(hashSheet("x".repeat(100_000)).length, 64);
});

test("sha256Hex hashes UTF-8 bytes, not UTF-16 or latin1", () => {
  assert.equal(sha256Hex("é"), createHash("sha256").update(Buffer.from("é", "utf8")).digest("hex"));
  assert.notEqual(sha256Hex("é"), createHash("sha256").update(Buffer.from("é", "latin1")).digest("hex"));
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("normalizeSheet and hashSheet reject non-strings and whitespace-only unicode", () => {
  for (const value of [null, undefined, 0, 1n, [], {}, Buffer.from("a"), "", " 　﻿", "\r\n\r\n", " \t "]) {
    assert.throws(() => hashSheet(value), (e) => e instanceof HashError && e.code === "bad_sheet", JSON.stringify(String(value)));
    assert.throws(() => normalizeSheet(value), (e) => e instanceof HashError && e.code === "bad_sheet");
  }
});

// --- the sheet-hash format ----------------------------------------------------------

test("SHEET_HASH_RE accepts exactly 64 lowercase hex characters and nothing around them", () => {
  const ok = hashSheet("x");
  assert.match(ok, SHEET_HASH_RE);
  assert.match("0".repeat(64), SHEET_HASH_RE);
  assert.match("abcdef0123456789".repeat(4), SHEET_HASH_RE);
  const bad = [
    "", ok.slice(0, 63), `${ok}0`, ok.toUpperCase(), `${ok.slice(0, 63)}G`, `0x${ok.slice(2)}`,
    ` ${ok}`, `${ok} `, `${ok}\n`, `\n${ok}`, ok.replace("a", "а"), `${ok.slice(0, 32)}\u0000${ok.slice(33)}`,
  ];
  for (const value of bad) assert.doesNotMatch(value, SHEET_HASH_RE, JSON.stringify(value));
  assert.equal(SHEET_HASH_RE.flags, "", "no global or multiline flags, so `$` cannot match before a trailing newline");
});
