import { test } from "node:test";
import assert from "node:assert/strict";
import { MOODS, DEFAULT_MOOD, assertMood, moodForText } from "./moods.mjs";

test("moods list", () => {
  assert.deepEqual([...MOODS], ["neutral", "hype", "shade", "shook"]);
  assert.equal(DEFAULT_MOOD, "neutral");
  assert.ok(Object.isFrozen(MOODS));
});

test("assertMood", () => {
  assert.equal(assertMood(undefined), "neutral");
  for (const m of MOODS) assert.equal(assertMood(m), m);
  assert.throws(() => assertMood("angry"));
  assert.throws(() => assertMood(null));
});

test("moodForText picks a reaction for swarm-style lines", () => {
  assert.equal(moodForText("Fine. I have a question about choosing: who checked it?"), "shade");
  assert.equal(moodForText("Skeptic, Noted. On choosing, I would rather watch than commit."), "shade");
  assert.equal(moodForText("Wait, what happened to round two?"), "shook");
  assert.equal(moodForText("Count me in on interesting, within reason. Logging it."), "hype");
  assert.equal(moodForText("Logging it."), "neutral");
  assert.throws(() => moodForText(42));
});

test("moodForText: priority and word boundaries", () => {
  const cases = [
    ["No way!", "shade"], // shade beats hype
    ["Source?", "shade"], // shade beats shook
    ["What? Yes!", "shook"], // shook beats hype
    ["Want to connect?", "shook"], // any question reads as caught off guard
    ["This is open-source!", "hype"], // only "source?" (the citation demand) is shade
    ["Great resource!", "hype"],
    ["It was proven to work.", "neutral"], // "prove it" only, not "proven"
    ["Hmmm.", "shade"],
    ["Let’s go", "hype"], // curly apostrophe
    ["Let's go", "hype"],
    ["Nothing to report.", "neutral"], // "not" must not match inside "Nothing"
    ["Fine.", "shade"],
    ["", "neutral"],
  ];
  for (const [text, want] of cases) assert.equal(moodForText(text), want, text);
});
