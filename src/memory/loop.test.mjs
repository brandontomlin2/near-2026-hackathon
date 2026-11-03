import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS } from "../traits/agents.mjs";
import { createMockClient } from "../inference/client.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { runMemoryLoop, tokenLogs } from "./loop.mjs";

const loop = async (seed) => {
  const swarm = await runSwarm({ rounds: 5, seed });
  return { swarm, result: await runMemoryLoop({ swarm, client: createMockClient() }) };
};

test("same seed gives deep-equal results", async () => {
  assert.deepEqual((await loop(1)).result, (await loop(1)).result);
});

test("one anchor per token, token ids equal agent ids", async () => {
  const { result } = await loop(1);
  assert.deepEqual(result.tokens.map((t) => t.tokenId), AGENTS.map((a) => a.id));
});

test("anchored hash equals the sheet hash and links the final round hash", async () => {
  const { swarm, result } = await loop(1);
  for (const t of result.tokens) {
    assert.equal(t.anchor.args.sheet_hash, t.sheet.sheetHash);
    assert.equal(t.anchor.args.token_id, t.tokenId);
    assert.equal(t.anchor.linkedRoundHash, swarm.roundHashes.at(-1));
    assert.equal(t.anchor.status, "dry-run");
    assert.equal(t.anchor.transactionHash, null);
  }
});

test("a different seed changes the final and linked hashes", async () => {
  const a = (await loop(1)).result;
  const b = (await loop(2)).result;
  assert.notEqual(a.finalRoundHash, b.finalRoundHash);
  assert.notEqual(a.tokens[0].anchor.linkedRoundHash, b.tokens[0].anchor.linkedRoundHash);
});

test("tokenLogs records a mention for the replied-to agent", () => {
  const events = [
    { id: 0, round: 1, turn: 0, agentId: "aloof", kind: "post", replyTo: null, text: "hi" },
    { id: 1, round: 1, turn: 1, agentId: "chaotic", kind: "reply", replyTo: 0, text: "yo" },
  ];
  const logs = tokenLogs(events, AGENTS);
  assert.deepEqual(logs.aloof.map((e) => [e.kind, e.from]), [["post", "aloof"], ["mention", "chaotic"]]);
  assert.deepEqual(logs.chaotic.map((e) => [e.kind, e.from]), [["reply", "chaotic"]]);
});
