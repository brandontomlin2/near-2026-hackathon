// Shared fixtures for the claude-loop test files (scripts/claude-loop.*.test.mjs).
// Each file is its own node --test process, so the slow end-to-end loop runs are
// spread across workers instead of queueing in one file.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "..");
export const LOOP = path.join(SCRIPTS, "claude-loop.sh");
const BOARD = path.join(SCRIPTS, "board.mjs");
export const SWARM = path.join(SCRIPTS, "claude-swarm.sh");
export const SENTINEL = "SENTINELSECRETVALUE99";

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

export const PASS_VERIFY = "#!/usr/bin/env bash\nprintf 'result: PASS\\n'\n";
export const FAIL_VERIFY = "#!/usr/bin/env bash\nprintf 'result: FAIL\\n'\nexit 1\n";

export function baseEnv(home, extra = {}) {
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

export function runLoop(cwd, home, extra = {}, timeout = 20000) {
  return spawnSync("/bin/bash", [LOOP], {
    cwd,
    env: baseEnv(home, extra),
    encoding: "utf8",
    timeout,
  });
}

export function git(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

export function task(id, title, lane, notes = "") {
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

export function writeClaudeStub(file) {
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
export function writeTimeoutWrapper(file) {
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

export function tempHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-loop-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home };
}

export function claudeRuns(logFile) {
  if (!fs.existsSync(logFile)) return 0;
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.includes("--output-format")).length;
}

export function readStatus(home) {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude-loop", "status.json"), "utf8"));
}

export function readItemStatus(home, id) {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude-loop", "status", `${id}.json`), "utf8"));
}

export function lockDir(home, id) {
  return path.join(home, ".claude-loop", "locks", id);
}

export function liveLock(home, id, pid = process.pid) {
  fs.mkdirSync(lockDir(home, id), { recursive: true });
  fs.writeFileSync(path.join(lockDir(home, id), "pid"), String(pid));
}

export function startLoop(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [LOOP], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export async function waitFor(check, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export function lockNames(home) {
  const dir = path.join(home, ".claude-loop", "locks");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.includes(".stale.")).sort() : [];
}

export function showBoard(origin, ref, env) {
  return JSON.parse(git(origin, ["show", `${ref}:board/board.json`], env));
}

export function itemById(items, id) {
  const item = items.find((entry) => entry.id === id);
  assert.ok(item, `missing item ${id}`);
  return item;
}

export function lastAttempts(notes) {
  let count = 0;
  const re = /(?:^|\n)\s*attempts\s*=\s*(\d+)\s*(?=\n|$)/g;
  let match = re.exec(String(notes || ""));
  while (match) {
    count = Number(match[1]);
    match = re.exec(String(notes || ""));
  }
  return count;
}

export function initRepo(t, { verify, items, stubMode }) {
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

export function loopEnv(fixture, overrides = {}) {
  return { ...fixture.env, ...overrides };
}
