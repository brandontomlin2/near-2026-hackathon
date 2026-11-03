// Sim mode: a deterministic, offline swarm.
//
// Four personas post and reply on one shared channel for N rounds. Each turn
// goes through the mock inference client, so a run never reads API keys,
// never touches the network and never writes to a chain. The same N gives the
// same transcript and the same hashes, every run.
//
// An agent wakes with its own event log only: the last RECENT_EVENTS events
// (posts, replies and mentions received), never the full log. Each round is
// hashed and chained to the round before, so a transcript can be checked later
// with verifyRounds.

import { createHash } from "node:crypto";

import { createMockClient } from "../inference/client.mjs";

export const RECENT_EVENTS = 6;
export const MAX_ROUNDS = 1000;
export const GENESIS_HASH = "0".repeat(64);

const TOPICS = Object.freeze([
  "the treasury proposal",
  "the relay fee",
  "the new charter",
  "the summary rule",
  "the mint schedule",
]);

// The four agents from PRODUCT.md. Openers and bodies are what the mock
// responder picks from; `{topic}` is filled in from the round.
export const PERSONAS = Object.freeze([
  Object.freeze({
    id: "aloof",
    name: "Aloof",
    role: "observer",
    voice: "dry",
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
  Object.freeze({
    id: "chaotic",
    name: "Chaotic",
    role: "trickster",
    voice: "loud",
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
  Object.freeze({
    id: "social",
    name: "Social",
    role: "connector",
    voice: "open",
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
  Object.freeze({
    id: "skeptic",
    name: "Skeptic",
    role: "auditor",
    voice: "flat",
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
]);

export class SimError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SimError";
    this.code = "bad_config";
  }
}

/**
 * Parse a round count. Only positive integers up to MAX_ROUNDS pass.
 * @param {string | number} raw
 * @returns {number}
 */
export function parseRounds(raw) {
  const text = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new SimError(`rounds must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const n = Number(text);
  if (n > MAX_ROUNDS) {
    throw new SimError(`rounds must be at most ${MAX_ROUNDS}, got ${n}`);
  }
  return n;
}

function validatePersonas(personas) {
  if (!Array.isArray(personas) || personas.length < 2) {
    throw new SimError("sim needs at least two personas");
  }
  const ids = new Set();
  const names = new Set();
  for (const persona of personas) {
    const ok = persona
      && typeof persona.id === "string" && persona.id.length > 0
      && typeof persona.name === "string" && persona.name.length > 0
      && typeof persona.role === "string"
      && typeof persona.voice === "string"
      && Array.isArray(persona.openers) && persona.openers.length > 0
      && Array.isArray(persona.bodies) && persona.bodies.length > 0;
    if (!ok) throw new SimError("each persona needs id, name, role, voice, openers and bodies");
    if (ids.has(persona.id) || names.has(persona.name)) {
      throw new SimError(`persona ids and names must be unique: ${persona.id}`);
    }
    ids.add(persona.id);
    names.add(persona.name);
  }
}

/**
 * Hash one round, chained to the previous round's hash.
 * @param {string} prevHash
 * @param {number} round
 * @param {{ seq: number, from: string, kind: string, to: string | null, text: string }[]} messages
 * @returns {string} 64-char hex sha256
 */
export function hashRound(prevHash, round, messages) {
  const canonical = JSON.stringify([
    prevHash,
    round,
    messages.map((m) => [m.seq, m.from, m.kind, m.to, m.text]),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The mock responder for one persona. The hash is of the whole request, so
 * the same turn gives the same sentence and different turns vary.
 * @param {typeof PERSONAS[number]} persona
 */
function personaResponder(persona) {
  return (request, hash) => {
    const byte = (i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    const opener = persona.openers[byte(0) % persona.openers.length];
    const topic = TOPICS[byte(2) % TOPICS.length];
    const filled = persona.bodies[byte(1) % persona.bodies.length].replace("{topic}", topic);
    const body = filled[0].toUpperCase() + filled.slice(1);
    return `${opener} ${body}`;
  };
}

/** Default client: mock inference only, one responder per persona. */
export function defaultClientFor(persona) {
  return createMockClient({ model: "sim", responder: personaResponder(persona) });
}

function describeEvent(event, nameOf) {
  if (event.kind === "mention") return `- mention r${event.round} from ${nameOf(event.from)}: ${event.text}`;
  const target = event.to ? ` to ${nameOf(event.to)}` : "";
  return `- ${event.kind} r${event.round}${target}: ${event.text}`;
}

/**
 * The request one agent sends on its turn. It carries the persona, its last
 * events and the latest message from someone else. Nothing else.
 * @param {{
 *   persona: typeof PERSONAS[number],
 *   events: { kind: string, round: number, from?: string, to?: string | null, text: string }[],
 *   round: number,
 *   latest: { name: string, text: string } | null,
 *   nameOf: (id: string) => string,
 * }} input
 */
export function buildTurnRequest({ persona, events, round, latest, nameOf }) {
  const lines = events.map((event) => describeEvent(event, nameOf));
  const latestLine = latest
    ? `Latest message from ${latest.name}: ${latest.text}`
    : "Nobody has spoken yet this round. Open the channel.";
  return {
    system: `You are ${persona.name}, a ${persona.role} with a ${persona.voice} voice. Answer in one or two sentences.`,
    messages: [
      {
        role: "user",
        content: `Round ${round}.\nYour recent events:\n${lines.length ? lines.join("\n") : "(none yet)"}\n${latestLine}`,
      },
    ],
    seed: round,
  };
}

/**
 * Run N rounds of the swarm in sim mode.
 *
 * @param {{
 *   rounds: number | string,
 *   personas?: typeof PERSONAS,
 *   clientFor?: (persona: typeof PERSONAS[number]) => { chat: (request: object) => Promise<{ content: string }> },
 *   recentEvents?: number,
 * }} options
 */
export async function runSwarm({
  rounds,
  personas = PERSONAS,
  clientFor = defaultClientFor,
  recentEvents = RECENT_EVENTS,
} = {}) {
  const total = parseRounds(rounds);
  validatePersonas(personas);
  if (!Number.isInteger(recentEvents) || recentEvents < 1) {
    throw new SimError("recentEvents must be a positive integer");
  }

  const nameById = new Map(personas.map((p) => [p.id, p.name]));
  const nameOf = (id) => nameById.get(id);
  const logs = new Map(personas.map((p) => [p.id, []]));
  const clients = new Map(personas.map((p) => [p.id, clientFor(p)]));
  const channel = [];
  const outRounds = [];
  let prevHash = GENESIS_HASH;
  let seq = 0;

  for (let round = 1; round <= total; round += 1) {
    const messages = [];
    for (const speaker of personas) {
      const log = logs.get(speaker.id);
      const target = [...channel].reverse().find((m) => m.from !== speaker.id) ?? null;
      const reply = await clients.get(speaker.id).chat(buildTurnRequest({
        persona: speaker,
        events: log.slice(-recentEvents),
        round,
        latest: target ? { name: nameOf(target.from), text: target.text } : null,
        nameOf,
      }));

      seq += 1;
      const text = target ? `@${nameOf(target.from)} ${reply.content}` : reply.content;
      const message = {
        seq,
        round,
        from: speaker.id,
        name: speaker.name,
        kind: target ? "reply" : "post",
        to: target ? target.from : null,
        text,
      };
      messages.push(message);
      channel.push(message);
      log.push({ seq, round, kind: message.kind, to: message.to, text });
      if (target) {
        logs.get(target.from).push({ seq, round, kind: "mention", from: speaker.id, text });
      }
    }
    const hash = hashRound(prevHash, round, messages);
    outRounds.push({ round, prevHash, hash, messages });
    prevHash = hash;
  }

  return {
    rounds: outRounds,
    headHash: prevHash,
    logs: Object.fromEntries(personas.map((p) => [p.id, logs.get(p.id)])),
  };
}

/**
 * Recompute the hash chain. Returns the first round that fails, if any.
 * @param {{ rounds: { round: number, prevHash: string, hash: string, messages: object[] }[], headHash: string }} result
 */
export function verifyRounds(result) {
  let prev = GENESIS_HASH;
  for (const r of result.rounds) {
    if (r.prevHash !== prev || hashRound(prev, r.round, r.messages) !== r.hash) {
      return { ok: false, round: r.round, headHash: prev };
    }
    prev = r.hash;
  }
  return { ok: prev === result.headHash, round: null, headHash: prev };
}

/**
 * One line per message: `r1 Aloof [post]: text`.
 * @param {{ rounds: { messages: { round: number, name: string, kind: string, text: string }[] }[] }} result
 */
export function formatTranscript(result) {
  return result.rounds
    .flatMap((r) => r.messages)
    .map((m) => `r${m.round} ${m.name} [${m.kind}]: ${m.text}`)
    .join("\n");
}
