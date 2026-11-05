import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SCENARIOS, ruleScenarios } from "./rule-scenarios.mjs";

const FILE = fileURLToPath(new URL("../../contracts/yield-vault/tests/rule-vectors.json", import.meta.url));
const fresh = () => JSON.parse(readFileSync(FILE, "utf8"));
const NAMES = {
  max_trade: "ERR_MAX_TRADE: amount_in one above max_trade",
  daily_cap: "ERR_DAILY_CAP: spent plus amount_in one above the daily cap",
  price_floor: "ERR_PRICE_FLOOR: pool 0 a->b one below the floor",
  paused: "ERR_PAUSED: vault is paused",
};

describe("ruleScenarios", () => {
  const out = ruleScenarios();

  it("has the documented shape and order", () => {
    assert.equal(out.source, "contracts/yield-vault/tests/rule-vectors.json");
    assert.equal(out.contract_fn, "check_rules");
    assert.deepEqual(out.scenarios.map((s) => s.id), ["max_trade", "daily_cap", "price_floor", "paused"]);
    assert.deepEqual(out.scenarios.map((s) => s.label), ["over max trade", "over daily cap", "below price floor", "paused"]);
  });

  it("each message is the vector file's expect, its code the message prefix, and the JS agrees", () => {
    const vectors = fresh();
    for (const s of out.scenarios) {
      const c = vectors.cases.find((x) => x.name === NAMES[s.id]);
      assert.ok(c, s.id);
      assert.equal(s.vector, c.name);
      assert.equal(s.contract_message, c.expect);
      assert.equal(s.js_message, c.expect);
      assert.ok(s.contract_message.startsWith(`${s.code}: `));
      assert.equal(s.outcome, "rejected");
      assert.equal(s.matches_contract, true);
      assert.deepEqual(s.proposal, c.proposal);
      assert.deepEqual(s.state, c.state ?? {});
    }
    assert.deepEqual(out.scenarios.map((s) => s.code), ["ERR_MAX_TRADE", "ERR_DAILY_CAP", "ERR_PRICE_FLOOR", "ERR_PAUSED"]);
  });

  it("selects exactly the pinned vector names", () => {
    assert.deepEqual(SCENARIOS.map((s) => s.vector), Object.values(NAMES));
  });

  it("throws, naming the case, when a vector is missing", () => {
    const v = fresh();
    v.cases = v.cases.filter((c) => c.name !== NAMES.paused);
    assert.throws(() => ruleScenarios(v), /paused.*missing/);
  });

  it("throws when a vector's expected message drifts from the JS rules", () => {
    const v = fresh();
    v.cases.find((c) => c.name === NAMES.max_trade).expect += " (changed)";
    assert.throws(() => ruleScenarios(v), /max_trade/);
  });

  it("throws when the JS rules would accept a vector proposal", () => {
    const v = fresh();
    v.cases.find((c) => c.name === NAMES.paused).state = { paused: false };
    assert.throws(() => ruleScenarios(v), /paused.*accepted/);
  });
});
