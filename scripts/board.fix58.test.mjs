// Regression test: an unreadable board/board.json (a directory, or chmod 000)
// must produce a clean one-line error and a nonzero exit, never a raw stack.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "board.mjs");

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-fix58-"));
  t.after(() => {
    const file = path.join(dir, "board", "board.json");
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // not a file or already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, "board"));
  return dir;
}

function expectCleanFailure(cwd) {
  const r = spawnSync(process.execPath, [CLI, "list"], { cwd, encoding: "utf8" });
  assert.notEqual(r.status, 0, `expected nonzero exit; stdout=${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^error: .*board\/board\.json.*\n$/);
  assert.equal(r.stderr.trimEnd().split("\n").length, 1, `stderr must be one line:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
}

test("board.json that is a directory fails cleanly", (t) => {
  const cwd = tempRepo(t);
  fs.mkdirSync(path.join(cwd, "board", "board.json"));
  expectCleanFailure(cwd);
});

test("board.json with mode 000 fails cleanly", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores file modes");
    return;
  }
  const cwd = tempRepo(t);
  const file = path.join(cwd, "board", "board.json");
  fs.writeFileSync(file, "[]\n");
  fs.chmodSync(file, 0o000);
  expectCleanFailure(cwd);
});
