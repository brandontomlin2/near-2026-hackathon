import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwarm, hashRound, GENESIS_HASH, personaPrompt } from "./runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { main } from "../../scripts/swarm.mjs";

const nameOf = (id) => AGENTS.find((a) => a.id === id).name;

const GOLDEN_ROUND_1 = `== Round 1 ==
[Skeptic] Hm. I can connect two of you on choosing if that helps. That is all for now.
[Chaotic -> Skeptic] Skeptic, Noted. On choosing, I would rather watch than commit. Reply if you disagree.
[Aloof] Fine. I have a question about choosing: who checked it?
[Social] Interesting. I have a question about choosing: who checked it? Logging it.
`;

test("same seed is byte-identical, different seed differs", async () => {
  const a = await runSwarm({ seed: 7 });
  const b = await runSwarm({ seed: 7 });
  const c = await runSwarm({ seed: 8 });
  assert.equal(a.transcript, b.transcript);
  assert.deepEqual(a.roundHashes, b.roundHashes);
  assert.notEqual(a.transcript, c.transcript);
  assert.notDeepEqual(a.roundHashes, c.roundHashes);
});

test("event ids, rounds and turns are correct; every agent speaks once per round", async () => {
  const { events, roundHashes } = await runSwarm({ rounds: 5, seed: 3 });
  assert.equal(events.length, 5 * AGENTS.length);
  assert.equal(roundHashes.length, 5);
  events.forEach((e, i) => {
    assert.equal(e.id, i + 1);
    assert.equal(e.round, Math.floor(i / AGENTS.length) + 1);
    assert.equal(e.turn, (i % AGENTS.length) + 1);
  });
  for (let r = 1; r <= 5; r++) {
    const ids = events.filter((e) => e.round === r).map((e) => e.agentId).sort();
    assert.deepEqual(ids, AGENTS.map((a) => a.id).sort());
  }
});

test("replies reference earlier events and mention the target; first turn is a post", async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const { events } = await runSwarm({ seed });
    assert.equal(events[0].kind, "post");
    let replies = 0;
    for (const e of events) {
      if (e.kind === "post") { assert.equal(e.replyTo, null); continue; }
      replies++;
      assert.ok(e.replyTo >= 1 && e.replyTo < e.id);
      const target = events[e.replyTo - 1];
      assert.notEqual(target.agentId, e.agentId);
      assert.ok(e.text.includes(nameOf(target.agentId)));
    }
    assert.ok(replies > 0);
  }
});

test("round hash chain is verifiable by recomputation", async () => {
  const { events, roundHashes } = await runSwarm({ seed: 11 });
  let prev = GENESIS_HASH;
  roundHashes.forEach((h, i) => {
    prev = hashRound(prev, events.filter((e) => e.round === i + 1));
    assert.equal(h, prev);
    assert.match(h, /^[0-9a-f]{64}$/);
  });
  // Independent recomputation of round 1 with sorted-key JSON.
  const r1 = events.filter((e) => e.round === 1)
    .map(({ id, round, turn, agentId, kind, replyTo, text }) => ({ agentId, id, kind, replyTo, round, text, turn }));
  const manual = createHash("sha256")
    .update(GENESIS_HASH).update("\n").update(JSON.stringify(r1)).digest("hex");
  assert.equal(roundHashes[0], manual);
});

test("golden first round for seed 1", async () => {
  const { transcript } = await runSwarm({ seed: 1, rounds: 5 });
  assert.ok(transcript.startsWith(GOLDEN_ROUND_1));
});

test("invalid arguments throw", async () => {
  await assert.rejects(runSwarm({ rounds: 0 }), RangeError);
  await assert.rejects(runSwarm({ agents: [] }), RangeError);
  await assert.rejects(runSwarm({ lastK: 0 }), RangeError);
});

test("stub client: lastK truncation and per-agent persona prompts", async () => {
  const requests = [];
  const client = {
    async chat(req) {
      requests.push(req);
      return { content: "ok" };
    },
  };
  await runSwarm({ client, rounds: 3, seed: 2, lastK: 2 });
  assert.equal(requests.length, 3 * AGENTS.length);
  for (const [i, req] of requests.entries()) {
    const shown = (req.messages[0].content.match(/^#\d+ /gm) ?? []).length;
    assert.equal(shown, Math.min(i, 2));
  }
  const systems = new Set(requests.slice(0, 40).map((r) => r.system));
  assert.equal(systems.size, AGENTS.length);
  assert.notEqual(personaPrompt(AGENTS[0]), personaPrompt(AGENTS[1]));
});

test("scripts/swarm.mjs main writes outputs and validates args", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-"));
  try {
    const lines = [];
    const code = await main(["--rounds", "2", "--seed", "4", "--out", dir], { env: {}, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    const transcript = await readFile(join(dir, "transcript.txt"), "utf8");
    const saved = JSON.parse(await readFile(join(dir, "events.json"), "utf8"));
    assert.equal(saved.events.length, 2 * AGENTS.length);
    assert.equal(transcript, saved.transcript);
    assert.ok(lines.join("\n").includes(saved.roundHashes.at(-1)));
    for (const bad of [["--rounds", "0"], ["--seed", "x"], ["--rounds"], ["--rounds", "-1"]]) {
      assert.equal(await main(bad, { env: {}, log() {} }), 2);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
