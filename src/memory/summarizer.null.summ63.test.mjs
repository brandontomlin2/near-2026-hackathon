import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMockClient } from "../inference/client.mjs";
import { MemoryError, createMemoryStore, maybeSummarize } from "./summarizer.mjs";

const ASK = fileURLToPath(new URL("../../scripts/ask.mjs", import.meta.url));

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "summ63-null-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const CASES = [
  ["null", "null", "null"],
  ["null with newline", "null\n", "null"],
  ["an empty array", "[]", "array"],
  ["a number", "42", "number"],
  ["a string", '"text"', "string"],
  ["a boolean", "true", "boolean"],
];

for (const [label, body, kind] of CASES) {
  test(`readSheet rejects a sheet.json holding ${label} as bad_sheet naming the file`, async (t) => {
    const root = await tempRoot(t);
    const store = createMemoryStore(root);
    const file = store.sheetFile("aloof");
    await mkdir(join(root, "aloof"));
    await writeFile(file, body);
    await assert.rejects(store.readSheet("aloof"), (err) => {
      assert.ok(err instanceof MemoryError);
      assert.equal(err.code, "bad_sheet");
      assert.ok(err.message.includes(file), err.message);
      assert.ok(err.message.includes(`(got ${kind})`), err.message);
      return true;
    });
  });
}

test("maybeSummarize with a null sheet.json is bad_sheet and does not overwrite the file", async (t) => {
  const root = await tempRoot(t);
  const store = createMemoryStore(root);
  const file = store.sheetFile("aloof");
  await store.appendEvent("aloof", { round: 1, kind: "post", from: "Aloof", text: "one" });
  await writeFile(file, "null\n");
  await assert.rejects(
    maybeSummarize({ client: createMockClient(), store, tokenId: "aloof", name: "Aloof", round: 5, every: 5 }),
    (err) => {
      assert.ok(err instanceof MemoryError);
      assert.equal(err.code, "bad_sheet");
      return true;
    },
  );
  assert.equal(await readFile(file, "utf8"), "null\n");
  assert.equal(existsSync(`${file}.tmp`), false);
});

test("a missing sheet.json still reads as null", async (t) => {
  const root = await tempRoot(t);
  assert.equal(await createMemoryStore(root).readSheet("aloof"), null);
});

test("ask CLI with a null sheet.json exits 1 with a one-line bad_sheet error, not 'no character sheet'", async (t) => {
  const out = await tempRoot(t);
  const dir = join(out, "memory", "chaotic");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "log.jsonl"), "");
  const file = join(dir, "sheet.json");
  await writeFile(file, "null");
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  for (const k of ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_BASE_URL"]) delete env[k];
  const r = spawnSync(process.execPath, [ASK, "--out", out, "chaotic", "hi"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes("memory error (bad_sheet)"), r.stderr);
  assert.ok(r.stderr.includes(file), r.stderr);
  assert.ok(!r.stderr.includes("no character sheet"), r.stderr);
  assert.ok(!/\n\s+at |node:internal/.test(r.stderr), r.stderr);
});
