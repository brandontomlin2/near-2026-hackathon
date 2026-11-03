import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS } from "../traits/agents.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { runMemoryLoop } from "./loop.mjs";

/** Swarm whose every line is unique and findable: "uniq-<event number>-end". */
async function uniqueSwarm(rounds) {
  let n = 0;
  const client = { async chat() { n++; return { content: `uniq-${String(n).padStart(2, "0")}-end` }; } };
  return runSwarm({ rounds, seed: 1, client });
}

/** Loop client that records each summarizer request and answers with a fixed sheet. */
function recorder() {
  const requests = [];
  return { requests, async chat(request) { requests.push(request); return { content: "A sheet." }; } };
}

test("a sheet request carries only events up to its round, and a later sheet only the events since the previous one", async () => {
  const swarm = await uniqueSwarm(4);
  const client = recorder();
  await runMemoryLoop({ swarm, client, every: 2 });
  // Agents run in order, each with its sheets at rounds 2 and 4: 8 requests.
  assert.equal(client.requests.length, AGENTS.length * 2);
  const text = (r) => r.messages.map((m) => m.content).join("\n");
  const textsOf = (round) => swarm.events.filter((e) => e.round === round).map((e) => e.text);
  const first = text(client.requests[0]);
  const second = text(client.requests[1]);
  // The first sheet (round 2) never sees round 3 or 4 text.
  for (const t of [...textsOf(3), ...textsOf(4)]) assert.ok(!first.includes(t), `round 2 sheet saw the future: ${t}`);
  // The aloof agent's round-1 and round-2 own posts are in the first request ...
  const aloofOwn = swarm.events.filter((e) => e.agentId === "aloof" && e.round <= 2).map((e) => e.text);
  assert.equal(aloofOwn.length, 2);
  for (const t of aloofOwn) assert.ok(first.includes(t), `missing own line ${t}`);
  // ... and are not repeated in the second, which carries round 3 and 4 lines of that agent.
  for (const t of aloofOwn) assert.ok(!second.includes(t), `old event resent: ${t}`);
  for (const e of swarm.events.filter((e) => e.agentId === "aloof" && e.round >= 3)) assert.ok(second.includes(e.text));
});

test("an agent subset gives sheets and anchors for just those agents, with the given contract id", async () => {
  const swarm = await runSwarm({ rounds: 2, seed: 4 });
  const subset = [AGENTS[2], AGENTS[0]];
  const result = await runMemoryLoop({ swarm, agents: subset, every: 2, contractId: "agents.example.testnet" });
  assert.deepEqual(result.tokens.map((t) => [t.tokenId, t.name]), [["social", "Social"], ["aloof", "Aloof"]]);
  for (const t of result.tokens) {
    assert.equal(t.anchor.contractId, "agents.example.testnet");
    assert.equal(t.anchor.args.token_id, t.tokenId);
    assert.match(t.sheet.sheet, new RegExp(`^Who I am: ${t.name}, `), "the stand-in names the agent it writes for");
  }
});

test("the result hands back the swarm's own hashes and the cadence it used", async () => {
  const swarm = await runSwarm({ rounds: 4, seed: 2 });
  const result = await runMemoryLoop({ swarm, every: 2 });
  assert.deepEqual(result.roundHashes, swarm.roundHashes);
  assert.equal(result.finalRoundHash, swarm.roundHashes[3]);
  assert.equal(result.every, 2);
  // Default cadence applies when `every` is left out.
  assert.equal((await runMemoryLoop({ swarm })).every, 3);
});

test("a client error stops the loop and reaches the caller unchanged", async () => {
  const swarm = await runSwarm({ rounds: 1, seed: 1 });
  const boom = new Error("model unreachable");
  await assert.rejects(runMemoryLoop({ swarm, client: { async chat() { throw boom; } }, every: 1 }), (error) => error === boom);
});

test("the sheet a model returns is what gets stored and anchored, with whitespace collapsed to one line", async () => {
  const swarm = await runSwarm({ rounds: 1, seed: 1 });
  const client = { async chat() { return { content: "Line one.\n\nLine   two." }; } };
  const { tokens } = await runMemoryLoop({ swarm, client, every: 1 });
  for (const t of tokens) {
    assert.equal(t.sheet.sheet, "Line one. Line two.");
    assert.deepEqual(t.sheets[0].diff.added, ["Line one.", "Line two."]);
  }
});
