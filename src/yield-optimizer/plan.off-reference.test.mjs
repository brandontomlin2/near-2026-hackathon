// Off-reference guard: a pool quoting far above the reference price is distrusted, never traded.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan, DEFAULTS, renderPlan } from "./plan.mjs";
import { parseSnapshot } from "./snapshot.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/rhea-testnet-snapshot.json", import.meta.url));

function snap(mutate) {
  const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
  mutate(r);
  return parseSnapshot(r);
}
/** Pool 17 only; its USDC reserve is scaled by pct/100 (so the wNEAR -> USDC quote scales too). */
const pool17Only = (usdcPct) => (r) => {
  r.pools = r.pools.filter((p) => p.pool_id === 17);
  r.pools[0].amounts[1] = ((BigInt(r.pools[0].amounts[1]) * BigInt(usdcPct)) / 100n).toString();
};
const cand = (plan, id) => plan.json.candidates.find((c) => c.proposal.pool_id === id && c.proposal.token_in === "wrap.testnet");

describe("off-reference quotes are distrusted", () => {
  it("default limit is 1000 bps", () => {
    assert.equal(DEFAULTS.max_edge_bps, 1000);
  });

  it("the only pool quoting ~50% above reference -> hold, off_reference, no execute_swap call", () => {
    const s = snap(pool17Only(150));
    const plan = buildPlan(s);
    const c = cand(plan, 17);
    assert.ok(c.edge_bps > 4000, `edge ${c.edge_bps}`);
    assert.equal(c.status, "off_reference");
    assert.match(c.note, /above the reference price/);
    assert.match(c.note, /1000 bps limit/);
    assert.match(c.note, /distrusted/);
    assert.equal(plan.json.decision, "hold");
    assert.equal(plan.json.call, null);
    assert.equal(plan.chosen, null);
    assert.match(plan.json.reason, /off the reference price/);
    assert.match(plan.json.reason, /1000 bps/);
    assert.equal(plan.json.simulated_pnl_vs_hold.expected_pnl_usd, "0.0000");
    assert.match(renderPlan(s, plan), /SKIP off reference \(quote is [\d.]+ bps above/);
  });

  it("a wildly off-reference pool does not beat a modestly profitable one", () => {
    const s = snap((r) => {
      // Pool 17 stays at ~+120 bps. Pool 99 (also wNEAR/USDC) is allowed and quotes 3x the USDC.
      const p99 = r.pools.find((p) => p.pool_id === 99);
      p99.amounts[1] = (BigInt(p99.amounts[1]) * 3n).toString();
      r.vault.config.allowed_pools.push({ ...r.vault.config.allowed_pools[0], pool_id: 99 });
      r.pools = r.pools.filter((p) => p.pool_id !== 23);
    });
    const plan = buildPlan(s);
    assert.equal(cand(plan, 99).status, "off_reference");
    assert.ok(cand(plan, 99).edge_bps > cand(plan, 17).edge_bps);
    assert.equal(cand(plan, 17).status, "ok");
    assert.equal(plan.json.decision, "swap");
    assert.equal(plan.json.call.args.proposal.pool_id, 17);
  });

  it("boundary: edge equal to max_edge_bps is eligible, anything below it is not", () => {
    const s = snap(pool17Only(100));
    const edge = buildPlan(s).candidates.find((c) => c.proposal.token_in === "wrap.testnet").edge_bps;
    assert.ok(edge > 100 && edge < 200);
    const atLimit = buildPlan(s, { max_edge_bps: edge });
    assert.equal(cand(atLimit, 17).status, "ok");
    assert.equal(atLimit.json.decision, "swap");
    const justOver = buildPlan(s, { max_edge_bps: edge - 1e-6 });
    assert.equal(cand(justOver, 17).status, "off_reference");
    assert.equal(justOver.json.decision, "hold");
  });

  it("max_edge_bps can be overridden: a looser limit trades the 50%-off pool, the report shows the limit", () => {
    const s = snap(pool17Only(150));
    const loose = buildPlan(s, { max_edge_bps: 10_000 });
    assert.equal(cand(loose, 17).status, "ok");
    assert.equal(loose.json.decision, "swap");
    assert.equal(loose.json.params.max_edge_bps, 10_000);
    assert.equal(buildPlan(s).json.params.max_edge_bps, 1000);
  });

  it("below_min_edge keeps its own hold reason when no quote is off reference", () => {
    const plan = buildPlan(snap(pool17Only(100)), { min_edge_bps: 900 });
    assert.match(plan.json.reason, /^no allowed trade beats the reference price by 900 bps/);
  });
});
