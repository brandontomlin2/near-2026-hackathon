import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TRAIT_KEYS, TRAIT_VALUES, validateTraits, assertTraits } from "./validate.mjs";
import { AGENTS, agentById } from "./agents.mjs";

const schema = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));
const good = { temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 1 };

test("empty object yields exactly one required error per key, in TRAIT_KEYS order", () => {
  assert.deepEqual(validateTraits({}), {
    valid: false,
    errors: TRAIT_KEYS.map((k) => `${k}: is required`),
  });
  assert.equal(validateTraits({}).errors.length, 5);
});

test("unknown keys are reported first, in Object.keys order, before missing keys", () => {
  const { voice, ...rest } = good;
  const input = { zeta: 1, ...rest, alpha: 2 };
  assert.deepEqual(validateTraits(input).errors, ["zeta: unknown key", "alpha: unknown key", "voice: is required"]);
});

test("errors accumulate across all five bad slots, one per key", () => {
  const r = validateTraits({ temperament: "x", role: "x", risk: "x", voice: "x", memory_depth: 0 });
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 5);
  TRAIT_KEYS.forEach((k, i) => assert.ok(r.errors[i].startsWith(`${k}: `), r.errors[i]));
});

test("arrays and non-objects yield only the single 'must be an object' error", () => {
  for (const v of [[], [good], "x", 1, undefined, null]) {
    assert.deepEqual(validateTraits(v), { valid: false, errors: ["traits: must be an object"] });
  }
});

test("present-but-undefined is a bad value, a deleted key is required", () => {
  assert.deepEqual(validateTraits({ ...good, voice: undefined }).errors, ["voice: must be one of dry, loud, open, flat"]);
  const gone = { ...good };
  delete gone.voice;
  assert.deepEqual(validateTraits(gone).errors, ["voice: is required"]);
});

test("inherited properties do not count as present", () => {
  const r = validateTraits(Object.create(good));
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, TRAIT_KEYS.map((k) => `${k}: is required`));
  assert.ok(!r.errors.some((e) => e.includes("unknown key")));
});

test("symbol-keyed extras are ignored", () => {
  const input = { ...good, [Symbol("extra")]: 1 };
  assert.deepEqual(validateTraits(input), { valid: true, errors: [] });
  assert.deepEqual(Object.keys(assertTraits(input)), [...TRAIT_KEYS]);
});

test("enums are exact-match: case, whitespace and empty string are rejected", () => {
  for (const v of ["Cool", " cool", "cool ", "COOL", ""]) {
    assert.equal(validateTraits({ ...good, temperament: v }).valid, false, JSON.stringify(v));
  }
  const probes = { role: "Observer", risk: " low", voice: "dry " };
  for (const [key, v] of Object.entries(probes)) {
    assert.deepEqual(validateTraits({ ...good, [key]: v }).errors.length, 1, key);
    assert.equal(validateTraits({ ...good, [key]: "" }).valid, false, key);
  }
});

test("enums reject non-string lookalikes", () => {
  for (const v of [null, 0, ["cool"], { toString: () => "cool" }, true]) {
    assert.equal(validateTraits({ ...good, temperament: v }).valid, false);
  }
});

test("memory_depth accepts only real integers in range", () => {
  for (const n of [3.0, 1e0, 12]) assert.equal(validateTraits({ ...good, memory_depth: n }).valid, true, String(n));
  const rejected = ["3", -0, 0, 13, Infinity, -Infinity, NaN, 2n, null, undefined, [3], 1.0000001];
  for (const n of rejected) {
    const r = validateTraits({ ...good, memory_depth: n });
    assert.equal(r.valid, false, String(typeof n === "bigint" ? `${n}n` : Object.is(n, -0) ? "-0" : n));
    assert.deepEqual(r.errors, ["memory_depth: must be an integer from 1 to 12"]);
  }
});

test("every error is shaped '<key>: ...' or 'traits: ...'", () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
  const inputs = [
    {},
    { x: 1, temperament: 1, role: 1, risk: 1, voice: 1, memory_depth: "a" },
    null,
    [],
    hostile,
  ];
  for (const input of inputs) {
    for (const e of validateTraits(input).errors) {
      assert.ok(/^[a-z_]+: /.test(e) || /^traits: /.test(e), e);
    }
  }
});

test("validateTraits returns a fresh errors array each call", () => {
  const a = validateTraits({});
  a.errors.push("junk");
  a.errors.length = 0;
  const b = validateTraits({});
  assert.notEqual(a.errors, b.errors);
  assert.equal(b.errors.length, 5);
  const c = validateTraits(null);
  c.errors.push("junk");
  assert.deepEqual(validateTraits(null).errors, ["traits: must be an object"]);
  const v1 = validateTraits(good);
  v1.errors.push("junk");
  assert.deepEqual(validateTraits(good).errors, []);
});

test("assertTraits output has exactly TRAIT_KEYS as own keys regardless of input order", () => {
  const shuffled = { voice: "dry", memory_depth: 4, temperament: "cool", risk: "low", role: "observer" };
  const out = assertTraits(shuffled);
  assert.deepEqual(Reflect.ownKeys(out), [...TRAIT_KEYS]);
  assert.ok(Object.isFrozen(out));
  assert.throws(() => { out.role = "auditor"; }, TypeError);
  assert.deepEqual(out, { ...good, memory_depth: 4 });
});

test("assertTraits output is decoupled from the input", () => {
  const input = { ...good };
  const out = assertTraits(input);
  input.temperament = "neon";
  input.memory_depth = 9;
  assert.equal(out.temperament, "cool");
  assert.equal(out.memory_depth, 1);
});

test("assertTraits accepts a frozen input and leaves it untouched", () => {
  const input = Object.freeze({ ...good });
  const out = assertTraits(input);
  assert.notEqual(out, input);
  assert.deepEqual(out, good);
  assert.ok(Object.isFrozen(input));
});

test("assertTraits rejects extra keys with a TypeError naming them", () => {
  assert.throws(
    () => assertTraits({ ...good, bonus: 1 }),
    (err) => err instanceof TypeError && err.message.includes("unknown key") && err.message.includes("bonus"),
  );
});

test("assertTraits message is the validateTraits errors joined with '; ' in order", () => {
  const input = { zeta: 1, temperament: "x", role: "observer", risk: "y", memory_depth: 99 };
  const { errors } = validateTraits(input);
  assert.ok(errors.length >= 4);
  assert.throws(
    () => assertTraits(input),
    (err) => err instanceof TypeError && err.message === errors.join("; "),
  );
});

test("assertTraits on a hostile proxy throws a TypeError, not the proxy's error", () => {
  const boom = new Error("boom");
  const hostile = new Proxy({}, { ownKeys() { throw boom; } });
  assert.throws(
    () => assertTraits(hostile),
    (err) => err !== boom && err instanceof TypeError && err.message.startsWith("traits: could not be read"),
  );
});

test("agents: ids and names are unique, ids match the channel author regex", () => {
  assert.equal(new Set(AGENTS.map((a) => a.id)).size, AGENTS.length);
  assert.equal(new Set(AGENTS.map((a) => a.name)).size, AGENTS.length);
  for (const a of AGENTS) {
    assert.match(a.id, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.equal(a.id, a.id.toLowerCase());
  }
});

test("agents: each enum trait takes each allowed value exactly once", () => {
  assert.equal(AGENTS.length, 4);
  for (const key of ["temperament", "role", "risk", "voice"]) {
    assert.deepEqual(AGENTS.map((a) => a.traits[key]).sort(), [...TRAIT_VALUES[key]].sort(), key);
  }
});

test("agents: every agent starts with memory_depth 1", () => {
  for (const a of AGENTS) assert.equal(a.traits.memory_depth, 1, a.id);
});

test("agentById throws an Error naming the id, including for undefined and null", () => {
  for (const id of ["nope", undefined, null]) {
    assert.throws(
      () => agentById(id),
      (err) => err instanceof Error && err.constructor === Error && err.message.includes(String(id)),
      String(id),
    );
  }
  for (const a of AGENTS) assert.equal(agentById(a.id), a);
});

test("AGENTS array is frozen", () => {
  assert.ok(Object.isFrozen(AGENTS));
  assert.throws(() => AGENTS.push({}), TypeError);
  assert.equal(AGENTS.length, 4);
});

test("every schema enum value is lowercase ASCII and validates in a good object", () => {
  for (const key of Object.keys(TRAIT_VALUES)) {
    const values = schema.properties[key].enum;
    assert.ok(values.length > 0, key);
    for (const v of values) {
      assert.match(v, /^[a-z]+$/, `${key}=${v}`);
      assert.deepEqual(validateTraits({ ...good, [key]: v }), { valid: true, errors: [] }, `${key}=${v}`);
    }
  }
});
