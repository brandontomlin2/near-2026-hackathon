import assert from "node:assert/strict";
import test from "node:test";
import { CATCHPHRASES, PERSONA_LINES, REPLY_LINES, personaResponder, replyTargetOf } from "./personas.mjs";

const HASH = "0".repeat(64);
const asking = (name) => ({ messages: [{ role: "user", content: `Recent channel events:\nx\n\nReply to event #7 from ${name}. Address ${name} by name.` }] });
const post = { messages: [{ role: "user", content: "Post a new message to the channel on a topic of your choosing." }] };

test("replyTargetOf reads the name out of a runner reply instruction and gives null for anything else", () => {
  assert.equal(replyTargetOf(asking("Social")), "Social");
  assert.equal(replyTargetOf(post), null);
  assert.equal(replyTargetOf({ messages: [{ role: "system", content: "Reply to event #1 from Social." }] }), null, "only the user message counts");
  for (const request of [undefined, null, {}, { messages: [] }, { messages: [{ role: "user" }] }]) {
    assert.equal(replyTargetOf(request), null);
  }
});

test("a reply to an agent with no written reply list is answered from the post lines", () => {
  const responder = personaResponder({ id: "aloof" });
  assert.ok(PERSONA_LINES.aloof.includes(responder(asking("Zed"), HASH)));
});

test("a reply to a known agent is answered from the list for that agent only", () => {
  for (const [id, byTarget] of Object.entries(REPLY_LINES)) {
    for (const [target, lines] of Object.entries(byTarget)) {
      assert.ok(lines.includes(personaResponder({ id })(asking(target), HASH)), `${id} -> ${target}`);
    }
  }
});

test("each reply list is walked on its own, so answering one agent does not move the walk for another", () => {
  const solo = personaResponder({ id: "aloof" });
  const lineCount = REPLY_LINES.aloof.Chaotic.length;
  const soloWalk = Array.from({ length: lineCount }, () => solo(asking("Chaotic"), HASH));
  const mixed = personaResponder({ id: "aloof" });
  const mixedWalk = [];
  for (let i = 0; i < lineCount; i++) {
    mixedWalk.push(mixed(asking("Chaotic"), HASH));
    mixed(asking("Social"), HASH);
    mixed(post, HASH);
  }
  assert.deepEqual(mixedWalk, soloWalk);
  assert.deepEqual([...soloWalk].sort(), [...REPLY_LINES.aloof.Chaotic].sort(), "every line before any repeat");
});

test("every agent's catchphrase is a string that appears in its own post lines", () => {
  for (const id of Object.keys(PERSONA_LINES)) {
    assert.equal(typeof CATCHPHRASES[id], "string");
    assert.ok(PERSONA_LINES[id].some((line) => line.includes(CATCHPHRASES[id])), id);
  }
});
