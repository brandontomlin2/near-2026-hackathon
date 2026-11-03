// Behaviour gaps in the swarm viewer renderer: the exact messages and
// boundaries of validateResult, and what the page shows for custom agents.
import test from "node:test";
import assert from "node:assert/strict";
import { GENESIS_HASH, hashRound } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { chainStatus, escapeHtml, renderViewer, validateResult } from "./render.mjs";

const A = [{ id: "a", name: "Ann", personality: "P", traits: { x: 1 } }, { id: "b", name: "Bob", personality: "Q", traits: {} }];
const ev = (id, round, agentId, text, extra = {}) => ({ id, round, agentId, text, kind: "post", ...extra });

function makeResult(events, rounds = Math.max(0, ...events.map((e) => e.round))) {
  const roundHashes = [];
  let prev = GENESIS_HASH;
  for (let r = 1; r <= rounds; r += 1) {
    prev = hashRound(prev, events.filter((e) => e.round === r));
    roundHashes.push(prev);
  }
  return { seed: 1, rounds, events, roundHashes };
}

const msg = (text) => (e) => e instanceof TypeError && e.message === `invalid swarm result: ${text}`;

test("validateResult: each structural failure names itself in a TypeError", () => {
  const ok = makeResult([ev("e1", 1, "a", "hi")]);
  assert.throws(() => validateResult(null, A), msg("must be an object"));
  assert.throws(() => validateResult([], A), msg("must be an object"));
  assert.throws(() => validateResult({ ...ok, events: "x" }, A), msg("events must be an array"));
  assert.throws(() => validateResult({ ...ok, roundHashes: undefined }, A), msg("roundHashes must be an array"));
  assert.throws(() => validateResult(ok, []), msg("agents must be a non-empty array"));
  assert.throws(() => validateResult(ok, "agents"), msg("agents must be a non-empty array"));
  assert.throws(() => validateResult({ ...ok, events: [null] }, A), msg("each event needs string text"));
});

test("validateResult: a nameless agent is rejected by position, whatever else is wrong", () => {
  const ok = makeResult([ev("e1", 1, "a", "hi")]);
  for (const bad of [null, {}, { id: "b" }, { id: "b", name: "" }, { id: "b", name: 7 }]) {
    assert.throws(() => validateResult(ok, [A[0], bad]), msg("agent 1 needs a non-empty string name"));
  }
  assert.throws(() => renderViewer(ok, [{ id: "a", name: "" }]), msg("agent 0 needs a non-empty string name"));
});

test("validateResult: round hashes must be exactly 64 lowercase hex characters", () => {
  const ok = makeResult([ev("e1", 1, "a", "hi")]);
  const h = ok.roundHashes[0];
  for (const bad of [h.toUpperCase(), h.slice(1), `${h}0`, ` ${h}`, `${h}\n`, 5, null]) {
    assert.throws(() => validateResult({ ...ok, roundHashes: [bad] }, A), msg("round 1 hash must be 64 lowercase hex characters"), String(bad));
  }
  assert.equal(validateResult(ok, A), ok);
});

test("validateResult: an event past the last round hash, out of order, or from an unknown agent is named by id", () => {
  const base = makeResult([ev("e1", 1, "a", "hi"), ev("e2", 2, "b", "yo")]);
  assert.throws(
    () => validateResult({ ...base, events: [...base.events, ev("e3", 3, "a", "late")] }, A),
    msg("event e3 has round 3 out of order or without a round hash"),
  );
  assert.throws(
    () => validateResult({ ...base, events: [base.events[1], base.events[0]] }, A),
    msg("event e1 has round 1 out of order or without a round hash"),
  );
  assert.throws(
    () => validateResult({ ...base, events: [ev("e1", 1, "zed", "hi")] }, A),
    msg('event e1 is from unknown agent "zed"'),
  );
  assert.throws(
    () => validateResult({ ...base, events: [ev("e1", 1.5, "a", "hi")] }, A),
    msg("event e1 has round 1.5 out of order or without a round hash"),
  );
});

test("custom agents: authors and reply arrows use their names, the table lists them, the default roster is not shown", () => {
  const events = [ev("e1", 1, "a", "first"), ev("e2", 1, "b", "answer", { kind: "reply", replyTo: "e1" })];
  const page = renderViewer(makeResult(events), A);
  assert.match(page, /<span class="author">Ann<\/span> first/);
  assert.match(page, /<span class="author">Bob<\/span> <span class="meta">&rarr; Ann<\/span> answer/);
  assert.match(page, /<td>Ann<\/td><td>P<\/td><td>x: 1<\/td>/);
  for (const a of AGENTS) assert.ok(!page.includes(`<td>${a.name}</td>`), a.name);
});

test("the table lists every agent in the order given, even one that never posts", () => {
  const page = renderViewer(makeResult([ev("e1", 1, "a", "hi")]), A);
  assert.ok(page.indexOf("<td>Ann</td>") < page.indexOf("<td>Bob</td>"));
});

test("a result whose last round has no events still renders that round with its hash and chain ok", () => {
  const result = makeResult([ev("e1", 1, "a", "hi")], 2);
  const page = renderViewer(result, A);
  assert.match(page, /2 rounds · 1 post · <span class="chain-ok">chain: ok<\/span>/);
  assert.ok(page.includes(result.roundHashes[1]));
  assert.deepEqual(chainStatus(result), { ok: true, brokenRound: null });
});

test("a tampered event is reported at its own round and the page still renders", () => {
  const result = makeResult([ev("e1", 1, "a", "hi"), ev("e2", 2, "b", "yo")]);
  const tampered = structuredClone(result);
  tampered.events[1].text = "changed";
  assert.deepEqual(chainStatus(tampered), { ok: false, brokenRound: 2 });
  assert.match(renderViewer(tampered, A), /<span class="chain-bad">chain: broken at round 2<\/span>/);
});

test("escapeHtml turns null and undefined into their words and escapes the single quote numerically", () => {
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml("‮<b>"), "�&lt;b&gt;");
});
