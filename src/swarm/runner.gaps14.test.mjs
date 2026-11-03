import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS } from "../traits/agents.mjs";
import { personaPrompt, runSwarm, verifyRounds } from "./runner.mjs";

const stub = (content) => ({ async chat() { return { content }; } });

test("each bad argument is a RangeError that says which argument and the allowed range", async () => {
  const bad = (opts, message) => assert.rejects(runSwarm(opts), (e) => e instanceof RangeError && e.message === message);
  await bad({ rounds: 1001 }, "rounds must be an integer from 1 to 1000");
  await bad({ rounds: 2.5 }, "rounds must be an integer from 1 to 1000");
  await bad({ seed: 1.5 }, "seed must be an integer");
  await bad({ lastK: 0 }, "lastK must be a positive integer");
  await bad({ agents: [] }, "agents must be a non-empty array");
  await bad({ agents: "aloof" }, "agents must be a non-empty array");
});

test("a lone agent only posts: nobody to reply to, no @ prefix, and the hash chain still verifies", async () => {
  const result = await runSwarm({ agents: [AGENTS[0]], rounds: 3, seed: 5, client: stub("on my own") });
  assert.equal(result.events.length, 3);
  for (const e of result.events) {
    assert.equal(e.kind, "post");
    assert.equal(e.replyTo, null);
    assert.equal(e.text, "on my own");
    assert.equal(e.turn, 1);
  }
  assert.ok(verifyRounds(result));
  assert.equal(result.transcript, "== Round 1 ==\n[Aloof] on my own\n\n== Round 2 ==\n[Aloof] on my own\n\n== Round 3 ==\n[Aloof] on my own\n");
});

test("clientFor wins over a shared client", async () => {
  const result = await runSwarm({ rounds: 1, client: stub("from client"), clientFor: (agent) => stub(`from ${agent.id}`) });
  for (const e of result.events) assert.ok(e.text.endsWith(`from ${e.agentId}`), e.text);
});

test("with lastK 1 a reply can only answer the event right before it, never the author's own", async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { events } = await runSwarm({ rounds: 6, seed, lastK: 1, client: stub("hmm") });
    const replies = events.filter((e) => e.kind === "reply");
    assert.ok(replies.length > 0, `seed ${seed} had no reply to check`);
    for (const e of replies) {
      assert.equal(e.replyTo, e.id - 1);
      assert.notEqual(events[e.replyTo - 1].agentId, e.agentId);
    }
  }
});

test("a reply names its target as '@Name ' in front of the model's words, and the transcript shows the arrow", async () => {
  const { events, transcript } = await runSwarm({ rounds: 3, seed: 1, client: stub("plain words") });
  const reply = events.find((e) => e.kind === "reply");
  assert.ok(reply, "seed 1 has a reply");
  const target = AGENTS.find((a) => a.id === events[reply.replyTo - 1].agentId);
  const me = AGENTS.find((a) => a.id === reply.agentId);
  assert.equal(reply.text, `@${target.name} plain words`);
  assert.ok(transcript.includes(`[${me.name} -> ${target.name}] @${target.name} plain words\n`));
});

test("every agent's persona prompt opens with its name and personality, closes with the style rule and differs per agent", () => {
  const prompts = AGENTS.map(personaPrompt);
  AGENTS.forEach((a, i) => {
    assert.ok(prompts[i].startsWith(`You are ${a.name}, the ${a.personality}, one of several agents on a shared channel. `));
    assert.ok(prompts[i].endsWith(" Reply in one or two short sentences, in character."));
  });
  assert.equal(new Set(prompts).size, AGENTS.length);
  assert.match(prompts[0], /You are cool and measured/);
  assert.match(prompts[3], /You speak flatly/);
});
