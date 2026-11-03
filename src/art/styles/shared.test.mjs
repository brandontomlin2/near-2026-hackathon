// Rarity tier boundaries and the per-token seed, asserted directly rather than
// through the contract (which compares a style against rarityTier itself).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rarityTier, traitSeed, defsPrefix, LAYER_IDS } from "./shared.mjs";
import { STYLES } from "./index.mjs";
import { TRAIT_VALUES, MEMORY_DEPTH_MIN, MEMORY_DEPTH_MAX } from "../../traits/validate.mjs";

const base = Object.freeze({ temperament: "muted", role: "auditor", risk: "wary", voice: "flat" });

const TIERS = ["common", "rare", "epic", "legendary"];
const EXPECTED_TIER = {
  1: "common", 2: "common", 3: "common",
  4: "rare", 5: "rare", 6: "rare",
  7: "epic", 8: "epic", 9: "epic",
  10: "legendary", 11: "legendary", 12: "legendary",
};

test("rarity tier boundaries: 1-3 common, 4-6 rare, 7-9 epic, 10-12 legendary", () => {
  for (let d = MEMORY_DEPTH_MIN; d <= MEMORY_DEPTH_MAX; d++) assert.equal(rarityTier(d), EXPECTED_TIER[d], `depth ${d}`);
});

test("every mood style stamps the same tier for the same depth on the root", () => {
  for (const style of Object.values(STYLES)) {
    if (style.name === "default") continue;
    for (let d = MEMORY_DEPTH_MIN; d <= MEMORY_DEPTH_MAX; d++) {
      const svg = style.render({ ...base, memory_depth: d });
      assert.match(svg, new RegExp(`^<svg [^>]*data-tier="${EXPECTED_TIER[d]}"`), `${style.name} depth ${d}`);
    }
  }
});

test("tier never moves down as summaries accumulate", () => {
  for (let d = MEMORY_DEPTH_MIN; d < MEMORY_DEPTH_MAX; d++) {
    assert.ok(TIERS.indexOf(rarityTier(d + 1)) >= TIERS.indexOf(rarityTier(d)), `depth ${d} -> ${d + 1}`);
  }
});

test("traitSeed is a stable unsigned 32-bit integer that differs per trait set", () => {
  const seeds = new Map();
  for (const temperament of TRAIT_VALUES.temperament) {
    for (const role of TRAIT_VALUES.role) {
      for (const risk of TRAIT_VALUES.risk) {
        for (const voice of TRAIT_VALUES.voice) {
          for (const memory_depth of [1, 7, 12]) {
            const t = { temperament, role, risk, voice, memory_depth };
            const s = traitSeed(t);
            assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, JSON.stringify(t));
            assert.equal(s, traitSeed({ memory_depth, voice, risk, role, temperament }), "key order");
            seeds.set(JSON.stringify(t), s);
          }
        }
      }
    }
  }
  // 768 trait sets: a 32-bit hash should not collide across them.
  assert.equal(new Set(seeds.values()).size, seeds.size, "seed collision");
});

test("defsPrefix is unique per style, trait set and mood and uses only id-safe characters", () => {
  const prefixes = new Set();
  for (const style of ["sticker", "pixel", "deepfried"]) {
    for (const mood of ["neutral", "hype", "shade", "shook"]) {
      for (const memory_depth of [1, 12]) {
        for (const role of TRAIT_VALUES.role) {
          const p = defsPrefix(style, { ...base, role, memory_depth }, mood);
          assert.match(p, /^[a-z][a-z0-9-]*$/, p);
          prefixes.add(p);
        }
      }
    }
  }
  assert.equal(prefixes.size, 3 * 4 * 2 * 4);
  assert.ok(!LAYER_IDS.some((id) => prefixes.has(id)), "a prefix must never equal a layer id");
});
