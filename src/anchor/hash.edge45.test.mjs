// Hashing as a user sees it: same input -> same hash, different input -> different hash,
// and a clear coded error (never "{}" or a raw Node error) for input that cannot be hashed.
import assert from "node:assert/strict";
import test from "node:test";

import { HashError, SHEET_HASH_RE, canonicalJson, hashSheet, normalizeSheet, sha256Hex } from "./hash.mjs";

test("hashSheet is deterministic and matches the lowercase 64-hex shape", () => {
  const h = hashSheet("Name: Ada\nRole: scout");
  for (let i = 0; i < 20; i += 1) assert.equal(hashSheet("Name: Ada\nRole: scout"), h);
  assert.match(h, SHEET_HASH_RE);
});

test("different words give different hashes; editor noise gives the same hash", () => {
  const base = hashSheet("Name: Ada\nRole: scout");
  assert.notEqual(hashSheet("Name: Ada\nRole: scouts"), base);
  assert.notEqual(hashSheet("name: Ada\nRole: scout"), base);
  assert.notEqual(hashSheet("Name: Ada\n\nRole: scout"), base);
  assert.equal(hashSheet("\n\nName: Ada   \r\nRole: scout\t\r\n\r\n"), base);
  assert.equal(hashSheet("Name: Ada\rRole: scout"), base);
});

test("a one-line sheet of unicode (accents, emoji, CJK) is stable and one-final-newline", () => {
  assert.equal(normalizeSheet("  日本語 😀 café  "), "  日本語 😀 café\n".replace(/^ +/, ""));
  assert.equal(hashSheet("café"), hashSheet("café"));
  assert.notEqual(hashSheet("café"), hashSheet("cafe"));
});

test("empty, whitespace-only and non-string sheets fail with a plain coded message", () => {
  for (const bad of ["", " ", "\n\t \r\n", "  "]) {
    assert.throws(() => hashSheet(bad), (e) => e instanceof HashError && e.code === "bad_sheet" && e.message === "sheet is empty after normalizing");
  }
  for (const bad of [null, undefined, 42, {}, ["a"], Buffer.from("a")]) {
    assert.throws(() => hashSheet(bad), (e) => e instanceof HashError && e.code === "bad_sheet" && e.message === "sheet must be a string");
  }
});

test("canonicalJson is key-order independent and different data gives different hashes", () => {
  const a = canonicalJson({ b: [1, { y: 1, x: 2 }], a: "é" });
  assert.equal(a, canonicalJson({ a: "é", b: [1, { x: 2, y: 1 }] }));
  assert.notEqual(sha256Hex(a), sha256Hex(canonicalJson({ a: "é", b: [1, { x: 2, y: 2 }] })));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson(null), "null");
});

test("canonicalJson refuses values that would silently hash as {} (Date, Map, Set, class instances)", () => {
  class Box {
    constructor() {
      this.v = 1;
    }
  }
  for (const bad of [new Date(0), new Map([[1, 2]]), new Set([1]), new Box(), /x/]) {
    assert.throws(() => canonicalJson(bad), (e) => e instanceof HashError && e.code === "bad_json", String(bad));
    assert.throws(() => canonicalJson({ nested: [bad] }), (e) => e instanceof HashError && e.code === "bad_json");
  }
  assert.equal(canonicalJson(Object.create(null)), "{}");
});

test("canonicalJson rejects undefined, NaN, Infinity, bigint, symbol and function with a named reason", () => {
  assert.throws(() => canonicalJson({ a: undefined }), /unsupported type undefined/);
  assert.throws(() => canonicalJson([NaN]), /non-finite number/);
  assert.throws(() => canonicalJson(Infinity), /non-finite number/);
  assert.throws(() => canonicalJson(1n), /unsupported type bigint/);
  assert.throws(() => canonicalJson(Symbol("s")), /unsupported type symbol/);
  assert.throws(() => canonicalJson(() => 1), /unsupported type function/);
});

test("sha256Hex of non-text input is a coded HashError, not a raw Node error", () => {
  for (const bad of [undefined, null, 5, {}]) {
    assert.throws(() => sha256Hex(bad), (e) => e instanceof HashError && e.code === "bad_text" && !/ERR_INVALID_ARG/.test(e.message));
  }
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
