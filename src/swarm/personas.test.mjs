import { test } from "node:test";
import assert from "node:assert/strict";
import { personaResponder, createPersonaMockClient, PERSONA_LINES } from "./personas.mjs";

const HASH_A = "0".repeat(64);
const HASH_B = `${"0".repeat(7)}1${"0".repeat(56)}`;
const draw = (responder, n, hash = HASH_A) => Array.from({ length: n }, () => responder(null, hash));

test("personaResponder cycles through every line exactly once, then repeats", () => {
  for (const [id, lines] of Object.entries(PERSONA_LINES)) {
    const responder = personaResponder({ id });
    const seq = draw(responder, lines.length * 2);
    assert.deepEqual([...seq.slice(0, lines.length)].sort(), [...lines].sort(), id);
    assert.deepEqual(seq.slice(lines.length), seq.slice(0, lines.length), id);
  }
});

test("personaResponder is deterministic for the same first hash", () => {
  for (const id of Object.keys(PERSONA_LINES)) {
    const n = PERSONA_LINES[id].length + 3;
    assert.deepEqual(draw(personaResponder({ id }), n), draw(personaResponder({ id }), n), id);
  }
});

test("personaResponder start depends on the first hash only", () => {
  for (const id of Object.keys(PERSONA_LINES)) {
    const r = personaResponder({ id });
    const first = r(null, HASH_A);
    // Later hashes are ignored: the walk continues from the first start.
    const second = r(null, HASH_B);
    const fresh = personaResponder({ id });
    assert.equal(fresh(null, HASH_A), first);
    assert.equal(fresh(null, HASH_A), second);
    assert.notEqual(personaResponder({ id })(null, HASH_B), first, id);
  }
});

test("personaResponder returns undefined for agents without written lines", () => {
  assert.equal(personaResponder({ id: "zed" }), undefined);
});

test("personaResponder ignores inherited keys such as toString and constructor", async () => {
  // Plain indexing found Object.prototype functions here: "toString" (length 0)
  // made strideFor loop forever and "constructor" produced undefined lines.
  for (const id of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(personaResponder({ id }), undefined, id);
    const reply = await createPersonaMockClient({ id }).chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(typeof reply.content, "string", id);
    assert.ok(reply.content.length > 0, id);
  }
});

test("a reply target that is an Object.prototype key falls back to the agent's own lines", async () => {
  // REPLY_LINES.aloof has no "constructor" entry; plain indexing found Object's own
  // constructor function there, and the mock client then threw bad_responder.
  for (const target of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const reply = await createPersonaMockClient({ id: "aloof" }).chat({
      messages: [{ role: "user", content: `Recent channel events:\n#1 [${target}] hi\n\nReply to event #1 from ${target}. Address ${target} by name.` }],
    });
    assert.ok(PERSONA_LINES.aloof.includes(reply.content), `${target}: ${reply.content}`);
  }
});

test("createPersonaMockClient speaks the agent's lines and falls back to the default mock", async () => {
  const req = { messages: [{ role: "user", content: "hello there" }] };
  const aloof = await createPersonaMockClient({ id: "aloof" }).chat(req);
  assert.ok(PERSONA_LINES.aloof.includes(aloof.content));
  const zed = await createPersonaMockClient({ id: "zed" }).chat(req);
  assert.equal(zed.mode, "mock");
  assert.ok(zed.content.length > 0);
  assert.ok(!Object.values(PERSONA_LINES).some((l) => l.includes(zed.content)));
});

test("personaResponder steps by the smallest stride of 3 or more that is coprime with the list length", () => {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  for (const [id, lines] of Object.entries(PERSONA_LINES)) {
    const n = lines.length;
    let stride = 3;
    while (gcd(stride, n) !== 1) stride++;
    const [a, b] = draw(personaResponder({ id }), 2);
    assert.equal((lines.indexOf(b) - lines.indexOf(a) + n) % n, stride % n, id);
  }
});
