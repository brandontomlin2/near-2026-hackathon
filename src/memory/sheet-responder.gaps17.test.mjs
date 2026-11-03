// Behaviour gaps in the mock sheet writer that npm run demo / swarm / ask show to a
// user: the "Rivalry arc" line, the quote length cut, whose exchanges count, and the
// order of the scorecard. Each case reads the sheet text a user would read.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sheetResponder, STORIES } from "./sheet-responder.mjs";
import { buildSummaryMessages } from "./summarizer.mjs";

const ev = (kind, from, text, round = 1) => ({ round, kind, from, text });
const respond = (name, previous, events) => sheetResponder({ messages: buildSummaryMessages({ name, previous, events }) }, "ignored");
// Every phrasing the sheet may use for one kind of record (the line varies by seed and memory).
const arcs = (kind, args) => STORIES[kind].map((f) => `Rivalry arc: ${f(args)}`);
const line = (sheet, label) => sheet.split("\n").find((l) => l.startsWith(`${label}:`));

describe("sheetResponder: what the sheet says (gaps 17)", () => {
  it("Rivalry arc names the rival and the ally together only when there are both", () => {
    const both = respond("Aloof", null, [
      ev("mention", "Skeptic", "@Aloof Doubtful. Show me the log."),
      ev("mention", "Social", "@Aloof Friends. Happy to help, together."),
    ]);
    const arc = line(both, "Rivalry arc");
    assert.ok(arcs("both", { rival: "Skeptic", ally: "Social", fights: 1 }).includes(arc), arc);
    assert.ok(arc.includes("Skeptic") && arc.includes("Social"), arc);
  });

  it("Rivalry arc with only a rival names only the rival; with only an ally it names only the ally", () => {
    const rivalOnly = respond("Aloof", null, [ev("mention", "Skeptic", "@Aloof Doubtful. Show me the log.")]);
    const rivalArc = line(rivalOnly, "Rivalry arc");
    assert.ok(arcs("rival", { rival: "Skeptic", fights: 1 }).includes(rivalArc), rivalArc);
    assert.ok(rivalArc.includes("Skeptic") && !rivalArc.includes("Social"), rivalArc);
    assert.doesNotMatch(rivalOnly, /undefined/);

    const allyOnly = respond("Aloof", null, [ev("mention", "Social", "@Aloof Friends. Happy to help, together.")]);
    const allyArc = line(allyOnly, "Rivalry arc");
    assert.ok(arcs("ally", { ally: "Social", fights: 0 }).includes(allyArc), allyArc);
    assert.ok(allyArc.includes("Social") && !allyArc.includes("Skeptic"), allyArc);
    assert.doesNotMatch(allyOnly, /undefined/);
  });

  it("Rivalry arc with nobody names no one", () => {
    const quiet = respond("Aloof", null, [ev("post", "Aloof", "Hi.")]);
    assert.ok(arcs("none", {}).includes(line(quiet, "Rivalry arc")), line(quiet, "Rivalry arc"));
  });

  it("the signature quote keeps a 12-word post whole and cuts a 13-word post with an ellipsis", () => {
    const twelve = "one two three four five six seven eight nine ten eleven twelve";
    const whole = respond("Aloof", null, [ev("post", "Aloof", twelve)]);
    assert.equal(line(whole, "Signature quote"), `Signature quote: "${twelve}".`);

    const cut = respond("Aloof", null, [ev("post", "Aloof", `${twelve} thirteen`)]);
    assert.equal(line(cut, "Signature quote"), `Signature quote: "${twelve}...".`);
  });

  it("a reply written by another agent does not become a relationship of this agent", () => {
    // Skeptic replying to Chaotic is not an exchange Aloof took part in.
    const sheet = respond("Aloof", null, [
      ev("post", "Aloof", "Quiet."),
      ev("reply", "Skeptic", "@Chaotic Nope, show me the receipts."),
    ]);
    assert.equal(line(sheet, "Scorecard"), "Scorecard: empty, still waiting on the first chat.");
    assert.equal(line(sheet, "Public enemy #1"), "Public enemy #1: nobody yet, the lore is still loading.");
  });

  it("scorecard ties are listed in alphabetical order whatever order the events arrived in", () => {
    const forward = respond("Aloof", null, [ev("mention", "Chaotic", "@Aloof a"), ev("mention", "Skeptic", "@Aloof b"), ev("mention", "Social", "@Aloof c")]);
    const backward = respond("Aloof", null, [ev("mention", "Social", "@Aloof c"), ev("mention", "Skeptic", "@Aloof b"), ev("mention", "Chaotic", "@Aloof a")]);
    const expected = "Scorecard: Chaotic: 0 fights, 0 hugs, 1 shrug; Skeptic: 0 fights, 0 hugs, 1 shrug; Social: 0 fights, 0 hugs, 1 shrug.";
    assert.equal(line(forward, "Scorecard"), expected);
    assert.equal(line(backward, "Scorecard"), expected);
  });
});
