// The seeded roster as shared state: lookups must not leak or share mutable data between calls.
import assert from "node:assert/strict";
import test from "node:test";

import { AGENTS, agentById } from "./agents.mjs";
import { TRAIT_KEYS, assertTraits } from "./validate.mjs";

test("the roster ids are unique, so agentById is a function of the id alone", () => {
  const ids = AGENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.equal(AGENTS.filter((a) => a.id === id).length, 1);
});

test("names and personalities are unique as well (they are shown side by side)", () => {
  assert.equal(new Set(AGENTS.map((a) => a.name)).size, AGENTS.length);
  assert.equal(new Set(AGENTS.map((a) => a.personality)).size, AGENTS.length);
});

test("every lookup returns the same reference each time, and a rejected mutation changes nothing", () => {
  for (const { id } of AGENTS) {
    const a = agentById(id);
    assert.equal(agentById(id), a);
    assert.throws(() => { a.traits.risk = "wary"; }, TypeError);
    assert.throws(() => { Object.defineProperty(a, "name", { value: "X" }); }, TypeError);
    assert.throws(() => Object.setPrototypeOf(a, null), TypeError);
    assert.equal(agentById(id).name, AGENTS.find((x) => x.id === id).name);
  }
});

test("copies handed to callers (spread, structuredClone, JSON) are mutable and do not affect later lookups", () => {
  const original = JSON.stringify(AGENTS);
  const spread = { ...agentById("aloof"), traits: { ...agentById("aloof").traits } };
  spread.name = "Changed";
  spread.traits.risk = "high";
  const clone = structuredClone(agentById("chaotic"));
  clone.traits.voice = "flat";
  const list = [...AGENTS];
  list.reverse();
  list.pop();
  assert.equal(JSON.stringify(AGENTS), original);
  assert.equal(agentById("aloof").traits.risk, "low");
  assert.equal(agentById("chaotic").traits.voice, "loud");
  assert.equal(AGENTS[0].id, "aloof");
});

test("a structuredClone of an agent is an unfrozen, equal copy that re-validates through assertTraits", () => {
  for (const a of AGENTS) {
    const clone = structuredClone(a);
    assert.deepEqual(clone, a);
    assert.equal(Object.isFrozen(clone), false);
    const again = assertTraits(clone.traits);
    assert.deepEqual(again, a.traits);
    assert.notEqual(again, a.traits);
  }
});

test("map/filter over AGENTS keeps the roster order and returns new arrays", () => {
  const ids = AGENTS.map((a) => a.id);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, ["aloof", "chaotic", "social", "skeptic"]);
  assert.deepEqual(sorted, ["aloof", "chaotic", "skeptic", "social"]);
  const copy = AGENTS.slice();
  assert.notEqual(copy, AGENTS);
  assert.deepEqual(copy, [...AGENTS]);
  assert.equal(Object.isFrozen(copy), false);
  assert.equal(Object.isFrozen(AGENTS), true);
});

test("Object.entries and for..in over an agent expose only its four fields (no inherited extras)", () => {
  for (const a of AGENTS) {
    const seen = [];
    for (const k in a) seen.push(k);
    assert.deepEqual(seen, ["id", "name", "personality", "traits"]);
    assert.deepEqual(Object.keys(a.traits), TRAIT_KEYS);
    assert.deepEqual(Object.getOwnPropertySymbols(a), []);
  }
});

test("agentById ignores names and personalities: only the lowercase id resolves", () => {
  for (const a of AGENTS) {
    assert.throws(() => agentById(a.name), /unknown agent id/);
    assert.throws(() => agentById(a.personality), /unknown agent id/);
    assert.throws(() => agentById(a.personality.toLowerCase()), /unknown agent id/);
  }
});

test("a thrown unknown-id error is a plain Error whose message does not name the roster", () => {
  try {
    agentById("nobody");
    assert.fail("expected a throw");
  } catch (e) {
    assert.equal(e.constructor, Error);
    assert.equal(e.message, "unknown agent id: nobody");
  }
});

test("a BigInt id and a boolean id are described, not matched", () => {
  assert.throws(() => agentById(1n), { message: "unknown agent id: 1" });
  assert.throws(() => agentById(true), { message: "unknown agent id: true" });
});
