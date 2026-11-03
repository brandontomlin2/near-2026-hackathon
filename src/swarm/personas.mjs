// Mock replies for the swarm: readable, in-character lines per seeded agent.
// Used only when inference is mocked. Live runs get replies from the model,
// steered by the trait-derived prompt in runner.mjs.
//
// The mock picks a starting opener, body and topic from the hash of the whole
// request, then walks forward by the persona's own turn count. Every step
// moves the opener, body and topic (strides coprime with the list sizes), so a
// persona never repeats a line in consecutive rounds and covers 8+ distinct
// bodies and 10 topics before cycling. Same seed and same turn, same line.

import { createMockClient } from "../inference/client.mjs";

export const TOPICS = Object.freeze([
  "the treasury proposal",
  "the relay fee",
  "the new charter",
  "the summary rule",
  "the mint schedule",
  "the validator vibes",
  "the airdrop rumor",
  "the gas meme",
  "the DAO vote",
  "the sunset clause",
]);

/** `{topic}` in a body is replaced with a topic. Keys are agent ids. */
export const PERSONA_LINES = Object.freeze({
  aloof: Object.freeze({
    openers: Object.freeze(["Noted.", "Hm.", "Mm.", "For the record.", "Watching.", "Quietly.", "Eventually.", "Sigh."]),
    bodies: Object.freeze([
      "I will wait on {topic} before I say more.",
      "{topic} looks fine from here, which worries me a little.",
      "I have seen {topic} go wrong before, and I kept my mouth shut.",
      "Nobody has answered the question about {topic}.",
      "I would rather observe {topic} for one more round.",
      "On {topic}, silence is also a position.",
      "{topic} will be fine, or it will be a story I tell later.",
      "I read {topic} and chose peace.",
    ]),
  }),
  chaotic: Object.freeze({
    openers: Object.freeze(["Ha!", "Wild!", "Oh, come on!", "Brilliant, truly!", "Chaos says.", "Nope!", "Send it!", "Zero regrets."]),
    bodies: Object.freeze([
      "{topic} is a joke and I am the punchline!",
      "Flip the table on {topic} right now!",
      "Who bets against {topic}? Me, loudly.",
      "I dare someone to defend {topic} with a straight face.",
      "{topic} needs a zigzag and a bad idea!",
      "Mix up {topic} and see who panics!",
      "{topic} but make it a speedrun, no brakes!",
      "Plot twist: {topic} was the exploit all along!",
    ]),
  }),
  social: Object.freeze({
    openers: Object.freeze(["Glad to see this.", "Friends.", "Happy to help.", "Okay, let's connect this.", "Warmly.", "Good point.", "Big hug.", "Team!"]),
    bodies: Object.freeze([
      "I can connect two of you on {topic} if that helps.",
      "Let's all agree a plan for {topic} together.",
      "I will introduce the two who disagree about {topic}.",
      "{topic} matters to more of us than it seems.",
      "Can we hear from everyone on {topic}?",
      "I want {topic} to land well for the whole group.",
      "Group chat time for {topic}, bring snacks!",
      "{topic} goes better when we all show up, so please do.",
    ]),
  }),
  skeptic: Object.freeze({
    openers: Object.freeze(["Check first.", "Show me.", "Hm, no.", "Doubtful.", "Audit note.", "Source?", "Citation needed.", "Receipts."]),
    bodies: Object.freeze([
      "Who verified {topic}? Not me.",
      "The numbers on {topic} do not add up yet.",
      "I will not sign off on {topic} without a receipt.",
      "{topic} is unproven until someone shows the log.",
      "Flag {topic} for review before anyone relies on it.",
      "I have read {topic} twice and still see a gap.",
      "{topic} smells like vaporware until I see a hash.",
      "Trust, but {topic} still needs a verifier.",
    ]),
  }),
});

/**
 * A mock responder for one agent. Agents without written lines fall back to
 * the inference client's default mock reply.
 * @param {{ id: string }} agent
 * @returns {import("../inference/client.mjs").MockResponder | undefined}
 */
export function personaResponder(agent) {
  const lines = PERSONA_LINES[agent.id];
  if (!lines) return undefined;
  // One responder serves one agent for one run. Its first request hash (which
  // carries the seed) fixes a starting point; each later call steps forward
  // from that same point, so consecutive lines cannot collide. Fresh responder,
  // same seed: same lines.
  let start = null;
  let turn = 0;
  return (_request, hash) => {
    start ??= hash;
    const n = turn++;
    const byte = (i) => Number.parseInt(start.slice(i * 2, i * 2 + 2), 16);
    const opener = lines.openers[(byte(0) + 3 * n) % lines.openers.length];
    const topic = TOPICS[(byte(2) + 3 * n) % TOPICS.length];
    const body = lines.bodies[(byte(1) + n) % lines.bodies.length].replace("{topic}", topic);
    return `${opener} ${body[0].toUpperCase()}${body.slice(1)}`;
  };
}

/** Deterministic, offline client that speaks in the agent's voice. */
export function createPersonaMockClient(agent) {
  return createMockClient({ model: "mock-persona", responder: personaResponder(agent) });
}
