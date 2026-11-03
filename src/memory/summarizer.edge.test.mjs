// Edge cases for the memory summarizer: empty and huge logs, malformed lines,
// unicode, missing files. Behavior tests only.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashSheet } from "../anchor/hash.mjs";
import { createMockClient } from "../inference/client.mjs";
import {
  MAX_EVENT_TEXT_CHARS,
  MAX_SHEET_WORDS,
  buildSummaryMessages,
  clampWords,
  createMemoryStore,
  makeEvent,
  maybeSummarize,
  summarize,
  wakeContext,
} from "./summarizer.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "memory-edge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ev = (round, text = "hello") => makeEvent({ round, kind: "post", from: "Aloof", text });
const fixed = (content) => ({ chat: async () => ({ content, mode: "mock", model: "mock" }) });

async function writeLog(root, id, raw) {
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, "log.jsonl"), raw, "utf8");
}

test("summarize on an empty log still produces a sheet and covers zero events", async () => {
  const rec = await summarize({ client: createMockClient(), tokenId: "1", name: "Aloof", round: 5, log: [] });
  assert.equal(rec.newEvents, 0);
  assert.equal(rec.throughIndex, 0);
  assert.ok(rec.sheet.length > 0);
});

test("summarize with a huge log and a runaway reply stays bounded", async () => {
  const log = Array.from({ length: 5000 }, (_, i) => ev(i, "x".repeat(2000)));
  const reply = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ");
  const rec = await summarize({ client: fixed(reply), tokenId: "1", name: "Aloof", round: 5, log });
  assert.equal(rec.sheet.split(" ").length, MAX_SHEET_WORDS);
  assert.equal(rec.throughIndex, 5000);
  assert.equal(rec.newEvents, 5000);
  assert.equal(rec.sheetHash, hashSheet(rec.sheet));
});

test("each quoted event is capped, so a huge event cannot blow up the prompt", () => {
  const [, user] = buildSummaryMessages({
    name: "Aloof",
    previous: null,
    events: [ev(1, "y".repeat(1_000_000))],
  });
  assert.ok(user.content.length < 2000);
});

test("event truncation never leaves half of a surrogate pair", () => {
  const text = "a".repeat(MAX_EVENT_TEXT_CHARS - 1) + "😀😀";
  const [, user] = buildSummaryMessages({ name: "Aloof", previous: null, events: [ev(1, text)] });
  // JSON.stringify escapes a lone surrogate as a literal \udXXX sequence.
  assert.doesNotMatch(user.content, /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
});

test("unicode text round-trips through the log and the sheet hash", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const text = "héllo 世界 🌍 ‮ RTL \u0000 nul \n newline";
  await store.appendEvent("1", { round: 1, kind: "post", from: "Aloof", text });
  const [back] = await store.readLog("1");
  assert.equal(back.text, text);
  assert.equal(hashSheet("世界"), hashSheet("世界"));
  // NFC and NFD spellings of the same text hash alike (see hashSheet).
  assert.equal(hashSheet("\u00e9"), hashSheet("e\u0301"));
});

test("clampWords handles empty input, unicode and other whitespace", () => {
  assert.equal(clampWords(""), "");
  assert.equal(clampWords("  \n\t "), "");
  assert.equal(clampWords("世界 你好　 ok"), "世界 你好 ok");
});

test("summarize refuses a reply that is only whitespace", async () => {
  await assert.rejects(
    summarize({ client: fixed(" \n\t "), tokenId: "1", name: "A", round: 5, log: [] }),
    (e) => e.code === "empty_sheet",
  );
});

test("summarize rejects a negative or fractional cursor", async () => {
  for (const throughIndex of [-1, 0.5, undefined]) {
    await assert.rejects(
      summarize({ client: fixed("ok"), tokenId: "1", name: "A", round: 5, log: [], previous: { sheet: "s", throughIndex } }),
      (e) => e.code === "bad_state",
    );
  }
});

test("makeEvent rejects bad shapes with a coded error", () => {
  for (const bad of [
    { round: -1, kind: "post", from: "a", text: "t" },
    { round: 1.5, kind: "post", from: "a", text: "t" },
    { round: 1, kind: "shout", from: "a", text: "t" },
    { round: 1, kind: "post", from: "", text: "t" },
    { round: 1, kind: "post", from: "a", text: 5 },
  ]) {
    assert.throws(() => makeEvent(bad), (e) => e.code === "bad_event");
  }
});

test("a token with no files reads as an empty log, no sheet, and an empty wake context", async (t) => {
  const store = createMemoryStore(join(await tempDir(t), "does", "not", "exist"));
  assert.deepEqual(await store.readLog("7"), []);
  assert.equal(await store.readSheet("7"), null);
  assert.deepEqual(wakeContext({ sheet: await store.readSheet("7"), log: await store.readLog("7") }), { sheet: "", events: [] });
});

test("maybeSummarize on a token with no files writes a first sheet", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const rec = await maybeSummarize({ client: createMockClient(), store, tokenId: "9", name: "Aloof", round: 5, every: 5 });
  assert.equal(rec.newEvents, 0);
  assert.deepEqual(await store.readSheet("9"), rec);
});

test("malformed log lines fail with the line number and a coded error", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  const good = JSON.stringify(ev(1));
  const cases = {
    "not json": `${good}\nnot json\n`,
    "truncated tail (crash mid-append)": `${good}\n{"round":2,"kind":"po`,
    "json null": `${good}\nnull\n`,
    "json array": `${good}\n[1,2]\n`,
    "json string": `${good}\n"hi"\n`,
    "wrong kind": `${good}\n{"round":2,"kind":"x","from":"a","text":"t"}\n`,
    "whitespace-only line": `${good}\n   \n`,
  };
  for (const [label, raw] of Object.entries(cases)) {
    await writeLog(root, "1", raw);
    await assert.rejects(store.readLog("1"), (e) => e.name === "MemoryError" && e.code === "bad_log" && /line 2/.test(e.message), label);
  }
});

test("log reading tolerates CRLF, blank lines and a missing final newline", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  await writeLog(root, "1", `${JSON.stringify(ev(1, "a"))}\r\n\n${JSON.stringify(ev(2, "b"))}`);
  assert.deepEqual((await store.readLog("1")).map((e) => e.text), ["a", "b"]);
});

test("a malformed sheet file is a coded MemoryError, not a bare SyntaxError", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  await mkdir(join(root, "1"), { recursive: true });
  await writeFile(join(root, "1", "sheet.json"), "{ half a record", "utf8");
  await assert.rejects(store.readSheet("1"), (e) => e.name === "MemoryError" && e.code === "bad_sheet");
});

test("an unreadable log is an io_error, not an empty log", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  // A directory where the log file should be: readFile fails with EISDIR.
  await mkdir(join(root, "1", "log.jsonl"), { recursive: true });
  await assert.rejects(store.readLog("1"), (e) => e.code === "io_error");
});

test("appends from many writers keep every line whole", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  await Promise.all(Array.from({ length: 200 }, (_, i) => store.appendEvent("1", { round: i, kind: "post", from: "A", text: `m${i} 🌍` })));
  const log = await store.readLog("1");
  assert.equal(log.length, 200);
  assert.equal(new Set(log.map((e) => e.text)).size, 200);
});

test("wakeContext never returns more than k events, even for a huge log", () => {
  const log = Array.from({ length: 100_000 }, (_, i) => ev(i));
  const ctx = wakeContext({ sheet: "s", log, k: 3 });
  assert.deepEqual(ctx.events.map((e) => e.round), [99_997, 99_998, 99_999]);
});
