// Mood classifier edges: case, word boundaries, emoji, multi-line posts and
// input types. Every input is fixed here, nothing comes from the demo corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MOODS, assertMood, moodForText } from "./moods.mjs";

const cases = (list) => {
  for (const [text, want] of list) assert.equal(moodForText(text), want, JSON.stringify(text));
};

test("keywords match in any case", () => {
  cases([
    ["DISAGREE.", "shade"],
    ["Doubtful", "shade"],
    ["WAIT", "shook"],
    ["Whoa", "shook"],
    ["YES", "hype"],
    ["Nice", "hype"],
    ["SEND IT", "hype"],
    ["Trust Me Bro", "shade"],
  ]);
});

test("every loud emoji is hype on its own, even surrounded by shade and questions", () => {
  for (const emoji of ["\u{1F480}", "\u{1F680}", "\u{1F525}"]) {
    cases([
      [emoji, "hype"],
      [`no, actually, wrong ${emoji}`, "hype"],
      [`${emoji}what?`, "hype"],
    ]);
  }
  // a different emoji carries no tone of its own
  cases([["\u{1F60A}", "neutral"], ["\u{1F60A} what", "shook"]]);
});

test("word boundaries: a keyword inside a longer word does not count", () => {
  cases([
    ["Notably quiet.", "neutral"], // not "not"
    ["Finely tuned.", "neutral"], // not "fine"
    ["sendit", "neutral"], // not "send it"
    ["Hmph.", "neutral"], // h+m+ needs a boundary after the m
    ["Nope.", "shade"],
    ["The receipt is attached.", "shade"], // singular form of receipts
    ["Receipted.", "neutral"], // but not a longer word
    ["Doubtless.", "neutral"], // not "doubt"
    ["Actually.", "shade"],
    ["Factually.", "neutral"],
    ["I agree.", "hype"],
    ["I disagree.", "shade"], // shade rule wins before hype can see "agree"
    ["Unexpected.", "shook"],
    ["Expected.", "neutral"],
    ["Surprise!", "shook"], // shook beats the plain "!" hype rule
    ["Surprised?", "shook"],
    ["Sources?", "shade"],
    ["Sources!", "hype"], // the citation demand needs its question mark
    ["Who checked?", "shade"],
    ["Prove it.", "shade"],
    ["Proved.", "neutral"],
    ["Let us go", "neutral"], // only the contraction is a hype cue
  ]);
});

test("a multi-line post is classified across all of its lines", () => {
  cases([
    ["Logging it.\nFine.", "shade"],
    ["Logging it.\nWait, what?", "shook"],
    ["Logging it.\r\nLet's go", "hype"],
    ["Logging it.\n\n", "neutral"],
  ]);
});

test("punctuation and whitespace alone carry no tone except '?' and '!'", () => {
  cases([
    ["   ", "neutral"],
    ["...", "neutral"],
    ["?", "shook"],
    ["!", "hype"],
    ["?!", "shook"], // shook beats hype
    ["!?", "shook"],
    [",;:-", "neutral"],
  ]);
});

test("the result is always one of the four moods and is accepted by assertMood", () => {
  const corpus = [
    "", "a", "ok", "ok!", "ok?", "no", "No!", "Nope?", "wait what", "send it", "\u{1F525}\u{1F525}",
    "trust me bro?", "count me in", "in on it", "love it", "great", "hmm", "HMMMMM", "fine", "rather watch",
    "x".repeat(10000), "?".repeat(1000), "\u0000\u0001\u0002", "<script>alert(1)</script>", "' & \"", "\u{1F480}".repeat(50),
  ];
  for (const text of corpus) {
    const mood = moodForText(text);
    assert.ok(MOODS.includes(mood), JSON.stringify(text));
    assert.equal(assertMood(mood), mood);
    assert.equal(moodForText(text), mood, "stable on repeat");
  }
});

test("classification is linear enough: a very long post with no cues stays fast and neutral", () => {
  const long = "lorem ipsum dolor sit amet ".repeat(20000);
  // CPU time, not wall time: a loaded machine stretches the wall clock but not this.
  const start = process.cpuUsage();
  assert.equal(moodForText(long), "neutral");
  const cpu = process.cpuUsage(start);
  assert.ok((cpu.user + cpu.system) / 1000 < 1000, "took too long");
});

test("non-string input is a TypeError, never a coerced string", () => {
  for (const bad of [undefined, null, 42, true, ["wait"], { toString: () => "wait" }, Symbol("wait"), new String("wait"), 1n]) {
    assert.throws(() => moodForText(bad), TypeError, String(typeof bad));
  }
});

test("assertMood does not coerce look-alikes", () => {
  for (const bad of ["", "Neutral", "hype ", new String("hype"), { toString: () => "hype" }, ["hype"], 0, false, NaN]) {
    assert.throws(() => assertMood(bad), /unknown mood/, String(bad));
  }
  assert.throws(() => assertMood(Symbol("hype")), /unknown mood/);
});
