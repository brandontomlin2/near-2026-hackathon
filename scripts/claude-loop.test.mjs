import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const LOOP = path.join(HERE, "claude-loop.sh");
const BOARD = path.join(HERE, "board.mjs");
const SWARM = path.join(HERE, "claude-swarm.sh");
const SENTINEL = "SENTINELSECRETVALUE99";

const STRIP = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_LOOP_DAILY_USD",
  "CLAUDE_LOOP_MAX_TURNS",
  "CLAUDE_LOOP_MAX_USD",
  "CLAUDE_LOOP_TIMEOUT",
  "CLAUDE_LOOP_BACKOFF_SEC",
  "CLAUDE_LOOP_REPO",
  "CLAUDE_LOOP_HEARTBEAT_SEC",
  "CLAUDE_LOOP_ONLY",
  "CLAUDE_LOOP_MAX_PARALLEL",
  "CLAUDE_LOOP_LOG_DIR",
  "CLAUDE_SWARM_STAGGER_SEC",
  "CLAUDE_STUB_MODE",
  "CLAUDE_STUB_LOG",
  "CLAUDE_BIN",
  "TIMEOUT_LOG",
];

const PASS_VERIFY = "#!/usr/bin/env bash\nprintf 'result: PASS\\n'\n";
const FAIL_VERIFY = "#!/usr/bin/env bash\nprintf 'result: FAIL\\n'\nexit 1\n";

function baseEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  Object.assign(env, extra);
  env.HOME = home;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(home, "empty-gitconfig");
  if (!extra.CLAUDE_LOOP_HEARTBEAT_SEC) env.CLAUDE_LOOP_HEARTBEAT_SEC = "3600";
  if (!fs.existsSync(home)) fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(env.GIT_CONFIG_GLOBAL)) fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  return env;
}

function runLoop(cwd, home, extra = {}, timeout = 20000) {
  return spawnSync("/bin/bash", [LOOP], {
    cwd,
    env: baseEnv(home, extra),
    encoding: "utf8",
    timeout,
  });
}

function git(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function task(id, title, lane, notes = "") {
  return {
    id,
    title,
    status: "todo",
    owner: "",
    kind: "task",
    lane,
    notes,
    updated_at: "2026-11-03T00:00:00.000Z",
    updated_by: "seed",
  };
}

function writeClaudeStub(file) {
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${CLAUDE_STUB_LOG:?}"
mode="\${CLAUDE_STUB_MODE:?}"
if [[ "\${1:-}" == "auth" && "\${2:-}" == "status" ]]; then
  if [[ "\$mode" == "logged-out" ]]; then
    printf '%s\\n' '{"loggedIn":false}'
    exit 0
  fi
  printf '%s\\n' '{"loggedIn":true}'
  exit 0
fi
case "\$mode" in
  success|verify-fail)
    printf 'work\\n' >> claude-loop-work.txt
    git add claude-loop-work.txt
    git commit -m "stub work" >/dev/null
    if [[ "\$mode" == "success" ]]; then
      printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-ok","total_cost_usd":1.25,"result":"done"}'
    else
      printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-fail","total_cost_usd":0.5,"result":"done"}'
    fi
    ;;
  heartbeat)
    node <<'JS'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const file = process.env.HOME + "/.claude-loop/status/beat-task.json";
const first = JSON.parse(fs.readFileSync(file, "utf8"));
if (first.state !== "running") {
  console.error("expected running status before heartbeat");
  process.exit(1);
}
const start = Date.now();
while (Date.now() - start < 10000) {
  spawnSync("sleep", ["0.2"]);
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  if (current.state === "running" && current.last_activity !== first.last_activity) {
    process.exit(0);
  }
}
console.error("heartbeat did not refresh status");
process.exit(1);
JS
    printf 'work\\n' >> claude-loop-work.txt
    git add claude-loop-work.txt
    git commit -m "stub work" >/dev/null
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-hb","total_cost_usd":0.2,"result":"done"}'
    ;;
  hold)
    while [[ ! -f "\${HOME}/.claude-loop/release" ]]; do sleep 0.1; done
    printf 'work\\n' >> claude-loop-work.txt
    git add claude-loop-work.txt
    git commit -m "stub work" >/dev/null
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-hold","total_cost_usd":0.3,"result":"done"}'
    ;;
  no-diff)
    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"sess-empty","total_cost_usd":0.1,"result":"nothing"}'
    ;;
  rate-limit)
    printf '%s\\n' '{"type":"result","subtype":"error_rate_limit","is_error":true,"session_id":"sess-rl","total_cost_usd":0.05,"result":"rate limit exceeded"}'
    exit 1
    ;;
  auth-error)
    printf '%s\\n' '{"type":"result","subtype":"error_authentication","is_error":true,"session_id":"sess-auth","total_cost_usd":0,"result":"unauthorized"}'
    exit 1
    ;;
  *)
    printf 'unknown stub mode\\n' >&2
    exit 1
    ;;
esac
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
}

// Installed as both gtimeout and timeout so the log is written whichever the
// loop prefers. It execs the first real gtimeout or timeout later in PATH.
function writeTimeoutWrapper(file) {
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${TIMEOUT_LOG:?}"
self_dir=\$(cd "\$(dirname "\$0")" && pwd)
real=""
IFS=: read -ra dirs <<< "\$PATH"
for dir in "\${dirs[@]}"; do
  [[ "\$dir" == "\$self_dir" ]] && continue
  for name in gtimeout timeout; do
    if [[ -x "\$dir/\$name" ]]; then
      real="\$dir/\$name"
      break 2
    fi
  done
done
if [[ -z "\$real" ]]; then
  printf 'no real gtimeout or timeout in PATH\\n' >&2
  exit 127
fi
exec "\$real" "\$@"
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
}

function tempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

function claudeRuns(logFile) {
  if (!fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("--output-format")).length;
}

function readStatus(home) {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude-loop", "status.json"), "utf8"));
}

function readItemStatus(home, id) {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude-loop", "status", `${id}.json`), "utf8"));
}

function lockDir(home, id) {
  return path.join(home, ".claude-loop", "locks", id);
}

function liveLock(home, id, pid = process.pid) {
  fs.mkdirSync(lockDir(home, id), { recursive: true });
  fs.writeFileSync(path.join(lockDir(home, id), "pid"), String(pid));
}

function startLoop(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [LOOP], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitFor(check, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function lockNames(home) {
  const dir = path.join(home, ".claude-loop", "locks");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.includes(".stale.")).sort() : [];
}

function showBoard(origin, ref, env) {
  return JSON.parse(git(origin, ["show", `${ref}:board/board.json`], env));
}

function itemById(items, id) {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `missing item ${id}`);
  return item;
}

function lastAttempts(notes) {
  let count = 0;
  const re = /(?:^|\n)\s*attempts\s*=\s*(\d+)\s*(?=\n|$)/g;
  let match = re.exec(String(notes || ""));
  while (match) {
    count = Number(match[1]);
    match = re.exec(String(notes || ""));
  }
  return count;
}

function initRepo(t, { verify, items, stubMode }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-"));
  const home = path.join(root, "home");
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const stubLog = path.join(root, "claude.log");
  const timeoutLog = path.join(root, "timeout.log");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "board"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeClaudeStub(path.join(bin, "claude"));
  writeTimeoutWrapper(path.join(bin, "gtimeout"));
  writeTimeoutWrapper(path.join(bin, "timeout"));
  fs.copyFileSync(BOARD, path.join(repo, "scripts", "board.mjs"));
  fs.writeFileSync(path.join(repo, "scripts", "verify.sh"), verify);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# CLAUDE\n\nFollow the board.\n");
  fs.writeFileSync(path.join(repo, "PRODUCT.md"), "# PRODUCT\n\nPersonality NFTs.\n");
  fs.writeFileSync(path.join(repo, "board", "board.json"), `${JSON.stringify(items, null, 2)}\n`);
  const env = baseEnv(home, {
    CLAUDE_BIN: path.join(bin, "claude"),
    CLAUDE_STUB_LOG: stubLog,
    CLAUDE_STUB_MODE: stubMode,
    TIMEOUT_LOG: timeoutLog,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  });
  git(root, ["init", "--bare", origin], env);
  git(repo, ["init", "-b", "main"], env);
  git(repo, ["config", "user.email", "test@example.com"], env);
  git(repo, ["config", "user.name", "Test"], env);
  git(repo, ["remote", "add", "origin", origin], env);
  git(repo, ["add", "."], env);
  git(repo, ["commit", "-m", "seed"], env);
  git(repo, ["push", "-u", "origin", "main"], env);
  return { root, home, origin, repo, env, stubLog, timeoutLog };
}

function loopEnv(fixture, overrides = {}) {
  return { ...fixture.env, ...overrides };
}

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

test("two concurrent runs take different items and the summary lists both", { timeout: 40000 }, async (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "hold",
    items: [task("par-a", "First", "any"), task("par-b", "Second", "any"), task("par-c", "Third", "any")],
  });
  const env = loopEnv(fixture);
  const first = startLoop(fixture.repo, env);
  assert.ok(await waitFor(() => lockNames(fixture.home).length === 1), "first lock");
  const second = startLoop(fixture.repo, env);
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

  fs.writeFileSync(path.join(fixture.home, ".claude-loop", "release"), "");
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

test("an item whose dependency is not done on main is skipped", { timeout: 30000 }, (t) => {
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

test("verify failure increments attempts and the second failure is blocked", { timeout: 20000 }, (t) => {
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

test("success moves the item to review and does not push main", { timeout: 20000 }, (t) => {
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

test("CLAUDE_LOOP_ONLY takes the named item instead of the first eligible one", { timeout: 20000 }, (t) => {
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

test("CLAUDE_LOOP_ONLY on an ineligible item exits 0 without claiming", { timeout: 20000 }, (t) => {
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

test("verify pass with no product diff increments attempts", { timeout: 20000 }, (t) => {
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

test("rate-limit output backs off without counting an attempt", { timeout: 20000 }, (t) => {
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

test("auth error in Claude output backs off without counting an attempt", { timeout: 20000 }, (t) => {
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

test("heartbeat refreshes status while claude is running", { timeout: 30000 }, (t) => {
  const fixture = initRepo(t, {
    verify: PASS_VERIFY,
    stubMode: "heartbeat",
    items: [task("beat-task", "Watch the heartbeat", "claude")],
  });
  const result = runLoop(
    fixture.repo,
    fixture.home,
    loopEnv(fixture, { CLAUDE_LOOP_HEARTBEAT_SEC: "1" }),
    25000,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const item = itemById(showBoard(fixture.origin, "claude/beat-task", fixture.env), "beat-task");
  assert.equal(item.status, "review");
  assert.equal(readItemStatus(fixture.home, "beat-task").session_id, "sess-hb");
  assert.deepEqual(lockNames(fixture.home), []);
});
