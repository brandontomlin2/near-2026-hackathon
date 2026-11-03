// claude-loop.sh run outcomes: review, verify failure, no product diff.
// Fixtures live in scripts/test-helpers/claude-loop.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  FAIL_VERIFY,
  PASS_VERIFY,
  SENTINEL,
  claudeRuns,
  git,
  initRepo,
  itemById,
  lastAttempts,
  lockDir,
  loopEnv,
  loopTimeout,
  readItemStatus,
  readStatus,
  runLoop,
  showBoard,
  task,
} from "./test-helpers/claude-loop.mjs";

test("verify failure increments attempts and the second failure is blocked", { timeout: loopTimeout(3) }, (t) => {
  const fixture = initRepo(t, {
    verify: FAIL_VERIFY,
    stubMode: "verify-fail",
    items: [task("retry-task", "Retry me", "any")],
  });
  const mainBefore = git(fixture.origin, ["rev-parse", "main"], fixture.env);

  const first = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  let item = itemById(showBoard(fixture.origin, "claude/retry-task", fixture.env), "retry-task");
  assert.equal(item.status, "todo");
  assert.equal(lastAttempts(item.notes), 1);
  assert.match(item.notes, /session_id=sess-fail/);
  assert.match(item.notes, /total_cost_usd=0\.5/);
  assert.match(item.notes, /verify=FAIL/);
  assert.doesNotMatch(item.notes, /(^|\n)blocked(\n|$)/);
  assert.equal(readStatus(fixture.home).last_result, "attempt");
  assert.equal(readItemStatus(fixture.home, "retry-task").last_result, "attempt");
  assert.equal(claudeRuns(fixture.stubLog), 1);

  const second = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  item = itemById(showBoard(fixture.origin, "claude/retry-task", fixture.env), "retry-task");
  assert.equal(item.status, "todo");
  assert.equal(lastAttempts(item.notes), 2);
  assert.match(item.notes, /(^|\n)blocked(\n|$)/);
  assert.equal(readStatus(fixture.home).last_result, "blocked");
  assert.equal(claudeRuns(fixture.stubLog), 2);

  const third = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(third.status, 0, `${third.stdout}\n${third.stderr}`);
  assert.match(third.stdout, /no eligible todo item/);
  assert.equal(claudeRuns(fixture.stubLog), 2);
  item = itemById(showBoard(fixture.origin, "claude/retry-task", fixture.env), "retry-task");
  assert.equal(lastAttempts(item.notes), 2);
  assert.equal(git(fixture.origin, ["rev-parse", "main"], fixture.env), mainBefore);
  assert.equal(git(fixture.repo, ["branch", "--show-current"], fixture.env), "main");
});

test("success moves the item to review and does not push main", { timeout: loopTimeout(2) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "success",
    items: [
      task("aaa-grok", "Grok only", "grok"),
      task("bbb-spent", "Already attempted", "any", "attempts=2\nblocked"),
      task("demo-task", "Demo task", "claude", `context ${SENTINEL}`),
    ],
  });
  const mainBefore = git(fixture.origin, ["rev-parse", "main"], fixture.env);
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { ANTHROPIC_API_KEY: SENTINEL }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /demo-task review/);

  const refs = git(fixture.origin, ["for-each-ref", "--format=%(refname)", "refs/heads"], fixture.env);
  assert.deepEqual(
    refs.split("\n").filter((ref) => ref.startsWith("refs/heads/claude/")),
    ["refs/heads/claude/demo-task"],
  );
  const item = itemById(showBoard(fixture.origin, "claude/demo-task", fixture.env), "demo-task");
  assert.equal(item.status, "review");
  assert.equal(item.owner, "claude");
  assert.match(item.notes, /session_id=sess-ok/);
  assert.match(item.notes, /total_cost_usd=1\.25/);
  assert.match(item.notes, /subtype=success/);
  assert.match(item.notes, /verify=PASS/);
  assert.equal(
    git(fixture.origin, ["show", "claude/demo-task:claude-loop-work.txt"], fixture.env),
    "work",
  );
  assert.equal(git(fixture.origin, ["rev-parse", "main"], fixture.env), mainBefore);
  assert.equal(git(fixture.repo, ["rev-parse", "main"], fixture.env), mainBefore);
  assert.equal(git(fixture.repo, ["status", "--porcelain"], fixture.env), "");
  assert.equal(git(fixture.repo, ["branch", "--show-current"], fixture.env), "main");

  const prompt = fs.readFileSync(path.join(fixture.home, ".claude-loop", "runs", "demo-task", "prompt.txt"), "utf8");
  assert.match(prompt, /CLAUDE\.md/);
  assert.match(prompt, /PRODUCT\.md/);
  assert.match(prompt, /\[redacted\]/);
  assert.equal(prompt.includes(SENTINEL), false);

  const calls = fs.readFileSync(fixture.stubLog, "utf8");
  assert.match(calls, /--output-format json/);
  assert.match(calls, /--max-turns 40/);
  assert.match(calls, /--max-budget-usd 5/);
  assert.match(calls, /--strict-mcp-config/);
  assert.match(
    calls,
    /--allowedTools Read,Edit,Write,Glob,Grep,Bash\(npm \*\),Bash\(node \*\),Bash\(git add \*\),Bash\(git commit \*\)/,
  );
  assert.match(calls, /--disallowedTools Bash\(git push \*\),Read\(\.env\*\),Read\(\*\*\/\*\.key\)/);
  const timeoutLog = fs.readFileSync(fixture.timeoutLog, "utf8");
  assert.match(timeoutLog, /^-s INT 45m /m);

  const status = readItemStatus(fixture.home, "demo-task");
  assert.equal(status.state, "idle");
  assert.equal(status.last_result, "review");
  assert.equal(status.item, "demo-task");
  assert.equal(status.session_id, "sess-ok");
  const summary = readStatus(fixture.home);
  assert.deepEqual(summary.running, []);
  assert.equal(summary.last_item, "demo-task");
  assert.equal(summary.last_result, "review");
  assert.equal(summary.spend_today, 1.25);
  assert.equal(fs.existsSync(lockDir(fixture.home, "demo-task")), false);

  const again = runLoop(fixture.repo, fixture.home, loopEnv(fixture, { ANTHROPIC_API_KEY: SENTINEL }));
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.match(again.stdout, /no eligible todo item/);
  assert.equal(claudeRuns(fixture.stubLog), 1);
  assert.equal(
    itemById(showBoard(fixture.origin, "claude/demo-task", fixture.env), "demo-task").status,
    "review",
  );
});

test("verify pass with no product diff increments attempts", { timeout: loopTimeout(1) }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "no-diff",
    items: [task("quiet-task", "No code change", "any")],
  });
  const result = runLoop(fixture.repo, fixture.home, loopEnv(fixture));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const item = itemById(showBoard(fixture.origin, "claude/quiet-task", fixture.env), "quiet-task");
  assert.equal(item.status, "todo");
  assert.equal(lastAttempts(item.notes), 1);
  assert.match(item.notes, /verify=PASS/);
  assert.equal(readStatus(fixture.home).last_result, "attempt");
  const files = git(fixture.origin, ["ls-tree", "-r", "--name-only", "claude/quiet-task"], fixture.env);
  assert.equal(files.includes("claude-loop-work.txt"), false);
});
