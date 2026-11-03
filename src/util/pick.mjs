// Deterministic choice between fixed phrasings. No randomness, no clocks: the
// same key always picks the same entry, so output stays reproducible.

/** Small stable string hash (FNV-1a over code points). */
export function fnv(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return h;
}

/** The entry of `options` that `key` selects. */
export function pickBy(options, key) {
  return options[fnv(key) % options.length];
}
