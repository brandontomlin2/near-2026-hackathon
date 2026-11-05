import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDeposit } from "./page.mjs";

test("formatDeposit rejects empty and whitespace-only strings", () => {
  assert.throws(() => formatDeposit(""), /invalid deposit/);
  assert.throws(() => formatDeposit("   "), /invalid deposit/);
});

test("formatDeposit rejects negative deposits", () => {
  assert.throws(() => formatDeposit("-5"), /deposit must not be negative/);
  assert.throws(() => formatDeposit(-5n), /deposit must not be negative/);
});

test("formatDeposit still renders zero", () => {
  assert.equal(formatDeposit("0"), "0 yoctoNEAR");
});
