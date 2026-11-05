import assert from "node:assert/strict";
import { test } from "node:test";
import { plural } from "./plural.mjs";

test("negative zero, boundary integers and the float just under one are not singular", () => {
  assert.equal(plural(-0, "round"), "0 rounds");
  assert.equal(plural(Number.MAX_SAFE_INTEGER, "round"), "9007199254740991 rounds");
  assert.equal(plural(0.9999999999999999, "round"), "0.9999999999999999 rounds");
  assert.equal(plural(1.0000000000000002, "round"), "1.0000000000000002 rounds");
});

test("NaN and Infinity print as they are and use the plural", () => {
  assert.equal(plural(NaN, "round"), "NaN rounds");
  assert.equal(plural(Infinity, "round"), "Infinity rounds");
  assert.equal(plural(-Infinity, "round"), "-Infinity rounds");
});

test("one-element array, boolean true and bigint 1 coerce to the singular", () => {
  assert.equal(plural([1], "round"), "1 round");
  assert.equal(plural(true, "round"), "true round");
  assert.equal(plural(1n, "round"), "1 round");
  assert.equal(plural(2n, "round"), "2 rounds");
  assert.equal(plural(false, "round"), "false rounds");
});

test("padded and hex numeric strings follow Number() coercion but print verbatim", () => {
  assert.equal(plural(" 1 ", "round"), " 1  round");
  assert.equal(plural("0x1", "round"), "0x1 round");
  assert.equal(plural("1e0", "round"), "1e0 round");
  assert.equal(plural("one", "round"), "one rounds");
  assert.equal(plural("", "round"), " rounds");
});

test("an explicit undefined plural falls back to the default; null and empty are used as given", () => {
  assert.equal(plural(2, "round", undefined), "2 rounds");
  assert.equal(plural(2, "round", ""), "2 ");
  assert.equal(plural(2, "round", null), "2 null");
  assert.equal(plural(1, "round", ""), "1 round");
});

test("the default plural is built from the singular, so odd nouns get a plain s", () => {
  assert.equal(plural(3, ""), "3 s");
  assert.equal(plural(2, "family"), "2 familys");
  assert.equal(plural(2, "👨‍👩‍👧"), "2 👨‍👩‍👧s");
  assert.equal(plural(2, "é"), "2 és");
  assert.equal(plural(2, "constructor"), "2 constructors");
  assert.equal(plural(1, "__proto__"), "1 __proto__");
});

test("a very long noun is passed through whole", () => {
  const noun = "x".repeat(100_000);
  assert.equal(plural(1, noun).length, 100_002);
  assert.equal(plural(2, noun).length, 100_003);
  assert.ok(plural(2, noun).endsWith("xs"));
});

test("a symbol count is the one input that throws", () => {
  assert.throws(() => plural(Symbol("n"), "round"), TypeError);
});
