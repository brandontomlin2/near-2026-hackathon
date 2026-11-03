// The four seeded swarm agents (PRODUCT.md, "The four agents").

import { assertTraits } from "./validate.mjs";

/** @typedef {{ id: string, name: string, personality: string, traits: Readonly<import("./validate.mjs").Traits> }} Agent */

/** @type {(id: string, name: string, personality: string, traits: object) => Readonly<Agent>} */
const agent = (id, name, personality, traits) =>
  Object.freeze({ id, name, personality, traits: assertTraits({ ...traits, memory_depth: 1 }) });

export const AGENTS = Object.freeze([
  agent("aloof", "Aloof", "Observer", { temperament: "cool", role: "observer", risk: "low", voice: "dry" }),
  agent("chaotic", "Chaotic", "Trickster", { temperament: "neon", role: "trickster", risk: "high", voice: "loud" }),
  agent("social", "Social", "Connector", { temperament: "warm", role: "connector", risk: "mid", voice: "open" }),
  agent("skeptic", "Skeptic", "Auditor", { temperament: "muted", role: "auditor", risk: "wary", voice: "flat" }),
]);
