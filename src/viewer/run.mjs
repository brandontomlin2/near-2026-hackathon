// Swarm run document and a deterministic demo builder.
//
// A run is a JSON-serialisable object that the viewer renders. Real swarm
// output will write the same shape. Until then, buildDemoRun drives the four
// personas from PRODUCT.md through the inference client. In mock mode (the
// default) the transcript is the same on every run.
//
// Each round's hash chains to the previous round, the way the product anchors
// round hashes on-chain: roundHash = sha256(previousHash + canonical posts).

import { createHash } from "node:crypto";

import { createInferenceClient } from "../inference/client.mjs";

export const RUN_SCHEMA = "near-viewer/run@1";
export const GENESIS_HASH = "0".repeat(64);

/** The four personas from PRODUCT.md. */
export const AGENTS = Object.freeze([
  {
    id: "aloof",
    name: "Aloof",
    role: "observer",
    traits: { temperament: "cool", role: "observer", risk: "low", voice: "dry" },
    system: "You are Aloof, an observer. You speak dryly and mostly watch. Reply in one or two sentences.",
  },
  {
    id: "chaotic",
    name: "Chaotic",
    role: "trickster",
    traits: { temperament: "neon", role: "trickster", risk: "high", voice: "loud" },
    system: "You are Chaotic, a trickster. You provoke and joke. Reply in one or two sentences.",
  },
  {
    id: "social",
    name: "Social",
    role: "connector",
    traits: { temperament: "warm", role: "connector", risk: "mid", voice: "open" },
    system: "You are Social, a connector. You bring people together. Reply in one or two sentences.",
  },
  {
    id: "skeptic",
    name: "Skeptic",
    role: "auditor",
    traits: { temperament: "muted", role: "auditor", risk: "wary", voice: "flat" },
    system: "You are Skeptic, an auditor. You ask for evidence. Reply in one or two sentences.",
  },
].map((agent) => Object.freeze(agent)));

/** How many prior posts each agent sees, so prompts stay small. */
const CONTEXT_POSTS = 8;

/**
 * @param {string} previousHash
 * @param {{ author: string, text: string }[]} posts
 * @returns {string} 64-char hex sha256
 */
export function roundHash(previousHash, posts) {
  return createHash("sha256")
    .update(previousHash)
    .update(JSON.stringify(posts.map((p) => [p.author, p.text])))
    .digest("hex");
}

/**
 * Build a demo run. Agents post in fixed order each round and see the most
 * recent channel posts before they speak.
 *
 * @param {{
 *   rounds: number,
 *   client?: { mode: string, model: string, chat: Function },
 *   agents?: typeof AGENTS,
 * }} options
 * @returns {Promise<object>}
 */
export async function buildDemoRun({ rounds, client = createInferenceClient(), agents = AGENTS }) {
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new TypeError(`rounds must be a positive integer, got ${JSON.stringify(rounds)}`);
  }
  const channel = [];
  const roundRecords = [];
  let prev = GENESIS_HASH;

  for (let r = 1; r <= rounds; r += 1) {
    const posts = [];
    for (const agent of agents) {
      const recent = [...channel, ...posts].slice(-CONTEXT_POSTS);
      const transcript = recent.length === 0
        ? "The channel is empty."
        : recent.map((p) => `${p.author}: ${p.text}`).join("\n");
      const reply = await client.chat({
        system: agent.system,
        messages: [{
          role: "user",
          content: `Channel so far:\n${transcript}\n\nRound ${r}. Post or reply.`,
        }],
        seed: `${agent.id}:${r}`,
      });
      posts.push({ author: agent.name, text: reply.content.trim() });
    }
    const hash = roundHash(prev, posts);
    roundRecords.push({ round: r, hash, posts });
    channel.push(...posts);
    prev = hash;
  }

  return {
    schema: RUN_SCHEMA,
    mode: client.mode,
    model: client.model,
    agents: agents.map(({ id, name, role, traits }) => ({ id, name, role, traits })),
    rounds: roundRecords,
  };
}
