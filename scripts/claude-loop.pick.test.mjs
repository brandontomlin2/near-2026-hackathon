// claude-loop.sh item selection: dependencies and CLAUDE_LOOP_ONLY.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PASS_VERIFY,
  claudeRuns,
  git,
  initRepo,
  itemById,
  lockNames,
  loopEnv,
  loopTimeout,
  readStatus,
  runLoop,
  showBoard,
  task,
} from "./test-helpers/claude-loop.mjs";

test("an item whose dependency is not done on main is skipped", { timeout: loopTimeout(4) }, (t) => {
  const child = task("aaa-child", "Needs the parent", "any");
  child.depends_on = ["zzz-parent"];
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [child, task("zzz-parent", "Parent", "any")],
  });
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /zzz-parent review/);
  const only = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { CLAUDE_LOOP_ONLY: "aaa-child" }));
  assert.equal(only.status, 0, `${only.stdout}\n${only.stderr}`);
  assert.match(only.stderr, /CLAUDE_LOOP_ONLY=aaa-child skipped: waiting on zzz-parent/);
  const none = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.match(none.stdout, /no eligible todo item/);
  assert.equal(claudeRuns(fixture.stubLog), 1);

  const board = showBoard(fixture.origin, "main", fixture.env);
  itemById(board, "zzz-parent").status = "done";
  fs.writeFileSync(path.join(fixture.repo, "board", "board.json"), `${JSON.stringify(board, null, 2)}\n`);
  git(fixture.repo, ["commit", "-am", "parent done"], fixture.env);
  git(fixture.repo, ["push", "origin", "main"], fixture.env);
  const unblocked = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(unblocked.status, 0, `${unblocked.stdout}\n${unblocked.stderr}`);
  assert.match(unblocked.stdout, /aaa-child review/);
  assert.equal(claudeRuns(fixture.stubLog), 2);
});

test("CLAUDE_LOOP_ONLY takes the named item instead of the first eligible one", { timeout: loopTimeout(1) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [task("aaa-first", "Would be picked first", "any"), task("zzz-target", "Named item", "any")],
  });
  const mainBefore = git(fixture.origin, ["rev-parse", "main"], fixture.env);
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { CLAUDE_LOOP_ONLY: "zzz-target" }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /zzz-target review/);
  assert.equal(claudeRuns(fixture.stubLog), 1);
  const refs = git(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"], fixture.env);
  assert.deepEqual(
    refs.split("\n").filter((ref) => ref.startsWith("refs/heads/claude/")),
    ["refs/heads/claude/zzz-target"],
  );
  const board = showBoard(fixture.origin, "claude/zzz-target", fixture.env);
  assert.equal(itemById(board, "zzz-target").status, "review");
  assert.equal(itemById(board, "aaa-first").status, "todo");
  assert.equal(itemById(board, "aaa-first").owner, "");
  assert.equal(readStatus(fixture.home).last_item, "zzz-target");
  assert.equal(git(fixture.origin, ["rev-parse", "main"], fixture.env), mainBefore);
});

test("CLAUDE_LOOP_ONLY on an ineligible item exits 0 without claiming", { timeout: loopTimeout(1) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [task("open-task", "Still open", "any"), task("stuck-task", "Blocked", "any", "attempts=2\nblocked")],
  });
  const mainBefore = git(fixture.origin, ["rev-parse", "main"], fixture.env);
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { CLAUDE_LOOP_ONLY: "stuck-task" }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.match(result.stderr, /CLAUDE_LOOP_ONLY=stuck-task skipped: blocked/);
  assert.equal(claudeRuns(fixture.stubLog), 0);
  const refs = git(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"], fixture.env);
  assert.equal(refs.includes("refs/heads/claude/"), false);
  assert.equal(git(fixture.origin, ["rev-parse", "main"], fixture.env), mainBefore);
  assert.equal(git(fixture.repo, ["status", "--porcelain"], fixture.env), "");
  const status = readStatus(fixture.home);
  assert.equal(status.last_result, "only_skipped");
  assert.equal(status.last_item, null);
  assert.deepEqual(lockNames(fixture.home), []);
});
