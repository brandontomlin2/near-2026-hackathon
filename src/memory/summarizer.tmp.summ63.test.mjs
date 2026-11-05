import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { askAgent } from "../owner/ask.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { sheetResponder } from "./sheet-responder.mjs";
import { createMemoryStore, summarize } from "./summarizer.mjs";

const chaotic = AGENTS.find((a) => a.id === "chaotic");
const sheetClient = () => createMockClient({ responder: sheetResponder });
const exists = (p) => access(p).then(() => true, () => false);

async function tempStore(t) {
  const root = await mkdtemp(join(tmpdir(), "summ63-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createMemoryStore(root);
}

/** A real record: appended events and a real summarize() call. Not yet written. */
async function realRecord(store, tokenId = "chaotic") {
  await store.appendEvent(tokenId, { round: 1, kind: "post", from: "Chaotic", text: "the treasury is on fire" });
  await store.appendEvent(tokenId, { round: 2, kind: "mention", from: "Skeptic", text: "no it is not" });
  const log = await store.readLog(tokenId);
  return summarize({ client: sheetClient(), tokenId, name: "Chaotic", round: 5, log, previous: null, sheetFile: store.sheetFile(tokenId) });
}

/** Make sheet.json a non-empty directory so no platform's rename can replace it. */
async function blockSheet(store, tokenId = "chaotic") {
  const file = store.sheetFile(tokenId);
  await rm(file, { force: true, recursive: true });
  await mkdir(file, { recursive: true });
  await writeFile(join(file, "inner.txt"), "keep me");
  return file;
}

test("writeSheet then readSheet round-trips and leaves no sheet.json.tmp", async (t) => {
  const store = await tempStore(t);
  const record = await realRecord(store);
  await store.writeSheet("chaotic", record);
  assert.deepEqual(await store.readSheet("chaotic"), record);
  assert.equal(await exists(`${store.sheetFile("chaotic")}.tmp`), false);
});

test("a failed rename removes sheet.json.tmp and leaves the blocking directory untouched", async (t) => {
  const store = await tempStore(t);
  const record = await realRecord(store);
  const file = await blockSheet(store);
  const dir = join(file, "..");
  const before = (await readdir(dir)).sort();

  await assert.rejects(store.writeSheet("chaotic", record), (err) => {
    assert.ok(["EISDIR", "ENOTEMPTY", "EEXIST", "EPERM"].includes(err.code), String(err.code));
    return true;
  });

  assert.equal(await exists(`${file}.tmp`), false);
  assert.deepEqual((await readdir(dir)).sort(), before);
  assert.equal(await readFile(join(file, "inner.txt"), "utf8"), "keep me");
});

test("askAgent with a sheet write that fails leaves no sheet.json.tmp and rolls the log back", async (t) => {
  const store = await tempStore(t);
  const record = await realRecord(store);
  await store.writeSheet("chaotic", record);
  const file = store.sheetFile("chaotic");
  const logFile = join(file, "..", "log.jsonl");
  const logBefore = await readFile(logFile, "utf8");

  const broken = {
    ...store,
    writeSheet: async (id, rec) => {
      await rm(file);
      await mkdir(join(file, "x"), { recursive: true });
      return store.writeSheet(id, rec);
    },
  };

  await assert.rejects(
    askAgent({ agent: chaotic, question: "what about Skeptic?", store: broken, answerClient: createMockClient(), sheetClient: sheetClient() }),
    (err) => ["EISDIR", "ENOTEMPTY", "EEXIST", "EPERM"].includes(err.code),
  );

  assert.equal(await exists(`${file}.tmp`), false);
  assert.equal(await readFile(logFile, "utf8"), logBefore);
});
