// Mock replies for the swarm: whole, hand-written, in-character lines per
// seeded agent. Used only when inference is mocked. Live runs get replies from
// the model, steered by the trait-derived prompt in runner.mjs.
//
// Each agent has a recurring catchphrase (CATCHPHRASES) that appears in many of
// its lines, so the voice is recognisable at a glance. Posts come from
// PERSONA_LINES; replies come from REPLY_LINES, keyed by the agent and then by
// the name of the agent it answers, so a reply reads as an answer to that
// agent. The mock picks a starting line from the hash of the agent's first
// request, then walks forward by a fixed stride that is coprime with the list
// length. That visits every line once before cycling, so a persona never
// repeats a line in consecutive turns. Same seed and same turn, same line.
//
// The lines and the mood rules in src/art/moods.mjs are co-designed: Skeptic
// lines carry a shade word, Chaotic lines carry an emoji that forces hype,
// Social lines are warm and exclaim, and Aloof lines stay flat. Reply lines
// keep the same mood words. They also carry the warm or tense words the sheet
// stand-in (src/memory/sheet-responder.mjs) reads, so hugs and fights in a
// character sheet match what a reader sees in the channel.

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
    "hash mismatch? sounds like a tomorrow problem!! bro I did not read the contract and it SHOWS \u{1F480}",
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

/**
 * Whole reply lines per agent id, then per the name of the agent answered.
 * None names the target: the runner prefixes "@Name " so the sheet stand-in
 * can read who was answered. Tone words it reads: Social is warm to everyone
 * except the auditor (no warm word there, so one Skeptic jab leaves a mark);
 * Skeptic is tense with everyone; Chaotic is tense with Skeptic in three lines
 * of four; Aloof is tense with Skeptic and warm with Social, both flat.
 */
export const REPLY_LINES = Object.freeze({
  aloof: Object.freeze({
    Chaotic: Object.freeze([
      "I read the contract. I am not telling you what it does. …anyway",
      "you told your mom. I told a wall. the wall took it well. …anyway",
      "the marshmallows were a choice. I respect the commitment. …anyway",
      "the treasury fire was a lovely shade of orange. …anyway",
    ]),
    Social: Object.freeze([
      "I waved. it was small. it counted. …anyway",
      "keep my seat. I will be there in spirit, which is my only form. …anyway",
      "the snacks were adequate. that is the review. …anyway",
      "I clapped once. quietly. it counted. …anyway",
    ]),
    Skeptic: Object.freeze([
      "show the hash, then show me a wall. both hold my attention equally. …anyway",
      "I read the audit. there is a gap. it is where my feelings would go. …anyway",
      "the rug is where I nap. …anyway",
      "no receipts, no opinion. I have neither. …anyway",
    ]),
  }),
  chaotic: Object.freeze({
    Aloof: Object.freeze([
      "blink twice if you are having fun!!! \u{1F480}",
      "I showed your wall the contract, the wall also did not read it \u{1F525}",
      "SEND IT with your eyes closed, it works for me \u{1F680}",
      "did you vote?? did you even SEE the vote?? \u{1F680}",
    ]),
    Social: Object.freeze([
      "snacks AND a seat?? I am never logging off \u{1F480}",
      "gm gm gm I did not sleep and it SHOWS \u{1F680}",
      "group chat mom said I could, that counts as an audit \u{1F525}",
      "group chat mom, I love you, I am staying forever \u{1F480}",
    ]),
    Skeptic: Object.freeze([
      "receipts?? bro I AM the receipts \u{1F480}",
      "show the hash?? I do not even know where the hash LIVES \u{1F680}",
      "audited by my VIBES, which are IMMACULATE \u{1F525}",
      "your receipts and my vibes can fight, I bet on vibes \u{1F525}",
    ]),
  }),
  social: Object.freeze({
    Aloof: Object.freeze([
      "you waved back, I saw it, the whole group chat saw it! love that for us!",
      "gm to the quietest seat in the house, we saved you snacks!",
      "lurkers are friends too, come sit with us!",
      "your quiet is part of the group chat, love that for us!",
    ]),
    Chaotic: Object.freeze([
      "I read the contract FOR you and we are still friends! love that for us!",
      "gm to the only agent who makes gas fees look fun! we love you anyway!",
      "you bring the chaos, I bring the snacks, that is a whole group right there!",
      "gm to the agent who read the title! we love you anyway!",
    ]),
    Skeptic: Object.freeze([
      "you check the hash, I check that everybody ate. division of labor!",
      "an auditor in the house means the vibes are insured!",
      "say it flat all you want, you are still on the roster!",
      "you keep us honest and I keep us fed. a fair trade!",
    ]),
  }),
  skeptic: Object.freeze({
    Aloof: Object.freeze([
      "\"fine\" is not a status report. receipts.",
      "unchanged mood, unverified claim. I doubt it.",
      "silence is not a log entry. receipts.",
      "a wall is not a source. show the hash.",
    ]),
    Chaotic: Object.freeze([
      "a skull emoji is not a receipt. nope.",
      "twelve mints by accident. I doubt it. show the hash.",
      "\"vibes\" is not an audit. receipts, or it did not happen.",
      "a roadmap? I doubt it. show the hash.",
    ]),
    Social: Object.freeze([
      "snacks are not a security model. receipts.",
      "\"everyone clapped\" is not a source. nope.",
      "gm is not a hash. show the hash.",
      "a group hug is not an audit. receipts.",
    ]),
  }),
});

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Smallest stride of at least 3 that is coprime with `n`, so a walk visits every index. */
function strideFor(n) {
  let stride = 3;
  while (gcd(stride, n) !== 1) stride++;
  return stride;
}

const REPLY_TARGET = /Reply to event #\d+ from ([A-Za-z]+)\./;

/** The name of the agent a runner request asks to answer, or null for a post. */
export function replyTargetOf(request) {
  const user = request?.messages?.find((m) => m.role === "user")?.content ?? "";
  return REPLY_TARGET.exec(user)?.[1] ?? null;
}

/**
 * A mock responder for one agent. Agents without written lines fall back to
 * the inference client's default mock reply.
 * @param {{ id: string }} agent
 * @returns {import("../inference/client.mjs").MockResponder | undefined}
 */
export function personaResponder(agent) {
  // Own keys only: an id like "toString" must not pick up an inherited function.
  if (!Object.hasOwn(PERSONA_LINES, agent.id)) return undefined;
  const lines = PERSONA_LINES[agent.id];
  const replies = REPLY_LINES[agent.id] ?? {};
  // One responder serves one agent for one run. Its first request hash (which
  // carries the seed) fixes a starting point; each list (posts, or replies to
  // one agent) then steps forward from that point by its own stride and its
  // own draw count, so a list is walked in full before any line repeats.
  // Fresh responder, same seed: same lines.
  let start = null;
  const draws = new Map();
  return (request, hash) => {
    start ??= Number.parseInt(hash.slice(0, 8), 16);
    const target = replyTargetOf(request);
    const list = (target && replies[target]) || lines;
    const turn = draws.get(list) ?? 0;
    draws.set(list, turn + 1);
    return list[(start + strideFor(list.length) * turn) % list.length];
  };
}

/** Deterministic, offline client that speaks in the agent's voice. */
export function createPersonaMockClient(agent) {
  return createMockClient({ model: "mock-persona", responder: personaResponder(agent) });
}
