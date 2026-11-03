import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import {
  MAX_SHEET_WORDS,
  MemoryError,
  buildSummaryMessages,
  clampWords,
  createMemoryStore,
  makeEvent,
  maybeSummarize,
  parseSummaryEvery,
  sheetHash,
  shouldSummarize,
  summarize,
  wakeContext,
} from "./summarizer.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "memory-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function event(round, kind = "post", from = "Aloof", text = "hello") {
  return makeEvent({ round, kind, from, text });
}

/** Client that records requests and returns a fixed reply. */
function recordingClient(content) {
  const requests = [];
  return {
    requests,
    client: {
      async chat(req) {
        requests.push(req);
        return { content, mode: "mock", model: "mock" };
      },
    },
  };
}

test("parseSummaryEvery defaults when unset and rejects bad values", () => {
  assert.equal(parseSummaryEvery(undefined), 5);
  assert.equal(parseSummaryEvery(""), 5);
  assert.equal(parseSummaryEvery("3"), 3);
  assert.equal(parseSummaryEvery(" 2 "), 2);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.throws(() => parseSummaryEvery(bad), (err) => err instanceof MemoryError && err.code === "bad_config");
  }
});

test("shouldSummarize fires on multiples of N and never on round 0", () => {
  assert.equal(shouldSummarize(0, 5), false);
  assert.equal(shouldSummarize(4, 5), false);
  assert.equal(shouldSummarize(5, 5), true);
  assert.equal(shouldSummarize(10, 5), true);
  assert.equal(shouldSummarize(3, 1), true);
  assert.equal(shouldSummarize(1.5, 1), false);
});

test("makeEvent validates shape and freezes the event", () => {
  const e = event(2, "mention", "Social", "hi");
  assert.ok(Object.isFrozen(e));
  assert.throws(() => makeEvent({ round: -1, kind: "post", from: "a", text: "" }), /round/);
  assert.throws(() => makeEvent({ round: 1, kind: "shout", from: "a", text: "" }), /kind/);
  assert.throws(() => makeEvent({ round: 1, kind: "post", from: "", text: "" }), /from/);
  assert.throws(() => makeEvent({ round: 1, kind: "post", from: "a", text: 3 }), /text/);
});

test("clampWords keeps at most the word limit and normalises whitespace", () => {
  assert.equal(clampWords("  one   two\nthree  "), "one two three");
  const long = Array.from({ length: 450 }, (_, i) => `w${i}`).join(" ");
  const clamped = clampWords(long);
  assert.equal(clamped.split(" ").length, MAX_SHEET_WORDS);
  assert.equal(clamped.split(" ")[0], "w0");
});

test("sheetHash is a stable sha256 hex of the sheet text", () => {
  const hash = sheetHash("I am careful.");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, sheetHash("I am careful."));
  assert.notEqual(hash, sheetHash("I am careful"));
});

test("buildSummaryMessages carries the previous sheet and every new event", () => {
  const messages = buildSummaryMessages({
    name: "Skeptic",
    previous: "I doubt things.",
    events: [event(1, "reply", "Chaotic", "prove it")],
  });
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
  assert.match(messages[0].content, /Skeptic/);
  assert.match(messages[0].content, /200 words/);
  assert.match(messages[1].content, /I doubt things\./);
  assert.match(messages[1].content, /round 1, reply from Chaotic: prove it/);
});

test("buildSummaryMessages marks a first summary and an empty event list", () => {
  const messages = buildSummaryMessages({ name: "Aloof", previous: null, events: [] });
  assert.match(messages[1].content, /\(none yet\)/);
  assert.match(messages[1].content, /\(none\)/);
});

test("summarize sends only events after the previous cursor", async () => {
  const log = [event(1), event(2), event(3), event(4)];
  const { client, requests } = recordingClient("I watched four rounds.");
  const record = await summarize({
    client,
    tokenId: "1",
    name: "Aloof",
    round: 5,
    log,
    previous: { sheet: "Earlier.", throughIndex: 2 },
  });
  const userMessage = requests[0].messages[1].content;
  assert.doesNotMatch(userMessage, /round 1, /);
  assert.doesNotMatch(userMessage, /round 2, /);
  assert.match(userMessage, /round 3, post/);
  assert.match(userMessage, /round 4, post/);
  assert.equal(record.newEvents, 2);
  assert.equal(record.throughIndex, 4);
  assert.equal(record.sheet, "I watched four rounds.");
  assert.equal(record.sheetHash, sheetHash("I watched four rounds."));
  assert.equal(record.tokenId, "1");
  assert.equal(record.round, 5);
});

test("summarize rejects a cursor past the end of the log", async () => {
  const { client } = recordingClient("x");
  await assert.rejects(
    summarize({ client, tokenId: "1", name: "A", round: 1, log: [], previous: { sheet: "s", throughIndex: 3 } }),
    (err) => err instanceof MemoryError && err.code === "bad_state",
  );
});

test("summarize refuses an empty model reply and an unsafe token id", async () => {
  const { client } = recordingClient("   ");
  await assert.rejects(
    summarize({ client, tokenId: "1", name: "A", round: 1, log: [] }),
    (err) => err.code === "empty_sheet",
  );
  await assert.rejects(
    summarize({ client, tokenId: "../etc", name: "A", round: 1, log: [] }),
    (err) => err.code === "bad_token_id",
  );
});

test("summarize with the mock client is deterministic and bounded", async () => {
  const log = [event(1, "post", "Aloof", "Quantum computing is overhyped.")];
  const client = createMockClient();
  const a = await summarize({ client, tokenId: "7", name: "Aloof", round: 5, log });
  const b = await summarize({ client, tokenId: "7", name: "Aloof", round: 5, log });
  assert.equal(a.sheet, b.sheet);
  assert.equal(a.sheetHash, b.sheetHash);
  assert.equal(a.mode, "mock");
  assert.ok(a.sheet.split(" ").length <= MAX_SHEET_WORDS);
});

test("wakeContext returns the sheet and only the last k events", () => {
  const log = [event(1), event(2), event(3), event(4)];
  const ctx = wakeContext({ sheet: "Me.", log, k: 2 });
  assert.equal(ctx.sheet, "Me.");
  assert.deepEqual(ctx.events.map((e) => e.round), [3, 4]);
  assert.deepEqual(wakeContext({ sheet: null, log: [], k: 8 }), { sheet: "", events: [] });
  assert.deepEqual(wakeContext({ sheet: "", log, k: 99 }).events.length, 4);
});

test("store appends events, reads them back, and reports an empty log", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  assert.deepEqual(await store.readLog("1"), []);
  await store.appendEvent("1", { round: 1, kind: "post", from: "Aloof", text: "one" });
  await store.appendEvent("1", { round: 2, kind: "reply", from: "Social", text: "two" });
  const log = await store.readLog("1");
  assert.deepEqual(log.map((e) => e.text), ["one", "two"]);
  assert.deepEqual(await store.readLog("2"), []);
});

test("store rejects a malformed log line instead of skipping it", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  await store.appendEvent("1", { round: 1, kind: "post", from: "Aloof", text: "ok" });
  await writeFile(join(root, "1", "log.jsonl"), "{\"round\":1}\n", { flag: "a" });
  await assert.rejects(store.readLog("1"), (err) => err.code === "bad_log");
});

test("store writes the sheet atomically and reads it back", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  assert.equal(await store.readSheet("1"), null);
  const record = { tokenId: "1", round: 5, sheet: "I am here.", sheetHash: sheetHash("I am here."), throughIndex: 3 };
  await store.writeSheet("1", record);
  assert.deepEqual(await store.readSheet("1"), record);
  const onDisk = JSON.parse(await readFile(join(root, "1", "sheet.json"), "utf8"));
  assert.deepEqual(onDisk, record);
});

test("store refuses token ids that could escape its root", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  for (const bad of ["../x", "a/b", "", "a".repeat(65)]) {
    await assert.rejects(store.readLog(bad), (err) => err.code === "bad_token_id");
  }
});

test("maybeSummarize does nothing off-cycle and writes a sheet on-cycle", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const { client, requests } = recordingClient("I have opinions now.");
  await store.appendEvent("3", { round: 1, kind: "post", from: "Chaotic", text: "hi" });

  assert.equal(await maybeSummarize({ client, store, tokenId: "3", name: "Chaotic", round: 4, every: 5 }), null);
  assert.equal(requests.length, 0);
  assert.equal(await store.readSheet("3"), null);

  const record = await maybeSummarize({ client, store, tokenId: "3", name: "Chaotic", round: 5, every: 5 });
  assert.equal(requests.length, 1);
  assert.equal(record.sheet, "I have opinions now.");
  assert.deepEqual(await store.readSheet("3"), record);
});

test("a second summary only covers events added since the first", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const { client, requests } = recordingClient("Sheet.");
  await store.appendEvent("3", { round: 1, kind: "post", from: "A", text: "first-batch" });
  await maybeSummarize({ client, store, tokenId: "3", name: "A", round: 5, every: 5 });
  await store.appendEvent("3", { round: 6, kind: "post", from: "A", text: "second-batch" });
  await maybeSummarize({ client, store, tokenId: "3", name: "A", round: 10, every: 5 });
  const second = requests[1].messages[1].content;
  assert.match(second, /second-batch/);
  assert.doesNotMatch(second.split("New events")[1], /first-batch/);
  assert.match(second, /Previous sheet:\nSheet\./);
});
