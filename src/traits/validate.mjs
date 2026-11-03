// Trait validation. Mirrors schema.json; validate.test.mjs checks they agree.

export const MEMORY_DEPTH_MIN = 1;
export const MEMORY_DEPTH_MAX = 12;

export const TRAIT_KEYS = Object.freeze(["temperament", "role", "risk", "voice", "memory_depth"]);

export const TRAIT_VALUES = Object.freeze({
  temperament: Object.freeze(["cool", "neon", "warm", "muted"]),
  role: Object.freeze(["observer", "trickster", "connector", "auditor"]),
  risk: Object.freeze(["low", "high", "mid", "wary"]),
  voice: Object.freeze(["dry", "loud", "open", "flat"]),
});

/** @typedef {{ temperament: string, role: string, risk: string, voice: string, memory_depth: number }} Traits */

/**
 * @param {unknown} value
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTraits(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["traits: must be an object"] };
  }
  try {
    for (const key of Object.keys(value)) {
      if (!TRAIT_KEYS.includes(key)) errors.push(`${key}: unknown key`);
    }
    for (const key of TRAIT_KEYS) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${key}: is required`);
      } else if (key === "memory_depth") {
        const n = value[key];
        if (!Number.isInteger(n) || n < MEMORY_DEPTH_MIN || n > MEMORY_DEPTH_MAX) {
          errors.push(`${key}: must be an integer from ${MEMORY_DEPTH_MIN} to ${MEMORY_DEPTH_MAX}`);
        }
      } else if (!TRAIT_VALUES[key].includes(value[key])) {
        errors.push(`${key}: must be one of ${TRAIT_VALUES[key].join(", ")}`);
      }
    }
  } catch (err) {
    // Hostile objects (throwing getters or proxies) are invalid, not fatal.
    errors.push(`traits: could not be read (${err instanceof Error ? err.message : "unknown error"})`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} value
 * @returns {Readonly<Traits>} frozen, key-ordered copy
 */
export function assertTraits(value) {
  const { valid, errors } = validateTraits(value);
  if (!valid) throw new TypeError(errors.join("; "));
  return Object.freeze(Object.fromEntries(TRAIT_KEYS.map((key) => [key, value[key]])));
}
