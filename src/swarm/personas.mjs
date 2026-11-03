// Mock replies for the swarm: readable, in-character lines per seeded agent.
// Used only when inference is mocked. Live runs get replies from the model,
// steered by the trait-derived prompt in runner.mjs.
//
// The mock picks an opener, a body and a topic from the hash of the whole
// request, so the same turn gives the same line and different turns vary.

import { createMockClient } from "../inference/client.mjs";

export const TOPICS = Object.freeze([
  "the treasury proposal",
  "the relay fee",
  "the new charter",
  "the summary rule",
  "the mint schedule",
]);

/** `{topic}` in a body is replaced with a topic. Keys are agent ids. */
export const PERSONA_LINES = Object.freeze({
  aloof: Object.freeze({
    openers: Object.freeze(["Noted.", "Hm.", "Mm.", "For the record.", "Watching.", "Quietly."]),
    bodies: Object.freeze([
      "I will wait on {topic} before I say more.",
      "{topic} looks fine from here, which worries me a little.",
      "I have seen {topic} go wrong before, and I kept my mouth shut.",
      "Nobody has answered the question about {topic}.",
      "I would rather observe {topic} for one more round.",
      "On {topic}, silence is also a position.",
    ]),
  }),
  chaotic: Object.freeze({
    openers: Object.freeze(["Ha!", "Wild!", "Oh, come on!", "Brilliant, truly!", "Chaos says.", "Nope!"]),
    bodies: Object.freeze([
      "{topic} is a joke and I am the punchline!",
      "Flip the table on {topic} right now!",
      "Who bets against {topic}? Me, loudly.",
      "I dare someone to defend {topic} with a straight face.",
      "{topic} needs a zigzag and a bad idea!",
      "Mix up {topic} and see who panics!",
    ]),
  }),
  social: Object.freeze({
    openers: Object.freeze(["Glad to see this.", "Friends.", "Happy to help.", "Okay, let's connect this.", "Warmly.", "Good point."]),
    bodies: Object.freeze([
      "I can connect two of you on {topic} if that helps.",
      "Let's all agree a plan for {topic} together.",
      "I will introduce the two who disagree about {topic}.",
      "{topic} matters to more of us than it seems.",
      "Can we hear from everyone on {topic}?",
      "I want {topic} to land well for the whole group.",
    ]),
  }),
  skeptic: Object.freeze({
    openers: Object.freeze(["Check first.", "Show me.", "Hm, no.", "Doubtful.", "Audit note.", "Source?"]),
    bodies: Object.freeze([
      "Who verified {topic}? Not me.",
      "The numbers on {topic} do not add up yet.",
      "I will not sign off on {topic} without a receipt.",
      "{topic} is unproven until someone shows the log.",
      "Flag {topic} for review before anyone relies on it.",
      "I have read {topic} twice and still see a gap.",
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
  return (_request, hash) => {
    const byte = (i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    const opener = lines.openers[byte(0) % lines.openers.length];
    const topic = TOPICS[byte(2) % TOPICS.length];
    const body = lines.bodies[byte(1) % lines.bodies.length].replace("{topic}", topic);
    return `${opener} ${body[0].toUpperCase()}${body.slice(1)}`;
  };
}

/** Deterministic, offline client that speaks in the agent's voice. */
export function createPersonaMockClient(agent) {
  return createMockClient({ model: "mock-persona", responder: personaResponder(agent) });
}
