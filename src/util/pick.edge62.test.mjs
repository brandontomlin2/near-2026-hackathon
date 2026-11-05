// pickBy as the memes/responder callers use it: keys built from seeds and counts, option lists of
// phrasing functions, and index arithmetic at the boundaries.
import assert from "node:assert/strict";
import test from "node:test";

import { fnv, pickBy } from "./pick.mjs";

test("pickBy picks index fnv(key) % length for every length from 1 to 9", () => {
  for (let len = 1; len <= 9; len += 1) {
    const options = Array.from({ length: len }, (_, i) => `o${i}`);
    for (const key of ["", "caption:seed:a:b:3:txt", "villain-top:x"]) {
      assert.equal(pickBy(options, key), options[fnv(key) % len], `${len} ${key}`);
    }
  }
});

test("a key whose hash is a multiple of the length picks index 0, and one below picks the last", () => {
  const options = ["a", "b", "c", "d", "e"];
  let zero = null;
  let last = null;
  for (let i = 0; i < 2000 && (zero === null || last === null); i += 1) {
    const h = fnv(`k${i}`) % 5;
    if (h === 0) zero = `k${i}`;
    if (h === 4) last = `k${i}`;
  }
  assert.equal(pickBy(options, zero), "a");
  assert.equal(pickBy(options, last), "e");
});

test("hash values above 2^31 still index non-negatively", () => {
  const options = ["a", "b", "c"];
  let found = 0;
  for (let i = 0; i < 500; i += 1) {
    const key = `big-${i}`;
    if (fnv(key) > 0x7fffffff) {
      found += 1;
      assert.ok(options.includes(pickBy(options, key)), key);
    }
  }
  assert.ok(found > 50, "expected plenty of keys hashing above 2^31");
});

test("the list is not modified and the same list can be re-picked after other lists are used", () => {
  const options = Object.freeze(["x", "y", "z"]);
  const before = pickBy(options, "k");
  pickBy(["p", "q"], "k");
  assert.equal(pickBy(options, "k"), before);
  assert.deepEqual([...options], ["x", "y", "z"]);
});

test("a sparse array hole is returned as undefined, not skipped", () => {
  // eslint-disable-next-line no-sparse-arrays
  const options = [, , ,];
  assert.equal(options.length, 3);
  assert.equal(pickBy(options, "any"), undefined);
});

test("function entries come back as the very same function so the caller can invoke them", () => {
  const fns = [({ n }) => `one ${n}`, ({ n }) => `two ${n}`, ({ n }) => `three ${n}`];
  const picked = pickBy(fns, "caption:42:a:b:2:txt");
  assert.ok(fns.includes(picked));
  assert.match(picked({ n: 7 }), /^(one|two|three) 7$/);
});

test("seed-style keys that differ only in a digit or separator are distinct hashes", () => {
  const keys = ["caption:1:a:b:2:x", "caption:2:a:b:2:x", "caption:1:a:b:3:x", "caption:1:a:b:2:y", "caption:1:a:b:2:x:", "caption:1:a:b:2x"];
  assert.equal(new Set(keys.map(fnv)).size, keys.length);
});

test("numeric keys at integer boundaries pick by their decimal text", () => {
  const options = Array.from({ length: 4 }, (_, i) => i);
  for (const n of [0, -0, 1, -1, 0.5, 2 ** 31, 2 ** 32, 2 ** 53, 1e21, 1e-7]) {
    assert.equal(pickBy(options, n), pickBy(options, String(n)), String(n));
  }
});

test("a non-positive-length or undefined options value does not pick a real entry", () => {
  assert.equal(pickBy([], "k"), undefined);
  assert.throws(() => pickBy(undefined, "k"), TypeError);
  assert.throws(() => pickBy(null, "k"), TypeError);
});

test("keys differing by Unicode normalisation or case are distinct picks of the hash", () => {
  assert.notEqual(fnv("Aloof"), fnv("aloof"));
  assert.notEqual(fnv("é"), fnv("é"));
  assert.equal(fnv("日本"), fnv("日本"));
});
