import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwarm, hashRound, verifyRounds, GENESIS_HASH, MAX_REPLY_BYTES, personaPrompt } from "./runner.mjs";
import { PERSONA_LINES, REPLY_LINES, CATCHPHRASES, personaResponder, replyTargetOf } from "./personas.mjs";
import { moodForText } from "../art/moods.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { main } from "../../scripts/swarm.mjs";

const nameOf = (id) => AGENTS.find((a) => a.id === id).name;

const GOLDEN_ROUND_1 = `== Round 1 ==
[Skeptic] gas is "basically free"? receipts or it did not happen. source: trust me bro? ABSOLUTELY NOT.
[Chaotic -> Skeptic] @Skeptic receipts?? bro I AM the receipts \u{1F480}
[Aloof] huh, the airdrop was a rumor. \u2026anyway
[Social] gas is high but we are all high-fiving in the group chat, love that for us!
`;

/** The list a mock event's line must come from: the post list, or the reply list for its target. */
function sourceList(events, e) {
  if (e.kind === "post") return PERSONA_LINES[e.agentId];
  const target = events.find((x) => x.id === e.replyTo);
  return REPLY_LINES[e.agentId][nameOf(target.agentId)];
}
const strip = (e) => e.text.replace(/^@\w+ /, "");

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

test("verifyRounds accepts a run and rejects a tampered one", async () => {
  const run = await runSwarm({ seed: 5, rounds: 3 });
  assert.ok(verifyRounds(run));
  const edited = run.events.map((e, i) => (i === 5 ? { ...e, text: `${e.text}!` } : e));
  assert.ok(!verifyRounds({ ...run, events: edited }));
  assert.ok(!verifyRounds({ ...run, roundHashes: run.roundHashes.slice(0, 2) }));
});

test("default mock speaks each agent's own lines: posts from its persona list, replies from the list for its target", async () => {
  const { events } = await runSwarm({ seed: 9, rounds: 6 });
  assert.deepEqual(Object.keys(PERSONA_LINES).sort(), AGENTS.map((a) => a.id).sort());
  assert.deepEqual(Object.keys(CATCHPHRASES).sort(), AGENTS.map((a) => a.id).sort());
  assert.ok(events.some((e) => e.kind === "reply"));
  for (const e of events) {
    assert.ok(sourceList(events, e).includes(strip(e)), `${e.agentId}: unexpected line ${JSON.stringify(e.text)}`);
    if (e.kind === "reply") assert.match(e.text, /^@[A-Z][a-z]+ /, "a reply names its target first");
  }
});

test("reply lines: 12 pairs of 3 whole lines, none naming the target, each in the agent's mood", () => {
  const expectedMood = { aloof: ["neutral", "shade"], chaotic: ["hype"], social: ["hype"], skeptic: ["shade"] };
  assert.deepEqual(Object.keys(REPLY_LINES).sort(), AGENTS.map((a) => a.id).sort());
  let pairs = 0;
  for (const agent of AGENTS) {
    const others = AGENTS.filter((a) => a.id !== agent.id).map((a) => a.name).sort();
    assert.deepEqual(Object.keys(REPLY_LINES[agent.id]).sort(), others, `${agent.id} answers every other agent`);
    for (const [target, lines] of Object.entries(REPLY_LINES[agent.id])) {
      pairs++;
      assert.equal(lines.length, 3, `${agent.id} -> ${target}`);
      assert.equal(new Set(lines).size, 3, `${agent.id} -> ${target} has a duplicate`);
      for (const line of lines) {
        assert.ok(!line.includes("@") && !line.includes(target), `${agent.id} -> ${target}: the runner adds the name: ${line}`);
        assert.ok(!PERSONA_LINES[agent.id].includes(line), `${agent.id}: reply line is also a post line: ${line}`);
        assert.ok(expectedMood[agent.id].includes(moodForText(line)), `${agent.id} -> ${target}: ${moodForText(line)} for ${line}`);
      }
    }
  }
  assert.equal(pairs, 12);
});

test("personaResponder parses the runner's reply instruction and answers from that target's list", () => {
  const user = (instruction) => ({ messages: [{ role: "user", content: `Recent channel events:\n#3 [Skeptic] x\n\n${instruction}` }] });
  assert.equal(replyTargetOf(user("Reply to event #3 from Skeptic. Address Skeptic by name.")), "Skeptic");
  assert.equal(replyTargetOf(user("Post a new message to the channel on a topic of your choosing.")), null);
  assert.equal(replyTargetOf({}), null);
  const respond = personaResponder({ id: "chaotic" });
  const hash = "0000000a".padEnd(64, "0");
  const toSkeptic = respond(user("Reply to event #3 from Skeptic. Address Skeptic by name."), hash);
  assert.ok(REPLY_LINES.chaotic.Skeptic.includes(toSkeptic), toSkeptic);
  const post = respond(user("Post a new message to the channel on a topic of your choosing."), hash);
  assert.ok(PERSONA_LINES.chaotic.includes(post), post);
  // An unknown target name falls back to the post lines rather than throwing.
  const toStranger = respond(user("Reply to event #3 from Zed. Address Zed by name."), hash);
  assert.ok(PERSONA_LINES.chaotic.includes(toStranger), toStranger);
  // Same seed (same first hash), fresh responder: same walk.
  const again = personaResponder({ id: "chaotic" });
  assert.equal(again(user("Reply to event #3 from Skeptic. Address Skeptic by name."), hash), toSkeptic);
  assert.equal(personaResponder({ id: "nobody" }), undefined);
});

test("every agent has 10+ whole lines and its catchphrase runs through them", () => {
  for (const [id, lines] of Object.entries(PERSONA_LINES)) {
    assert.ok(lines.length >= 10, `${id} has only ${lines.length} lines`);
    assert.equal(new Set(lines).size, lines.length, `${id} has duplicate lines`);
    for (const line of lines) assert.ok(!line.includes("{topic}"), `${id}: unfilled template in ${line}`);
    const withBit = lines.filter((l) => l.toLowerCase().includes(CATCHPHRASES[id].toLowerCase()));
    assert.ok(withBit.length >= lines.length / 3, `${id}: catchphrase in only ${withBit.length} of ${lines.length} lines`);
  }
});

test("a shared client overrides the persona mock", async () => {
  const { events } = await runSwarm({ rounds: 1, client: { async chat() { return { content: "same" }; } } });
  assert.ok(events.every((e) => e.text.endsWith("same")));
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

test("mock personas vary across 10 rounds: no consecutive repeats, every list walked before it cycles, deterministic per seed", async () => {
  for (const seed of [1, 2, 9, 42]) {
    const a = await runSwarm({ seed, rounds: 10 });
    const b = await runSwarm({ seed, rounds: 10 });
    assert.equal(a.transcript, b.transcript, `seed ${seed} not deterministic`);
    assert.deepEqual(a.roundHashes, b.roundHashes);
    for (const { id } of AGENTS) {
      const own = a.events.filter((e) => e.agentId === id);
      assert.equal(own.length, 10);
      for (let i = 1; i < own.length; i++) {
        assert.notEqual(strip(own[i]), strip(own[i - 1]), `${id} repeats in rounds ${i} and ${i + 1} (seed ${seed})`);
      }
      // Per list (posts, or replies to one agent): the first `length` draws are all distinct.
      const draws = new Map();
      for (const e of own) {
        const list = sourceList(a.events, e);
        assert.ok(list.includes(strip(e)), `${id}: line outside its list (seed ${seed}): ${e.text}`);
        if (!draws.has(list)) draws.set(list, []);
        draws.get(list).push(strip(e));
      }
      for (const [list, lines] of draws) {
        const first = lines.slice(0, list.length);
        assert.equal(new Set(first).size, first.length, `${id}: a list repeats before it is walked (seed ${seed}): ${first}`);
      }
    }
  }
});

// Audit L-2 and L-3: whatever client answers, stored event text (and so transcript.txt,
// events.json and the round hashes) carries no control or bidi characters and is bounded.
test("hostile client: control characters are replaced and a 4 MiB reply is cut to MAX_REPLY_BYTES", async () => {
  const hostile = "\u001b[2J\u001b]0;pwned\u0007\u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007 \u202ereversed\u202c ok";
  const huge = "é".repeat(2 * 1024 * 1024);
  let n = 0;
  const client = { async chat() { return { content: (n++ % 2 === 0) ? hostile : huge }; } };
  const result = await runSwarm({ client, rounds: 2, seed: 4 });
  const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  for (const e of result.events) {
    assert.doesNotMatch(e.text, unsafe, `event ${e.id}`);
    assert.ok(Buffer.byteLength(e.text, "utf8") <= MAX_REPLY_BYTES + 32, `event ${e.id}: ${Buffer.byteLength(e.text, "utf8")} bytes`); // + "@Name " prefix at most
    assert.ok(!e.text.includes("\uFFFD\uFFFD\uFFFD"), "no split code point");
  }
  const small = result.events.filter((e) => e.text.includes("link"));
  assert.ok(small.length > 0);
  for (const e of small) assert.ok(e.text.includes("\uFFFD[2J") && e.text.endsWith(" ok"), e.text);
  const big = result.events.filter((e) => e.text.includes("é"));
  assert.ok(big.length > 0);
  for (const e of big) assert.ok(Buffer.byteLength(e.text, "utf8") >= MAX_REPLY_BYTES - 1);
  assert.doesNotMatch(result.transcript, unsafe);
  assert.ok(result.transcript.length < 4 * MAX_REPLY_BYTES * 2 + 200);
  assert.ok(verifyRounds(result));
});
