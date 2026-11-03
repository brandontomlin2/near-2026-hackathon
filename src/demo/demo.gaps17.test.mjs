import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDemo } from "./pipeline.mjs";
import { AGENTS } from "../traits/agents.mjs";

const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const readJson = (dir, f) => JSON.parse(read(dir, f));
const readLog = (dir, id) => read(dir, `memory/${id}/log.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));

function withTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "demo-gaps17-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("demo: memory log wiring", () => {
  it("each token's log.jsonl is exactly its own posts and replies plus a mention for every reply aimed at it, in event order", async (t) => {
    const out = withTmp(t);
    await runDemo({ outDir: out, rounds: 4, every: 2 });
    const { events } = readJson(out, "events.json");
    const nameOf = new Map(AGENTS.map((a) => [a.id, a.name]));
    for (const agent of AGENTS) {
      const expected = [];
      for (const e of events) {
        if (e.agentId === agent.id) expected.push({ round: e.round, kind: e.kind, from: agent.name, text: e.text });
        if (e.kind === "reply") {
          const target = events.find((x) => x.id === e.replyTo);
          if (target?.agentId === agent.id) expected.push({ round: e.round, kind: "mention", from: nameOf.get(e.agentId), text: e.text });
        }
      }
      assert.ok(expected.some((x) => x.kind === "mention"), `${agent.id} should have been mentioned in this fixture`);
      assert.deepEqual(readLog(out, agent.id), expected, `${agent.id} log`);
    }
  });

  it("the final sheet's Receipts line counts exactly the posts, replies and mentions in that token's log", async (t) => {
    const out = withTmp(t);
    await runDemo({ outDir: out, rounds: 6, every: 3 });
    for (const agent of AGENTS) {
      const log = readLog(out, agent.id);
      const count = (kind) => log.filter((e) => e.kind === kind).length;
      const { sheet } = readJson(out, `memory/${agent.id}/sheet.json`);
      const m = /Receipts: (\d+) posts?, (\d+) repl(?:y|ies), mentioned (\d+) times?/.exec(sheet);
      assert.ok(m, `${agent.id} sheet has a Receipts line: ${sheet}`);
      assert.deepEqual(m.slice(1).map(Number), [count("post"), count("reply"), count("mention")], agent.id);
    }
  });
});

describe("demo: rounds not divisible by --every", () => {
  it("rounds 5, every 2 summarizes at rounds 2 and 4 only; the round-5 chatter stays in the log but is never anchored", async (t) => {
    const out = withTmp(t);
    const { manifest } = await runDemo({ outDir: out, rounds: 5, every: 2 });
    const anchors = readJson(out, "anchors.json");
    assert.equal(anchors.calls.length, AGENTS.length * 2);
    for (const agent of AGENTS) {
      assert.deepEqual(manifest.agents.find((a) => a.id === agent.id).sheets.map((s) => s.round), [2, 4]);
      assert.deepEqual(anchors.calls.filter((c) => c.tokenId === agent.id).map((c) => c.round), [2, 4]);
      assert.equal(readJson(out, `memory/${agent.id}/sheet.json`).round, 4);
      assert.ok(readLog(out, agent.id).some((e) => e.round === 5), `${agent.id} log has round 5`);
      assert.ok(readLog(out, agent.id).every((e) => e.round <= 5));
    }
    // Memory depth on the page art: 1 + number of sheets.
    assert.ok(manifest.agents.every((a) => a.memoryDepth === 3));
  });
});

describe("demo: manifest sheet records", () => {
  it("words is the sheet's word count and sheetHash is the hash anchored for that round", async (t) => {
    const out = withTmp(t);
    const { manifest } = await runDemo({ outDir: out, rounds: 4, every: 2 });
    const anchors = readJson(out, "anchors.json");
    for (const a of manifest.agents) {
      for (const s of a.sheets) {
        assert.equal(s.words, s.sheet.split(/\s+/).filter(Boolean).length);
        const call = anchors.calls.find((c) => c.tokenId === a.id && c.round === s.round);
        assert.equal(call.args.sheet_hash, s.sheetHash);
      }
      assert.notEqual(a.sheets[0].sheetHash, a.sheets[1].sheetHash, `${a.id} sheets differ between rounds`);
    }
  });
});
