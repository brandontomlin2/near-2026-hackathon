// Behaviour tests for plan building and rendering (plan.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan, clipToLimits, MIN_EXECUTE_GAS_TGAS, DRY_RUN_NOTICE, DEFAULTS, formatUnits, renderPlan } from "./plan.mjs";
import { EXECUTE_SWAP_GAS_CLI, EXECUTE_SWAP_TGAS } from "../yield/gas.mjs";
import { quoteOut } from "../yield/pools.mjs";
import { checkProposal } from "../yield/rules.mjs";
import { PLACEHOLDER_RUNNER, PLACEHOLDER_VAULT, WNEAR as WNEAR_ID, limitFor, plannerVaultConfig } from "../yield/strategies.mjs";
import { MOCK_EPOCH_MS } from "../yield/mock.mjs";
import { loadSnapshot, rulesView } from "./snapshot.mjs";

/** The vault's rules on a snapshot, as `{ ok, reason }` (the contract's CheckResult). */
const checkRules = (snap, proposal) => {
  const v = rulesView(snap);
  const { ok, reason } = checkProposal(proposal, v.config, v.state, snap.runner_id, v.nowMs);
  return { ok, reason };
};
import { parseSnapshot } from "./snapshot.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/scenario.hand-built.json", import.meta.url));
const WNEAR = "wnear.fixture.testnet";
const USDC = "usdc.fixture.testnet";
const DAI = "dai.fixture.testnet";
const E26 = 10n ** 26n;

/** Fixture snapshot, optionally mutated on the raw JSON first. */
function snap(mutate) {
  const r = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (mutate) mutate(r);
  return parseSnapshot(r);
}
const onlyPool = (r, id) => (r.pools = r.pools.filter((p) => p.pool_id === id));
const onlyPool17 = (r) => onlyPool(r, 17);
const cand = (plan, poolId) => plan.json.candidates.find((c) => c.proposal.pool_id === poolId);

describe("buildPlan on the fixture", () => {
  const s = snap();
  const plan = buildPlan(s);
  const j = plan.json;

  it("swaps wNEAR -> USDC on pool 17, clipped to max_trade", () => {
    assert.equal(j.decision, "swap");
    assert.equal(j.call.args.proposal.pool_id, 17);
    assert.equal(j.call.args.proposal.token_in, WNEAR);
    assert.equal(j.call.args.proposal.token_out, USDC);
    assert.equal(j.call.args.proposal.amount_in, (2n * E26).toString());
    assert.ok(cand(plan, 17).clipped_by.includes("max_trade"));
    assert.equal(cand(plan, 17).wanted_amount_in, (5n * E26).toString());
  });

  it("call JSON has exactly the SwapProposal keys, decimal strings, 280 TGas, 0 deposit", () => {
    assert.deepEqual(Object.keys(j.call.args), ["proposal"]);
    const p = j.call.args.proposal;
    assert.deepEqual(Object.keys(p).sort(), ["amount_in", "min_amount_out", "pool_id", "token_in", "token_out"]);
    assert.match(p.amount_in, /^[1-9]\d*$/);
    assert.match(p.min_amount_out, /^[1-9]\d*$/);
    assert.equal(typeof p.pool_id, "number");
    assert.equal(j.call.method_name, "execute_swap");
    assert.equal(j.call.receiver_id, "yield-vault.fixture.testnet");
    assert.equal(j.call.gas_tgas, EXECUTE_SWAP_TGAS);
    assert.equal(j.call.gas, EXECUTE_SWAP_GAS_CLI);
    assert.equal(j.call.deposit_yocto, "0");
  });

  it("is a dry run: dry_run true, signed false, sent false", () => {
    assert.equal(j.dry_run, true);
    assert.equal(j.signed, false);
    assert.equal(j.sent, false);
    assert.equal(j.notice, DRY_RUN_NOTICE);
  });

  it("the chosen proposal passes checkRules, and so does the reported check", () => {
    assert.deepEqual(checkRules(s, plan.chosen.proposal), { ok: true, reason: "" });
    assert.deepEqual(j.check, { ok: true, reason: "" });
    assert.equal(typeof plan.chosen.proposal.amount_in, "bigint");
  });

  it("refuses the disallowed-token candidate (pool 23 sells DAI) with ERR_NO_LIMIT", () => {
    const c = cand(plan, 23);
    assert.equal(c.status, "refused");
    assert.match(c.check.reason, /^ERR_NO_LIMIT/);
  });

  it("refuses the non-allowed pool 99 with ERR_POOL_NOT_ALLOWED", () => {
    const c = cand(plan, 99);
    assert.equal(c.status, "refused");
    assert.match(c.check.reason, /^ERR_POOL_NOT_ALLOWED: pool 99/);
  });

  it("swap P&L: expected >= worst, and expected beats holding", () => {
    assert.ok(plan.pnl.expected_usd >= plan.pnl.worst_usd);
    assert.ok(plan.pnl.expected_usd > plan.pnl.hold_usd);
    assert.ok(Number(j.simulated_pnl_vs_hold.expected_pnl_usd) > 0);
    assert.ok(Number(j.simulated_pnl_vs_hold.expected_pnl_usd) >= Number(j.simulated_pnl_vs_hold.worst_case_pnl_usd));
  });

  it("min_amount_out is the pools.mjs quote less slippage (the one quote function)", () => {
    const pool = s.pools.find((p) => p.pool_id === 17);
    const out = quoteOut(pool, WNEAR, 2n * E26);
    assert.ok(out > 0n);
    assert.equal(plan.chosen.expected_out, out);
    assert.equal(j.candidates.find((c) => c.proposal.pool_id === 17).expected_amount_out, out.toString());
    assert.equal(plan.chosen.proposal.min_amount_out, (out * 9950n) / 10000n);
    const tight = buildPlan(s, { slippage_bps: 0 });
    assert.equal(tight.chosen.proposal.min_amount_out, out);
  });
});

describe("buildPlan holds", () => {
  it("paused vault -> hold, every candidate refused with ERR_PAUSED, zero P&L", () => {
    const plan = buildPlan(snap((r) => (r.vault.state.paused = true)));
    assert.equal(plan.json.decision, "hold");
    assert.equal(plan.json.call, null);
    assert.equal(plan.json.check, null);
    assert.equal(plan.json.reason, "no pool passes every gate (3 refused by the vault rules)");
    for (const c of plan.json.candidates) assert.match(c.check.reason, /^ERR_PAUSED/);
    assert.equal(plan.pnl.expected_usd, plan.pnl.hold_usd);
    assert.equal(plan.pnl.worst_usd, plan.pnl.hold_usd);
    const s = plan.json.simulated_pnl_vs_hold;
    assert.equal(s.expected_pnl_usd, "0.0000");
    assert.equal(s.worst_case_pnl_usd, "0.0000");
    assert.equal(s.expected_pnl_bps, 0);
    assert.equal(s.worst_case_pnl_bps, 0);
  });

  it("swap in flight and recovery in flight both hold", () => {
    for (const k of ["swap_in_flight", "recovery_in_flight"]) {
      const plan = buildPlan(snap((r) => (r.vault.state[k] = true)));
      assert.equal(plan.json.decision, "hold", k);
      assert.match(plan.json.candidates[0].check.reason, /^ERR_SWAP_IN_FLIGHT/);
    }
  });

  it("min_edge_bps huge -> hold with the below-min-edge reason", () => {
    const plan = buildPlan(snap(), { min_edge_bps: 10_000 });
    assert.equal(plan.json.decision, "hold");
    assert.equal(cand(plan, 17).status, "below_min_edge");
    assert.match(plan.json.reason, /^no pool passes every gate \(1 below the 10000 bps min edge, 2 refused by the vault rules\)$/);
    assert.equal(plan.json.simulated_pnl_vs_hold.expected_pnl_usd, "0.0000");
  });

  it("slippage so large that min_amount_out falls below the pool floor -> ERR_PRICE_FLOOR", () => {
    const plan = buildPlan(snap(), { slippage_bps: 9_999 });
    const c = cand(plan, 17);
    assert.equal(c.status, "refused");
    assert.match(c.check.reason, /^ERR_PRICE_FLOOR/);
    assert.equal(plan.json.decision, "hold");
  });

  it("daily cap fully spent today -> candidate refused with ERR_DAILY_CAP, plan holds", () => {
    const plan = buildPlan(
      snap((r) => {
        onlyPool17(r);
        r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]]; // == daily_cap
        r.vault.state.balances[0][1] = E26.toString(); // wanted 0.5e26 < max_trade, so the cap is the binding rule
        r.vault.state.balances = [r.vault.state.balances[0]]; // only wNEAR, so the other direction is empty and refused too
      }),
    );
    const c = plan.json.candidates[0];
    assert.equal(plan.json.decision, "hold");
    assert.equal(c.status, "refused");
    assert.equal(c.blocked_by, "daily_cap");
    assert.match(c.check.reason, /^ERR_DAILY_CAP/);
    // Refused at the wanted size, not at 0.
    assert.equal(c.proposal.amount_in, c.wanted_amount_in);
  });

  it("an older stored day resets the daily cap: the same spend no longer blocks", () => {
    const plan = buildPlan(
      snap((r) => {
        onlyPool17(r);
        r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]];
        r.vault.state.day = 20760;
      }),
    );
    assert.equal(plan.json.decision, "swap");
    assert.deepEqual(cand(plan, 17).clipped_by, ["max_trade"]);
  });

  it("daily cap fully spent with a large wanted size still reports ERR_DAILY_CAP (the binding rule) and holds", () => {
    const plan = buildPlan(
      snap((r) => {
        onlyPool17(r);
        r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]];
        r.vault.state.balances = [r.vault.state.balances[0]]; // only wNEAR
      }),
    );
    const c = plan.json.candidates[0];
    assert.equal(plan.json.decision, "hold");
    assert.deepEqual(c.clipped_by, ["max_trade"]);
    assert.equal(c.blocked_by, "daily_cap");
    assert.equal(c.proposal.amount_in, (2n * E26).toString());
    assert.match(c.check.reason, /^ERR_DAILY_CAP/);
  });

  it("a direction the vault refuses does not hide the other: better-spot wNEAR -> USDC is refused, USDC -> wNEAR is ok", () => {
    const s = snap((r) => {
      onlyPool17(r);
      r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]]; // wNEAR daily_cap fully spent
    });
    const pool = s.pools[0];
    const refused = buildPlan(s).json.candidates[0];
    // Default min edge: the wNEAR side is refused and USDC -> wNEAR is allowed but too thin.
    assert.equal(refused.status, "below_min_edge");
    assert.equal(refused.proposal.token_in, USDC);
    // Looser min edge: the allowed direction wins even though wNEAR -> USDC has the better spot edge.
    const plan = buildPlan(s, { min_edge_bps: -500 });
    const c = plan.json.candidates[0];
    assert.equal(pool.token_a, WNEAR);
    assert.equal(c.status, "ok");
    assert.equal(c.proposal.token_in, USDC);
    assert.equal(c.proposal.token_out, WNEAR);
    assert.equal(plan.json.decision, "swap");
    assert.deepEqual(plan.json.check, { ok: true, reason: "" });
    assert.deepEqual(checkRules(s, plan.chosen.proposal), { ok: true, reason: "" });
  });

  it("an empty-balance vault holds", () => {
    const plan = buildPlan(snap((r) => (r.vault.state.balances = [])));
    assert.equal(plan.json.decision, "hold");
    assert.match(cand(plan, 17).check.reason, /^ERR_ZERO_AMOUNT/);
    assert.match(cand(plan, 23).check.reason, /^ERR_ZERO_AMOUNT/);
    assert.match(cand(plan, 99).check.reason, /^ERR_POOL_NOT_ALLOWED/);
  });

  it("a balance token named like an Object.prototype member, with no tokens entry, does not crash", () => {
    for (const id of ["toString", "constructor", "__proto__"]) {
      const s = snap((r) => r.vault.state.balances.push([id, "5"]));
      const plan = buildPlan(s);
      assert.equal(plan.json.decision, "swap", id);
      const text = renderPlan(s, plan);
      assert.match(text, new RegExp(`5 \\(base units of ${id}\\)`), id);
    }
  });

  it("zero pools -> hold, 'snapshot has no pools'", () => {
    const s = snap((r) => (r.pools = []));
    const plan = buildPlan(s);
    assert.equal(plan.json.decision, "hold");
    assert.equal(plan.json.reason, "snapshot has no pools");
    assert.deepEqual(plan.json.candidates, []);
    assert.match(renderPlan(s, plan), /none: the snapshot has no pools/);
  });
});

describe("buildPlan clipping", () => {
  it("clipped by remaining daily cap", () => {
    const plan = buildPlan(
      snap((r) => {
        onlyPool17(r);
        r.vault.state.spent_today = [[WNEAR, (4n * E26).toString()]]; // 1e26 left
      }),
    );
    assert.equal(plan.json.decision, "swap");
    assert.equal(plan.json.call.args.proposal.amount_in, E26.toString());
    assert.deepEqual(cand(plan, 17).clipped_by, ["max_trade", "daily_cap"]);
  });

  it("an unclipped trade has an empty clipped_by", () => {
    const plan = buildPlan(
      snap((r) => {
        onlyPool17(r);
        r.vault.state.balances[0][1] = E26.toString();
      }),
    );
    assert.deepEqual(cand(plan, 17).clipped_by, []);
    assert.equal(plan.json.call.args.proposal.amount_in, (E26 / 2n).toString());
  });
});

describe("clipToLimits", () => {
  const s = snap();
  it("max_trade", () => {
    assert.deepEqual(clipToLimits(s, WNEAR, 5n * E26), { amount: 2n * E26, clipped_by: ["max_trade"], blocked_by: null });
  });
  it("remaining daily cap (cap 5e26, spent 1e26 -> 4e26 left; max_trade binds first)", () => {
    const t = snap((r) => {
      r.vault.config.limits[0].max_trade = (5n * E26).toString();
    });
    assert.deepEqual(clipToLimits(t, WNEAR, 9n * E26), { amount: 4n * E26, clipped_by: ["max_trade", "daily_cap"], blocked_by: null });
    assert.deepEqual(clipToLimits(t, WNEAR, 4n * E26 + 1n).clipped_by, ["daily_cap"]);
  });
  it("balance", () => {
    // USDC: max_trade 1e9, daily_cap 2e9, balance 5e8.
    assert.deepEqual(clipToLimits(s, USDC, 900_000_000n), { amount: 500_000_000n, clipped_by: ["balance"], blocked_by: null });
  });
  it("within all limits is untouched", () => {
    assert.deepEqual(clipToLimits(s, WNEAR, E26), { amount: E26, clipped_by: [], blocked_by: null });
  });
  it("spent_today of an older day is ignored", () => {
    const t = snap((r) => {
      r.vault.state.day = 20700;
      r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]];
      r.vault.config.limits[0].max_trade = (5n * E26).toString();
    });
    assert.deepEqual(clipToLimits(t, WNEAR, 5n * E26), { amount: 5n * E26, clipped_by: [], blocked_by: null });
  });
  it("fully spent cap is reported as blocked_by daily_cap, not clipped to zero", () => {
    const t = snap((r) => (r.vault.state.spent_today = [[WNEAR, (5n * E26).toString()]]));
    assert.deepEqual(clipToLimits(t, WNEAR, E26), { amount: E26, clipped_by: [], blocked_by: "daily_cap" });
    // Earlier clips still apply before the block.
    assert.deepEqual(clipToLimits(t, WNEAR, 5n * E26), { amount: 2n * E26, clipped_by: ["max_trade"], blocked_by: "daily_cap" });
  });
  it("an empty balance is reported as blocked_by balance", () => {
    const t = snap((r) => (r.vault.state.balances = []));
    assert.deepEqual(clipToLimits(t, WNEAR, 1n), { amount: 1n, clipped_by: [], blocked_by: "balance" });
  });
  it("no limit for the token: nothing is clipped", () => {
    assert.deepEqual(clipToLimits(s, DAI, 10n ** 30n), { amount: 10n ** 30n, clipped_by: [], blocked_by: null });
  });
});

describe("formatUnits", () => {
  it("formatUnits trims zeros and truncates to 6 decimals", () => {
    assert.equal(formatUnits(1_500_000n, 6), "1.5");
    assert.equal(formatUnits(1_000_000n, 6), "1");
    assert.equal(formatUnits(5n, 6), "0.000005");
    assert.equal(formatUnits(1_234_567_891n, 9), "1.234567");
    assert.equal(formatUnits(-2_500_000n, 6), "-2.5");
    assert.equal(formatUnits(7n, 0), "7");
  });
});

describe("renderPlan", () => {
  it("starts with DRY RUN and ends with the notice (swap)", () => {
    const s = snap();
    const text = renderPlan(s, buildPlan(s));
    assert.ok(text.startsWith("DRY RUN"));
    assert.ok(text.includes(DRY_RUN_NOTICE));
    assert.ok(text.endsWith(DRY_RUN_NOTICE));
    assert.match(text, /Decision: SWAP .*wnear.*usdc.* on pool 17/);
    assert.match(text, /REFUSED ERR_NO_LIMIT/);
    assert.match(text, /REFUSED ERR_POOL_NOT_ALLOWED/);
    assert.match(text, /Would call execute_swap on yield-vault\.fixture\.testnet with 280\.0 Tgas/);
  });
  it("renders a hold", () => {
    const s = snap((r) => (r.vault.state.paused = true));
    const text = renderPlan(s, buildPlan(s));
    assert.ok(text.startsWith("DRY RUN"));
    assert.ok(text.includes(DRY_RUN_NOTICE));
    assert.match(text, /Decision: HOLD - no pool passes every gate \(3 refused by the vault rules\)/);
    assert.match(text, /\$0\.0000/);
  });
});

describe("gas", () => {
  it("MIN_EXECUTE_GAS_TGAS is the one figure from src/yield/gas.mjs, equal to lib.rs MIN_EXECUTE_GAS", () => {
    const lib = readFileSync(fileURLToPath(new URL("../../contracts/yield-vault/src/lib.rs", import.meta.url)), "utf8");
    const m = lib.match(/pub const MIN_EXECUTE_GAS: Gas = Gas::from_tgas\((\d+)\);/);
    assert.ok(m, "MIN_EXECUTE_GAS not found in lib.rs");
    assert.equal(MIN_EXECUTE_GAS_TGAS, Number(m[1]));
  });
  it("plan.mjs holds no gas literal of its own", () => {
    const src = readFileSync(fileURLToPath(new URL("./plan.mjs", import.meta.url)), "utf8");
    // Code only: a comment may mention the figure.
    const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert.doesNotMatch(code, /\b280\b/);
  });
});

describe("reference guard", () => {
  // Pool 99 (same pair as pool 17, 4.8% off the reference) is made allowed, then moved far off.
  const allowPool99 = (r) => {
    r.vault.config.allowed_pools.push({ ...r.vault.config.allowed_pools[0], pool_id: 99 });
  };

  it("a pool far from the reference is off_reference and never chosen, even with the biggest raw edge", () => {
    const s = snap((r) => {
      allowPool99(r);
      r.pools.find((p) => p.pool_id === 99).reserve_b = "650000000000"; // 6.50 USDC per wNEAR vs 3.10 reference
    });
    const plan = buildPlan(s);
    const junk = cand(plan, 99);
    assert.equal(junk.status, "off_reference");
    assert.ok(junk.ref_deviation_bps > DEFAULTS.max_ref_deviation_bps, `deviation ${junk.ref_deviation_bps}`);
    // Its raw edge really is the biggest of all candidates...
    assert.ok(junk.edge_bps > cand(plan, 17).edge_bps, "the junk pool would win on raw edge");
    // ...and the sane pool 17 is chosen instead.
    assert.equal(plan.json.decision, "swap");
    assert.equal(plan.json.call.args.proposal.pool_id, 17);
    assert.match(renderPlan(s, plan), /pool 99 wnear -> usdc: .*SKIP off reference: spot \+\d+ bps vs the mock reference price \(limit 1000 bps\); quote is [\d.]+ bps above the reference price, over the 1000 bps limit/);
  });

  it("with only the junk pool the plan holds and the reason names the guard", () => {
    const s = snap((r) => {
      allowPool99(r);
      onlyPool(r, 99);
      r.pools[0].reserve_b = "650000000000";
    });
    const plan = buildPlan(s);
    assert.equal(plan.json.decision, "hold");
    assert.equal(plan.json.call, null);
    assert.match(plan.json.reason, /1 off the mock reference price \(spot more than 1000 bps away, or quote more than 1000 bps above\)/);
  });

  it("max_ref_deviation_bps is a parameter: widening it lets a 4.8% off pool through the guard", () => {
    const s = snap((r) => {
      allowPool99(r);
      onlyPool(r, 99);
    });
    assert.equal(cand(buildPlan(s), 99).status, "ok"); // 4.8% is inside the default 10%
    assert.equal(cand(buildPlan(s, { max_ref_deviation_bps: 100 }), 99).status, "off_reference");
  });

  it("a token without a mock reference price gives no_reference_price, no edge and no fake price", () => {
    const s = snap((r) => {
      r.tokens["usdc.fixture.testnet"].mock_usd_price = null;
    });
    const plan = buildPlan(s);
    const c = cand(plan, 17);
    assert.equal(c.status, "no_reference_price");
    assert.equal(c.edge_bps, null);
    assert.equal(c.ref_deviation_bps, null);
    assert.deepEqual(c.unpriced_tokens, ["usdc.fixture.testnet"]);
    assert.equal(plan.json.decision, "hold");
    assert.match(renderPlan(s, plan), /SKIP no mock reference price for usdc/);
    assert.match(renderPlan(s, plan), /\(no mock reference price\)/); // holdings line
  });

  it("a vault-refused candidate stays refused (the rules are the hard truth), not no_reference_price", () => {
    const s = snap((r) => {
      r.tokens["wnear.fixture.testnet"].mock_usd_price = null;
    });
    assert.equal(cand(buildPlan(s), 99).status, "refused");
  });
});

describe("the default snapshot: the shared Ref market and the demo vault", () => {
  const s = loadSnapshot(null);
  const plan = buildPlan(s);

  it("uses the demo vault and runner ids, the mock round's clock and labels the snapshot by block", () => {
    assert.equal(plan.json.vault_id, PLACEHOLDER_VAULT);
    assert.equal(plan.json.runner_id, PLACEHOLDER_RUNNER);
    assert.equal(plan.json.snapshot.now_ms, MOCK_EPOCH_MS);
    assert.equal(plan.json.snapshot.block_height, 276332963);
    assert.equal(plan.json.snapshot.taken_at, null);
    assert.match(plan.json.snapshot.source, /ref-finance-101\.testnet/);
    assert.match(plan.json.snapshot.reference_prices, /mock reference price, not an oracle/);
  });

  it("honestly holds on the thin real pools and names why each one was stopped", () => {
    assert.equal(plan.json.decision, "hold");
    const by = Object.fromEntries(plan.json.candidates.map((c) => [c.proposal.pool_id, c]));
    assert.equal(by[0].status, "no_reference_price"); // rft has no mock price
    assert.deepEqual(by[0].unpriced_tokens, ["rft.tokenfactory.testnet"]);
    assert.equal(by[1].status, "off_reference"); // 0.237 nusdt vs 444 nusdc
    assert.ok(by[1].ref_deviation_bps > 1_000_000);
    assert.ok(by[1].edge_bps > 1_000_000, "the raw edge of the junk pool is enormous and must not win");
    for (const id of [2, 5, 6, 8]) {
      assert.equal(by[id].status, "refused", `pool ${id}`);
      assert.match(by[id].check.reason, /^ERR_POOL_NOT_ALLOWED/);
    }
    assert.match(plan.json.reason, /^no pool passes every gate \(1 off the mock reference price \(spot more than 1000 bps away, or quote more than 1000 bps above\), 1 without a mock reference price, 4 refused by the vault rules\)$/);
  });

  it("every candidate's expected_amount_out is exactly the pools.mjs quote of its proposal", () => {
    for (const c of plan.candidates) {
      const pool = s.pools.find((p) => p.pool_id === c.proposal.pool_id);
      assert.equal(c.expected_out, quoteOut(pool, c.proposal.token_in, c.proposal.amount_in), `pool ${pool.pool_id}`);
    }
  });

  it("symbols are the token id before the first dot, as the personality side prints them", () => {
    const text = renderPlan(s, plan);
    // The pool 0 candidate trades the demo vault's wrap max_trade, printed in whole wNEAR.
    const maxWrap = BigInt(limitFor(plannerVaultConfig(), WNEAR_ID).max_trade) / 10n ** 24n;
    assert.match(text, new RegExp(`pool 0 wrap -> rft: ${maxWrap} wrap`));
    assert.match(text, /pool 1 nusdt -> nusdc/);
  });

  it("the planner pools can actually win: a sane priced pool on the real market is chosen and its check passes", () => {
    // wrap/nusdc pool 6 made sane (3 USDC-ish per wrap) and allowed in the vault config.
    const t = loadSnapshot(null);
    const pool6 = t.pools.find((p) => p.pool_id === 6);
    pool6.reserve_a = 10n ** 27n; // 1000 wrap
    pool6.reserve_b = 309_000n; // 3090.00 nusdc (2 decimals) per 1000 wrap: 3.09 vs the 3.00 reference, 3% above
    t.vault.config.allowed_pools.push({ pool_id: 6, token_a: pool6.token_a, token_b: pool6.token_b, min_rate_a_to_b: { num: "1", den: "10000000000000000000000" }, min_rate_b_to_a: { num: "1", den: "1" } });
    const p = buildPlan(t);
    const c = p.json.candidates.find((x) => x.proposal.pool_id === 6);
    assert.equal(c.status, "ok", JSON.stringify(c));
    assert.equal(p.chosen.expected_out, quoteOut(pool6, c.proposal.token_in, c.proposal.amount_in));
    assert.deepEqual(checkRules(t, p.chosen.proposal), { ok: true, reason: "" });
  });
});
