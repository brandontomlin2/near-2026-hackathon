// Mock replies for the swarm: whole, hand-written, in-character lines per
// seeded agent. Used only when inference is mocked. Live runs get replies from
// the model, steered by the trait-derived prompt in runner.mjs.
//
// Each agent has a recurring catchphrase (CATCHPHRASES) that appears in many of
// its lines, so the voice is recognisable at a glance. The mock picks a
// starting line from the hash of the agent's first request, then walks forward
// by a fixed stride that is coprime with the list length. That visits every
// line once before cycling, so a persona never repeats a line in consecutive
// rounds and shows 8+ distinct lines before looping. Same seed and same turn,
// same line.
//
// The lines and the mood rules in src/art/moods.mjs are co-designed: Skeptic
// lines carry a shade word, Chaotic lines carry an emoji that forces hype,
// Social lines are warm and exclaim, and Aloof lines stay flat.

import { createMockClient } from "../inference/client.mjs";

/** The signature bit for each agent. Many of its lines include it verbatim. */
export const CATCHPHRASES = Object.freeze({
  aloof: "\u2026anyway",
  chaotic: "bro I did not read the contract and it SHOWS \u{1F480}",
  social: "love that for us",
  skeptic: "source: trust me bro? ABSOLUTELY NOT",
});

/** Whole lines per agent id. Nothing is templated. */
export const PERSONA_LINES = Object.freeze({
  aloof: Object.freeze([
    "gas went up 400% and I felt nothing. \u2026anyway",
    "the DAO vote closes in an hour. I will be asleep. \u2026anyway",
    "someone said airdrop and the whole room stood up. I stayed seated. \u2026anyway",
    "validators are doing validator things. \u2026anyway",
    "I minted one. I am not discussing it. \u2026anyway",
    "the hash matches. cool. \u2026anyway",
    "everyone is panicking about the sheet. I am looking at a wall. \u2026anyway",
    "huh, the airdrop was a rumor. \u2026anyway",
    "my portfolio is down and my mood is unchanged. \u2026anyway",
    "I read the whole proposal and chose to log off. \u2026anyway",
    "the mint sold out while I was blinking. \u2026anyway",
    "fine. the gas is fine. everything is fine. \u2026anyway",
    "wait, there was a vote today? \u2026anyway",
  ]),
  chaotic: Object.freeze([
    "bro I did not read the contract and it SHOWS \u{1F480}",
    "just aped into the DAO vote with zero context, bro I did not read the contract and it SHOWS \u{1F480}",
    "gas is 900 Tgas?? SEND IT ANYWAY \u{1F680}",
    "airdrop rumor?? I already told my mom!! \u{1F480}",
    "I minted twelve by accident and kept going. bro I did not read the contract and it SHOWS \u{1F480}",
    "validators asked me to slow down and I said no!! \u{1F525}",
    "hash mismatch? sounds like a tomorrow problem!! \u{1F480}",
    "I pasted the whole sheet into the chat and hit enter!!! \u{1F680}",
    "who needs a roadmap when you have VIBES!!! bro I did not read the contract and it SHOWS \u{1F480}",
    "voted yes, voted no, voted yes again. the DAO is a slot machine now \u{1F480}",
    "the treasury is on fire and I brought marshmallows \u{1F525}",
    "ngmi? NGMI?? I am the whole index!! \u{1F680}",
    "wait WHAT, the contract does that?? I only read the title",
  ]),
  social: Object.freeze([
    "the DAO vote got everybody talking again, love that for us!",
    "gas is high but we are all high-fiving in the group chat, love that for us!",
    "airdrop rumor means the whole swarm is online at once. love that for us!",
    "new validator just said hi in the thread and everyone waved back. love that for us!",
    "I put the mint schedule on a shared sheet so we can all poke at it. love that for us!",
    "someone verified a hash and the whole room clapped. love that for us!",
    "bringing snacks to the DAO vote, you bring the opinions. love that for us!",
    "everybody gets a seat at the sheet today. love that for us!",
    "tag a friend who still thinks gas fees are a personality, we love you anyway!",
    "gm to the validators, gm to the lurkers, gm to everyone in between!",
    "wait, who is hosting the group chat tonight? love that for us!",
    "huh, who unmuted the whole swarm?? love that for us!",
  ]),
  skeptic: Object.freeze([
    "airdrop rumor, source: trust me bro? ABSOLUTELY NOT.",
    "gas is \"basically free\"? receipts or it did not happen. source: trust me bro? ABSOLUTELY NOT.",
    "DAO vote passed 99 to 1? I doubt it. show the hash.",
    "validators are \"totally fine\" per a screenshot. no.",
    "mint is \"definitely not a rug.\" source: trust me bro? ABSOLUTELY NOT.",
    "the sheet says 100% uptime. receipts. now.",
    "who checked the hash? nobody? cool. I doubt it.",
    "\"audited\" by whom? I need receipts, not vibes.",
    "this thread is vibes and zero logs. no receipts, no belief.",
    "airdrop \"confirmed\" by an anonymous account with a frog avatar. nope.",
    "I will believe the mint schedule when the log says so. source: trust me bro? ABSOLUTELY NOT.",
    "wait, an audit? since when?",
  ]),
});

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Smallest stride of at least 3 that is coprime with `n`, so a walk visits every index. */
function strideFor(n) {
  let stride = 3;
  while (gcd(stride, n) !== 1) stride++;
  return stride;
}

/**
 * A mock responder for one agent. Agents without written lines fall back to
 * the inference client's default mock reply.
 * @param {{ id: string }} agent
 * @returns {import("../inference/client.mjs").MockResponder | undefined}
 */
export function personaResponder(agent) {
  const lines = PERSONA_LINES[agent.id];
  if (!lines) return undefined;
  const stride = strideFor(lines.length);
  // One responder serves one agent for one run. Its first request hash (which
  // carries the seed) fixes a starting point; each later call steps forward
  // from that same point, so consecutive lines cannot collide. Fresh responder,
  // same seed: same lines.
  let start = null;
  let turn = 0;
  return (_request, hash) => {
    start ??= Number.parseInt(hash.slice(0, 8), 16);
    return lines[(start + stride * turn++) % lines.length];
  };
}

/** Deterministic, offline client that speaks in the agent's voice. */
export function createPersonaMockClient(agent) {
  return createMockClient({ model: "mock-persona", responder: personaResponder(agent) });
}
