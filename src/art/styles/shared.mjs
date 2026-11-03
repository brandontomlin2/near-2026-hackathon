// Helpers shared by every style module. Pure functions, integers only.
//
// A style module exports `style = { name, title, description, render(traits) }`
// and must satisfy the contract in contract.mjs.
//
// render(traits, { mood }) must call assertTraits(traits) and assertMood(mood)
// (both re-exported here) before drawing anything.

export { assertTraits } from "../../traits/validate.mjs";
export { MOODS, DEFAULT_MOOD, assertMood } from "../moods.mjs";

/** The four layer groups every style emits, in `<g id="NAME">` form. */
export const LAYER_IDS = Object.freeze(["background", "rings", "glyph", "face"]);

export const range = (n) => Array.from({ length: n }, (_, i) => i);

/**
 * Rarity tier from memory depth. Shared by all styles so a token's tier is the
 * same whichever style renders it. Tiers only move up as summaries accumulate.
 *   1-3 common, 4-6 rare, 7-9 epic, 10-12 legendary.
 * @param {number} depth
 * @returns {"common"|"rare"|"epic"|"legendary"}
 */
export function rarityTier(depth) {
  if (depth >= 10) return "legendary";
  if (depth >= 7) return "epic";
  if (depth >= 4) return "rare";
  return "common";
}

/**
 * 32-bit FNV-1a over the canonical trait string. Deterministic seed for
 * micro-variation (feTurbulence seeds, jitter) that must stay stable per token.
 * @param {import("../../traits/validate.mjs").Traits} t
 * @returns {number} unsigned 32-bit integer
 */
export function traitSeed(t) {
  const s = `${t.temperament}|${t.role}|${t.risk}|${t.voice}|${t.memory_depth}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Prefix for every id defined inside a style's SVG (gradients, patterns,
 * filters, clip paths). Unique per style and trait set, so several tokens can
 * be inlined in one HTML page without their defs colliding.
 * @param {string} styleName
 * @param {import("../../traits/validate.mjs").Traits} t
 */
export function defsPrefix(styleName, t, mood) {
  return `${styleName}-${t.temperament}-${t.role}-${t.risk}-${t.voice}-${t.memory_depth}-${mood}`;
}

/**
 * Root element. Fixed 256x256 canvas, carries style, rarity tier and mood as
 * data attributes so viewers and tests can read them without parsing the art.
 * @param {string} styleName
 * @param {string} tier
 * @param {string} mood
 */
export function svgOpen(styleName, tier, mood) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" data-style="${styleName}" data-tier="${tier}" data-mood="${mood}">`;
}
