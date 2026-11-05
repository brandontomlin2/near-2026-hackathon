import { test } from "node:test";
import assert from "node:assert/strict";

import { floorMinOut, loadPoolFixture } from "./pools.mjs";
import { U128_MAX, checkProposal } from "./rules.mjs";
import { NUSDC, NUSDT, PLACEHOLDER_RUNNER, defaultVaultConfig } from "./strategies.mjs";

const fixture = loadPoolFixture();
const NOW = Date.UTC(2026, 10, 3, 12);
const config = defaultVaultConfig("social", { runner: PLACEHOLDER_RUNNER, fixture });
const state = () => ({
  paused: false,
  in_flight: false,
  spent: { day: 0, amounts: {} },
  balances: { [NUSDT]: "1000000000", [NUSDC]: "1000000000" },
});
const pool1 = config.allowed_pools.find((p) => p.pool_id === 1);
const valid = () => ({
  pool_id: 1,
  token_in: NUSDT,
  token_out: NUSDC,
  amount_in: "5000",
  min_amount_out: floorMinOut(pool1.min_rate_a_to_b, "5000").toString(),
});
const check = (p) => checkProposal(p, config, state(), PLACEHOLDER_RUNNER, NOW);

const BAD = ["-5", "0x10", " 5 ", "", "01", "1.5", "1e3", "+5", "5\n", (U128_MAX + 1n).toString()];

for (const field of ["amount_in", "min_amount_out"]) {
  for (const bad of BAD) {
    test(`${field} ${JSON.stringify(bad)} is ERR_BAD_AMOUNT and does not throw`, () => {
      const r = check({ ...valid(), [field]: bad });
      assert.equal(r.ok, false);
      assert.equal(r.code, "ERR_BAD_AMOUNT");
      assert.match(r.reason, new RegExp(`^ERR_BAD_AMOUNT: ${field} `));
    });
  }

  for (const bad of [5, 1.5, undefined, null, -1n, U128_MAX + 1n, {}, ["5"]]) {
    test(`${field} non-string ${String(typeof bad)}:${String(bad)} is ERR_BAD_AMOUNT`, () => {
      const r = check({ ...valid(), [field]: bad });
      assert.equal(r.code, "ERR_BAD_AMOUNT");
    });
  }
}

test("U128_MAX as a string passes the amount check and reaches the later rules", () => {
  const max = U128_MAX.toString();
  // a huge min_amount_out is well-formed and clears every later rule
  assert.equal(check({ ...valid(), min_amount_out: max }).ok, true);
  // a huge amount_in is well-formed too; the price floor (min_out too small for it) is the next rule to fire
  assert.equal(check({ ...valid(), amount_in: max }).code, "ERR_PRICE_FLOOR");
  assert.equal(check({ ...valid(), amount_in: max, min_amount_out: max }).code, "ERR_MAX_TRADE");
});

test('"0" is canonical: it reaches the zero-amount rules', () => {
  assert.equal(check({ ...valid(), amount_in: "0" }).code, "ERR_ZERO_AMOUNT");
  assert.equal(check({ ...valid(), min_amount_out: "0" }).code, "ERR_ZERO_MIN_OUT");
});

test("a normal valid proposal still passes, as strings or as in-range BigInt", () => {
  assert.deepEqual(check(valid()), { ok: true, code: null, reason: "" });
  const p = valid();
  assert.equal(check({ ...p, amount_in: BigInt(p.amount_in), min_amount_out: BigInt(p.min_amount_out) }).ok, true);
});
