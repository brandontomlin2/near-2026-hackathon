// claude-loop.sh item locks: held, stale and pid-less locks.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PASS_VERIFY,
  claudeRuns,
  initRepo,
  liveLock,
  lockDir,
  lockNames,
  loopEnv,
  runLoop,
  task,
} from "./test-helpers/claude-loop.mjs";

test("a held item lock makes the loop take the next item; a stale lock is replaced", { timeout: 30000 }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [task("aaa-held", "Held elsewhere", "any"), task("bbb-free", "Free", "any")],
  });
  liveLock(fixture.home, "aaa-held");
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /bbb-free review/);
  assert.deepEqual(lockNames(fixture.home), ["aaa-held"]);

  fs.writeFileSync(path.join(lockDir(fixture.home, "aaa-held"), "pid"), "999999");
  const second = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /aaa-held review/);
  assert.deepEqual(lockNames(fixture.home), []);
  assert.equal(claudeRuns(fixture.stubLog), 2);
});

test("a pid-less item lock past the grace period is reclaimed; a fresh one still counts", { timeout: 40000 }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [task("aaa-orphan", "Orphaned lock", "any")],
  });
  const orphan = lockDir(fixture.home, "aaa-orphan");
  fs.mkdirSync(orphan, { recursive: true });
  const env = loopEnv(fixture, { CLAUDE_LOOP_MAX_PARALLEL: "1" });

  const fresh = runLoop(fixture.repo, fixture.home, env);
  assert.equal(fresh.status, 0, `${fresh.stdout}\n${fresh.stderr}`);
  assert.equal(fresh.stdout, "");
  assert.equal(claudeRuns(fixture.stubLog), 0);
  assert.deepEqual(lockNames(fixture.home), ["aaa-orphan"]);

  const old = new Date(Date.now() - 120000);
  fs.utimesSync(orphan, old, old);
  const reclaimed = runLoop(fixture.repo, fixture.home, env);
  assert.equal(reclaimed.status, 0, `${reclaimed.stdout}\n${reclaimed.stderr}`);
  assert.match(reclaimed.stdout, /aaa-orphan review/);
  assert.equal(claudeRuns(fixture.stubLog), 1);
  assert.deepEqual(lockNames(fixture.home), []);
});
