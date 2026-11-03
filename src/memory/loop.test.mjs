import assert from "node:assert/strict";
import test from "node:test";
import { AGENTS } from "../traits/agents.mjs";
import { createMockClient } from "../inference/client.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { diffSheets, runMemoryLoop, sheetRounds, tokenLogs } from "./loop.mjs";

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
  // `from` is the agent's display name, the one the summarizer prompt and the sheet stand-in use (same as npm run demo).
  assert.deepEqual(logs.aloof.map((e) => [e.kind, e.from]), [["post", "Aloof"], ["mention", "Chaotic"]]);
  assert.deepEqual(logs.chaotic.map((e) => [e.kind, e.from]), [["reply", "Chaotic"]]);
});

test("without a client the loop writes sheets with the counting stand-in, the same one npm run demo uses", async () => {
  const { sheetResponder } = await import("./sheet-responder.mjs");
  const swarm = await runSwarm({ rounds: 3, seed: 1 });
  const { tokens } = await runMemoryLoop({ swarm });
  const standIn = await runMemoryLoop({ swarm, client: createMockClient({ responder: sheetResponder }) });
  assert.deepEqual(tokens, standIn.tokens);
  for (const t of tokens) {
    assert.match(t.sheet.sheet, new RegExp(`^Who I am: ${t.name}, `));
    assert.match(t.sheet.sheet, /Public enemy #1: .* Ride-or-die: .* Scorecard: .* Receipts: \d+ posts?, \d+ repl(?:y|ies), mentioned \d+ times?\.$/);
  }
  // The stand-in reads the channel: a reply from another agent shows up as that agent's row on the scorecard.
  const chaoticReply = swarm.events.find((e) => e.kind === "reply" && e.agentId === "chaotic");
  const target = swarm.events.find((e) => e.id === chaoticReply.replyTo);
  const targetSheet = tokens.find((t) => t.tokenId === target.agentId).sheet.sheet;
  assert.match(targetSheet, /Scorecard: .*Chaotic: \d+ fights?, \d+ hugs?, \d+ shrugs?/);
});

test("sheets are written every N rounds plus the final round, one anchor each", async () => {
  assert.deepEqual(sheetRounds(7, 3), [3, 6, 7]);
  assert.deepEqual(sheetRounds(6, 3), [3, 6]);
  assert.deepEqual(sheetRounds(2, 5), [2]);
  const swarm = await runSwarm({ rounds: 7, seed: 1 });
  const result = await runMemoryLoop({ swarm, client: createMockClient(), every: 3 });
  for (const t of result.tokens) {
    assert.deepEqual(t.sheets.map((s) => s.round), [3, 6, 7]);
    for (const s of t.sheets) {
      assert.equal(s.anchor.args.sheet_hash, s.sheet.sheetHash);
      assert.equal(s.anchor.status, "dry-run");
      assert.equal(s.anchor.linkedRoundHash, swarm.roundHashes[s.round - 1]);
    }
    assert.equal(t.sheet, t.sheets.at(-1).sheet);
    assert.equal(t.anchor.linkedRoundHash, result.finalRoundHash);
  }
});

test("each sheet builds on the previous one and records what changed", async () => {
  const swarm = await runSwarm({ rounds: 6, seed: 1 });
  const { tokens } = await runMemoryLoop({ swarm, client: createMockClient(), every: 3 });
  const [first, second] = tokens[0].sheets;
  assert.equal(first.diff.previousHash, null);
  assert.equal(second.diff.previousHash, first.sheet.sheetHash);
  assert.equal(second.diff.sheetHash, second.sheet.sheetHash);
  assert.ok(second.sheet.throughIndex > first.sheet.throughIndex);
  assert.equal(second.diff.newEvents, second.sheet.throughIndex - first.sheet.throughIndex);
});

test("a sheet only sees events up to its own round", async () => {
  const swarm = await runSwarm({ rounds: 6, seed: 1 });
  const { tokens } = await runMemoryLoop({ swarm, client: createMockClient(), every: 3 });
  const logs = tokenLogs(swarm.events, AGENTS);
  const upTo3 = logs[tokens[0].tokenId].filter((e) => e.round <= 3).length;
  assert.equal(tokens[0].sheets[0].sheet.throughIndex, upTo3);
});

test("diffSheets lists added and removed sentences", () => {
  const prev = { round: 3, sheet: "Hm. Keep going.", sheetHash: "a" };
  const next = { round: 6, sheet: "Keep going. New thing.", sheetHash: "b", newEvents: 2 };
  assert.deepEqual(diffSheets(prev, next), {
    fromRound: 3, toRound: 6, previousHash: "a", sheetHash: "b", changed: true,
    added: ["New thing."], removed: ["Hm."], newEvents: 2,
  });
  assert.equal(diffSheets(null, next).changed, true);
  assert.equal(diffSheets({ ...next }, { ...next }).changed, false);
});

test("cadence: N=1 matches the default when the run is one round, N=2 writes even rounds only", async () => {
  const one = await runSwarm({ rounds: 1, seed: 1 });
  const byDefault = await runMemoryLoop({ swarm: one, client: createMockClient() });
  const everyOne = await runMemoryLoop({ swarm: one, client: createMockClient(), every: 1 });
  assert.deepEqual({ ...everyOne, every: undefined }, { ...byDefault, every: undefined });

  const six = await runSwarm({ rounds: 6, seed: 1 });
  const unset = await runMemoryLoop({ swarm: six, client: createMockClient() });
  assert.deepEqual(unset, await runMemoryLoop({ swarm: six, client: createMockClient(), every: 3 }));
  const twos = await runMemoryLoop({ swarm: six, client: createMockClient(), every: 2 });
  for (const t of twos.tokens) assert.deepEqual(t.sheets.map((s) => s.round), [2, 4, 6]);
  const ones = await runMemoryLoop({ swarm: six, client: createMockClient(), every: 1 });
  for (const t of ones.tokens) assert.deepEqual(t.sheets.map((s) => s.round), [1, 2, 3, 4, 5, 6]);
});
