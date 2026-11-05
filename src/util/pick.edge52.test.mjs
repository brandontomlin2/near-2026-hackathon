import assert from "node:assert/strict";
import { test } from "node:test";
import { fnv, pickBy } from "./pick.mjs";

test("fnv pins prototype-key names, a combining mark, a lone surrogate and negative zero", () => {
  assert.equal(fnv("constructor"), 4066221903);
  assert.equal(fnv("́"), 68021900);
  assert.equal(fnv("\ud83d"), 931276136);
  assert.equal(fnv(-0), fnv("0"));
});

test("fnv stringifies objects and arrays like String() does", () => {
  assert.equal(fnv({}), fnv("[object Object]"));
  assert.equal(fnv([1, 2]), fnv("1,2"));
  assert.equal(fnv(NaN), fnv("NaN"));
  assert.equal(fnv(Infinity), fnv("Infinity"));
  assert.notEqual(fnv([]), fnv({}));
});

test("fnv always returns an unsigned 32-bit integer, even for a very long key", () => {
  for (const key of ["", "a", "x".repeat(200_000), "é".repeat(5000), "🙂".repeat(5000)]) {
    const h = fnv(key);
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, `bad hash for key of length ${key.length}`);
  }
});

test("fnv is order-sensitive and ZWJ sequences differ from their parts", () => {
  assert.notEqual(fnv("ab"), fnv("ba"));
  assert.notEqual(fnv("👨‍👩"), fnv("👨👩"));
  assert.notEqual(fnv("a"), fnv("a​"));
});

test("fnv hashes a symbol key by its description text, since String() accepts symbols", () => {
  assert.equal(fnv(Symbol("k")), fnv("Symbol(k)"));
});

test("pickBy on an empty list returns undefined instead of throwing", () => {
  assert.equal(pickBy([], "any key"), undefined);
});

test("pickBy with prototype-key names picks a real, stable entry", () => {
  const options = ["a", "b", "c"];
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const first = pickBy(options, key);
    assert.ok(options.includes(first), key);
    assert.equal(pickBy(options, key), first);
    assert.equal(first, options[fnv(key) % 3]);
  }
});

test("pickBy accepts a string or array-like as the options and indexes it", () => {
  assert.equal(pickBy("x", "k"), "x");
  assert.equal(pickBy({ length: 2, 0: "p", 1: "q" }, "k"), ["p", "q"][fnv("k") % 2]);
});

test("pickBy can return a falsy or undefined entry as stored", () => {
  assert.equal(pickBy([0], "k"), 0);
  assert.equal(pickBy([null], "k"), null);
  assert.equal(pickBy([undefined], "k"), undefined);
});

test("pickBy with NaN, a number and its string spelling choose the same entry", () => {
  const options = Array.from({ length: 7 }, (_, i) => `o${i}`);
  assert.equal(pickBy(options, NaN), pickBy(options, "NaN"));
  assert.equal(pickBy(options, 42), pickBy(options, "42"));
  assert.equal(pickBy(options, Number.MAX_SAFE_INTEGER), pickBy(options, "9007199254740991"));
});

test("pickBy over a long list reaches the last index for some key", () => {
  const options = Array.from({ length: 5 }, (_, i) => i);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(pickBy(options, `key-${i}`));
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
});
