import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  TRAIT_KEYS,
  TRAIT_VALUES,
  MEMORY_DEPTH_MIN,
  MEMORY_DEPTH_MAX,
  validateTraits,
  assertTraits,
} from "./validate.mjs";
import { AGENTS, agentById } from "./agents.mjs";

const schema = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));
const good = { temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 1 };

test("all four agents validate", () => {
  assert.deepEqual(AGENTS.map((a) => a.id), ["aloof", "chaotic", "social", "skeptic"]);
  for (const a of AGENTS) {
    assert.deepEqual(validateTraits(a.traits), { valid: true, errors: [] });
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.traits));
  }
  assert.equal(agentById("social").personality, "Connector");
  assert.throws(() => agentById("nope"));
});

const bad = [
  ["bad enum", { ...good, temperament: "hot" }, /temperament: must be one of cool, neon, warm, muted/],
  ["extra key", { ...good, extra: 1 }, /extra: unknown key/],
  ["missing key", { ...good, voice: undefined }, /voice: /],
  ["memory_depth 0", { ...good, memory_depth: 0 }, /memory_depth: /],
  ["memory_depth 13", { ...good, memory_depth: 13 }, /memory_depth: /],
  ["memory_depth 3.5", { ...good, memory_depth: 3.5 }, /memory_depth: /],
  ["memory_depth string", { ...good, memory_depth: "3" }, /memory_depth: /],
  ["memory_depth true", { ...good, memory_depth: true }, /memory_depth: /],
  ["null", null, /must be an object/],
  ["array", [good], /must be an object/],
  ["string", "cool", /must be an object/],
  ["number", 7, /must be an object/],
];
for (const [name, input, pattern] of bad) {
  test(`rejects ${name}`, () => {
    const r = validateTraits(input);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => pattern.test(e)), r.errors.join("; "));
  });
}

test("missing key is reported as required", () => {
  const { voice, ...rest } = good;
  assert.deepEqual(validateTraits(rest).errors, ["voice: is required"]);
});

test("memory_depth bounds are accepted", () => {
  for (const n of [MEMORY_DEPTH_MIN, MEMORY_DEPTH_MAX]) {
    assert.equal(validateTraits({ ...good, memory_depth: n }).valid, true);
  }
});

test("assertTraits returns a frozen key-ordered copy", () => {
  const shuffled = { memory_depth: 2, voice: "dry", risk: "low", role: "observer", temperament: "cool" };
  const out = assertTraits(shuffled);
  assert.ok(Object.isFrozen(out));
  assert.notEqual(out, shuffled);
  assert.deepEqual(Object.keys(out), [...TRAIT_KEYS]);
  assert.equal(out.memory_depth, 2);
});

test("assertTraits throws TypeError with joined errors", () => {
  assert.throws(
    () => assertTraits({ ...good, role: "x", memory_depth: 0 }),
    (err) => err instanceof TypeError && err.message.includes("role: ") && err.message.includes("; memory_depth: "),
  );
});

test("schema.json agrees with TRAIT_VALUES and TRAIT_KEYS", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [...TRAIT_KEYS]);
  assert.deepEqual(Object.keys(schema.properties), [...TRAIT_KEYS]);
  for (const [key, values] of Object.entries(TRAIT_VALUES)) {
    assert.deepEqual(schema.properties[key].enum, [...values], key);
  }
  const md = schema.properties.memory_depth;
  assert.equal(md.type, "integer");
  assert.equal(md.minimum, MEMORY_DEPTH_MIN);
  assert.equal(md.maximum, MEMORY_DEPTH_MAX);
  for (const p of Object.values(schema.properties)) assert.ok(p.title && p.description);
});

test("validator agrees with schema on boundary cases", () => {
  const md = schema.properties.memory_depth;
  for (const n of [md.minimum - 1, md.minimum, md.maximum, md.maximum + 1]) {
    const inRange = n >= md.minimum && n <= md.maximum;
    assert.equal(validateTraits({ ...good, memory_depth: n }).valid, inRange, String(n));
  }
  for (const key of Object.keys(TRAIT_VALUES)) {
    for (const v of schema.properties[key].enum) assert.equal(validateTraits({ ...good, [key]: v }).valid, true);
    assert.equal(validateTraits({ ...good, [key]: "zzz" }).valid, false);
  }
});

test("validateTraits never throws on junk", () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error("boom"); } });
  const getter = { get temperament() { throw new Error("boom"); } };
  const junk = [undefined, null, () => {}, NaN, 0, "", {}, [], new Date(), new Map(), Object.create(null), hostile, getter, 10n];
  for (const j of junk) {
    const r = validateTraits(j);
    assert.equal(typeof r.valid, "boolean");
    assert.ok(Array.isArray(r.errors));
    assert.equal(r.valid, false);
  }
});
