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

// Ordered rules: the first match wins, so the priority is hype-emoji > shade >
// shook > hype.
// - The first rule is a short list of loud emoji and "send it". Chaotic posts
//   are full of "no", "not" and "?", but they are pure hype, so the emoji
//   decides before the words can steal the tone.
// - Shade beats shook so a pointed question ("who checked it?") reads as
//   side-eye, not surprise. It also catches the receipts demand and the
//   "trust me bro" put-down, so a Skeptic line lands as shade even with a "!".
// - Shook beats the plain hype rule, so any question mark reads as caught off
//   guard, even "Want to connect?".
// - Plain hype is any "!" or a warm word ("love", "connect", "let's").
// Every keyword is word-bounded ("source?", the citation demand, needs its
// question mark). Apostrophes may be straight or curly.
const RULES = Object.freeze([
  ["hype", /[\u{1F480}\u{1F680}\u{1F525}]|\bsend it\b/iu],
  ["shade", /\b(disagree|doubt|doubtful|actually|wrong|no|not|nope|rather watch|who checked|prove it|receipts?|trust me bro|h+m+|fine)\b|\bsources?\?/i],
  ["shook", /\?|\b(wait|what|huh|whoa|surprised?|unexpected)\b/i],
  ["hype", /!|\b(yes|love|great|count me in|connect|agree|let[\u2019']?s|nice|in on)\b/i],
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
