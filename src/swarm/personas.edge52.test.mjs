import assert from "node:assert/strict";
import test from "node:test";
import { CATCHPHRASES, PERSONA_LINES, REPLY_LINES, createPersonaMockClient, personaResponder, replyTargetOf } from "./personas.mjs";

const HASH = "0".repeat(64);
const userReq = (content) => ({ messages: [{ role: "user", content }] });
const asking = (name) => userReq(`Reply to event #7 from ${name}. Address ${name} by name.`);
const hashWithStart = (n) => n.toString(16).padStart(8, "0") + "0".repeat(56);

test("replyTargetOf only matches ASCII letter names and needs the trailing period", () => {
  assert.equal(replyTargetOf(userReq("Reply to event #1 from Social")), null, "no period");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from Social2.")), null, "digit before period");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from Zoë.")), null, "non-ASCII letter breaks the name");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from .")), null, "empty name");
  assert.equal(replyTargetOf(userReq("Reply to event #abc from Social.")), null, "non-numeric event id");
  assert.equal(replyTargetOf(userReq("Reply to event # from Social.")), null, "missing event id");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from Social-Bot.")), null, "hyphenated name");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from __proto__.")), null, "underscores are not letters");
  assert.equal(replyTargetOf(userReq("reply to event #1 from Social.")), null, "case-sensitive prefix");
});

test("replyTargetOf keeps the case of the name and accepts huge event numbers", () => {
  assert.equal(replyTargetOf(userReq("Reply to event #1 from social.")), "social");
  assert.equal(replyTargetOf(userReq("Reply to event #1 from SOCIAL.")), "SOCIAL");
  assert.equal(replyTargetOf(userReq(`Reply to event #${"9".repeat(500)} from constructor.`)), "constructor");
  assert.equal(replyTargetOf(userReq("Reply to event #0 from Aloof.")), "Aloof");
});

test("replyTargetOf finds the instruction inside long, emoji-laden channel text", () => {
  const noise = "\u{1F468}‍\u{1F469}‍\u{1F467} é \u{1F480} ".repeat(5000);
  assert.equal(replyTargetOf(userReq(`${noise}\nReply to event #12 from Skeptic. Address Skeptic by name.`)), "Skeptic");
  assert.equal(replyTargetOf(userReq(noise)), null);
});

test("replyTargetOf uses the first user message only, and the first match inside it", () => {
  const request = {
    messages: [
      { role: "system", content: "Reply to event #1 from Aloof." },
      { role: "user", content: "just chatting" },
      { role: "user", content: "Reply to event #2 from Social." },
    ],
  };
  assert.equal(replyTargetOf(request), null);
  assert.equal(replyTargetOf(userReq("Reply to event #1 from Aloof. Reply to event #2 from Social.")), "Aloof");
});

test("replyTargetOf gives null for non-string or empty content", () => {
  for (const content of [null, undefined, "", 0, 42, true, [], {}, ["Reply to event #1 from Social."]]) {
    // An array of one string stringifies to the same text, so only the empty/non-matching cases are null.
    const got = replyTargetOf(userReq(content));
    if (Array.isArray(content) && content.length === 1) assert.equal(got, "Social");
    else assert.equal(got, null, String(content));
  }
});

test("replyTargetOf reads a request parsed from JSON, including a __proto__ key", () => {
  const request = JSON.parse('{"__proto__":{"messages":[]},"messages":[{"role":"user","content":"Reply to event #3 from Chaotic."}]}');
  assert.equal(replyTargetOf(request), "Chaotic");
  assert.equal(replyTargetOf(JSON.parse('{"__proto__":{"messages":[{"role":"user","content":"Reply to event #3 from Chaotic."}]}}')), null);
});

test("personaResponder only recognises the exact agent ids", () => {
  for (const id of ["Aloof", "ALOOF", " aloof", "aloof ", "aloof\0", "al​oof", "ａloof", "", "aloo", "aloofaloof", "\u{1F480}", "chaotic\n"]) {
    assert.equal(personaResponder({ id }), undefined, JSON.stringify(id));
  }
});

test("personaResponder gives no responder for missing or non-string ids", () => {
  for (const id of [undefined, null, 0, NaN, Infinity, -1, 1.5, true, false, {}, Symbol("aloof")]) {
    assert.equal(personaResponder({ id }), undefined, String(typeof id === "symbol" ? "symbol" : id));
  }
  assert.equal(personaResponder({}), undefined);
});

test("personaResponder throws a TypeError when no agent object is given", () => {
  assert.throws(() => personaResponder(undefined), TypeError);
  assert.throws(() => personaResponder(null), TypeError);
  assert.throws(() => createPersonaMockClient(undefined), TypeError);
});

test("personaResponder ignores extra agent fields and prototype pollution via JSON ids", () => {
  const agent = JSON.parse('{"id":"social","__proto__":{"id":"aloof"},"name":"\\ud83d\\udc80"}');
  assert.ok(PERSONA_LINES.social.includes(personaResponder(agent)(null, HASH)));
  const polluted = JSON.parse('{"__proto__":{"id":"aloof"}}');
  assert.equal(personaResponder(polluted), undefined, "an inherited id is not read as an own key of PERSONA_LINES");
});

test("personaResponder walks every post line before repeating, from every possible start offset", () => {
  for (const [id, lines] of Object.entries(PERSONA_LINES)) {
    for (let start = 0; start < lines.length * 2; start++) {
      const r = personaResponder({ id });
      const walk = Array.from({ length: lines.length }, () => r(null, hashWithStart(start)));
      assert.equal(new Set(walk).size, lines.length, `${id} start ${start}`);
      assert.equal(walk[0], lines[start % lines.length], `${id} start ${start}`);
    }
  }
});

test("every reply list is walked in full, once per cycle, from every start offset", () => {
  for (const [id, byTarget] of Object.entries(REPLY_LINES)) {
    for (const [target, lines] of Object.entries(byTarget)) {
      for (let start = 0; start < lines.length; start++) {
        const r = personaResponder({ id });
        const walk = Array.from({ length: lines.length * 2 }, () => r(asking(target), hashWithStart(start)));
        assert.deepEqual([...walk.slice(0, lines.length)].sort(), [...lines].sort(), `${id}->${target} start ${start}`);
        assert.deepEqual(walk.slice(lines.length), walk.slice(0, lines.length), `${id}->${target} start ${start}`);
        assert.equal(walk[0], lines[start % lines.length]);
      }
    }
  }
});

test("a reply as the first request fixes the start for later posts too", () => {
  const a = personaResponder({ id: "social" });
  a(asking("Aloof"), hashWithStart(5));
  const afterReply = a(null, hashWithStart(9));
  const b = personaResponder({ id: "social" });
  assert.equal(afterReply, b(null, hashWithStart(5)), "the later hash (9) is ignored; start 5 governs the post list");
});

test("the start is the first 8 hex digits only, case-insensitively, and the rest of the hash is ignored", () => {
  const n = PERSONA_LINES.aloof.length;
  const lower = personaResponder({ id: "aloof" })(null, "abcdef01" + "0".repeat(56));
  assert.equal(lower, PERSONA_LINES.aloof[0xabcdef01 % n]);
  assert.equal(personaResponder({ id: "aloof" })(null, "ABCDEF01" + "f".repeat(56)), lower);
  assert.equal(personaResponder({ id: "aloof" })(null, "abcdef01"), lower, "an 8-char hash is enough");
  assert.equal(personaResponder({ id: "aloof" })(null, "ffffffff" + "0".repeat(56)), PERSONA_LINES.aloof[0xffffffff % n]);
});

test("a short hash is read as the number it spells", () => {
  const n = PERSONA_LINES.chaotic.length;
  assert.equal(personaResponder({ id: "chaotic" })(null, "ff"), PERSONA_LINES.chaotic[255 % n]);
  assert.equal(personaResponder({ id: "chaotic" })(null, "0"), PERSONA_LINES.chaotic[0]);
});

test("many turns never repeat inside a cycle and stay within the line list", () => {
  const lines = PERSONA_LINES.skeptic;
  const r = personaResponder({ id: "skeptic" });
  const walk = Array.from({ length: lines.length * 50 }, () => r(null, hashWithStart(0xffffffff)));
  for (let i = 0; i < walk.length; i++) {
    assert.ok(lines.includes(walk[i]), `turn ${i}`);
    if (i > 0) assert.notEqual(walk[i], walk[i - 1], `turn ${i} repeated the previous line`);
    if (i >= lines.length) assert.equal(walk[i], walk[i - lines.length], `turn ${i}`);
  }
});

test("a reply naming a prototype key, a wrong-case name or a non-ASCII name falls back to post lines", () => {
  for (const target of ["constructor", "__proto__", "toString", "social", "SOCIAL", "Zoë", "\u{1F480}"]) {
    const reply = personaResponder({ id: "aloof" })(asking(target), HASH);
    assert.ok(PERSONA_LINES.aloof.includes(reply), target);
    assert.ok(!Object.values(REPLY_LINES.aloof).some((l) => l.includes(reply)), `${target} must not use a reply list`);
  }
});

test("a reply to oneself or to a name with no entry for this agent uses the post lines", () => {
  for (const id of Object.keys(REPLY_LINES)) {
    const own = id[0].toUpperCase() + id.slice(1);
    assert.ok(!Object.hasOwn(REPLY_LINES[id], own), `${id} has no list for itself`);
    assert.ok(PERSONA_LINES[id].includes(personaResponder({ id })(asking(own), HASH)), id);
  }
});

test("persona data is deeply frozen and rejects mutation", () => {
  assert.ok(Object.isFrozen(CATCHPHRASES));
  assert.ok(Object.isFrozen(PERSONA_LINES));
  assert.ok(Object.isFrozen(REPLY_LINES));
  for (const id of Object.keys(PERSONA_LINES)) assert.ok(Object.isFrozen(PERSONA_LINES[id]), id);
  for (const byTarget of Object.values(REPLY_LINES)) {
    assert.ok(Object.isFrozen(byTarget));
    for (const lines of Object.values(byTarget)) assert.ok(Object.isFrozen(lines));
  }
  assert.throws(() => { PERSONA_LINES.aloof.push("x"); }, TypeError);
  assert.throws(() => { PERSONA_LINES.zed = []; }, TypeError);
  assert.throws(() => { REPLY_LINES.aloof.Chaotic[0] = "x"; }, TypeError);
  assert.throws(() => { CATCHPHRASES.aloof = "x"; }, TypeError);
});

test("persona data is well formed: unique non-empty single-line strings, reply keys match known agents", () => {
  const agents = Object.keys(PERSONA_LINES);
  assert.deepEqual(Object.keys(CATCHPHRASES).sort(), [...agents].sort());
  assert.deepEqual(Object.keys(REPLY_LINES).sort(), [...agents].sort());
  const all = [];
  for (const id of agents) all.push(...PERSONA_LINES[id]);
  for (const [id, byTarget] of Object.entries(REPLY_LINES)) {
    for (const [target, lines] of Object.entries(byTarget)) {
      assert.ok(agents.some((a) => a[0].toUpperCase() + a.slice(1) === target), `${id} -> ${target} is a known agent name`);
      all.push(...lines);
    }
  }
  for (const line of all) {
    assert.equal(typeof line, "string");
    assert.equal(line, line.trim(), line);
    assert.ok(line.length > 0 && !/[\r\n]/.test(line), line);
  }
  for (const id of agents) assert.equal(new Set(PERSONA_LINES[id]).size, PERSONA_LINES[id].length, `${id} has duplicate post lines`);
});

test("reply lines never address the target by name (the runner prefixes the @Name)", () => {
  for (const byTarget of Object.values(REPLY_LINES)) {
    for (const [target, lines] of Object.entries(byTarget)) {
      for (const line of lines) assert.ok(!line.includes(`@${target}`) && !line.startsWith(target), line);
    }
  }
});

test("the mock client answers a prototype-key agent's reply request with a non-empty default string", async () => {
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const reply = await createPersonaMockClient({ id }).chat(asking("Social"));
    assert.equal(typeof reply.content, "string", id);
    assert.ok(reply.content.length > 0, id);
    assert.equal(reply.mode, "mock", id);
  }
});

test("the mock client returns the same reply twice for the same agent and request, and a reply-list line for a known target", async () => {
  const one = await createPersonaMockClient({ id: "skeptic" }).chat(asking("Chaotic"));
  const two = await createPersonaMockClient({ id: "skeptic" }).chat(asking("Chaotic"));
  assert.equal(one.content, two.content);
  assert.ok(REPLY_LINES.skeptic.Chaotic.includes(one.content));
});
