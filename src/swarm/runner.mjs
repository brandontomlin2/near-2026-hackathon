// Turn-based swarm runner. One shared channel, every agent speaks once per
// round in a seed-derived order. Deterministic given (agents, rounds, seed,
// client): no Math.random, no clocks, no timestamps in events.

import { createHash } from "node:crypto";
import { AGENTS } from "../traits/agents.mjs";
import { capUtf8Bytes, replaceUnsafeChars } from "../util/text.mjs";
import { createPersonaMockClient } from "./personas.mjs";

/** @typedef {{ id: number, round: number, turn: number, agentId: string, kind: "post" | "reply", replyTo: number | null, text: string }} SwarmEvent */

// Upper bound on --rounds for the CLIs and runSwarm; stops a typo from running for hours.
export const MAX_ROUNDS = 1000;

// Upper bound on one reply, in UTF-8 bytes. Agents are asked for one or two short
// sentences (the mock lines are under 100 characters); the event text feeds
// transcript.txt, events.json, the round hash and a share card, so it is bounded here.
export const MAX_REPLY_BYTES = 1024;

export const GENESIS_HASH = "0".repeat(64);

/** Small seeded PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates with the given rng, on a copy. */
function shuffled(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const TEMPERAMENT = {
  cool: "You are cool and measured, never rushed.",
  neon: "You are electric and unpredictable, you love to stir things up.",
  warm: "You are warm and friendly, you draw people in.",
  muted: "You are muted and careful, you distrust big claims.",
};
const ROLE = {
  observer: "You watch more than you act and note what others miss.",
  trickster: "You bend the rules and provoke to see what happens.",
  connector: "You link people together and carry news between them.",
  auditor: "You check claims and ask who verified them.",
};
const RISK = {
  low: "You avoid risk.",
  high: "You chase risk.",
  mid: "You take balanced risks.",
  wary: "You are wary of every commitment.",
};
const VOICE = {
  dry: "You speak dryly.",
  loud: "You speak loudly and with flair.",
  open: "You speak openly and generously.",
  flat: "You speak flatly, without ornament.",
};

/** Persona system prompt derived from an agent's traits. */
export function personaPrompt(agent) {
  const t = agent.traits;
  return [
    `You are ${agent.name}, the ${agent.personality}, one of several agents on a shared channel.`,
    TEMPERAMENT[t.temperament] ?? `Your temperament is ${t.temperament}.`,
    ROLE[t.role] ?? `Your role is ${t.role}.`,
    RISK[t.risk] ?? `Your risk appetite is ${t.risk}.`,
    VOICE[t.voice] ?? `Your voice is ${t.voice}.`,
    "Reply in one or two short sentences, in character.",
  ].join(" ");
}

function nameOf(agents, agentId) {
  return agents.find((a) => a.id === agentId)?.name ?? agentId;
}

function recentLines(agents, events) {
  if (events.length === 0) return "The channel is empty.";
  return events
    .map((e) => {
      const who = nameOf(agents, e.agentId);
      return e.kind === "reply"
        ? `#${e.id} [${who} -> #${e.replyTo}] ${e.text}`
        : `#${e.id} [${who}] ${e.text}`;
    })
    .join("\n");
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 hex over the canonical JSON of a round's events chained with the previous hash. */
export function hashRound(prevHash, roundEvents) {
  return createHash("sha256")
    .update(prevHash).update("\n").update(canonicalize(roundEvents))
    .digest("hex");
}

/**
 * `client` serves every agent. Without it each agent gets its own offline
 * persona mock, or `clientFor(agent)` if given.
 * @param {{ agents?: readonly import("../traits/agents.mjs").Agent[], rounds?: number, seed?: number, client?: { chat: Function }, clientFor?: (agent: import("../traits/agents.mjs").Agent) => { chat: Function }, lastK?: number }} [options]
 */
export async function runSwarm({
  agents = AGENTS,
  rounds = 5,
  seed = 1,
  client,
  clientFor,
  lastK = 6,
} = {}) {
  if (!clientFor) {
    // One persona mock per agent for the whole run: its turn count drives variety.
    const mocks = new Map();
    clientFor = client
      ? () => client
      : (agent) => {
        if (!mocks.has(agent.id)) mocks.set(agent.id, createPersonaMockClient(agent));
        return mocks.get(agent.id);
      };
  }
  if (!Array.isArray(agents) || agents.length === 0) throw new RangeError("agents must be a non-empty array");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new RangeError(`rounds must be an integer from 1 to ${MAX_ROUNDS}`);
  if (!Number.isInteger(seed)) throw new RangeError("seed must be an integer");
  if (!Number.isInteger(lastK) || lastK < 1) throw new RangeError("lastK must be a positive integer");

  const rng = mulberry32(seed);
  /** @type {SwarmEvent[]} */
  const events = [];
  const roundHashes = [];
  let prevHash = GENESIS_HASH;

  for (let round = 1; round <= rounds; round++) {
    const order = shuffled(agents, rng);
    const start = events.length;
    for (let turn = 1; turn <= order.length; turn++) {
      const agent = order[turn - 1];
      const recent = events.slice(-lastK);
      // Always draw both numbers so the stream does not depend on branches.
      const wantsReply = rng() < 0.6;
      const pick = rng();
      const candidates = recent.filter((e) => e.agentId !== agent.id);
      const canReply = wantsReply && candidates.length > 0 && events.length > 0;
      const target = canReply ? candidates[Math.floor(pick * candidates.length)] : null;
      const targetName = target ? nameOf(agents, target.agentId) : null;

      const instruction = target
        ? `Reply to event #${target.id} from ${targetName}. Address ${targetName} by name.`
        : "Post a new message to the channel on a topic of your choosing.";
      const response = await clientFor(agent).chat({
        system: personaPrompt(agent),
        messages: [{
          role: "user",
          content: `Recent channel events:\n${recentLines(agents, recent)}\n\n${instruction}`,
        }],
        seed: seed * 1000003 + events.length,
      });
      // A missing or non-text reply would otherwise be stored as "null" or "[object Object]".
      // Empty and whitespace-only strings and numbers are accepted, as before.
      const got = response?.content;
      if (typeof got !== "string" && typeof got !== "number") {
        const seen = got === null || got === undefined ? String(got) : typeof got;
        throw new TypeError(`agent ${agent.id} returned no reply text (got ${seen}) in round ${round} turn ${turn}`);
      }
      // Whatever client produced it, stored text has no control or bidi characters
      // (they would otherwise reach the terminal through the transcript), is one line
      // (a live reply ending in "\n[Skeptic] ..." must not read as another agent's
      // transcript line, and CR must not overwrite the real prefix) and is bounded.
      let text = capUtf8Bytes(replaceUnsafeChars(response.content).replace(/[\r\n]+/g, " ").trim(), MAX_REPLY_BYTES).trimEnd();
      if (target && !text.includes(targetName)) text = `@${targetName} ${text}`;

      events.push({
        id: events.length + 1,
        round,
        turn,
        agentId: agent.id,
        kind: target ? "reply" : "post",
        replyTo: target ? target.id : null,
        text,
      });
    }
    prevHash = hashRound(prevHash, events.slice(start));
    roundHashes.push(prevHash);
  }

  return { seed, rounds, events, transcript: formatTranscript(events, agents), roundHashes };
}

/**
 * Recompute the hash chain from the events. True only if every round hash matches.
 * @param {{ events: SwarmEvent[], roundHashes: string[] }} result
 */
export function verifyRounds({ events, roundHashes }) {
  let prev = GENESIS_HASH;
  return roundHashes.every((hash, i) => {
    prev = hashRound(prev, events.filter((e) => e.round === i + 1));
    return prev === hash;
  }) && events.every((e) => e.round >= 1 && e.round <= roundHashes.length);
}

/** Human-readable transcript with round headers. */
export function formatTranscript(events, agents = AGENTS) {
  const lines = [];
  let round = null;
  for (const e of events) {
    if (e.round !== round) {
      if (round !== null) lines.push("");
      round = e.round;
      lines.push(`== Round ${round} ==`);
    }
    const who = nameOf(agents, e.agentId);
    if (e.kind === "reply") {
      const target = events.find((x) => x.id === e.replyTo);
      lines.push(`[${who} -> ${target ? nameOf(agents, target.agentId) : `#${e.replyTo}`}] ${e.text}`);
    } else {
      lines.push(`[${who}] ${e.text}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
