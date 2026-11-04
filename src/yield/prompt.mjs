// Prompts for the yield agents. The system message carries the role, the rules and the
// strict reply format; the user message is one JSON document (the facts for this round),
// which the mock responder parses and a live model reads.

import { AGENTS, agentById } from "../traits/agents.mjs";
import { PROPOSAL_KEYS } from "./proposal.mjs";
import { strategyFor } from "./strategies.mjs";

const PROPOSAL_SHAPE = `{"pool_id": <integer>, "token_in": "<account id>", "token_out": "<account id>", "amount_in": "<decimal integer string>", "min_amount_out": "<decimal integer string>", "rationale": "<one short sentence>"}`;

const RULES = `Hard vault rules (enforced on chain; a proposal that breaks one is discarded, never sent):
- pool_id must be in allowed_pools; token_in and token_out must be the two different tokens of that pool.
- amount_in and min_amount_out must be greater than 0.
- limits are per token_in, in that token's own base units: a token without an entry in limits cannot be sold; amount_in must not exceed that entry's max_trade, and spent_today[token_in] plus amount_in must not exceed its daily_cap.
- each pool has a price floor per direction (min_rate_a_to_b, min_rate_b_to_a as num/den): min_amount_out * den must be at least amount_in * num.
- min_amount_out is your slippage floor: quote times (10000 - slippage_bps) / 10000.`;

const FORMAT = `Reply with strict JSON only: exactly one JSON object, no code fence, no text before or after, exactly the keys ${PROPOSAL_KEYS.join(", ")}. Amounts are decimal integer strings without leading zeros.`;

/** @param {string} agentId @param {"propose" | "review"} task */
export function systemPrompt(agentId, task) {
  const agent = agentById(agentId);
  const s = strategyFor(agentId);
  const head = `You are the yield agent "${agent.name}" (${agent.personality}) in a four-agent swarm on NEAR testnet. Strategy: ${s.name}. ${s.description}\nagent: ${agentId}\ntask: ${task}\nStrategy params: ${JSON.stringify(s.params)}`;
  if (task === "review") {
    const ids = AGENTS.map((a) => a.id).join(", ");
    return `${head}\n\n${RULES}\n\nYou audit the other agents' proposals listed in the user message. Veto a proposal that sits close to the vault limits (size above audit.veto_size_bps of the max_trade for its token_in) or allows loose slippage (above audit.veto_slippage_bps). If any volatile exposure was proposed, you may also propose a small hedge back to stable.\nReply with strict JSON only: exactly one JSON object, no code fence, no text before or after, exactly the keys vetoes and hedge:\n{"vetoes": [{"agent": "<one of ${ids}>", "reason": "<short>"}], "hedge": ${PROPOSAL_SHAPE} or null}`;
  }
  return `${head}\n\n${RULES}\n\nPropose exactly one swap, within your strategy.\n${FORMAT}\nShape: ${PROPOSAL_SHAPE}`;
}

/** The pool list a prompt shows: only the pools the agent's vault allows, with fixture reserves. */
export function poolFacts(config, fixture) {
  return config.allowed_pools.map((ap) => {
    const p = fixture.pools.find((x) => x.pool_id === ap.pool_id);
    return {
      pool_id: ap.pool_id,
      token_a: ap.token_a,
      token_b: ap.token_b,
      reserve_a: p?.reserve_a ?? "0",
      reserve_b: p?.reserve_b ?? "0",
      min_rate_a_to_b: ap.min_rate_a_to_b,
      min_rate_b_to_a: ap.min_rate_b_to_a,
      fee_bps: p?.total_fee ?? 0,
      stable: Boolean(p && fixture.tokens[p.token_a]?.stable && fixture.tokens[p.token_b]?.stable),
    };
  });
}

/** @returns {string} the user message (JSON) */
export function userPrompt({ task, round, agentId, config, fixture, spentToday, others = [], consensus = null }) {
  return JSON.stringify({
    task,
    round,
    agent: agentId,
    limits: config.limits,
    spent_today: spentToday,
    allowed_pools: poolFacts(config, fixture),
    others,
    consensus,
  });
}
