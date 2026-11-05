// Deterministic mock responder for the yield agents. It reads the same JSON facts a live
// model would and answers with strategy-appropriate strict JSON. It is a stand-in, not
// a model: the schedule below is fixed per round so the demo shows every outcome.

import { createMockClient } from "../inference/client.mjs";
import { floorMinOut, loadPoolFixture, minOutFor, poolById, quoteOut } from "./pools.mjs";
import { NUSDC, NUSDT, WNEAR, strategyFor } from "./strategies.mjs";

// Chaotic's size (bps of max_trade for wNEAR) and slippage by round, cycling: a big one the
// skeptic vetoes, a modest one that passes, one over the vault's max_trade (the hard rules
// discard it: ERR_MAX_TRADE), a loose-slippage one the skeptic vetoes, and one whose
// min_amount_out sits below the pool's price floor (the hard rules discard it: ERR_PRICE_FLOOR).
// `below_floor` skips the floor clamp on purpose; every other entry respects the floor.
const CHAOTIC_SCHEDULE = [
  { size_bps: 10000, slip: 300 },
  { size_bps: 6000, slip: 150 },
  { size_bps: 13000, slip: 300 },
  { size_bps: 6500, slip: 400 },
  { size_bps: 6000, slip: 6000, below_floor: true },
];

const fraction = (value, bps) => ((BigInt(value) * BigInt(bps)) / 10000n).toString();

// The vault's max_trade for `tokenIn` from the facts (a token without a limit cannot be sold: 0).
const maxTradeOf = (facts, tokenIn) => facts.limits.find((l) => l.token_id === tokenIn)?.max_trade ?? "0";

function build(pool, tokenIn, amountIn, slip, rationale, fixture, { belowFloor = false } = {}) {
  const p = poolById(pool.pool_id, fixture);
  const tokenOut = tokenIn === p.token_a ? p.token_b : p.token_a;
  let minOut = minOutFor(p, tokenIn, amountIn, slip);
  const rate = pool[tokenIn === p.token_a ? "min_rate_a_to_b" : "min_rate_b_to_a"];
  if (rate && !belowFloor) {
    // Clamp up to the floor only when the quote itself clears it. A quote below the floor means
    // the pool is mispriced against the vault's reference: raising min_out to the floor would
    // build a swap that is guaranteed to revert on Ref (stranding funds), so leave min_out from
    // the quote and let the hard rule (ERR_PRICE_FLOOR) refuse it off chain.
    const floor = floorMinOut(rate, amountIn);
    if (minOut < floor && quoteOut(p, tokenIn, amountIn) >= floor) minOut = floor;
  }
  return {
    pool_id: p.pool_id,
    token_in: tokenIn,
    token_out: tokenOut,
    amount_in: amountIn,
    min_amount_out: minOut.toString(),
    rationale,
  };
}

// Odd rounds trade nusdt -> nusdc, even rounds nusdc -> nusdt, so the stable pool is used both ways.
const stableIn = (round) => (round % 2 === 1 ? NUSDT : NUSDC);

function propose(facts, fixture) {
  const { agent, round } = facts;
  const s = strategyFor(agent).params;
  const pools = facts.allowed_pools;
  const stable = pools.find((p) => p.stable);
  const volatile = pools.find((p) => !p.stable);
  if (agent === "aloof" || agent === "skeptic") {
    const size = agent === "skeptic" ? s.audit.hedge_size_bps : s.size_bps;
    const tokenIn = stableIn(round);
    return build(stable, tokenIn, fraction(maxTradeOf(facts, tokenIn), size), s.slippage_bps, "Stable pair, small size, tight slippage.", fixture);
  }
  if (agent === "chaotic") {
    const step = CHAOTIC_SCHEDULE[(round - 1) % CHAOTIC_SCHEDULE.length];
    return build(volatile, WNEAR, fraction(maxTradeOf(facts, WNEAR), step.size_bps), step.slip, "Momentum is up, size up and ride it.", fixture, { belowFloor: step.below_floor });
  }
  // social: adopt the consensus, capped at its own max_trade
  const c = facts.consensus;
  const max = maxTradeOf(facts, c.token_in);
  const amount = BigInt(c.amount_in) > BigInt(max) ? max : c.amount_in;
  return build(pools.find((x) => x.pool_id === c.pool_id) ?? { pool_id: c.pool_id }, c.token_in, amount, s.slippage_bps, `Following the swarm: ${c.supporters.join(" and ")} agree.`, fixture);
}

function review(facts, fixture) {
  const a = strategyFor("skeptic").params.audit;
  const vetoes = [];
  let volatileSeen = false;
  for (const o of facts.others) {
    const pool = poolById(o.proposal.pool_id, fixture);
    if (pool && !(fixture.tokens[pool.token_a]?.stable && fixture.tokens[pool.token_b]?.stable)) volatileSeen = true;
    if (o.size_bps_of_max_trade > a.veto_size_bps) {
      vetoes.push({ agent: o.agent, reason: `size is ${o.size_bps_of_max_trade} bps of max_trade, above my ${a.veto_size_bps} bps line` });
    } else if (o.slippage_bps === null || o.slippage_bps > a.veto_slippage_bps) {
      vetoes.push({ agent: o.agent, reason: `slippage allowance ${o.slippage_bps ?? "unquotable"} bps is above my ${a.veto_slippage_bps} bps line` });
    }
  }
  return { vetoes, hedge: volatileSeen ? propose({ ...facts, agent: "skeptic" }, fixture) : null };
}

/** @type {import("../inference/client.mjs").MockResponder} */
export function yieldMockResponder(request) {
  const facts = JSON.parse(request.messages.at(-1).content);
  const fixture = loadPoolFixture();
  if (facts.task === "review") return JSON.stringify(review(facts, fixture));
  return JSON.stringify(propose(facts, fixture));
}

/** The fixed clock of every mock run (2026-11-03 00:00 UTC), so the mock output is the same bytes every time. */
export const MOCK_EPOCH_MS = Date.UTC(2026, 10, 3);

/** A mock inference client wired to the yield responder. */
export function createYieldMockClient() {
  return createMockClient({ model: "mock-yield", responder: yieldMockResponder });
}
