// Gap tests for `npm run ask` in LIVE mode (MOCK_INFERENCE=0). Every other ask test is mock-only.
// The live path is the one a judge with a key would run: one client answers and writes the sheet,
// the output ends with the "NEAR AI Cloud" line, and a failing model must leave memory untouched.
// A local loopback stub plays NEAR AI Cloud; nothing leaves the machine and no real key is used.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { hashSheet } from "../anchor/hash.mjs";
import { createMemoryStore, makeEvent } from "../memory/summarizer.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/ask.mjs", import.meta.url));
const KEY = "stub-key-gaps17-not-real";
const PRIOR_SHEET = "I am Chaotic, a villain. Skeptic is my enemy. I have no friends.";
const NEW_SHEET = "I am Chaotic, a villain. Skeptic is still my enemy. The Owner asked me things.";
const ANSWER = "Skeptic owes me a rematch, owner.";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A memory dir with one sheet and a two-event log for chaotic, written through the real store. */
async function seed() {
  const out = mkdtempSync(join(tmpdir(), "ask-gaps17-"));
  dirs.push(out);
  const store = createMemoryStore(join(out, "memory"));
  await store.appendEvent("chaotic", makeEvent({ round: 1, kind: "post", from: "Chaotic", text: "gm" }));
  await store.appendEvent("chaotic", makeEvent({ round: 2, kind: "mention", from: "Skeptic", text: "show the hash" }));
  await store.writeSheet("chaotic", {
    tokenId: "chaotic", round: 2, sheet: PRIOR_SHEET, sheetHash: hashSheet(PRIOR_SHEET), throughIndex: 2, newEvents: 2, mode: "mock", model: "m",
  });
  return out;
}

/** Stub chat endpoint. `handler(kind, body)` returns [status, content]; kind is "sheet" or "answer". */
async function withStub(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const kind = system.includes("Character sheet:\n") ? "answer" : "sheet";
      seen.push({ kind, body, auth: req.headers.authorization });
      const [status, content] = handler(kind, body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { id: "c1", model: "stub-model", choices: [{ message: { content } }] } : { error: "nope" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, seen);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function runLive(args, baseUrl) {
  const env = { ...process.env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "stub-model", NEAR_AI_BASE_URL: baseUrl };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const read = (out, ...p) => readFileSync(join(out, "memory", "chaotic", ...p), "utf8");

test("live ask: one model answers and rewrites the sheet; output, log and sheet.json say so", async () => {
  const out = await seed();
  await withStub((kind) => [200, kind === "answer" ? ANSWER : NEW_SHEET], async (baseUrl, seen) => {
    const r = await runLive(["--out", out, "chaotic", "what", "about", "Skeptic?"], baseUrl);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "mode: live model: stub-model\n");

    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines[0], `Chaotic (live): ${ANSWER}`);
    assert.equal(lines.at(-1), "Nothing was signed or sent; the answer and the sheet come from stub-model on NEAR AI Cloud, the anchor is a dry run.");
    assert.doesNotMatch(r.stdout, /mocked|stand-ins/);
    // A free-text live sheet has no labels, so the diff is per sentence, and the anchor line carries the new hash.
    assert.ok(lines.includes("  - Skeptic is my enemy."), r.stdout);
    assert.ok(lines.includes("  + Skeptic is still my enemy."), r.stdout);
    assert.ok(lines.includes("  + The Owner asked me things."), r.stdout);
    assert.equal(lines.at(-2), `sheet chaotic round 3 ${hashSheet(NEW_SHEET)} (+${lines.filter((l) => l.startsWith("  + ")).length} -${lines.filter((l) => l.startsWith("  - ")).length}) -> anchor_sheet dry-run (not sent)`);

    const sheet = JSON.parse(read(out, "sheet.json"));
    assert.equal(sheet.sheet, NEW_SHEET);
    assert.equal(sheet.sheetHash, hashSheet(NEW_SHEET));
    assert.equal(sheet.round, 3);
    assert.equal(sheet.mode, "live");
    const log = read(out, "log.jsonl").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.slice(-2).map((e) => [e.kind, e.from, e.round, e.text]), [
      ["mention", "Owner", 3, "what about Skeptic?"],
      ["reply", "Chaotic", 3, ANSWER],
    ]);

    // Wiring: the answer request carries the prior sheet and the question; the sheet request carries both new events.
    assert.deepEqual(seen.map((s) => s.kind), ["answer", "sheet"]);
    assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
    assert.ok(seen[0].body.messages.find((m) => m.role === "system").content.endsWith(`Character sheet:\n${PRIOR_SHEET}`));
    assert.equal(seen[0].body.messages.findLast((m) => m.role === "user").content, "what about Skeptic?");
    const sheetPrompt = seen[1].body.messages.map((m) => m.content).join("\n");
    assert.ok(sheetPrompt.includes(PRIOR_SHEET) && sheetPrompt.includes("what about Skeptic?") && sheetPrompt.includes(ANSWER));
    assert.ok(!sheetPrompt.includes("show the hash"), "events already in the previous sheet are not sent again");
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  });
});

test("live ask: the model failing while writing the sheet exits 1 with a coded line and leaves log and sheet untouched", async () => {
  const out = await seed();
  const before = { log: read(out, "log.jsonl"), sheet: read(out, "sheet.json") };
  await withStub((kind) => (kind === "answer" ? [200, ANSWER] : [400, ""]), async (baseUrl, seen) => {
    const r = await runLive(["--out", out, "chaotic", "hello?"], baseUrl);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^ask: inference error \(http_error\): .*\n?$/m);
    assert.doesNotMatch(r.stderr, /\n\s+at |node:internal/);
    assert.ok(!r.stderr.includes(KEY));
    assert.deepEqual(seen.map((s) => s.kind), ["answer", "sheet"], "the answer was fetched, then the sheet call failed");
  });
  assert.equal(read(out, "log.jsonl"), before.log);
  assert.equal(read(out, "sheet.json"), before.sheet);
});

test("live ask: a model that answers with only whitespace is a bad_response error and writes nothing", async () => {
  const out = await seed();
  const before = { log: read(out, "log.jsonl"), sheet: read(out, "sheet.json") };
  await withStub(() => [200, "  \n "], async (baseUrl, seen) => {
    const r = await runLive(["--out", out, "chaotic", "hello?"], baseUrl);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^ask: inference error \(bad_response\): .*no non-empty choices\[0\]\.message\.content$/m);
    assert.equal(seen.length, 1, "no sheet request is made for an empty answer");
  });
  assert.equal(read(out, "log.jsonl"), before.log);
  assert.equal(read(out, "sheet.json"), before.sheet);
});
