import assert from "node:assert/strict";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import {
  GENESIS_HASH,
  MAX_ROUNDS,
  PERSONAS,
  RECENT_EVENTS,
  SimError,
  formatTranscript,
  hashRound,
  parseRounds,
  runSwarm,
  verifyRounds,
} from "./swarm.mjs";

test("the same round count gives a byte-identical run", async () => {
  const a = await runSwarm({ rounds: 5 });
  const b = await runSwarm({ rounds: 5 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("every round has one message per persona, in persona order", async () => {
  const result = await runSwarm({ rounds: 3 });
  assert.equal(result.rounds.length, 3);
  result.rounds.forEach((r, index) => {
    assert.equal(r.round, index + 1);
    assert.deepEqual(r.messages.map((m) => m.from), PERSONAS.map((p) => p.id));
    assert.deepEqual(r.messages.map((m) => m.name), PERSONAS.map((p) => p.name));
  });
});

test("the first message opens the channel, later ones reply with an @mention", async () => {
  const [first, second, third] = (await runSwarm({ rounds: 1 })).rounds[0].messages;
  assert.equal(first.kind, "post");
  assert.equal(first.to, null);
  assert.equal(second.kind, "reply");
  assert.equal(second.to, first.from);
  assert.ok(second.text.startsWith(`@${first.name} `), second.text);
  assert.equal(third.to, second.from, "the third speaker replies to the latest message from someone else");
});

test("a reply shows up in the target agent's log as a mention", async () => {
  const result = await runSwarm({ rounds: 1 });
  const [first, second] = result.rounds[0].messages;
  const targetLog = result.logs[first.from];
  const mention = targetLog.find((e) => e.kind === "mention");
  assert.ok(mention, "target agent has a mention event");
  assert.equal(mention.from, second.from);
  assert.equal(mention.text, second.text);
});

test("an agent wakes with its last RECENT_EVENTS events only", async () => {
  const eventCounts = [];
  const clientFor = () => ({
    chat: async (request) => {
      const content = request.messages[0].content;
      eventCounts.push(content.split("\n").filter((l) => l.startsWith("- ")).length);
      return { content: "Noted." };
    },
  });
  const rounds = 12;
  const result = await runSwarm({ rounds, clientFor });

  // Every agent's log grows past the window, so the window must cap at K.
  assert.ok(Math.max(...Object.values(result.logs).map((l) => l.length)) > RECENT_EVENTS);
  assert.ok(eventCounts.every((n) => n <= RECENT_EVENTS), `windows: ${eventCounts}`);
  assert.equal(Math.max(...eventCounts), RECENT_EVENTS);
  assert.equal(eventCounts.length, rounds * PERSONAS.length);
});

test("the hash chain verifies, and a changed message breaks it", async () => {
  const result = await runSwarm({ rounds: 3 });
  assert.deepEqual(verifyRounds(result), { ok: true, round: null, headHash: result.headHash });
  assert.equal(result.rounds[0].prevHash, GENESIS_HASH);
  assert.equal(result.rounds[1].prevHash, result.rounds[0].hash);

  const tampered = structuredClone(result);
  tampered.rounds[1].messages[0].text += " edited";
  const check = verifyRounds(tampered);
  assert.equal(check.ok, false);
  assert.equal(check.round, 2);
});

test("hashRound depends on the previous hash", () => {
  const messages = [{ seq: 1, from: "aloof", kind: "post", to: null, text: "Hm." }];
  assert.notEqual(hashRound(GENESIS_HASH, 1, messages), hashRound("1".repeat(64), 1, messages));
});

test("sim mode never touches the network or reads inference env", async () => {
  const original = globalThis.fetch;
  const savedEnv = { MOCK_INFERENCE: process.env.MOCK_INFERENCE, NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY };
  globalThis.fetch = () => {
    throw new Error("network used");
  };
  process.env.MOCK_INFERENCE = "0";
  process.env.NEAR_AI_API_KEY = "test-key-not-a-real-credential";
  try {
    const result = await runSwarm({ rounds: 2 });
    assert.equal(verifyRounds(result).ok, true);
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("parseRounds accepts positive integers up to MAX_ROUNDS and rejects the rest", () => {
  assert.equal(parseRounds("5"), 5);
  assert.equal(parseRounds(MAX_ROUNDS), MAX_ROUNDS);
  for (const bad of ["0", "-1", "1.5", "abc", "", `${MAX_ROUNDS + 1}`]) {
    assert.throws(() => parseRounds(bad), SimError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("runSwarm rejects duplicate persona ids and too few personas", async () => {
  await assert.rejects(runSwarm({ rounds: 1, personas: [PERSONAS[0], PERSONAS[0]] }), SimError);
  await assert.rejects(runSwarm({ rounds: 1, personas: [PERSONAS[0]] }), SimError);
});

test("formatTranscript prints one line per message", async () => {
  const result = await runSwarm({ rounds: 2 });
  const lines = formatTranscript(result).split("\n");
  assert.equal(lines.length, 2 * PERSONAS.length);
  assert.match(lines[0], /^r1 Aloof \[post\]: /);
});

test("a custom client can be injected per persona", async () => {
  const seen = [];
  const clientFor = (persona) => createMockClient({
    responder: () => {
      seen.push(persona.id);
      return "Noted.";
    },
  });
  await runSwarm({ rounds: 1, clientFor });
  assert.deepEqual(seen, PERSONAS.map((p) => p.id));
});
