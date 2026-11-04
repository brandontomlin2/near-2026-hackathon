// One swarm round. Order: aloof and chaotic propose; skeptic reviews them (vetoes with a
// reason, or proposes a hedge); social adopts the majority of the other agents' eligible
// proposals; every proposal then goes through the vault's hard rules and the agent's own
// soft checks. The result is a decision record: what each agent did and what may execute.
//
// The skeptic reviews aloof and chaotic. Social copies a consensus that is made only of
// eligible proposals (valid, not vetoed, passing the hard rules), so a veto also keeps a
// proposal out of the consensus.

import { slippageBps, poolById } from "./pools.mjs";
import { ProposalError, parseProposal, parseReview, vaultArgs } from "./proposal.mjs";
import { evaluateProposal } from "./rules.mjs";
import { systemPrompt, userPrompt } from "./prompt.mjs";
import { AGENTS } from "../traits/agents.mjs";

export const AGENT_IDS = AGENTS.map((a) => a.id);

const ask = async (client, agentId, task, facts) => {
  const res = await client.chat({
    system: systemPrompt(agentId, task),
    messages: [{ role: "user", content: userPrompt({ task, agentId, ...facts }) }],
    temperature: 0,
    seed: facts.round,
  });
  return res.content;
};

const spentToday = (state, today) => (state.spent && state.spent.day === today ? state.spent.amount : "0");

function median(values) {
  const sorted = [...values].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)].toString();
}

/**
 * Majority of the eligible proposals: the largest group sharing pool and direction, needing
 * at least two members. Ties go to the group with the lowest pool_id. Amount is the (lower) median.
 */
export function computeConsensus(eligible) {
  const groups = new Map();
  for (const { agent, proposal } of eligible) {
    const key = `${proposal.pool_id}|${proposal.token_in}|${proposal.token_out}`;
    const g = groups.get(key) ?? { pool_id: proposal.pool_id, token_in: proposal.token_in, token_out: proposal.token_out, members: [] };
    g.members.push({ agent, amount_in: proposal.amount_in });
    groups.set(key, g);
  }
  const best = [...groups.values()]
    .filter((g) => g.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length || a.pool_id - b.pool_id)[0];
  if (!best) return null;
  return {
    pool_id: best.pool_id,
    token_in: best.token_in,
    token_out: best.token_out,
    amount_in: median(best.members.map((m) => m.amount_in)),
    supporters: best.members.map((m) => m.agent),
  };
}

/**
 * @param {object} args
 * @param {{ chat: Function }} args.client inference client (mock or live)
 * @param {Record<string, object>} args.configs VaultConfig per agent
 * @param {Record<string, object>} args.states vault state per agent
 * @param {object} args.fixture pool snapshot
 * @param {number} args.round 1-based
 * @param {number} args.nowMs
 * @param {string} args.runnerId
 * @param {string[]} [args.agents] restrict to these agents (single-agent mode: no cross-agent steps)
 */
export async function runRound({ client, configs, states, fixture, round, nowMs, runnerId, agents = AGENT_IDS }) {
  const today = Math.floor(nowMs / 86_400_000);
  const base = (id) => ({ round, config: configs[id], fixture, spentToday: spentToday(states[id], today) });
  const decisions = Object.fromEntries(agents.map((id) => [id, { agent: id, status: "none", proposal: null, error: null, hard: null, soft: null, veto: null, outcome: "none" }]));
  const active = (id) => agents.includes(id);

  const evaluate = (id, proposal, ctx) => evaluateProposal(proposal, id, configs[id], states[id], runnerId, nowMs, fixture, ctx);
  const propose = async (id, ctx = {}, extra = {}) => {
    const d = decisions[id];
    try {
      d.proposal = parseProposal(await ask(client, id, "propose", { ...base(id), ...extra }));
      d.status = "proposed";
      Object.assign(d, evaluate(id, d.proposal, ctx));
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error;
      d.status = "invalid";
      d.error = { code: error.code, message: error.message };
    }
  };

  for (const id of ["aloof", "chaotic"]) if (active(id)) await propose(id);

  // Skeptic: review aloof and chaotic, then maybe a hedge.
  let review = null;
  if (active("skeptic")) {
    const reviewed = ["aloof", "chaotic"].filter((id) => decisions[id]?.proposal);
    const others = reviewed.map((id) => {
      const p = decisions[id].proposal;
      const pool = poolById(p.pool_id, fixture);
      return {
        agent: id,
        proposal: p,
        size_bps_of_max_trade: Number((BigInt(p.amount_in) * 10000n) / BigInt(configs[id].max_trade)),
        slippage_bps: pool ? slippageBps(pool, p) : null,
      };
    });
    const d = decisions.skeptic;
    try {
      review = parseReview(await ask(client, "skeptic", "review", { ...base("skeptic"), others }), AGENT_IDS);
      for (const v of review.vetoes) {
        if (decisions[v.agent]?.proposal) decisions[v.agent].veto = { by: "skeptic", reason: v.reason };
      }
      if (review.hedge) {
        d.proposal = review.hedge;
        d.status = "proposed";
        Object.assign(d, evaluate("skeptic", d.proposal));
      } else {
        d.status = "abstained";
      }
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error;
      d.status = "invalid";
      d.error = { code: error.code, message: error.message };
    }
  }

  // Social: majority of the eligible proposals of the other agents.
  let consensus = null;
  if (active("social")) {
    const eligible = ["aloof", "chaotic", "skeptic"]
      .map((id) => decisions[id])
      .filter((d) => d && d.proposal && d.hard?.ok && !d.veto)
      .map((d) => ({ agent: d.agent, proposal: d.proposal }));
    consensus = computeConsensus(eligible);
    if (consensus) await propose("social", { consensus }, { consensus });
    else decisions.social.status = "abstained";
  }

  const executions = [];
  for (const d of Object.values(decisions)) {
    if (d.status === "invalid") d.outcome = "invalid";
    else if (d.status === "abstained" || !d.proposal) d.outcome = "none";
    else if (d.veto) d.outcome = "vetoed";
    else if (!d.hard.ok) d.outcome = "rejected_hard";
    else if (!d.soft.ok) d.outcome = "rejected_soft";
    else {
      d.outcome = "execute";
      executions.push({ agent: d.agent, proposal: d.proposal, vault_args: vaultArgs(d.proposal) });
    }
  }
  return { round, now_ms: nowMs, consensus, review, decisions, executions };
}
