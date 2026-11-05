// Edge cases for the hash helpers: hostile object shapes, prototype-named keys,
// getters and accessors, long inputs and hash stability across builds of the
// same value. Pure functions only; nothing here touches a network.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { HashError, canonicalJson, hashSheet, normalizeSheet, sha256Hex } from "./hash.mjs";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

test("prototype-named own keys from JSON.parse are hashed as ordinary data and pollute nothing", () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":2}},"prototype":3}');
  assert.equal(
    canonicalJson(parsed),
    '{"__proto__":{"polluted":1},"constructor":{"prototype":{"x":2}},"prototype":3}',
  );
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).x, undefined);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
});

test("an own __proto__ key hashes the same whatever order the keys were parsed in", () => {
  const a = JSON.parse('{"__proto__":1,"a":2,"constructor":3}');
  const b = JSON.parse('{"constructor":3,"a":2,"__proto__":1}');
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});

test("an own __proto__ key is not the same data as a missing key or an inherited prototype", () => {
  const own = JSON.parse('{"__proto__":{"k":1}}');
  const inherited = { __proto__: { k: 1 } }; // literal form sets the prototype, not a key
  assert.notEqual(canonicalJson(own), canonicalJson({}));
  // A plain-looking object whose prototype was swapped is not hashable at all.
  assert.throws(() => canonicalJson(inherited), { name: "HashError", code: "bad_json" });
});

test("a null-prototype object hashes like the equivalent plain object", () => {
  const bare = Object.create(null);
  bare.b = 1;
  bare.a = [true, null];
  assert.equal(canonicalJson(bare), canonicalJson({ a: [true, null], b: 1 }));
});

test("objects with a changed or foreign prototype are refused, even when they look plain", () => {
  const sub = Object.create({ inherited: 1 });
  sub.own = 2;
  for (const bad of [sub, Object.create(Array.prototype), new (class Sheet { a = 1; })(), new Error("x"), /re/, new Uint8Array(2)]) {
    assert.throws(() => canonicalJson(bad), { name: "HashError", code: "bad_json" });
  }
});

test("only own enumerable string keys are hashed: symbols and non-enumerables are ignored", () => {
  const o = { a: 1 };
  Object.defineProperty(o, "hidden", { value: 9, enumerable: false });
  o[Symbol("s")] = 5;
  assert.equal(canonicalJson(o), '{"a":1}');
});

test("accessor properties are read once through the getter and the result is hashed", () => {
  let reads = 0;
  const o = {
    get a() {
      reads += 1;
      return "v";
    },
  };
  assert.equal(canonicalJson(o), '{"a":"v"}');
  assert.equal(reads, 1);
});

test("a throwing getter surfaces the caller's own error rather than being swallowed into a hash", () => {
  const o = {
    get a() {
      throw new RangeError("getter boom");
    },
  };
  assert.throws(() => canonicalJson(o), { name: "RangeError", message: "getter boom" });
});

test("a refusal anywhere in a nested value refuses the whole value, with no partial output", () => {
  const cases = [
    { a: [1, { b: [2, undefined] }] },
    { a: { b: { c: Infinity } } },
    [[[[1n]]]],
    { list: [() => 1] },
    { when: new Date(0) },
  ];
  for (const bad of cases) {
    assert.throws(() => canonicalJson(bad), (err) => err instanceof HashError && err.code === "bad_json");
  }
});

test("repeated and aliased (non-cyclic) references hash by value, not by identity", () => {
  const shared = { z: 1, a: [1, 2] };
  const dag = { first: shared, second: shared, list: [shared, shared] };
  const copy = {
    first: { a: [1, 2], z: 1 },
    second: { a: [1, 2], z: 1 },
    list: [{ a: [1, 2], z: 1 }, { z: 1, a: [1, 2] }],
  };
  assert.equal(canonicalJson(dag), canonicalJson(copy));
});

test("canonicalJson output parses back to the same data and re-canonicalizes to itself", () => {
  const value = {
    "": 0,
    "k\"q": [" ", "\n", "é", "😀"],
    nested: { "\u0000": null, big: 1e21, small: 1e-7, neg: -123.456 },
  };
  const text = canonicalJson(value);
  assert.deepEqual(JSON.parse(text), value);
  assert.equal(canonicalJson(JSON.parse(text)), text);
});

test("the empty key, empty containers and a lone scalar each have one fixed form", () => {
  assert.equal(canonicalJson({ "": {} }), '{"":{}}');
  assert.equal(canonicalJson([[], {}]), "[[],{}]");
  assert.equal(canonicalJson("x"), '"x"');
  assert.equal(canonicalJson(0), "0");
  assert.equal(canonicalJson(null), "null");
});

test("a lone surrogate is escaped in canonical JSON so the text stays valid and reversible", () => {
  const text = canonicalJson({ s: "a\ud800b" });
  assert.equal(text, '{"s":"a\\ud800b"}');
  assert.equal(JSON.parse(text).s, "a\ud800b");
  // High and low halves are different strings and stay different in canonical JSON.
  assert.notEqual(canonicalJson("\ud800"), canonicalJson("\udfff"));
});

test("a 3 MB sheet with CRLF and trailing spaces hashes deterministically and quickly", () => {
  const unit = "The quick brown fox jumps over the lazy dog.   \r\n";
  const noisy = unit.repeat(Math.ceil((3 * 1024 * 1024) / unit.length));
  assert.ok(noisy.length > 3 * 1024 * 1024);
  const clean = noisy.replace(/\r\n/g, "\n").replace(/ +\n/g, "\n");
  const started = Date.now();
  const hash = hashSheet(noisy);
  assert.ok(Date.now() - started < 2000);
  assert.equal(hash, hashSheet(noisy));
  assert.equal(hash, hashSheet(clean));
  assert.equal(hash, sha(clean.trim() + "\n"));
});

test("a long single-line sheet and the same sheet with one changed character differ", () => {
  const base = "x".repeat(2 * 1024 * 1024);
  const changed = `${base.slice(0, 1_000_000)}y${base.slice(1_000_001)}`;
  assert.equal(base.length, changed.length);
  assert.notEqual(hashSheet(base), hashSheet(changed));
});

test("a 4 MB multibyte string is hashed over its UTF-8 bytes", () => {
  const text = "é中😀".repeat(300_000); // 2 + 3 + 4 bytes per repeat
  assert.equal(Buffer.byteLength(text, "utf8"), 9 * 300_000);
  assert.equal(sha256Hex(text), sha(text));
});

test("canonicalJson of an object with 50,000 keys is independent of insertion order", () => {
  const forward = {};
  const backward = {};
  const n = 50_000;
  for (let i = 0; i < n; i += 1) forward[`key${i}`] = i;
  for (let i = n - 1; i >= 0; i -= 1) backward[`key${i}`] = i;
  const a = canonicalJson(forward);
  assert.equal(a, canonicalJson(backward));
  assert.ok(a.startsWith('{"key0":0,"key1":1,"key10":10,'));
  assert.equal(JSON.parse(a).key49999, 49999);
});

test("canonicalJson handles an array of 200,000 numbers and a nesting depth of 500", () => {
  const nums = Array.from({ length: 200_000 }, (_, i) => i);
  const text = canonicalJson(nums);
  assert.equal(text.length, JSON.stringify(nums).length);
  let deep = "leaf";
  for (let i = 0; i < 500; i += 1) deep = { d: [deep] };
  const deepText = canonicalJson(deep);
  assert.equal(deepText, JSON.stringify(deep));
});

test("sha256Hex and canonicalJson inputs are never mutated or reordered in place", () => {
  const value = { b: [3, 2, 1], a: { y: 1, x: 2 } };
  const before = JSON.stringify(value);
  canonicalJson(value);
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(Object.keys(value), ["b", "a"]);
  assert.deepEqual(Object.keys(value.a), ["y", "x"]);
});

test("normalizeSheet is idempotent and hashSheet(normalizeSheet(x)) equals hashSheet(x)", () => {
  for (const raw of ["  a  \r\n\r\n b\t\r", "é́\n", "﻿hello", "one\n\n\n\ntwo"]) {
    const once = normalizeSheet(raw);
    assert.equal(normalizeSheet(once), once);
    assert.equal(hashSheet(once), hashSheet(raw));
  }
});

test("hashSheet rejects every non-string with the same coded error and does not coerce", () => {
  const hostile = [null, undefined, 0, NaN, 1n, true, [], ["a"], {}, { toString: () => "text" }, Symbol("s"), () => "a", new String("abc"), Buffer.from("abc")];
  for (const bad of hostile) {
    assert.throws(() => hashSheet(bad), (err) => err instanceof HashError && err.code === "bad_sheet");
  }
});

test("sha256Hex rejects boxed strings and byte arrays, and hashes the empty string", () => {
  for (const bad of [new String("abc"), Buffer.from("abc"), new Uint8Array(1), ["a"]]) {
    assert.throws(() => sha256Hex(bad), (err) => err instanceof HashError && err.code === "bad_text");
  }
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
