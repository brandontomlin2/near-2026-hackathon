// Edge cases for src/traits/agents.mjs not covered by agents.gaps15.test / validate.behavior.test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AGENTS, agentById } from "./agents.mjs";
import { validateTraits, TRAIT_KEYS } from "./validate.mjs";

test("agentById rejects object keys that exist on Object.prototype or Array.prototype", () => {
  for (const bad of ["hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__", "length", "0", "map", "find"]) {
    assert.throws(() => agentById(bad), { name: "Error", message: `unknown agent id: ${bad}` }, bad);
  }
});

test("agentById rejects numeric indexes 0..3 and their string forms (no array-index leakage)", () => {
  for (const bad of [0, 1, 2, 3, "0", "1", -1, 0.5, NaN, Infinity]) {
    assert.throws(() => agentById(bad), { message: `unknown agent id: ${String(bad)}` }, String(bad));
  }
});

test("agentById rejects String objects, objects with toString returning a real id, and arrays of one id", () => {
  assert.throws(() => agentById(new String("aloof")), /unknown agent id/);
  assert.throws(() => agentById({ toString: () => "aloof" }), /unknown agent id/);
  assert.throws(() => agentById(["social"]), /unknown agent id/);
});

test("agentById rejects unicode lookalikes, combining marks, ZWJ and emoji variants of real ids", () => {
  const bads = ["alo‍of", "aloof́", "аloof", "aloof​", "﻿aloof", "\u{1F600}", "\uD83D", "chaotic\0", "social\n", "ＳＫＥＰＴＩＣ", "skeptic "];
  for (const bad of bads) assert.throws(() => agentById(bad), /unknown agent id/, JSON.stringify(bad));
});

test("agentById with a very long id throws and echoes the id in full", () => {
  const long = "a".repeat(200_000);
  assert.throws(() => agentById(long), (e) => e.message === `unknown agent id: ${long}`);
});

test("agentById with a symbol or object with throwing toString: symbol is describable, hostile object surfaces its own error", () => {
  // String(Symbol()) works, so the lookup error is the normal one.
  assert.throws(() => agentById(Symbol("x")), { message: "unknown agent id: Symbol(x)" });
  // Object.create(null) has no toString: String() itself throws a TypeError.
  assert.throws(() => agentById(Object.create(null)), TypeError);
});

test("agentById is called without arguments: throws about 'undefined'", () => {
  assert.throws(() => agentById(), { message: "unknown agent id: undefined" });
});

test("agentById returns a deeply frozen agent: id, name, personality cannot be changed or deleted", () => {
  const a = agentById("aloof");
  assert.throws(() => { a.id = "x"; }, TypeError);
  assert.throws(() => { delete a.name; }, TypeError);
  assert.throws(() => { a.personality = "Z"; }, TypeError);
  assert.throws(() => { a.extra = 1; }, TypeError);
  assert.throws(() => { delete a.traits.role; }, TypeError);
  assert.throws(() => { a.traits.memory_depth = 12; }, TypeError);
  assert.equal(agentById("aloof").traits.memory_depth, 1);
});

test("the frozen roster cannot be shrunk, extended or reordered", () => {
  assert.throws(() => AGENTS.pop(), TypeError);
  assert.throws(() => AGENTS.shift(), TypeError);
  assert.throws(() => AGENTS.unshift({}), TypeError);
  assert.throws(() => AGENTS.reverse(), TypeError);
  assert.throws(() => AGENTS.sort(), TypeError);
  assert.throws(() => { AGENTS.length = 0; }, TypeError);
  assert.throws(() => { AGENTS[4] = {}; }, TypeError);
  assert.equal(AGENTS.length, 4);
});

test("each agent has exactly the keys id, name, personality, traits and traits has exactly TRAIT_KEYS in order", () => {
  for (const a of AGENTS) {
    assert.deepEqual(Object.keys(a), ["id", "name", "personality", "traits"], a.id);
    assert.deepEqual(Object.keys(a.traits), TRAIT_KEYS, a.id);
  }
});

test("every agent's string fields are non-empty plain strings, id is lowercase, name is id capitalised", () => {
  for (const a of AGENTS) {
    for (const f of ["id", "name", "personality"]) {
      assert.equal(typeof a[f], "string");
      assert.ok(a[f].length > 0);
      assert.equal(a[f], a[f].trim());
    }
    assert.equal(a.id, a.id.toLowerCase());
    assert.equal(a.name, a.id[0].toUpperCase() + a.id.slice(1));
    assert.match(a.id, /^[a-z]+$/);
  }
});

test("agent traits are a fresh, own validated object: validateTraits accepts a spread copy and rejects a 1-key tamper", () => {
  for (const a of AGENTS) {
    assert.deepEqual(validateTraits({ ...a.traits }), { valid: true, errors: [] });
    assert.equal(validateTraits({ ...a.traits, memory_depth: 13 }).valid, false);
    assert.equal(validateTraits({ ...a.traits, voice: "loud‍" }).valid, false);
  }
});

test("agent trait objects are distinct per agent (no shared traits reference)", () => {
  const refs = new Set(AGENTS.map((a) => a.traits));
  assert.equal(refs.size, AGENTS.length);
});

test("agentById resolves via own id only: lookups after a failed lookup still work", () => {
  assert.throws(() => agentById("nobody"));
  assert.equal(agentById("skeptic").name, "Skeptic");
  assert.throws(() => agentById("__proto__"));
  assert.equal(agentById("chaotic").traits.risk, "high");
});

test("the JSON form of an agent round-trips and keeps trait order", () => {
  for (const a of AGENTS) {
    const parsed = JSON.parse(JSON.stringify(a));
    assert.deepEqual(parsed, a);
    assert.deepEqual(Object.keys(parsed.traits), TRAIT_KEYS);
  }
});
