// Regression (fix58): when the token's memory directory is read-only, a failed
// ask must not leave log.jsonl ahead of sheet.json. Appends to an existing
// log.jsonl succeed in a read-only directory, but the sheet temp file cannot be
// created, so the log used to gain a round the sheet never saw.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { askAgent, askResponder } from "../owner/ask.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { sheetResponder } from "./sheet-responder.mjs";
import { createMemoryStore, summarize } from "./summarizer.mjs";

const agent = AGENTS.find((a) => a.id === "chaotic");

test("truncateLog keeps the first N events and is a no-op on a missing log with count 0", async () => {
  const root = mkdtempSync(join(tmpdir(), "fix58-trunc-"));
  try {
    const store = createMemoryStore(root);
    await store.truncateLog("nobody", 0);
    for (const text of ["one", "two", "three"]) {
      await store.appendEvent("tok", { round: 1, kind: "post", from: "A", text });
    }
    await store.truncateLog("tok", 2);
    assert.deepEqual((await store.readLog("tok")).map((e) => e.text), ["one", "two"]);
    await store.appendEvent("tok", { round: 2, kind: "post", from: "A", text: "four" });
    assert.deepEqual((await store.readLog("tok")).map((e) => e.text), ["one", "two", "four"]);
    await store.truncateLog("tok", 0);
    assert.deepEqual(await store.readLog("tok"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "a failed sheet write in a read-only memory dir leaves log and sheet in agreement",
  { skip: process.getuid?.() === 0 ? "chmod has no effect as root" : false },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "fix58-"));
    const agentDir = join(root, agent.id);
    const store = createMemoryStore(root);
    const sheetClient = createMockClient({ responder: sheetResponder });
    const answerClient = createMockClient({ model: "mock-persona", responder: askResponder(agent) });
    try {
      // Seed through the public API: two events and the sheet that covers them.
      await store.appendEvent(agent.id, { round: 1, kind: "post", from: agent.name, text: "hello swarm" });
      await store.appendEvent(agent.id, { round: 1, kind: "mention", from: "Skeptic", text: "you again" });
      const seeded = await summarize({ client: sheetClient, tokenId: agent.id, name: agent.name, round: 1, log: await store.readLog(agent.id) });
      await store.writeSheet(agent.id, seeded);

      chmodSync(agentDir, 0o555);
      await assert.rejects(askAgent({ agent, question: "how are you?", store, answerClient, sheetClient }));
      chmodSync(agentDir, 0o755);

      const sheet = await store.readSheet(agent.id);
      const log = await store.readLog(agent.id);
      assert.deepEqual(sheet, seeded, "sheet is unchanged");
      assert.equal(log.length, sheet.throughIndex, "log holds exactly the events the sheet covers");
      assert.equal(log.at(-1).round, sheet.round);
    } finally {
      chmodSync(agentDir, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
