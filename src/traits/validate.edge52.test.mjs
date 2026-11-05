// Edge cases for src/traits/validate.mjs not covered by validate.test / validate.behavior.test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateTraits, assertTraits, TRAIT_KEYS } from "./validate.mjs";

const GOOD = Object.freeze({ temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 5 });
const good = (over = {}) => ({ ...GOOD, ...over });

test("a JSON.parse'd own __proto__ key is reported as an unknown key, not swallowed as a prototype", () => {
  const withProto = JSON.parse('{"temperament":"cool","role":"observer","risk":"low","voice":"dry","memory_depth":2,"__proto__":{"x":1}}');
  const r = validateTraits(withProto);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ["__proto__: unknown key"]);
});

test("an object whose only key is a JSON-parsed __proto__ gets unknown-key then every required error", () => {
  const r = validateTraits(JSON.parse('{"__proto__":{"temperament":"cool"}}'));
  assert.deepEqual(r.errors, [
    "__proto__: unknown key",
    ...TRAIT_KEYS.map((k) => `${k}: is required`),
  ]);
});

test("a normal literal { __proto__: {...} } sets the prototype, so inherited traits do not count", () => {
  const r = validateTraits({ __proto__: good() });
  assert.deepEqual(r.errors, TRAIT_KEYS.map((k) => `${k}: is required`));
});

test("prototype-method names as extra keys are unknown keys, in insertion order", () => {
  const r = validateTraits(JSON.parse('{"constructor":1,"toString":2,"hasOwnProperty":3,"valueOf":4}'));
  assert.deepEqual(r.errors.slice(0, 4), [
    "constructor: unknown key",
    "toString: unknown key",
    "hasOwnProperty: unknown key",
    "valueOf: unknown key",
  ]);
  assert.equal(r.errors.length, 4 + TRAIT_KEYS.length);
});

test("a null-prototype object with valid traits validates", () => {
  const o = Object.assign(Object.create(null), GOOD);
  assert.deepEqual(validateTraits(o), { valid: true, errors: [] });
});

test("a null-prototype object with an unknown key is still checked", () => {
  const o = Object.assign(Object.create(null), GOOD, { extra: 1 });
  assert.deepEqual(validateTraits(o).errors, ["extra: unknown key"]);
});

test("assertTraits turns a null-prototype input into an ordinary frozen object", () => {
  const o = Object.assign(Object.create(null), GOOD);
  const out = assertTraits(o);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.isFrozen(out));
  assert.deepEqual(out, GOOD);
});

test("assertTraits does not carry a JSON-parsed __proto__ through: it throws naming the key", () => {
  const withProto = JSON.parse('{"temperament":"cool","role":"observer","risk":"low","voice":"dry","memory_depth":2,"__proto__":{"polluted":true}}');
  assert.throws(() => assertTraits(withProto), { name: "TypeError", message: "__proto__: unknown key" });
  assert.equal({}.polluted, undefined);
});

test("trait values named like prototype members are not accepted as enum values", () => {
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "length", "0", "includes"]) {
    for (const key of ["temperament", "role", "risk", "voice"]) {
      assert.equal(validateTraits(good({ [key]: bad })).valid, false, `${key}=${bad}`);
    }
  }
});

test("non-plain objects are objects: a Date, Map or class instance has every key missing", () => {
  class Foo {}
  for (const v of [new Date(0), new Map(), new Set(), new Foo(), /re/, new Error("x")]) {
    const r = validateTraits(v);
    assert.equal(r.valid, false);
    assert.deepEqual(r.errors, TRAIT_KEYS.map((k) => `${k}: is required`), Object.prototype.toString.call(v));
  }
});

test("a class instance carrying valid own traits validates", () => {
  class Traitful { constructor() { Object.assign(this, GOOD); } }
  assert.equal(validateTraits(new Traitful()).valid, true);
});

test("functions, bigint, symbol, booleans and strings are rejected with the single object error", () => {
  for (const v of [() => GOOD, 5n, Symbol("s"), true, false, "cool", 0, NaN, Infinity, -0]) {
    assert.deepEqual(validateTraits(v), { valid: false, errors: ["traits: must be an object"] }, String(typeof v));
  }
});

test("typed arrays and array subclasses are not objects for this purpose only when Array.isArray says so", () => {
  assert.deepEqual(validateTraits(Object.assign([], GOOD)).errors, ["traits: must be an object"]);
  const typed = validateTraits(new Uint8Array(2));
  assert.equal(typed.valid, false);
  assert.ok(typed.errors.includes("0: unknown key"));
  assert.ok(typed.errors.includes("role: is required"));
});

test("boxed primitives validate as objects with no own trait keys (indices are unknown keys)", () => {
  const r = validateTraits(new String("ab"));
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors.slice(0, 2), ["0: unknown key", "1: unknown key"]);
});

test("memory_depth: -0 and 0 are out of range, just-below and just-above bounds are rejected", () => {
  for (const n of [-0, 0, 0.9999999999999999, 1.0000000000000002, 11.999999999999998, 12.000000000000002, 13, -1, -12]) {
    const r = validateTraits(good({ memory_depth: n }));
    assert.equal(r.valid, false, String(n));
    assert.deepEqual(r.errors, ["memory_depth: must be an integer from 1 to 12"], String(n));
  }
});

test("memory_depth: 1 and 12 as float literals (1.0, 12e0) are the integers they are", () => {
  assert.equal(validateTraits(good({ memory_depth: 1.0 })).valid, true);
  assert.equal(validateTraits(good({ memory_depth: 12e0 })).valid, true);
  assert.equal(validateTraits(good({ memory_depth: 1.2e1 })).valid, true);
});

test("memory_depth: huge and non-finite numbers are rejected", () => {
  for (const n of [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, Number.EPSILON, NaN, Infinity, -Infinity, 2 ** 53]) {
    assert.equal(validateTraits(good({ memory_depth: n })).valid, false, String(n));
  }
});

test("memory_depth: numeric lookalikes of every in-range value are rejected", () => {
  for (let i = 1; i <= 12; i++) {
    for (const lookalike of [String(i), BigInt(i), [i], { valueOf: () => i }, new Number(i), `${i} `, `0x${i.toString(16)}`]) {
      assert.equal(validateTraits(good({ memory_depth: lookalike })).valid, false, `${i}:${typeof lookalike}`);
    }
  }
});

test("every integer 1..12 is accepted and 0 and 13 are not (exhaustive sweep)", () => {
  const ok = [];
  for (let i = -3; i <= 16; i++) if (validateTraits(good({ memory_depth: i })).valid) ok.push(i);
  assert.deepEqual(ok, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("enum values: unicode lookalikes, combining marks, ZWJ, emoji and surrogate pairs are rejected", () => {
  const bads = [
    "coöl", // diaeresis
    "cooĺ", // combining acute
    "c‍ool", // ZWJ inside
    "cool​", // zero width space
    "﻿cool", // BOM
    "сool", // Cyrillic es
    "ｃool", // fullwidth c
    "\u{1F468}‍\u{1F469}‍\u{1F467}", // family emoji ZWJ sequence
    "\u{1F600}", // surrogate pair
    "\uD83D", // lone high surrogate
    "\uDE00", // lone low surrogate
    "COOL",
    "cool\0",
    "cool\n",
  ];
  for (const bad of bads) {
    assert.equal(validateTraits(good({ temperament: bad })).valid, false, JSON.stringify(bad));
  }
});

test("a very long enum string is rejected quickly and the error stays short", () => {
  const long = "cool".repeat(250_000);
  const r = validateTraits(good({ temperament: long }));
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ["temperament: must be one of cool, neon, warm, muted"]);
});

test("a very long unknown key name is reported verbatim", () => {
  const key = "k".repeat(100_000);
  const r = validateTraits({ ...GOOD, [key]: 1 });
  assert.deepEqual(r.errors, [`${key}: unknown key`]);
});

test("unknown keys with emoji and combining marks are reported verbatim", () => {
  const keys = ["\u{1F600}", "é", "\u{1F468}‍\u{1F469}‍\u{1F467}", "\uD83D"];
  const r = validateTraits({ ...GOOD, ...Object.fromEntries(keys.map((k) => [k, 0])) });
  assert.deepEqual(r.errors, keys.map((k) => `${k}: unknown key`));
});

test("empty-string and numeric-string unknown keys are reported", () => {
  const r = validateTraits({ ...GOOD, "": 1, 7: 2 });
  // integer-like keys enumerate first
  assert.deepEqual(r.errors, ["7: unknown key", ": unknown key"]);
});

test("trait key names with different case or padding count as unknown and the real key as missing", () => {
  const r = validateTraits({ Temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 3 });
  assert.deepEqual(r.errors, ["Temperament: unknown key", "temperament: is required"]);
  const r2 = validateTraits({ ...good(), " risk": "low" });
  assert.deepEqual(r2.errors, [" risk: unknown key"]);
  const camel = validateTraits({ ...good(), memoryDepth: 3 });
  assert.deepEqual(camel.errors, ["memoryDepth: unknown key"]);
});

test("null and undefined for each slot are bad values (not required errors)", () => {
  for (const key of TRAIT_KEYS) {
    for (const v of [null, undefined]) {
      const r = validateTraits(good({ [key]: v }));
      assert.equal(r.valid, false);
      assert.equal(r.errors.length, 1);
      assert.ok(r.errors[0].startsWith(`${key}: must be`), r.errors[0]);
    }
  }
});

test("non-enumerable own trait keys count as present (hasOwn) and are validated, but are not unknown", () => {
  const o = {};
  for (const [k, v] of Object.entries(GOOD)) Object.defineProperty(o, k, { value: v, enumerable: false });
  assert.deepEqual(validateTraits(o), { valid: true, errors: [] });
  const bad = Object.defineProperty(good(), "role", { value: "nope", enumerable: false });
  assert.deepEqual(validateTraits(bad).errors, ["role: must be one of observer, trickster, connector, auditor"]);
});

test("a non-enumerable extra key is not reported as unknown", () => {
  const o = Object.defineProperty(good(), "hidden", { value: 1, enumerable: false });
  assert.equal(validateTraits(o).valid, true);
});

test("a getter that throws on one trait yields a single 'could not be read' error and no partial results", () => {
  const o = good();
  Object.defineProperty(o, "voice", { enumerable: true, get() { throw new RangeError("boom"); } });
  const r = validateTraits(o);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ["traits: could not be read (boom)"]);
});

test("a getter that throws a non-Error is reported as unknown error", () => {
  const o = good();
  Object.defineProperty(o, "voice", { enumerable: true, get() { throw "str"; } });
  assert.deepEqual(validateTraits(o).errors, ["traits: could not be read (unknown error)"]);
});

test("errors collected before a throwing getter are kept alongside the read failure", () => {
  const o = { bogus: 1, temperament: "cool" };
  Object.defineProperty(o, "role", { enumerable: true, get() { throw new Error("late"); } });
  assert.deepEqual(validateTraits(o).errors, ["bogus: unknown key", "traits: could not be read (late)"]);
});

test("assertTraits error message for several unrelated bad slots joins them with '; ' and names each key", () => {
  assert.throws(
    () => assertTraits({ temperament: "x", role: 1, risk: null, voice: [], memory_depth: "5" }),
    (e) => {
      assert.ok(e instanceof TypeError);
      const parts = e.message.split("; ");
      assert.equal(parts.length, 5);
      assert.deepEqual(parts.map((p) => p.split(":")[0]), TRAIT_KEYS);
      return true;
    },
  );
});

test("assertTraits rejects every non-object input with the object error", () => {
  for (const v of [undefined, null, [], [GOOD], "str", 1, true, () => 0]) {
    assert.throws(() => assertTraits(v), { name: "TypeError", message: "traits: must be an object" });
  }
});

test("assertTraits output does not include a symbol-keyed or non-enumerable extra from the input", () => {
  const s = Symbol("extra");
  const input = good();
  input[s] = 1;
  Object.defineProperty(input, "hidden", { value: 1, enumerable: false });
  const out = assertTraits(input);
  assert.deepEqual(Reflect.ownKeys(out), TRAIT_KEYS);
});

test("assertTraits normalises 1.0 / -0-adjacent inputs to the plain number and keeps a boundary value", () => {
  assert.equal(assertTraits(good({ memory_depth: 12 })).memory_depth, 12);
  assert.equal(Object.is(assertTraits(good({ memory_depth: 1 })).memory_depth, 1), true);
});

test("assertTraits result is frozen even if the input is an unfrozen null-prototype object later mutated", () => {
  const o = Object.assign(Object.create(null), GOOD);
  const out = assertTraits(o);
  o.role = "auditor";
  assert.equal(out.role, "observer");
  assert.throws(() => { out.role = "auditor"; }, TypeError);
  assert.throws(() => { out.extra = 1; }, TypeError);
});

test("validateTraits returns fresh result objects: mutating errors does not affect the next call", () => {
  const a = validateTraits({});
  a.errors.length = 0;
  assert.equal(validateTraits({}).errors.length, TRAIT_KEYS.length);
});

test("a revoked proxy is invalid, not fatal: validateTraits reports it, assertTraits throws TypeError", () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const r = validateTraits(proxy);
  assert.equal(r.valid, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^traits: could not be read \(.*revoked/);
  assert.throws(() => assertTraits(proxy), (e) => e instanceof TypeError && /could not be read/.test(e.message));
});

test("arrays are still rejected as non-objects after the revoked-proxy fix", () => {
  assert.deepEqual(validateTraits([]), { valid: false, errors: ["traits: must be an object"] });
});
