import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { MemoryError, createMemoryStore, maybeSummarize, summarize } from "./summarizer.mjs";

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "summ63-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("store.sheetFile returns the sheet.json path under the token directory", async (t) => {
  const root = await tempRoot(t);
  assert.equal(createMemoryStore(root).sheetFile("aloof"), join(root, "aloof", "sheet.json"));
});

test("a malformed sheet.json is bad_sheet and the message names the file", async (t) => {
  const root = await tempRoot(t);
  const store = createMemoryStore(root);
  const file = join(root, "aloof", "sheet.json");
  await mkdir(join(root, "aloof"));
  await writeFile(file, "{not json");
  await assert.rejects(store.readSheet("aloof"), (err) => {
    assert.ok(err instanceof MemoryError);
    assert.equal(err.code, "bad_sheet");
    assert.ok(err.message.includes(file), err.message);
    return true;
  });
});

test("an unreadable sheet.json (a directory) is io_error and the message names the file", async (t) => {
  const root = await tempRoot(t);
  const store = createMemoryStore(root);
  const file = join(root, "aloof", "sheet.json");
  await mkdir(file, { recursive: true });
  await assert.rejects(store.readSheet("aloof"), (err) => {
    assert.ok(err instanceof MemoryError);
    assert.equal(err.code, "io_error");
    assert.ok(err.message.includes(file), err.message);
    return true;
  });
});

test("maybeSummarize with a throughIndex past the log is bad_state naming the file, and leaves sheet.json untouched", async (t) => {
  const root = await tempRoot(t);
  const store = createMemoryStore(root);
  const file = store.sheetFile("aloof");
  await store.appendEvent("aloof", { round: 1, kind: "post", from: "Aloof", text: "one" });
  const body = JSON.stringify({ tokenId: "aloof", round: 1, sheet: "x", sheetHash: "y", throughIndex: 99 });
  await writeFile(file, body);
  await assert.rejects(
    maybeSummarize({ client: createMockClient(), store, tokenId: "aloof", name: "Aloof", round: 5, every: 5 }),
    (err) => {
      assert.ok(err instanceof MemoryError);
      assert.equal(err.code, "bad_state");
      assert.ok(err.message.includes(file), err.message);
      return true;
    },
  );
  assert.equal(await readFile(file, "utf8"), body);
});

test("summarize called directly without sheetFile keeps the plain message", async () => {
  await assert.rejects(
    summarize({
      client: createMockClient(),
      tokenId: "7",
      name: "Aloof",
      round: 5,
      log: [],
      previous: { sheet: "x", throughIndex: 3 },
    }),
    (err) => {
      assert.equal(err.code, "bad_state");
      assert.equal(err.message, "previous.throughIndex is outside the log");
      return true;
    },
  );
});
