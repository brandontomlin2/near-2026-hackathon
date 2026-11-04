// "count + noun" text a user reads: zero, one, many, and odd counts.
import assert from "node:assert/strict";
import test from "node:test";

import { plural } from "./plural.mjs";

test("zero, one and many read naturally", () => {
  assert.equal(plural(0, "round"), "0 rounds");
  assert.equal(plural(1, "round"), "1 round");
  assert.equal(plural(2, "round"), "2 rounds");
  assert.equal(plural(1000000, "round"), "1000000 rounds");
});

test("irregular plurals use the supplied form, and one still uses the singular", () => {
  assert.equal(plural(0, "summary", "summaries"), "0 summaries");
  assert.equal(plural(1, "summary", "summaries"), "1 summary");
  assert.equal(plural(3, "summary", "summaries"), "3 summaries");
  assert.equal(plural(2, "child", "children"), "2 children");
});

test("numeric strings and 1.0 count as one; negatives and fractions are plural", () => {
  assert.equal(plural("1", "round"), "1 round");
  assert.equal(plural(1.0, "round"), "1 round");
  assert.equal(plural(-1, "round"), "-1 rounds");
  assert.equal(plural(0.5, "round"), "0.5 rounds");
  assert.equal(plural(1.5, "round"), "1.5 rounds");
});

test("unicode and whitespace nouns pass through untouched", () => {
  assert.equal(plural(1, "tâche"), "1 tâche");
  assert.equal(plural(2, "tâche"), "2 tâches");
  assert.equal(plural(2, "😀"), "2 😀s");
  assert.equal(plural(2, "agent run"), "2 agent runs");
  assert.equal(plural(1, ""), "1 ");
});

test("never throws on a missing count, and never reads as one", () => {
  assert.doesNotMatch(plural(undefined, "round"), /^1 /);
  assert.equal(plural(NaN, "round"), "NaN rounds");
  assert.equal(plural(null, "round"), "null rounds");
});
