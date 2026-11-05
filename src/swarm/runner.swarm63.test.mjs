import test from "node:test";
import assert from "node:assert/strict";
import { runSwarm } from "./runner.mjs";
import { AGENTS } from "../traits/agents.mjs";

const rejectsWith = (client, seen) =>
  assert.rejects(runSwarm({ rounds: 2, seed: 1, client }), (e) => {
    assert.ok(e instanceof TypeError, String(e));
    const m = e.message.match(/^agent (\S+) returned no reply text \(got (\w+)\) in round (\d+) turn (\d+)$/);
    assert.ok(m, e.message);
    assert.ok(AGENTS.some((a) => a.id === m[1]), e.message);
    assert.equal(m[2], seen);
    assert.equal(m[3], "1");
    assert.equal(m[4], "1");
    return true;
  });

test("content null rejects naming the agent, round, turn and null", () =>
  rejectsWith({ chat: async () => ({ content: null }) }, "null"));

test("content undefined rejects naming undefined", () =>
  rejectsWith({ chat: async () => ({ content: undefined }) }, "undefined"));

test("a missing response object rejects naming undefined", () =>
  rejectsWith({ chat: async () => undefined }, "undefined"));

test("object content rejects instead of storing [object Object]", () =>
  rejectsWith({ chat: async () => ({ content: { text: "hi" } }) }, "object"));

test("the failing turn is reported, not an earlier good one", async () => {
  let calls = 0;
  const client = { chat: async () => (++calls === 3 ? { content: null } : { content: "fine" }) };
  await assert.rejects(runSwarm({ rounds: 1, client }), /returned no reply text \(got null\) in round 1 turn 3$/);
});

test("a normal string reply and a numeric reply still work", async () => {
  const ok = await runSwarm({ rounds: 1, client: { chat: async () => ({ content: "hello" }) } });
  assert.equal(ok.events.length, AGENTS.length);
  assert.ok(ok.events.every((e) => e.text.includes("hello")));
  const num = await runSwarm({ rounds: 1, client: { chat: async () => ({ content: 42 }) } });
  assert.equal(num.events[0].text, "42");
});
