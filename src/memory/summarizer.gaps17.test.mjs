// Behaviour gaps in the memory store and summarizer that npm run demo / ask depend on.

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryError, createMemoryStore, makeEvent, summarize } from "./summarizer.mjs";

const client = (content) => ({ async chat() { return { content, mode: "mock", model: "mock" }; } });

test("summarize accepts a previous sheet that covers none of the log yet (throughIndex 0) and reads the whole log", async () => {
  const log = [makeEvent({ round: 1, kind: "post", from: "Aloof", text: "one" }), makeEvent({ round: 2, kind: "post", from: "Aloof", text: "two" })];
  const record = await summarize({
    client: client("I am Aloof."),
    tokenId: "aloof",
    name: "Aloof",
    round: 3,
    log,
    previous: { sheet: "old sheet", throughIndex: 0 },
  });
  assert.equal(record.newEvents, 2);
  assert.equal(record.throughIndex, 2);
  assert.equal(record.sheet, "I am Aloof.");
});

test("summarize refuses a previous sheet that claims more events than the log holds, with a bad_state error", async () => {
  await assert.rejects(
    summarize({ client: client("x"), tokenId: "aloof", name: "Aloof", round: 3, log: [], previous: { sheet: "s", throughIndex: 1 } }),
    (err) => err instanceof MemoryError && err.code === "bad_state",
  );
});

test("createMemoryStore refuses an empty root up front with a bad_config error", () => {
  assert.throws(() => createMemoryStore(""), (err) => err instanceof MemoryError && err.code === "bad_config" && /non-empty path/.test(err.message));
});
