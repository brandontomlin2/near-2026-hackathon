// Edge cases for the shared style helpers: out-of-range and hostile inputs,
// pinned seed values, id-prefix sensitivity, root element shape and the
// re-exported validators.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rarityTier, traitSeed, defsPrefix, svgOpen, range, LAYER_IDS,
  assertTraits, assertMood, MOODS, DEFAULT_MOOD,
} from "./shared.mjs";

const T = Object.freeze({ temperament: "warm", role: "connector", risk: "mid", voice: "open", memory_depth: 3 });

test("rarityTier: depths below 1 stay common and large depths stay legendary", () => {
  for (const d of [0, -1, -1000, Number.MIN_SAFE_INTEGER]) assert.equal(rarityTier(d), "common", String(d));
  for (const d of [13, 99, 1e9, Number.MAX_SAFE_INTEGER]) assert.equal(rarityTier(d), "legendary", String(d));
});

test("rarityTier: a fractional depth just under a boundary stays in the lower tier", () => {
  assert.equal(rarityTier(3.999), "common");
  assert.equal(rarityTier(6.999), "rare");
  assert.equal(rarityTier(9.999), "epic");
  assert.equal(rarityTier(4), "rare");
});

test("traitSeed: pinned value for a fixed trait set (a changed hash would re-seed every minted token)", () => {
  assert.equal(traitSeed({ temperament: "cool", role: "auditor", risk: "low", voice: "dry", memory_depth: 1 }), 308085106);
});

test("traitSeed: ignores keys outside the five trait slots", () => {
  assert.equal(traitSeed({ ...T, extra: "x", __note: 1 }), traitSeed(T));
});

test("traitSeed: unicode, emoji and very long values still give an unsigned 32-bit integer", () => {
  for (const role of ["café", "\u{1F680}\u{1F525}", "\u0000", "x".repeat(100000), ""]) {
    const s = traitSeed({ ...T, role });
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, role.slice(0, 8));
    assert.equal(s, traitSeed({ ...T, role }));
  }
  assert.notEqual(traitSeed({ ...T, role: "\u{1F680}" }), traitSeed({ ...T, role: "\u{1F525}" }));
});

test("traitSeed: null and undefined traits throw instead of returning a seed", () => {
  assert.throws(() => traitSeed(null), TypeError);
  assert.throws(() => traitSeed(undefined), TypeError);
});

test("range: zero, negative and NaN lengths are empty; each call returns a fresh array", () => {
  assert.deepEqual(range(0), []);
  assert.deepEqual(range(-5), []);
  assert.deepEqual(range(NaN), []);
  const a = range(3);
  a.push(99);
  assert.deepEqual(range(3), [0, 1, 2]);
});

test("range: impossible lengths throw RangeError rather than hang or allocate", () => {
  for (const n of [Infinity, 2 ** 32, 1e10]) assert.throws(() => range(n), RangeError, String(n));
});

test("defsPrefix: changing any single trait slot, the mood or the style changes the prefix", () => {
  const base = defsPrefix("sticker", T, "neutral");
  const variants = [
    defsPrefix("pixel", T, "neutral"),
    defsPrefix("sticker", { ...T, temperament: "cool" }, "neutral"),
    defsPrefix("sticker", { ...T, role: "auditor" }, "neutral"),
    defsPrefix("sticker", { ...T, risk: "low" }, "neutral"),
    defsPrefix("sticker", { ...T, voice: "dry" }, "neutral"),
    defsPrefix("sticker", { ...T, memory_depth: 4 }, "neutral"),
    defsPrefix("sticker", T, "hype"),
  ];
  for (const v of variants) assert.notEqual(v, base);
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
});

test("defsPrefix: depths 1, 11, 12 and 2 across all moods never collide", () => {
  const seen = new Set();
  for (const d of [1, 11, 12, 2]) for (const mood of MOODS) seen.add(defsPrefix("pixel", { ...T, memory_depth: d }, mood));
  assert.equal(seen.size, 16);
});

test("defsPrefix: begins with the style name and is deterministic", () => {
  const p = defsPrefix("deepfried", T, "shook");
  assert.ok(p.startsWith("deepfried-"));
  assert.equal(p, defsPrefix("deepfried", { ...T }, "shook"));
});

test("svgOpen: every tier and mood gives one well-formed 256x256 root tag with the data attributes", () => {
  for (const tier of ["common", "rare", "epic", "legendary"]) {
    for (const mood of MOODS) {
      const tag = svgOpen("sticker", tier, mood);
      assert.equal(
        tag,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" data-style="sticker" data-tier="${tier}" data-mood="${mood}">`,
      );
      assert.ok(!tag.includes("\n"));
    }
  }
});

test("LAYER_IDS: frozen, so a style cannot add or drop a layer for everyone else", () => {
  assert.throws(() => LAYER_IDS.push("extra"), TypeError);
  assert.throws(() => { LAYER_IDS[0] = "x"; }, TypeError);
  assert.equal(LAYER_IDS.length, 4);
});

test("assertTraits: rejects non-objects, arrays and prototype-named values with a TypeError", () => {
  for (const bad of [undefined, null, 0, "", "traits", true, [], [T]]) assert.throws(() => assertTraits(bad), TypeError, String(bad));
  for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => assertTraits({ ...T, role: v }), /role: must be one of/, v);
    assert.throws(() => assertTraits({ ...T, voice: v }), /voice: must be one of/, v);
  }
});

test("assertTraits: depth must be a real integer 1..12 (no NaN, Infinity, fractions or numeric strings)", () => {
  for (const d of [0, 13, -1, 1.5, NaN, Infinity, -Infinity, "3", null, undefined, 2 ** 53, [3]]) {
    assert.throws(() => assertTraits({ ...T, memory_depth: d }), /memory_depth: must be an integer/, String(d));
  }
});

test("assertTraits: an own __proto__ key and unknown keys are rejected; hostile proxies fail as TypeError", () => {
  assert.throws(() => assertTraits(JSON.parse('{"__proto__":1}')), /__proto__: unknown key/);
  assert.throws(() => assertTraits({ ...T, extra: 1 }), /extra: unknown key/);
  const hostile = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
  assert.throws(() => assertTraits(hostile), TypeError);
});

test("assertTraits: returns a frozen, key-ordered copy and never freezes or mutates the caller's object", () => {
  const input = { memory_depth: 3, voice: "open", risk: "mid", role: "connector", temperament: "warm" };
  const out = assertTraits(input);
  assert.deepEqual(Object.keys(out), ["temperament", "role", "risk", "voice", "memory_depth"]);
  assert.ok(Object.isFrozen(out));
  assert.notEqual(out, input);
  assert.ok(!Object.isFrozen(input));
  assert.deepEqual(Object.keys(input), ["memory_depth", "voice", "risk", "role", "temperament"]);
});

test("assertMood: only undefined defaults; null, wrong types and prototype names throw", () => {
  assert.equal(assertMood(undefined), DEFAULT_MOOD);
  assert.equal(assertMood(), "neutral");
  for (const bad of [null, 0, false, "", "__proto__", "constructor", "toString", "length", "0", ["hype"], {}, Symbol("hype")]) {
    assert.throws(() => assertMood(bad), /unknown mood: /, String(bad));
  }
});

test("MOODS and DEFAULT_MOOD: frozen list that contains the default", () => {
  assert.ok(Object.isFrozen(MOODS));
  assert.throws(() => MOODS.push("angry"), TypeError);
  assert.ok(MOODS.includes(DEFAULT_MOOD));
});
