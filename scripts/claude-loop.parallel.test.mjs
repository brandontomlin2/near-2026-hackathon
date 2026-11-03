// claude-loop.sh concurrent runs and claude-swarm.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PASS_VERIFY,
  SWARM,
  claudeRuns,
  initRepo,
  itemById,
  lockNames,
  loopEnv,
  readItemStatus,
  readStatus,
  runLoop,
  showBoard,
  startLoop,
  task,
  waitFor,
} from "./test-helpers/claude-loop.mjs";

test("two concurrent runs take different items and the summary lists both", { timeout: 40000 }, async (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "hold",
    items: [task("par-a", "First", "any"), task("par-b", "Second", "any"), task("par-c", "Third", "any")],
  });
  const env = loopEnv(fixture);
  const loopDir = path.join(fixture.home, ".claude-loop");
  const first = startLoop(fixture.repo, env);
  let second;
  try {
    assert.ok(await waitFor(() => lockNames(fixture.home).length === 1), "first lock");
    second = startLoop(fixture.repo, env);
    assert.ok(await waitFor(() => lockNames(fixture.home).length === 2), "second lock");
    assert.deepEqual(lockNames(fixture.home), ["par-a", "par-b"]);
    assert.ok(
      await waitFor(() => {
        try {
          return readStatus(fixture.home).running.length === 2;
        } catch {
          return false;
        }
      }),
      "summary shows two running items",
    );
    const summary = readStatus(fixture.home);
    assert.deepEqual(summary.running.map((entry) => entry.item), ["par-a", "par-b"]);
    assert.equal(readItemStatus(fixture.home, "par-a").state, "running");
    assert.equal(readItemStatus(fixture.home, "par-b").state, "running");

    const third = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { CLAUDE_LOOP_MAX_PARALLEL: "2" }));
    assert.equal(third.status, 0, third.stderr);
    assert.equal(third.stdout + third.stderr, "");
  } finally {
    // The "hold" stubs wait for this file. Write it even when an assertion above
    // failed: otherwise the two loops keep their pipes open and this process never
    // exits, turning a failure into a hang.
    fs.mkdirSync(loopDir, { recursive: true });
    fs.writeFileSync(path.join(loopDir, "release"), "");
  }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, `${a.stdout}\n${a.stderr}`);
  assert.equal(b.status, 0, `${b.stdout}\n${b.stderr}`);
  assert.match(a.stdout, /par-a review/);
  assert.match(b.stdout, /par-b review/);
  assert.deepEqual(lockNames(fixture.home), []);
  assert.equal(itemById(showBoard(fixture.origin, "claude/par-a", fixture.env), "par-a").status, "review");
  assert.equal(itemById(showBoard(fixture.origin, "claude/par-b", fixture.env), "par-b").status, "review");
  assert.equal(itemById(showBoard(fixture.origin, "main", fixture.env), "par-c").status, "todo");
  const day = new Date().toISOString().slice(0, 10);
  const spend = fs
    .readFileSync(path.join(fixture.home, ".claude-loop", `spend-${day}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(spend.map((line) => line.item_id).sort(), ["par-a", "par-b"]);
  const after = readStatus(fixture.home);
  assert.deepEqual(after.running, []);
  assert.equal(after.spend_today, 0.6);
  assert.equal(readItemStatus(fixture.home, "par-a").state, "idle");
  assert.equal(readItemStatus(fixture.home, "par-b").last_result, "review");
});

test("claude-swarm launches one run per id and logs to logs/<id>.log", { timeout: 40000 }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [task("sw-a", "A", "any"), task("sw-b", "B", "any"), task("sw-c", "C", "any")],
  });
  const result = spawnSync("/bin/bash", [SWARM, "--wait", "sw-b", "sw-c", "sw-a"], {
    cwd: fixture.repo,
    env: loopEnv(fixture, { CLAUDE_LOOP_MAX_PARALLEL: "2", CLAUDE_SWARM_STAGGER_SEC: "0" }),
    encoding: "utf8",
    timeout: 35000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /skipping: sw-a/);
  assert.equal(result.stdout.match(/claude-swarm: started/g).length, 2);
  for (const id of ["sw-b", "sw-c"]) {
    const log = fs.readFileSync(path.join(fixture.home, ".claude-loop", "logs", `${id}.log`), "utf8");
    assert.match(log, new RegExp(`${id} review`));
    assert.equal(itemById(showBoard(fixture.origin, `claude/${id}`, fixture.env), id).status, "review");
  }
  assert.equal(itemById(showBoard(fixture.origin, "main", fixture.env), "sw-a").status, "todo");
  assert.equal(claudeRuns(fixture.stubLog), 2);
});
