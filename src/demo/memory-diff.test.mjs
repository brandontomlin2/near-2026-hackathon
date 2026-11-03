import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { memoryDiffLine, sheetFacts, sheetSection } from "./memory-diff.mjs";

const FIRST = 'Who I am: Chaotic, lurking. I live in a shared channel with three other agents. Public enemy #1: nobody yet, the lore is still loading. Ride-or-die: no one yet, applications open. Rivalry arc: Nobody has picked a side yet. Scorecard: Skeptic: 0 fights, 0 hugs, 3 shrugs. Signature quote: "airdrop rumor?? I already told my mom!!". Receipts: 0 posts, 3 replies, mentioned 2 times.';
const LATEST = 'Who I am: Chaotic, villain arc. I live in a shared channel with three other agents. Public enemy #1: Skeptic (4 fights). Ride-or-die: Social (2 warm moments). Rivalry arc: Skeptic and I keep clashing. Scorecard: Skeptic: 4 fights, 0 hugs, 5 shrugs. Signature quote: "wait WHAT, the contract does that??". Receipts: 1 post, 5 replies, mentioned 6 times.';

describe("memory diff line", () => {
  it("reads enemy, ride-or-die and quote from a stand-in sheet", () => {
    assert.deepEqual(sheetFacts(LATEST), {
      enemy: "Skeptic (4 fights)",
      friend: "Social (2 warm moments)",
      quote: "wait WHAT, the contract does that??",
    });
  });

  it("maps 'nobody yet' style placeholders and missing labels to none", () => {
    assert.deepEqual(sheetFacts(FIRST).enemy, "none");
    assert.deepEqual(sheetFacts(FIRST).friend, "none");
    assert.deepEqual(sheetFacts("Who I am: Aloof. Receipts: 1 post."), { enemy: "none", friend: "none", quote: "none" });
    assert.deepEqual(sheetFacts(""), { enemy: "none", friend: "none", quote: "none" });
    assert.deepEqual(sheetFacts(undefined), { enemy: "none", friend: "none", quote: "none" });
  });

  it("tolerates reworded labels and a quote without quotation marks", () => {
    const sheet = "Name: Skeptic. Rival: Chaotic, 3 fights. Best friend: Aloof. Catchphrase: show me the hash. Receipts: none.";
    assert.deepEqual(sheetFacts(sheet), { enemy: "Chaotic, 3 fights", friend: "Aloof", quote: "show me the hash" });
  });

  it("does not let the Rivalry arc section pass for the enemy", () => {
    const sheet = "Rivalry arc: Skeptic and I are not done yet. Receipts: 1 post.";
    assert.equal(sheetFacts(sheet).enemy, "none");
    assert.equal(sheetSection(sheet, /\brivalry arc:\s*/i), "Skeptic and I are not done yet");
  });

  it("prints first -> latest only for fields that changed", () => {
    const line = memoryDiffLine({ id: "chaotic", sheets: [{ sheet: FIRST }, { sheet: LATEST }] });
    assert.equal(line, 'chaotic: enemy none -> Skeptic (4 fights), ride-or-die none -> Social (2 warm moments), quote "wait WHAT, the contract does that??"');
    const same = memoryDiffLine({ id: "chaotic", sheets: [{ sheet: LATEST }] });
    assert.equal(same, 'chaotic: enemy Skeptic (4 fights), ride-or-die Social (2 warm moments), quote "wait WHAT, the contract does that??"');
  });

  it("handles no sheets and hostile sheet text without breaking the line", () => {
    assert.equal(memoryDiffLine({ id: "aloof", sheets: [] }), "aloof: no sheet yet");
    const hostile = `Public enemy #1: Skeptic\n\u001b[31mRED\u001b[0m\r\n. Signature quote: "${"x".repeat(300)}". Receipts: 0 posts.`;
    const line = memoryDiffLine({ id: "aloof", sheets: [{ sheet: hostile }] });
    assert.equal(line.split("\n").length, 1);
    assert.ok(!/[\u0000-\u001f]/.test(line), "control characters leaked");
    assert.ok(line.length < 260, `line too long: ${line.length}`);
    assert.ok(line.includes('quote "xxx'));
  });
});
