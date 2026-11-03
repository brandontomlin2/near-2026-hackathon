// Observable page helpers: the deposit shown in the anchor table and the "then -> now" enemy caption under each hero face.
import { test } from "node:test";
import assert from "node:assert/strict";

import { enemyInSheet, formatDeposit, thenNowCaption } from "./page.mjs";

test("formatDeposit: sub-1e18 values are yoctoNEAR, larger ones are NEAR with trailing zeros trimmed", () => {
  const cases = {
    "0": "0 yoctoNEAR",
    "1": "1 yoctoNEAR",
    "999999999999999999": "999999999999999999 yoctoNEAR",
    "1000000000000000000": "0.000001 NEAR",
    "10000000000000000000000": "0.01 NEAR",
    "1000000000000000000000000": "1 NEAR",
    "1500000000000000000000000": "1.5 NEAR",
    "123456789012345678901234567": "123.456789012345678901234567 NEAR",
  };
  for (const [yocto, shown] of Object.entries(cases)) assert.equal(formatDeposit(yocto), shown, yocto);
});

test("formatDeposit takes a bigint or a numeric string alike and rejects non-integers", () => {
  assert.equal(formatDeposit(10n ** 24n), "1 NEAR");
  assert.throws(() => formatDeposit("abc"), SyntaxError);
  assert.throws(() => formatDeposit("1.5"), SyntaxError);
});

test("enemyInSheet: finds the named agent, case-insensitive label, ends at a sentence end or a newline", () => {
  const names = ["Skeptic", "Chaotic"];
  assert.equal(enemyInSheet("Who I am: x. Public enemy #1: Skeptic (3 fights). Ride-or-die: Chaotic.", names), "Skeptic");
  assert.equal(enemyInSheet("public ENEMY #1: Chaotic\nRide-or-die: Skeptic", names), "Chaotic");
});

test("enemyInSheet: nobody, a longer word, an unlisted name, an empty field or a missing sheet is null", () => {
  const names = ["Skeptic", "Chaotic"];
  assert.equal(enemyInSheet("Public enemy #1: nobody yet, the lore is still loading.", names), null);
  assert.equal(enemyInSheet("Public enemy #1: Skepticism (2 fights).", names), null, "a name inside a longer word is not a match");
  assert.equal(enemyInSheet("Public enemy #1: Social (2 fights).", names), null, "only names in the run count");
  assert.equal(enemyInSheet("Public enemy #1: ", names), null);
  assert.equal(enemyInSheet("Ride-or-die: Skeptic.", names), null, "a name outside the enemy field is not an enemy");
  assert.equal(enemyInSheet(null, names), null);
  assert.equal(enemyInSheet(undefined, names), null);
});

test("enemyInSheet: names with regex metacharacters are matched literally", () => {
  assert.equal(enemyInSheet("Public enemy #1: A.B (1 fight).", ["A.B"]), "A.B");
  assert.equal(enemyInSheet("Public enemy #1: AxB (1 fight).", ["A.B"]), null);
});

test("thenNowCaption: first sheet -> latest sheet, 'no enemies' before the feud starts", () => {
  const agent = {
    name: "Ann",
    sheets: [
      { round: 3, sheet: "Public enemy #1: nobody yet." },
      { round: 6, sheet: "Public enemy #1: Bob (2 fights)." },
    ],
  };
  assert.equal(thenNowCaption(agent, ["Ann", "Bob"]), "Round 3: no enemies → Round 6: Public enemy #1 Bob");
});

test("thenNowCaption: one sheet gives one label, no sheets gives an empty caption, and an agent never names itself", () => {
  assert.equal(thenNowCaption({ name: "Ann", sheets: [{ round: 3, sheet: "Public enemy #1: Bob (1 fight)." }] }, ["Ann", "Bob"]), "Round 3: Public enemy #1 Bob");
  assert.equal(thenNowCaption({ name: "Ann", sheets: [] }, ["Ann", "Bob"]), "");
  assert.equal(thenNowCaption({ name: "Ann", sheets: [{ round: 3, sheet: "Public enemy #1: Ann (1 fight)." }] }, ["Ann", "Bob"]), "Round 3: no enemies");
});
