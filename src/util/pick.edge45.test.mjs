// Deterministic phrasing choice: the same key always gives the same line, in range, for any key.
import assert from "node:assert/strict";
import test from "node:test";

import { fnv, pickBy } from "./pick.mjs";

const OPTIONS = ["alpha", "beta", "gamma", "delta"];

test("the same key picks the same entry every time", () => {
  const first = pickBy(OPTIONS, "round 7");
  for (let i = 0; i < 50; i += 1) assert.equal(pickBy(OPTIONS, "round 7"), first);
});

test("fnv is pinned: empty string is the offset basis, known inputs keep their value", () => {
  assert.equal(fnv(""), 2166136261);
  assert.equal(fnv("a"), 0xe40c292c);
  assert.equal(fnv("foobar"), 0xbf9cf968);
});

test("empty, whitespace, unicode and emoji keys all pick a real entry", () => {
  for (const key of ["", " ", "\t\n", "é", "é", "日本語", "😀", "a b c", "../x y"]) {
    assert.ok(OPTIONS.includes(pickBy(OPTIONS, key)), JSON.stringify(key));
  }
});

test("emoji hash by code point, not by UTF-16 half, and composed differs from decomposed", () => {
  assert.notEqual(fnv("😀"), fnv("\ud83d"));
  assert.notEqual(fnv("é"), fnv("é"));
});

test("null, undefined and numbers are keys by their text, never an exception", () => {
  assert.equal(fnv(null), fnv("null"));
  assert.equal(fnv(undefined), fnv("undefined"));
  assert.equal(pickBy(OPTIONS, 12), pickBy(OPTIONS, "12"));
});

test("a single option is always chosen; different keys spread over many options", () => {
  assert.equal(pickBy(["only"], "anything"), "only");
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(pickBy(OPTIONS, `key-${i}`));
  assert.equal(seen.size, OPTIONS.length);
});
