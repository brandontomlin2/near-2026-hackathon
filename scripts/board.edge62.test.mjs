// Edge tests for `board.mjs log` when board/events.jsonl cannot be read:
// a directory in its place or a file without read permission must give one
// clean `error:` line and exit 1, not a Node stack trace. Each case spawns
// the real script in a fresh temp dir; the real board/ is never touched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "board.mjs");

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-edge62-"));
  t.after(() => {
    const events = path.join(dir, "board", "events.jsonl");
    try {
      fs.chmodSync(events, 0o644);
    } catch {
      // already gone or a directory; rmSync handles both
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, "board"), { recursive: true });
  return dir;
}

function run(cwd, args) {
  const env = { ...process.env };
  delete env.BOARD_ACTOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 20000 });
}

function assertOneCleanLine(res, pattern) {
  assert.equal(res.status, 1, `stderr: ${res.stderr}`);
  assert.equal(res.stdout, "");
  const lines = res.stderr.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 1, `expected one stderr line, got:\n${res.stderr}`);
  assert.match(lines[0], /^error: /);
  assert.match(lines[0], /events\.jsonl/);
  assert.match(lines[0], pattern);
}

test("log: events.jsonl that is a directory gives one clean error line and exit 1", (t) => {
  const cwd = tempRepo(t);
  fs.mkdirSync(path.join(cwd, "board", "events.jsonl"));
  assertOneCleanLine(run(cwd, ["log"]), /EISDIR/);
});

test("log --since: events.jsonl that is a directory also fails cleanly", (t) => {
  const cwd = tempRepo(t);
  fs.mkdirSync(path.join(cwd, "board", "events.jsonl"));
  assertOneCleanLine(run(cwd, ["log", "--since", "2026-01-01T00:00:00Z"]), /EISDIR/);
});

test(
  "log: unreadable events.jsonl gives one clean error line and exit 1",
  { skip: process.getuid?.() === 0 ? "root can read mode-000 files" : false },
  (t) => {
    const cwd = tempRepo(t);
    const events = path.join(cwd, "board", "events.jsonl");
    fs.writeFileSync(events, `${JSON.stringify({ ts: "2026-11-01T00:00:00Z", action: "claim" })}\n`);
    fs.chmodSync(events, 0o000);
    assertOneCleanLine(run(cwd, ["log"]), /EACCES/);
  },
);

test("log: readable events.jsonl still prints its lines (fix does not change the happy path)", (t) => {
  const cwd = tempRepo(t);
  const line = JSON.stringify({ ts: "2026-11-01T00:00:00Z", action: "claim", item_id: "x" });
  fs.writeFileSync(path.join(cwd, "board", "events.jsonl"), `${line}\n\n`);
  const res = run(cwd, ["log"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${line}\n`);
});
