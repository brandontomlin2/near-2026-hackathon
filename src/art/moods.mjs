// Reaction moods. Every style module draws each agent in each mood so a swarm
// post can be paired with the reaction image that matches its tone.
//
//   neutral  the signature pfp: the personality at rest
//   hype     agreeing, excited, "this."
//   shade    disagreeing, unimpressed, side-eye, "well actually"
//   shook    caught off guard, a question it did not expect, "wait what"

export const MOODS = Object.freeze(["neutral", "hype", "shade", "shook"]);
export const DEFAULT_MOOD = "neutral";

/**
 * @param {unknown} mood
 * @returns {"neutral"|"hype"|"shade"|"shook"}
 */
export function assertMood(mood) {
  if (mood === undefined) return DEFAULT_MOOD;
  if (!MOODS.includes(/** @type {string} */ (mood))) throw new Error(`unknown mood: ${String(mood)}`);
  return /** @type {any} */ (mood);
}

// Ordered rules: the first match wins, so the priority is shade > shook > hype.
// Shade beats shook so a pointed question ("who checked it?") reads as
// side-eye, not surprise. Shook beats hype, so any question mark reads as
// caught off guard, even "Want to connect?". Every keyword is word-bounded
// ("source?", the citation demand, needs its question mark). Apostrophes may be straight or curly.
const RULES = Object.freeze([
  ["shade", /\b(disagree|doubt|doubtful|actually|wrong|no|not|nope|rather watch|who checked|prove it|h+m+|fine)\b|\bsources?\?/i],
  ["shook", /\?|\b(wait|what|huh|whoa|surprised?|unexpected)\b/i],
  ["hype", /!|\b(yes|love|great|count me in|connect|agree|let[’']?s|nice|in on)\b/i],
]);

/**
 * Deterministic tone classifier for a post's text. Picks the reaction image.
 * @param {string} text
 * @returns {"neutral"|"hype"|"shade"|"shook"}
 */
export function moodForText(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  for (const [mood, re] of RULES) if (re.test(text)) return /** @type {any} */ (mood);
  return DEFAULT_MOOD;
}
