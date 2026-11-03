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

describe("memory diff line: edge cases", () => {
  const withSheet = (sheet) => memoryDiffLine({ id: "a", sheets: [{ sheet }] });

  it("handles a missing id and non-array sheets", () => {
    assert.equal(memoryDiffLine({ sheets: [] }), "agent: no sheet yet");
    assert.equal(memoryDiffLine({ id: "a", sheets: "nope" }), "a: no sheet yet");
    assert.equal(memoryDiffLine({ id: "a" }), "a: no sheet yet");
    assert.equal(memoryDiffLine(undefined), "agent: no sheet yet");
  });

  it("replaces control and bidi characters with U+FFFD like every other model-text path, and clips a long id", () => {
    assert.equal(memoryDiffLine({ id: "al\u001b[0m\u0007oof\n", sheets: [] }), "al�[0m�oof: no sheet yet");
    assert.equal(memoryDiffLine({ id: "al‮oof", sheets: [] }), "al�oof: no sheet yet");
    assert.equal(sheetFacts("Public enemy #1: Sk⁦eptic. Receipts: 1.").enemy, "Sk�eptic");
    const line = memoryDiffLine({ id: "x".repeat(200), sheets: [] });
    assert.equal(line, `${"x".repeat(77)}...: no sheet yet`);
  });

  it("tolerates sheet entries without a sheet string", () => {
    assert.equal(memoryDiffLine({ id: "a", sheets: [{}] }), "a: enemy none, ride-or-die none, quote none");
    assert.equal(memoryDiffLine({ id: "a", sheets: [null, undefined] }), "a: enemy none, ride-or-die none, quote none");
  });

  // "-" and "(none)" are regression cases: the old `\b` after them never matched.
  for (const word of ["none", "nobody", "no one", "no-one", "nothing", "n/a", "None", "NOBODY yet", "-", "(none)", "- (no one yet)"]) {
    it(`maps the placeholder ${JSON.stringify(word)} to none`, () => {
      const facts = sheetFacts(`Public enemy #1: ${word}. Ride-or-die: ${word}. Signature quote: ${word}. Receipts: 1.`);
      assert.deepEqual(facts, { enemy: "none", friend: "none", quote: "none" });
    });
  }

  it('maps a quoted "None." quote to none', () => {
    assert.equal(sheetFacts('Signature quote: "None.". Receipts: 1.').quote, "none");
    assert.equal(sheetFacts("Signature quote: None.").quote, "none");
  });

  it("keeps a real value that merely starts with a placeholder", () => {
    const facts = sheetFacts("Public enemy #1: nonetheless I win. Ride-or-die: nobodyish. Signature quote: nothingness. Receipts: 1.");
    assert.deepEqual(facts, { enemy: "nonetheless I win", friend: "nobodyish", quote: "nothingness" });
    const glued = sheetFacts("Public enemy #1: -a. Ride-or-die: (none)x. Receipts: 1.");
    assert.deepEqual([glued.enemy, glued.friend], ["-a", "(none)x"]);
  });

  it("clips a value over 80 characters to exactly 80 ending in ..., and keeps exactly 80", () => {
    const long = sheetFacts(`Public enemy #1: ${"a".repeat(81)}. Receipts: 1.`).enemy;
    assert.equal(long.length, 80);
    assert.equal(long, `${"a".repeat(77)}...`);
    const exact = sheetFacts(`Public enemy #1: ${"b".repeat(80)}. Receipts: 1.`).enemy;
    assert.equal(exact, "b".repeat(80));
    assert.equal(sheetSection(`Rival: ${"c".repeat(80)}`, /rival:\s*/i).length, 80);
  });

  it("sheetSection accepts a single RegExp and returns '' when nothing matches", () => {
    assert.equal(sheetSection("Mood: calm. Receipts: 1.", /\bmood:\s*/i), "calm");
    assert.equal(sheetSection("Mood: calm.", /\bnothing here:\s*/i), "");
    assert.equal(sheetSection("Mood: calm.", [/x:/, /y:/]), "");
    assert.equal(sheetSection(null, /x/), "");
  });

  it("stops at the next '. Label:' boundary and strips trailing punctuation", () => {
    assert.equal(sheetSection("A: one two. B: three", /\bA:\s*/), "one two");
    assert.equal(sheetSection("A: wow!?;, . B: three", /\bA:\s*/), "wow");
    assert.equal(sheetSection("A: one. two. B: three", /\bA:\s*/), "one. two");
    assert.equal(sheetSection("A: tail...", /\bA:\s*/), "tail");
  });

  it("does not match a label in the middle of a word", () => {
    assert.equal(sheetFacts("Frenemy: Skeptic. Receipts: 1.").enemy, "none");
    assert.equal(sheetFacts("Unbestie: Social.").friend, "none");
    assert.equal(sheetFacts("Frenemy: Skeptic.").enemy, "none");
    assert.equal(sheetFacts("The enemy: Skeptic.").enemy, "Skeptic");
  });

  it("unwraps curly quotes, and a quote whose closing mark was clipped", () => {
    assert.equal(sheetFacts("Signature quote: \u201chello world\u201d. Receipts: 1.").quote, "hello world");
    const clipped = sheetFacts(`Signature quote: "${"y".repeat(120)}". Receipts: 1.`).quote;
    assert.ok(clipped.startsWith("y") && clipped.endsWith("..."));
    assert.ok(!clipped.includes('"'));
    assert.equal(clipped.length, 79);
    assert.equal(sheetFacts("Signature quote: \u201dodd\u201c. Receipts: 1.").quote, "odd");
  });
});
