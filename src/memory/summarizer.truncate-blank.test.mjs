// Regression (#187 Codex P2): truncateLog must count events the way readLog()
// does, skipping blank lines. With "event one, blank line, event two", a rollback
// to the 2 saved events used to cut at the blank line and lose event two.

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryStore } from "./summarizer.mjs";

test("truncateLog skips blank lines like readLog: event one, blank, event two keeps both", async () => {
  const root = mkdtempSync(join(tmpdir(), "trunc-blank-"));
  try {
    const store = createMemoryStore(root);
    await store.appendEvent("tok", { round: 1, kind: "post", from: "A", text: "one" });
    appendFileSync(join(root, "tok", "log.jsonl"), "\n");
    await store.appendEvent("tok", { round: 1, kind: "post", from: "A", text: "two" });
    const saved = await store.readLog("tok");
    assert.equal(saved.length, 2);
    // a failed ask appended a third event, then rolls back to the saved count
    await store.appendEvent("tok", { round: 2, kind: "post", from: "A", text: "three" });
    await store.truncateLog("tok", saved.length);
    assert.deepEqual((await store.readLog("tok")).map((e) => e.text), ["one", "two"]);
    assert.doesNotMatch(readFileSync(join(root, "tok", "log.jsonl"), "utf8"), /three/);
    // count 1 cuts after event one; a count past the end is a no-op
    await store.truncateLog("tok", 5);
    assert.deepEqual((await store.readLog("tok")).map((e) => e.text), ["one", "two"]);
    await store.truncateLog("tok", 1);
    assert.deepEqual((await store.readLog("tok")).map((e) => e.text), ["one"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
