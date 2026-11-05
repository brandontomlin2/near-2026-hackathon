// Rule-breaker scenarios: proposals the vault's on-chain rules reject, taken from the shared
// vectors in contracts/yield-vault/tests/rule-vectors.json (the same file the Rust tests run).
// Each one is re-checked here with the JS copy of check_rules (rules.mjs) and must produce the
// exact message the contract's vector expects; any drift throws so the demo fails loudly.
// Offline: reads one committed JSON file, nothing else.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkProposal } from "./rules.mjs";

export const VECTORS_SOURCE = "contracts/yield-vault/tests/rule-vectors.json";
const VECTORS_FILE = fileURLToPath(new URL("../../contracts/yield-vault/tests/rule-vectors.json", import.meta.url));

/** The scenarios, in display order, each pinned to a vector by exact name. */
export const SCENARIOS = [
  { id: "max_trade", label: "over max trade", vector: "ERR_MAX_TRADE: amount_in one above max_trade" },
  { id: "daily_cap", label: "over daily cap", vector: "ERR_DAILY_CAP: spent plus amount_in one above the daily cap" },
  { id: "price_floor", label: "below price floor", vector: "ERR_PRICE_FLOOR: pool 0 a->b one below the floor" },
  { id: "paused", label: "paused", vector: "ERR_PAUSED: vault is paused" },
];

export function loadVectors() {
  return JSON.parse(readFileSync(VECTORS_FILE, "utf8"));
}

/** A vector's state as the checkProposal state shape (the file's `recovery` is `recovery_in_flight`). */
export function stateOf(c, vectors) {
  const s = { ...vectors.base_state, ...c.state };
  return {
    paused: s.paused,
    in_flight: s.in_flight,
    recovery_in_flight: s.recovery,
    spent: { day: s.day, amounts: s.spent_today },
    balances: s.balances,
  };
}

/** @param {object} [vectors] the parsed rule-vectors.json (injectable for tests) */
export function ruleScenarios(vectors = loadVectors()) {
  const scenarios = SCENARIOS.map(({ id, label, vector }) => {
    const c = vectors.cases.find((x) => x.name === vector);
    if (!c) throw new Error(`rule scenario "${id}": vector "${vector}" is missing from ${VECTORS_SOURCE}`);
    const nowNs = BigInt(c.now_ns ?? vectors.base_state.now_ns);
    const r = checkProposal(c.proposal, vectors.config, stateOf(c, vectors), c.runner, Number(nowNs / 1_000_000n));
    if (r.ok) throw new Error(`rule scenario "${id}" (${vector}): rules.mjs accepted a proposal the contract rejects`);
    if (r.reason !== c.expect) {
      throw new Error(`rule scenario "${id}" (${vector}): rules.mjs says "${r.reason}" but the contract vector expects "${c.expect}"`);
    }
    return {
      id,
      label,
      vector,
      proposal: { ...c.proposal },
      state: c.state ?? {},
      outcome: "rejected",
      code: c.expect.split(":")[0],
      contract_message: c.expect,
      js_message: r.reason,
      matches_contract: true,
    };
  });
  return { source: VECTORS_SOURCE, contract_fn: "check_rules", scenarios };
}
