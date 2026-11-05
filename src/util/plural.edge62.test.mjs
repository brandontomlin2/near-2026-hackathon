// plural as callers pass counts: HTML-escaped strings, byte lengths, stats numbers, score fallbacks.
import assert from "node:assert/strict";
import test from "node:test";

import { plural } from "./plural.mjs";

test("a count that arrives as an escaped string (demo page) still reads singular at '1'", () => {
  assert.equal(plural("1", "word"), "1 word");
  assert.equal(plural("12", "word"), "12 words");
  assert.equal(plural("0", "word"), "0 words");
  assert.equal(plural("-1", "word"), "-1 words");
  assert.equal(plural("1.0", "word"), "1.0 word");
  assert.equal(plural("+1", "word"), "+1 word");
  assert.equal(plural("1_000", "word"), "1_000 words");
});

test("bigint counts print without an n suffix and only 1n is singular", () => {
  assert.equal(plural(0n, "post"), "0 posts");
  assert.equal(plural(1n, "post"), "1 post");
  assert.equal(plural(-1n, "post"), "-1 posts");
  assert.equal(plural(10n ** 30n, "post"), `${10n ** 30n} posts`);
});

test("a count of exactly 1 with explicit many form always uses the one form", () => {
  assert.equal(plural(1, "warm moment", "warm moments"), "1 warm moment");
  assert.equal(plural(0, "warm moment", "warm moments"), "0 warm moments");
  assert.equal(plural(1, "fight", "fights"), "1 fight");
});

test("counts built from sums with fallbacks (ask.mjs) behave", () => {
  const score = { fights: 0, hugs: 1, shrugs: 0 };
  assert.equal(plural((score?.fights ?? 0) + (score?.hugs ?? 0) + (score?.shrugs ?? 0), "exchange", "exchanges"), "1 exchange");
  assert.equal(plural((undefined?.fights ?? 0) + (undefined?.hugs ?? 0), "exchange", "exchanges"), "0 exchanges");
  assert.equal(plural(0.1 + 0.2, "round"), "0.30000000000000004 rounds");
  assert.equal(plural(0.5 + 0.5, "round"), "1 round");
});

test("a byte length from a Buffer or typed array is a plain integer count", () => {
  assert.equal(plural(Buffer.alloc(1).length, "byte"), "1 byte");
  assert.equal(plural(new Uint8Array(0).length, "byte"), "0 bytes");
  assert.equal(plural(new Uint8Array(64).length, "byte"), "64 bytes");
});

test("exponent-form numbers print the way JavaScript prints them", () => {
  assert.equal(plural(1e21, "round"), "1e+21 rounds");
  assert.equal(plural(1e-7, "round"), "1e-7 rounds");
  assert.equal(plural(-1e21, "round"), "-1e+21 rounds");
});

test("objects with valueOf/toString follow Number() for choosing and String() for printing", () => {
  const one = { valueOf: () => 1, toString: () => "one" };
  assert.equal(plural(one, "round"), "one round");
  const date = new Date(1);
  assert.equal(plural(date, "round"), `${date} round`);
  assert.equal(plural(new Number(1), "round"), "1 round");
  assert.equal(plural(null, "round"), "null rounds");
});

test("a string many-form given as a number or object is printed as text", () => {
  assert.equal(plural(2, "round", 5), "2 5");
  assert.equal(plural(2, "round", { toString: () => "rondes" }), "2 rondes");
});

test("Infinity, -Infinity and NaN never read singular, with irregular forms too", () => {
  for (const n of [Infinity, -Infinity, NaN]) {
    assert.equal(plural(n, "summary", "summaries"), `${n} summaries`);
  }
});

test("zero-width and RTL nouns pass through in both forms", () => {
  assert.equal(plural(1, "رسالة"), "1 رسالة");
  assert.equal(plural(2, "رسالة"), "2 رسالةs");
  assert.equal(plural(2, "a​b"), "2 a​bs");
});
