// claude-loop.sh gates: STOP file, timeout binary, credentials, spend cap, parallel cap.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  claudeRuns,
  liveLock,
  lockDir,
  lockNames,
  readStatus,
  runLoop,
  tempHome,
  writeClaudeStub,
} from "./test-helpers/claude-loop.mjs";

test("STOP file exits quietly without calling claude", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const stubLog = path.join(root, "claude.log");
  fs.mkdirSync(path.join(home, ".claude-loop"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-loop", "STOP"), "");
  writeClaudeStub(path.join(root, "claude"));
  const result = runLoop(root, home, {
    CLAUDE_BIN: path.join(root, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: "success",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(readStatus(home).last_result, "stopped");
  assert.equal(fs.existsSync(stubLog), false);
});

test("missing timeout tells the operator to install coreutils", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync("/bin/mkdir", path.join(bin, "mkdir"));
  const result = runLoop(root, home, { PATH: bin });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /brew install coreutils/);
});

test("refuses when both Claude credentials are set", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const stubLog = path.join(root, "claude.log");
  writeClaudeStub(path.join(root, "claude"));
  const result = runLoop(root, home, {
    CLAUDE_BIN: path.join(root, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: "success",
    ANTHROPIC_API_KEY: "one-key",
    CLAUDE_CODE_OAUTH_TOKEN: "other-token",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ANTHROPIC_API_KEY/);
  assert.match(result.stderr, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(fs.existsSync(stubLog), false);
  assert.equal(readStatus(home).last_result, "auth_conflict");
});

test("logged-out auth status refuses to run", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const stubLog = path.join(root, "claude.log");
  writeClaudeStub(path.join(root, "claude"));
  const result = runLoop(root, home, {
    CLAUDE_BIN: path.join(root, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: "logged-out",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loggedIn true/);
  assert.equal(claudeRuns(stubLog), 0);
  assert.equal(readStatus(home).last_result, "logged_out");
});

test("daily spend cap refuses at the default of 25", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const stubLog = path.join(root, "claude.log");
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(home, ".claude-loop");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `spend-${day}.jsonl`),
    '{"total_cost_usd":20}\n{"total_cost_usd":5}\n{"total_cost_usd":"nope"}\n',
  );
  writeClaudeStub(path.join(root, "claude"));
  const result = runLoop(root, home, {
    CLAUDE_BIN: path.join(root, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: "success",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CLAUDE_LOOP_DAILY_USD/);
  const status = readStatus(home);
  assert.equal(status.last_result, "capped");
  assert.ok(status.spend_today >= 25);
  assert.equal(claudeRuns(stubLog), 0);
  assert.match(fs.readFileSync(stubLog, "utf8"), /auth status/);
});

test("at the parallel cap the loop exits 0 quietly without calling claude", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  const stubLog = path.join(root, "claude.log");
  liveLock(home, "busy-item");
  writeClaudeStub(path.join(root, "claude"));
  const result = runLoop(root, home, {
    CLAUDE_BIN: path.join(root, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: "success",
    CLAUDE_LOOP_MAX_PARALLEL: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(fs.existsSync(stubLog), false);
  assert.equal(fs.readFileSync(path.join(lockDir(home, "busy-item"), "pid"), "utf8").trim(), String(process.pid));
});

test("the cap scan never deletes a lock; reclaiming stale locks happens only under locks.lock", { timeout: 20000 }, (t) => {
  const { root, home } = tempHome(t);
  liveLock(home, "dead-item", 999999);
  // Exits 1 right after the quick cap scan, before acquire_item runs.
  const result = runLoop(root, home, {
    ANTHROPIC_API_KEY: "dummy",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy",
    CLAUDE_LOOP_MAX_PARALLEL: "2",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN/);
  assert.deepEqual(lockNames(home), ["dead-item"]);
});
