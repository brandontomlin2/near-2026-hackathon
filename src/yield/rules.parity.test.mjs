// Pins src/yield/rules.mjs to the contract's check_rules. The vectors live in
// contracts/yield-vault/tests/rule-vectors.json; contracts/yield-vault/src/tests.rs runs the same
// file through the Rust check_proposal view. Neither side hardcodes an expected string.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HARD_RULE_ORDER, checkProposal } from "./rules.mjs";

const FILE = fileURLToPath(new URL("../../contracts/yield-vault/tests/rule-vectors.json", import.meta.url));
const vectors = JSON.parse(readFileSync(FILE, "utf8"));

/** A vector's state as the checkProposal state shape (the file's `recovery` is `recovery_in_flight`). */
function stateOf(c) {
  const s = { ...vectors.base_state, ...c.state };
  return {
    paused: s.paused,
    in_flight: s.in_flight,
    recovery_in_flight: s.recovery,
    spent: { day: s.day, amounts: s.spent_today },
    balances: s.balances,
  };
}

describe("rules.mjs matches the contract's rule vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const nowNs = BigInt(c.now_ns ?? vectors.base_state.now_ns);
      const r = checkProposal(c.proposal, vectors.config, stateOf(c), c.runner, Number(nowNs / 1_000_000n));
      assert.equal(r.reason, c.expect);
      assert.equal(r.ok, c.expect === "");
    });
  }

  it("has a vector for every hard rule code", () => {
    for (const code of HARD_RULE_ORDER) {
      assert.ok(vectors.cases.some((c) => c.expect.startsWith(`${code}: `)), `no vector expects ${code}`);
    }
  });

  it("only expects codes that HARD_RULE_ORDER lists", () => {
    for (const c of vectors.cases.filter((v) => v.expect !== "")) {
      assert.ok(HARD_RULE_ORDER.includes(c.expect.split(":")[0]), c.name);
    }
  });

  it("has passing cases, including both pool directions", () => {
    assert.ok(vectors.cases.filter((c) => c.expect === "").length >= 4);
  });
});
