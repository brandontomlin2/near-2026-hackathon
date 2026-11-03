import assert from "node:assert/strict";
import test from "node:test";
import { sheetResponder, VIBES } from "./sheet-responder.mjs";
import { buildSummaryMessages } from "./summarizer.mjs";

const ev = (kind, from, text, round = 1) => ({ round, kind, from, text });
const respond = (name, previous, events) => sheetResponder({ messages: buildSummaryMessages({ name, previous, events }) }, "ignored");

test("a signature quote longer than 12 words is cut at 12 with '...', loses its quote marks and a leading @Name", () => {
  const sheet = respond("Aloof", null, [
    ev("reply", "Aloof", '@Social "one two three four five six seven eight nine ten eleven twelve thirteen fourteen."'),
  ]);
  assert.match(sheet, /Signature quote: "one two three four five six seven eight nine ten eleven twelve\.\.\."\./);
});

test("a request with no system prompt and no events still gives a full sheet for 'Agent' with zero counts", () => {
  for (const request of [undefined, {}, { messages: [] }, { messages: [{ role: "user", content: "hello" }] }]) {
    const sheet = sheetResponder(request, "ignored");
    assert.match(sheet, /^Who I am: Agent, /);
    assert.match(sheet, /Signature quote: none yet, ask me after I post\./);
    assert.match(sheet, /Scorecard: empty, still waiting on the first chat\./);
    assert.match(sheet, /Receipts: 0 posts, 0 replies, mentioned 0 times\.$/);
  }
});

test("an agent with no written vibes falls back to the default list for its state", () => {
  const quiet = respond("Zed", null, [ev("post", "Zed", "hello there")]);
  const vibe = /^Who I am: Zed, (.*)\. I live in a shared channel/.exec(quiet)?.[1];
  assert.ok(VIBES.default.quiet.includes(vibe), vibe);
  const fighting = respond("Zed", null, [ev("mention", "Aloof", "@Zed nope")]);
  assert.ok(VIBES.default.fighting.some((v) => fighting.includes(`Zed, ${v}.`)), fighting);
});

test("a mention from the agent itself and a reply that names itself or nobody are not scored", () => {
  const sheet = respond("Social", null, [
    ev("mention", "Social", "@Social love this"),
    ev("reply", "Social", "@Social love me"),
    ev("reply", "Social", "no target named here, love it"),
  ]);
  assert.match(sheet, /Scorecard: empty, still waiting on the first chat\./);
  assert.match(sheet, /Receipts: 0 posts, 2 replies, mentioned 0 times\./);
  assert.match(sheet, /Public enemy #1: nobody yet/);
  assert.match(sheet, /Ride-or-die: no one yet/);
});

test("a line with both tense and warm words counts as a fight, not a hug", () => {
  const sheet = respond("Chaotic", null, [ev("mention", "Social", "@Chaotic love you but nope")]);
  assert.match(sheet, /Scorecard: Social: 1 fight, 0 hugs, 0 shrugs\./);
  assert.match(sheet, /Public enemy #1: Social \(1 fight\)/);
});

test("a line with neither kind of word is a shrug and makes neither an enemy nor a friend", () => {
  const sheet = respond("Skeptic", null, [ev("mention", "Aloof", "@Skeptic the weather is mild")]);
  assert.match(sheet, /Scorecard: Aloof: 0 fights, 0 hugs, 1 shrug\./);
  assert.match(sheet, /Public enemy #1: nobody yet/);
  assert.match(sheet, /Ride-or-die: no one yet/);
});

test("words only count whole: 'know' and 'glovely' are not 'no' or 'love'", () => {
  const sheet = respond("Aloof", null, [ev("mention", "Social", "@Aloof you know glovely things")]);
  assert.match(sheet, /Scorecard: Social: 0 fights, 0 hugs, 1 shrug\./);
});

test("the sheet is one text with its seven labelled sections in a fixed order", () => {
  const sheet = respond("Aloof", null, [ev("post", "Aloof", "hi")]);
  const labels = ["Who I am:", "Public enemy #1:", "Ride-or-die:", "Rivalry arc:", "Scorecard:", "Signature quote:", "Receipts:"];
  const positions = labels.map((l) => sheet.indexOf(l));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal(sheet.split("\n").length, labels.length);
});
