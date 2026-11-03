// Round-boundary behaviour of the summarizer: round 0, round 1, exact
// multiples of the cadence and rounds off it, a cursor already at the end of
// the log, and the config checks on every, k, name and the store root.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hashSheet } from "../anchor/hash.mjs";
import {
  DEFAULT_SUMMARY_EVERY_N_ROUNDS,
  MemoryError,
  createMemoryStore,
  makeEvent,
  maybeSummarize,
  parseSummaryEvery,
  shouldSummarize,
  summarize,
} from "./summarizer.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "memory-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ev = (round, text = `r${round}`) => makeEvent({ round, kind: "post", from: "Aloof", text });

function recording(content = "A sheet.") {
  const requests = [];
  return { requests, client: { async chat(req) { requests.push(req); return { content, mode: "mock", model: "mock" }; } } };
}

test("shouldSummarize: round 0 never, round 1 only when every is 1, exact multiples yes, everything between no", () => {
  for (const every of [1, 2, 3, 5, 7]) {
    assert.equal(shouldSummarize(0, every), false, `round 0 every ${every}`);
    assert.equal(shouldSummarize(1, every), every === 1, `round 1 every ${every}`);
    for (let round = 1; round <= 30; round++) {
      assert.equal(shouldSummarize(round, every), round % every === 0, `round ${round} every ${every}`);
    }
    assert.equal(shouldSummarize(every, every), true);
    assert.equal(shouldSummarize(every * 2, every), true);
    assert.equal(shouldSummarize(every * 2 - 1, every), every === 1);
  }
});

test("shouldSummarize: negative, fractional, huge and non-number rounds never summarize", () => {
  for (const round of [-5, -1, 0.5, 4.999, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
    assert.equal(shouldSummarize(round, 5), false, JSON.stringify(round));
  }
  assert.equal(shouldSummarize(Number.MAX_SAFE_INTEGER, 1), true);
  assert.equal(shouldSummarize(10 ** 12, 10 ** 6), true);
});

test("shouldSummarize refuses a bad cadence even on round 0", () => {
  for (const every of [0, -1, 1.5, "5", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, [5]]) {
    assert.throws(() => shouldSummarize(0, every), (e) => e instanceof MemoryError && e.code === "bad_config", JSON.stringify(every));
    assert.throws(() => shouldSummarize(5, every), (e) => e.code === "bad_config");
  }
});

test("parseSummaryEvery at the edges: whitespace, signs, leading zeros, huge values", () => {
  assert.equal(parseSummaryEvery(" \t "), DEFAULT_SUMMARY_EVERY_N_ROUNDS);
  assert.equal(parseSummaryEvery("1"), 1);
  assert.equal(parseSummaryEvery("9007199254740991"), Number.MAX_SAFE_INTEGER);
  for (const raw of ["+3", "03", "3.0", "3e1", "9007199254740992", "0x3", "3 3", "三", "-0", "Infinity"]) {
    assert.throws(() => parseSummaryEvery(raw), (e) => e instanceof MemoryError && e.code === "bad_config", raw);
  }
});

test("maybeSummarize: round 0 is a no-op with every 1, and a bad cadence throws before any read", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const { client, requests } = recording();
  assert.equal(await maybeSummarize({ client, store, tokenId: "a", name: "A", round: 0, every: 1 }), null);
  assert.equal(requests.length, 0);
  await assert.rejects(maybeSummarize({ client, store, tokenId: "a", name: "A", round: 0, every: 0 }), (e) => e.code === "bad_config");
  await assert.rejects(maybeSummarize({ client, store, tokenId: "../a", name: "A", round: 0, every: 0 }), (e) => e.code === "bad_config", "the cadence is checked first");
  assert.equal(requests.length, 0);
});

test("maybeSummarize: rounds 1..7 every 3 summarize at 3 and 6 only, each covering only the events since the last", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const { client, requests } = recording("Sheet text.");
  const written = [];
  for (let round = 1; round <= 7; round++) {
    await store.appendEvent("a", { round, kind: "post", from: "A", text: `event-${round}` });
    const rec = await maybeSummarize({ client, store, tokenId: "a", name: "A", round, every: 3 });
    if (rec) written.push(rec);
  }
  assert.deepEqual(written.map((r) => r.round), [3, 6]);
  assert.deepEqual(written.map((r) => r.throughIndex), [3, 6]);
  assert.deepEqual(written.map((r) => r.newEvents), [3, 3]);
  assert.equal(requests.length, 2);
  const [first, second] = requests.map((r) => r.messages[1].content);
  assert.match(first, /Previous sheet:\n\(none yet\)/);
  assert.match(first, /event-1[\s\S]*event-3/);
  assert.doesNotMatch(first, /event-4/);
  assert.match(second, /Previous sheet:\nSheet text\./);
  assert.match(second, /event-4[\s\S]*event-6/);
  assert.doesNotMatch(second.split("New events")[1], /event-[123]\b/);
  assert.doesNotMatch(second, /event-7/);
  // After round 7 the sheet on disk is still the round-6 one: nothing is written off-cycle.
  assert.equal((await store.readSheet("a")).round, 6);
  assert.equal((await store.readSheet("a")).sheetHash, hashSheet("Sheet text."));
});

test("maybeSummarize: when every is 1 each round writes a sheet that covers exactly that round's events", async (t) => {
  const store = createMemoryStore(await tempDir(t));
  const { client } = recording();
  const cursors = [];
  for (let round = 1; round <= 4; round++) {
    await store.appendEvent("a", { round, kind: "post", from: "A", text: "x" });
    await store.appendEvent("a", { round, kind: "mention", from: "B", text: "y" });
    const rec = await maybeSummarize({ client, store, tokenId: "a", name: "A", round, every: 1 });
    cursors.push([rec.round, rec.throughIndex, rec.newEvents]);
  }
  assert.deepEqual(cursors, [[1, 2, 2], [2, 4, 2], [3, 6, 2], [4, 8, 2]]);
});

test("summarize: a cursor already at the end of the log sends no events and still rewrites the sheet", async () => {
  const log = [ev(1), ev(2)];
  const { client, requests } = recording("Rewritten.");
  const rec = await summarize({ client, tokenId: "a", name: "A", round: 10, log, previous: { sheet: "Old.", throughIndex: 2 } });
  assert.equal(rec.newEvents, 0);
  assert.equal(rec.throughIndex, 2);
  assert.equal(rec.sheet, "Rewritten.");
  assert.match(requests[0].messages[1].content, /Previous sheet:\nOld\.\n\nNew events since the last sheet:\n\[\]/);
  assert.equal(requests[0].seed, "a:10");
});

test("summarize: the seed changes with the round and the token, so two sheets never share a mock seed", async () => {
  const { client, requests } = recording();
  await summarize({ client, tokenId: "a", name: "A", round: 0, log: [] });
  await summarize({ client, tokenId: "a", name: "A", round: 1, log: [] });
  await summarize({ client, tokenId: "b", name: "A", round: 1, log: [] });
  assert.deepEqual(requests.map((r) => r.seed), ["a:0", "a:1", "b:1"]);
});

test("summarize: a previous sheet with an empty string is shown as (none yet)", async () => {
  const { client, requests } = recording();
  await summarize({ client, tokenId: "a", name: "A", round: 1, log: [ev(1)], previous: { sheet: "", throughIndex: 0 } });
  assert.match(requests[0].messages[1].content, /\(none yet\)/);
});

test("summarize refuses an empty or non-string name before calling the model", async () => {
  const { client, requests } = recording();
  for (const name of ["", 5, null, undefined, ["A"]]) {
    await assert.rejects(summarize({ client, tokenId: "a", name, round: 1, log: [] }), (e) => e instanceof MemoryError && e.code === "bad_request", JSON.stringify(name));
  }
  assert.equal(requests.length, 0);
});

test("summarize: events with round 0 count like any other event", async () => {
  const { client, requests } = recording();
  const rec = await summarize({ client, tokenId: "a", name: "A", round: 1, log: [ev(0, "genesis"), ev(1)] });
  assert.equal(rec.newEvents, 2);
  assert.match(requests[0].messages[1].content, /"round": 0/);
});

test("createMemoryStore refuses an empty or non-string root", () => {
  for (const root of ["", null, undefined, 5, ["x"]]) {
    assert.throws(() => createMemoryStore(root), (e) => e instanceof MemoryError && e.code === "bad_config", JSON.stringify(root));
  }
});

test("an unreadable sheet file is an io_error, not a missing sheet", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  await mkdir(join(root, "a", "sheet.json"), { recursive: true });
  await assert.rejects(store.readSheet("a"), (e) => e instanceof MemoryError && e.code === "io_error" && e.cause?.code === "EISDIR");
});

test("writeSheet replaces an earlier sheet whole and leaves no temp file behind", async (t) => {
  const root = await tempDir(t);
  const store = createMemoryStore(root);
  await store.writeSheet("a", { tokenId: "a", round: 3, sheet: "First.", sheetHash: hashSheet("First."), throughIndex: 1, extra: "gone later" });
  await store.writeSheet("a", { tokenId: "a", round: 6, sheet: "Second.", sheetHash: hashSheet("Second."), throughIndex: 2 });
  const back = await store.readSheet("a");
  assert.deepEqual(back, { tokenId: "a", round: 6, sheet: "Second.", sheetHash: hashSheet("Second."), throughIndex: 2 });
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(root, "a")), ["sheet.json"]);
});
