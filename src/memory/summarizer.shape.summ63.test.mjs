import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { AskError, askAgent } from "../owner/ask.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { sheetResponder } from "./sheet-responder.mjs";
import { MemoryError, createMemoryStore, maybeSummarize, summarize } from "./summarizer.mjs";

const chaotic = AGENTS.find((a) => a.id === "chaotic");
const sheetClient = () => createMockClient({ responder: sheetResponder });

async function tempStore(t) {
  const root = await mkdtemp(join(tmpdir(), "summ63-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createMemoryStore(root);
}

/** A real record: appended events, a real summarize() call, written by the real store. */
async function seedRealSheet(store, tokenId = "chaotic") {
  await store.appendEvent(tokenId, { round: 1, kind: "post", from: "Chaotic", text: "the treasury is on fire" });
  await store.appendEvent(tokenId, { round: 2, kind: "mention", from: "Skeptic", text: "no it is not" });
  const log = await store.readLog(tokenId);
  const record = await summarize({ client: sheetClient(), tokenId, name: "Chaotic", round: 5, log, previous: null, sheetFile: store.sheetFile(tokenId) });
  await store.writeSheet(tokenId, record);
  return record;
}

async function corrupt(store, tokenId, patch) {
  const real = JSON.parse(await readFile(store.sheetFile(tokenId), "utf8"));
  const next = { ...real, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
  const body = JSON.stringify(next);
  await writeFile(store.sheetFile(tokenId), body);
  return body;
}

const BAD = [
  ["tokenId", undefined],
  ["tokenId", "skeptic"],
  ["tokenId", 7],
  ["round", -1],
  ["round", 1.5],
  ["round", "7"],
  ["round", Number.MAX_SAFE_INTEGER + 2],
  ["round", undefined],
  ["sheet", ""],
  ["sheet", 5],
  ["sheet", undefined],
  ["sheetHash", "y"],
  ["sheetHash", "A".repeat(64)],
  ["sheetHash", "a".repeat(63)],
  ["sheetHash", undefined],
  ["throughIndex", -1],
  ["throughIndex", "3"],
  ["throughIndex", 2.5],
  ["throughIndex", undefined],
];

test("a record produced by summarize() and written by the store reads back unchanged", async (t) => {
  const store = await tempStore(t);
  const record = await seedRealSheet(store);
  assert.deepEqual(await store.readSheet("chaotic"), record);
});

for (const [field, value] of BAD) {
  const label = value === undefined ? "missing" : JSON.stringify(value);
  test(`readSheet rejects ${field} ${label} as bad_sheet naming the file and the field`, async (t) => {
    const store = await tempStore(t);
    await seedRealSheet(store);
    await corrupt(store, "chaotic", { [field]: value });
    await assert.rejects(store.readSheet("chaotic"), (err) => {
      assert.ok(err instanceof MemoryError);
      assert.equal(err.code, "bad_sheet");
      assert.ok(err.message.includes(store.sheetFile("chaotic")), err.message);
      assert.ok(err.message.includes(`bad ${field}`), err.message);
      return true;
    });
  });
}

test("a sheet copied into another token's directory is bad_sheet", async (t) => {
  const store = await tempStore(t);
  await seedRealSheet(store);
  const copy = await readFile(store.sheetFile("chaotic"), "utf8");
  await store.writeSheet("skeptic", JSON.parse(copy));
  await assert.rejects(store.readSheet("skeptic"), (err) => err.code === "bad_sheet" && err.message.includes("bad tokenId"));
});

test("maybeSummarize on a record with sheet: 5 rejects and leaves sheet.json bytes unchanged", async (t) => {
  const store = await tempStore(t);
  await seedRealSheet(store);
  const body = await corrupt(store, "chaotic", { sheet: 5 });
  await assert.rejects(
    maybeSummarize({ client: sheetClient(), store, tokenId: "chaotic", name: "Chaotic", round: 10, every: 5 }),
    (err) => err instanceof MemoryError && err.code === "bad_sheet" && err.message.includes("bad sheet"),
  );
  assert.equal(await readFile(store.sheetFile("chaotic"), "utf8"), body);
});

test("askAgent on a record with round: \"7\" rejects bad_sheet and leaves log and sheet unchanged", async (t) => {
  const store = await tempStore(t);
  await seedRealSheet(store);
  const body = await corrupt(store, "chaotic", { round: "7" });
  const logBefore = await readFile(join(store.sheetFile("chaotic"), "..", "log.jsonl"), "utf8");
  await assert.rejects(
    askAgent({ agent: chaotic, question: "what about Skeptic?", store, answerClient: createMockClient(), sheetClient: sheetClient() }),
    (err) => err instanceof MemoryError && !(err instanceof AskError) && err.code === "bad_sheet" && err.message.includes("bad round"),
  );
  assert.equal(await readFile(store.sheetFile("chaotic"), "utf8"), body);
  assert.equal(await readFile(join(store.sheetFile("chaotic"), "..", "log.jsonl"), "utf8"), logBefore);
});
