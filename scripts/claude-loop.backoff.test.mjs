// claude-loop.sh backoff and heartbeat.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PASS_VERIFY,
  claudeRuns,
  initRepo,
  itemById,
  lastAttempts,
  lockNames,
  loopEnv,
  loopTimeout,
  readItemStatus,
  readStatus,
  runLoop,
  showBoard,
  task,
} from "./test-helpers/claude-loop.mjs";

test("rate-limit output backs off without counting an attempt", { timeout: loopTimeout(2) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "rate-limit",
    items: [task("limited-task", "Hit the limit", "claude", "attempts=1")],
  });
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const item = itemById(showBoard(fixture.origin, "claude/limited-task", fixture.env), "limited-task");
  assert.equal(item.status, "todo");
  assert.equal(lastAttempts(item.notes), 1);
  assert.match(item.notes, /backoff/);
  assert.match(item.notes, /session_id=sess-rl/);
  assert.match(item.notes, /subtype=error_rate_limit/);
  const status = readItemStatus(fixture.home, "limited-task");
  assert.equal(status.state, "backoff");
  assert.equal(status.last_result, "rate_limit");
  assert.equal(status.session_id, "sess-rl");
  const backoff = JSON.parse(
    fs.readFileSync(path.join(fixture.home, ".claude-loop", "backoff.json"), "utf8"),
  );
  assert.equal(backoff.reason, "rate_limit");
  assert.ok(Date.parse(backoff.until) > Date.now());
  const day = new Date().toISOString().slice(0, 10);
  const spend = fs
    .readFileSync(path.join(fixture.home, ".claude-loop", `spend-${day}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(spend.length, 1);
  assert.equal(spend[0].total_cost_usd, 0.05);
  assert.equal(spend[0].session_id, "sess-rl");
  assert.equal(claudeRuns(fixture.stubLog), 1);

  const paused = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(paused.status, 0, `${paused.stdout}\n${paused.stderr}`);
  assert.match(paused.stdout, /backoff/);
  assert.equal(claudeRuns(fixture.stubLog), 1);
  assert.equal(readStatus(fixture.home).last_result, "backoff");
});

test("auth error in Claude output backs off without counting an attempt", { timeout: loopTimeout(1) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "auth-error",
    items: [task("auth-task", "Auth blew up", "any", "attempts=1")],
  });
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const item = itemById(showBoard(fixture.origin, "claude/auth-task", fixture.env), "auth-task");
  assert.equal(item.status, "todo");
  assert.equal(lastAttempts(item.notes), 1);
  assert.match(item.notes, /backoff/);
  assert.match(item.notes, /session_id=sess-auth/);
  const status = readItemStatus(fixture.home, "auth-task");
  assert.equal(status.state, "backoff");
  assert.equal(status.last_result, "auth");
});

test("heartbeat refreshes status while claude is running", { timeout: loopTimeout(1) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "heartbeat",
    items: [task("beat-task", "Watch the heartbeat", "claude")],
  });
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { CLAUDE_LOOP_HEARTBEAT_SEC: "1" }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const item = itemById(showBoard(fixture.origin, "claude/beat-task", fixture.env), "beat-task");
  assert.equal(item.status, "review");
  assert.equal(readItemStatus(fixture.home, "beat-task").session_id, "sess-hb");
  assert.deepEqual(lockNames(fixture.home), []);
});
