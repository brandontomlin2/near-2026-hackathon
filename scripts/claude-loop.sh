#!/usr/bin/env bash
# One task-board item per invocation, then exit. Several invocations can run
# at once: each takes a different item under ~/.claude-loop/locks/<id>, up to
# CLAUDE_LOOP_MAX_PARALLEL live locks.
# macOS has no flock(1) and no timeout(1) until coreutils is installed:
# every lock is an atomic mkdir, and the timer is gtimeout or timeout.
# Bash 3.2 compatible. Do not run under xtrace; it can print credentials.
# Several functions run only through the EXIT trap or with_repo_lock.
# shellcheck disable=SC2329
set -euo pipefail
unset CDPATH
unset GIT_DIR
unset GIT_WORK_TREE
export GIT_TERMINAL_PROMPT=0

if [[ $# -gt 0 ]]; then
  printf 'usage: bash scripts/claude-loop.sh\n' >&2
  exit 2
fi

: "${HOME:?HOME is required}"

CLAUDE_BIN=${CLAUDE_BIN:-claude}
MAX_TURNS=${CLAUDE_LOOP_MAX_TURNS:-40}
MAX_USD=${CLAUDE_LOOP_MAX_USD:-5}
TIMEOUT_DUR=${CLAUDE_LOOP_TIMEOUT:-45m}
DAILY_USD=${CLAUDE_LOOP_DAILY_USD:-25}
BACKOFF_SEC=${CLAUDE_LOOP_BACKOFF_SEC:-900}
MAX_PARALLEL=${CLAUDE_LOOP_MAX_PARALLEL:-3}
ONLY_ID=${CLAUDE_LOOP_ONLY:-}
LOG_DIR=${CLAUDE_LOOP_LOG_DIR:-}
LOOP_DIR="$HOME/.claude-loop"
STATUS_FILE="$LOOP_DIR/status.json"
STATUS_DIR="$LOOP_DIR/status"
STATUS_LOCK="$LOOP_DIR/status.lock"
LOCKS_DIR="$LOOP_DIR/locks"
LOCKS_META="$LOOP_DIR/locks.lock"
REPO_LOCK="$LOOP_DIR/repo.lock"
BACKOFF_FILE="$LOOP_DIR/backoff.json"
STOP_FILE="$LOOP_DIR/STOP"
TMP_DIR="$LOOP_DIR/tmp"

HB_PID=""
WT=""
REPO=""
LOCK_HELD=0
ITEM_LOCK=""
RUN_DIR=""
ITEM_ID=""
SESSION_ID=""
LAST_RESULT=""
SPEND_TODAY=0
SPEND_FILE=""
STARTED_AT=""
TIMEOUT_BIN=""
HEARTBEAT_SEC=60
TODAY=""

die() {
  printf 'error: %s\n' "$*" >&2
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    stop_heartbeat
    write_status idle "error" || true
  fi
  exit 1
}

now_iso() {
  node -e 'process.stdout.write(new Date().toISOString())'
}

# Waits for a mkdir mutex. A lock whose recorded pid is gone is renamed away
# first, so two waiters cannot both remove and recreate it.
mutex_acquire() {
  local dir="$1"
  local wait_sec="${2:-120}"
  local tries=0
  local old=""
  while true; do
    if mkdir "$dir" 2>/dev/null; then
      printf '%s\n' "$$" > "$dir/pid"
      return 0
    fi
    old=$(cat "$dir/pid" 2>/dev/null || true)
    if [[ -n "$old" ]] && ! kill -0 "$old" 2>/dev/null; then
      if mv "$dir" "$dir.stale.$$" 2>/dev/null; then
        rm -rf "$dir.stale.$$"
      fi
      continue
    fi
    tries=$((tries + 1))
    if [[ "$tries" -ge $((wait_sec * 5)) ]]; then
      return 1
    fi
    sleep 0.2
  done
}

mutex_release() {
  local dir="$1"
  if [[ "$(cat "$dir/pid" 2>/dev/null || true)" == "$$" ]]; then
    rm -rf "$dir"
  fi
}

# Serialises git operations that touch the control checkout. Two concurrent
# fetches or worktree adds in one repository can fail on each other's ref locks.
with_repo_lock() {
  local code=0
  if ! mutex_acquire "$REPO_LOCK" 180; then
    die "timed out waiting for ${REPO_LOCK}"
  fi
  set +e
  "$@"
  code=$?
  set -e
  mutex_release "$REPO_LOCK"
  return "$code"
}

# MODE write: rewrite status/<item>.json (when an item is set) and the summary.
# MODE beat: refresh last_activity on a running item and the summary.
status_node() {
  local mode="$1"
  local state="${2-}"
  local result="${3-}"
  CLAUDE_LOOP_STATUS_MODE="$mode" \
    CLAUDE_LOOP_STATUS_FILE="$STATUS_FILE" \
    CLAUDE_LOOP_STATUS_DIR="$STATUS_DIR" \
    CLAUDE_LOOP_STATUS_LOCK="$STATUS_LOCK" \
    CLAUDE_LOOP_SPEND_FILE="$SPEND_FILE" \
    CLAUDE_LOOP_STATUS_STATE="$state" \
    CLAUDE_LOOP_STATUS_ITEM="$ITEM_ID" \
    CLAUDE_LOOP_STATUS_SESSION="$SESSION_ID" \
    CLAUDE_LOOP_STATUS_STARTED="$STARTED_AT" \
    CLAUDE_LOOP_STATUS_RESULT="$result" \
    CLAUDE_LOOP_STATUS_PID="$$" \
    node <<'JS'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const mode = process.env.CLAUDE_LOOP_STATUS_MODE;
const file = process.env.CLAUDE_LOOP_STATUS_FILE;
const dir = process.env.CLAUDE_LOOP_STATUS_DIR;
const lock = process.env.CLAUDE_LOOP_STATUS_LOCK;
const spendFile = process.env.CLAUDE_LOOP_SPEND_FILE || "";
const item = process.env.CLAUDE_LOOP_STATUS_ITEM || "";
const itemFile = item ? path.join(dir, `${item}.json`) : "";

function alive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function acquire() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") return false;
      spawnSync("sleep", ["0.05"]);
    }
  }
  if (mode !== "write") return false;
  try {
    fs.renameSync(lock, `${lock}.stale.${process.pid}`);
    fs.rmSync(`${lock}.stale.${process.pid}`, { recursive: true, force: true });
    fs.mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

function writeJson(target, body) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    return null;
  }
}

function spendToday() {
  let micros = 0;
  if (spendFile && fs.existsSync(spendFile)) {
    for (const line of fs.readFileSync(spendFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = Number(JSON.parse(line).total_cost_usd);
        if (Number.isFinite(value)) micros += Math.round(value * 1e6);
      } catch {
        // Ignore a torn or non-JSON line.
      }
    }
  }
  return micros / 1e6;
}

function writeSummary(now, last) {
  const running = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const data = readJson(path.join(dir, name));
      if (!data || data.state !== "running" || !alive(data.pid)) continue;
      running.push({
        item: data.item,
        session_id: data.session_id,
        started_at: data.started_at,
        last_activity: data.last_activity,
        pid: data.pid,
      });
    }
  }
  const previous = readJson(file) || {};
  writeJson(file, {
    running,
    spend_today: spendToday(),
    last_item: last ? last.item : previous.last_item || null,
    last_result: last ? last.result : previous.last_result || "",
    updated_at: now,
  });
}

if (!acquire()) process.exit(mode === "write" ? 1 : 0);
try {
  const now = new Date().toISOString();
  if (mode === "write") {
    const session = process.env.CLAUDE_LOOP_STATUS_SESSION || "";
    const result = process.env.CLAUDE_LOOP_STATUS_RESULT || "";
    if (itemFile) {
      writeJson(itemFile, {
        state: process.env.CLAUDE_LOOP_STATUS_STATE,
        item,
        session_id: session || null,
        started_at: process.env.CLAUDE_LOOP_STATUS_STARTED || now,
        last_activity: now,
        last_result: result,
        pid: Number(process.env.CLAUDE_LOOP_STATUS_PID),
      });
    }
    writeSummary(now, { item: item || null, result });
  } else if (itemFile) {
    const data = readJson(itemFile);
    if (data && data.state === "running") {
      data.last_activity = now;
      writeJson(itemFile, data);
    }
    writeSummary(now, null);
  }
} finally {
  fs.rmSync(lock, { recursive: true, force: true });
}
JS
}

write_status() {
  local state="$1"
  local result="${2-}"
  if [[ $# -ge 2 ]]; then
    LAST_RESULT=$result
  else
    result=$LAST_RESULT
  fi
  status_node write "$state" "$result"
}

stop_heartbeat() {
  if [[ -z "$HB_PID" ]]; then
    return 0
  fi
  kill "$HB_PID" 2>/dev/null || true
  wait "$HB_PID" 2>/dev/null || true
  HB_PID=""
}

start_heartbeat() {
  stop_heartbeat
  (
    sleep_pid=""
    trap 'if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT
    while true; do
      sleep "$HEARTBEAT_SEC" &
      sleep_pid=$!
      if wait "$sleep_pid"; then
        sleep_pid=""
      else
        exit 0
      fi
      status_node beat || true
    done
  ) &
  HB_PID=$!
}

remove_worktree() {
  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WT" || true
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
}

# Invoked from the EXIT trap. Shellcheck cannot see that call.
# shellcheck disable=SC2317
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  stop_heartbeat
  if [[ -n "$WT" && -n "$REPO" ]]; then
    if mutex_acquire "$REPO_LOCK" 60; then
      remove_worktree
      mutex_release "$REPO_LOCK"
    else
      remove_worktree
    fi
  fi
  mutex_release "$REPO_LOCK"
  if [[ "$LOCK_HELD" -eq 1 && -n "$ITEM_LOCK" && -d "$ITEM_LOCK" ]]; then
    local lock_pid=""
    lock_pid=$(cat "$ITEM_LOCK/pid" 2>/dev/null || true)
    if [[ "$lock_pid" == "$$" ]]; then
      rm -rf "$ITEM_LOCK" || true
    fi
  fi
  rm -f "$TMP_DIR/$$-"* 2>/dev/null || true
  exit "$code"
}

finish() {
  local code="$1"
  local state="$2"
  local result="$3"
  stop_heartbeat
  write_status "$state" "$result" || true
  exit "$code"
}

refresh_spend() {
  local today="$1"
  SPEND_FILE="$LOOP_DIR/spend-${today}.jsonl"
  SPEND_TODAY=$(
    CLAUDE_LOOP_SPEND_FILE="$SPEND_FILE" node <<'JS'
const fs = require("node:fs");
const file = process.env.CLAUDE_LOOP_SPEND_FILE;
let micros = 0;
if (file && fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = Number(JSON.parse(line).total_cost_usd);
      if (Number.isFinite(value)) micros += Math.round(value * 1e6);
    } catch {
      // Ignore a torn or non-JSON line.
    }
  }
}
process.stdout.write(String(micros / 1e6));
JS
  )
}

cap_state() {
  CLAUDE_LOOP_SPEND="$SPEND_TODAY" CLAUDE_LOOP_CAP="$DAILY_USD" node <<'JS'
const spend = Number(process.env.CLAUDE_LOOP_SPEND);
const cap = Number(process.env.CLAUDE_LOOP_CAP);
if (!Number.isFinite(spend) || !Number.isFinite(cap) || cap < 0) {
  process.stdout.write("bad");
} else if (Math.round(spend * 1e6) >= Math.round(cap * 1e6)) {
  process.stdout.write("capped");
} else {
  process.stdout.write("ok");
}
JS
}

resolve_timeout() {
  TIMEOUT_BIN=$(command -v gtimeout || true)
  if [[ -z "$TIMEOUT_BIN" ]]; then
    TIMEOUT_BIN=$(command -v timeout || true)
  fi
  if [[ -z "$TIMEOUT_BIN" ]]; then
    printf 'error: gtimeout or timeout is required: brew install coreutils\n' >&2
    exit 1
  fi
}

require_number_setting() {
  local name="$1"
  local value="$2"
  case "$value" in
    0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]|[1-9][0-9][0-9][0-9][0-9])
      ;;
    *)
      die "${name} must be a non-negative integer"
      ;;
  esac
}

auth_is_logged_in() {
  local auth_out=""
  local auth_code=0
  set +e
  auth_out=$("$CLAUDE_BIN" auth status 2>&1)
  auth_code=$?
  set -e
  if [[ "$auth_code" -ne 0 ]]; then
    return 1
  fi
  CLAUDE_LOOP_AUTH_TEXT="$auth_out" node <<'JS'
const text = process.env.CLAUDE_LOOP_AUTH_TEXT || "";
function loggedIn(value) {
  return Boolean(value && typeof value === "object" && value.loggedIn === true);
}
const trimmed = text.trim();
try {
  if (loggedIn(JSON.parse(trimmed))) process.exit(0);
} catch {
  // Fall through to a JSON object embedded in other text.
}
const start = trimmed.indexOf("{");
const end = trimmed.lastIndexOf("}");
if (start >= 0 && end > start) {
  try {
    if (loggedIn(JSON.parse(trimmed.slice(start, end + 1)))) process.exit(0);
  } catch {
    // Not JSON.
  }
}
process.exit(1);
JS
}

backoff_active() {
  CLAUDE_LOOP_BACKOFF_FILE="$BACKOFF_FILE" node <<'JS'
const fs = require("node:fs");
const file = process.env.CLAUDE_LOOP_BACKOFF_FILE;
if (!file || !fs.existsSync(file)) process.exit(1);
try {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const until = Date.parse(data.until);
  if (Number.isFinite(until) && until > Date.now()) process.exit(0);
} catch {
  // A broken backoff file does not pause the loop.
}
process.exit(1);
JS
}

clear_backoff_file() {
  rm -f "$BACKOFF_FILE"
}

write_backoff_file() {
  local reason="$1"
  CLAUDE_LOOP_BACKOFF_FILE="$BACKOFF_FILE" \
    CLAUDE_LOOP_BACKOFF_SEC="$BACKOFF_SEC" \
    CLAUDE_LOOP_BACKOFF_REASON="$reason" \
    CLAUDE_LOOP_BACKOFF_ITEM="$ITEM_ID" \
    node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.CLAUDE_LOOP_BACKOFF_FILE;
const seconds = Number(process.env.CLAUDE_LOOP_BACKOFF_SEC);
const until = new Date(Date.now() + seconds * 1000).toISOString();
const body = {
  until,
  reason: process.env.CLAUDE_LOOP_BACKOFF_REASON || "backoff",
  item: process.env.CLAUDE_LOOP_BACKOFF_ITEM || null,
};
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
fs.renameSync(tmp, file);
JS
}

# Prints the number of item locks whose pid is still running. Stale locks are
# renamed away and removed.
live_lock_count() {
  CLAUDE_LOOP_LOCKS_DIR="$LOCKS_DIR" node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_LOOP_LOCKS_DIR;
function alive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}
let live = 0;
if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    const lock = path.join(dir, name);
    let pid = "";
    try {
      pid = fs.readFileSync(path.join(lock, "pid"), "utf8").trim();
    } catch {
      // A lock without a pid yet belongs to a process between mkdir and write.
      live += 1;
      continue;
    }
    if (alive(pid)) {
      live += 1;
      continue;
    }
    const stale = `${lock}.stale.${process.pid}`;
    try {
      fs.renameSync(lock, stale);
      fs.rmSync(stale, { recursive: true, force: true });
    } catch {
      // Another run removed it first.
    }
  }
}
process.stdout.write(String(live));
JS
}

ensure_git_identity() {
  if ! git -C "$REPO" config user.email >/dev/null; then
    git -C "$REPO" config user.email "claude-loop@localhost"
  fi
  if ! git -C "$REPO" config user.name >/dev/null; then
    git -C "$REPO" config user.name "claude-loop"
  fi
}

assert_feature_branch() {
  local branch=""
  branch=$(git -C "$WT" rev-parse --abbrev-ref HEAD)
  case "$branch" in
    claude/*) ;;
    *)
      die "refusing to commit on ${branch}"
      ;;
  esac
}

commit_board() {
  local message="$1"
  assert_feature_branch
  git -C "$WT" add -- board/board.json board/events.jsonl
  if git -C "$WT" diff --cached --quiet; then
    return 0
  fi
  git -C "$WT" commit -m "$message" >/dev/null
}

push_feature() {
  local branch=""
  branch=$(git -C "$WT" rev-parse --abbrev-ref HEAD)
  case "$branch" in
    claude/*) ;;
    *)
      die "refusing to push ${branch}"
      ;;
  esac
  git -C "$WT" push origin "HEAD:refs/heads/${branch}" >/dev/null
}

board_cmd() {
  (
    cd "$WT" || exit 1
    node scripts/board.mjs --actor claude "$@"
  )
}

commit_session_edits() {
  local path=""
  assert_feature_branch
  git -C "$WT" add -A -- . ':(exclude)board'
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      .env | .env.* | */.env | */.env.* | *.key | *.pem)
        git -C "$WT" reset -q -- "$path" || true
        ;;
    esac
  done <<EOF
$(git -C "$WT" diff --cached --name-only)
EOF
  if git -C "$WT" diff --cached --quiet; then
    return 0
  fi
  git -C "$WT" commit -m "claude-loop: save session edits" >/dev/null
}

has_product_diff() {
  local names=""
  names=$(git -C "$WT" diff --name-only "origin/main...HEAD" -- . ':(exclude)board')
  [[ -n "$names" ]]
}

current_attempts() {
  CLAUDE_LOOP_BOARD="$WT/board/board.json" CLAUDE_LOOP_ITEM="$ITEM_ID" node <<'JS'
const fs = require("node:fs");
const items = JSON.parse(fs.readFileSync(process.env.CLAUDE_LOOP_BOARD, "utf8"));
const item = items.find((entry) => entry.id === process.env.CLAUDE_LOOP_ITEM);
const notes = item && item.notes ? String(item.notes) : "";
let count = 0;
const re = /(?:^|\n)\s*attempts\s*=\s*(\d+)\s*(?=\n|$)/g;
let match = re.exec(notes);
while (match) {
  count = Number(match[1]);
  match = re.exec(notes);
}
process.stdout.write(String(count));
JS
}

# One appendFileSync of one line. O_APPEND keeps concurrent writers from
# interleaving a line this short, so parallel runs share today's log.
append_spend() {
  local today="$1"
  CLAUDE_LOOP_SPEND_FILE="$LOOP_DIR/spend-${today}.jsonl" \
    CLAUDE_LOOP_PARSED="$RUN_DIR/parsed.json" \
    CLAUDE_LOOP_ITEM="$ITEM_ID" \
    node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const parsed = JSON.parse(fs.readFileSync(process.env.CLAUDE_LOOP_PARSED, "utf8"));
const file = process.env.CLAUDE_LOOP_SPEND_FILE;
const line = {
  ts: new Date().toISOString(),
  item_id: process.env.CLAUDE_LOOP_ITEM,
  session_id: parsed.session_id,
  total_cost_usd: parsed.total_cost_usd,
  subtype: parsed.subtype,
};
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
JS
}

read_parsed_field() {
  local field="$1"
  CLAUDE_LOOP_PARSED="$RUN_DIR/parsed.json" CLAUDE_LOOP_FIELD="$field" node <<'JS'
const fs = require("node:fs");
const parsed = JSON.parse(fs.readFileSync(process.env.CLAUDE_LOOP_PARSED, "utf8"));
const value = parsed[process.env.CLAUDE_LOOP_FIELD];
process.stdout.write(value === undefined || value === null ? "" : String(value));
JS
}

parse_claude_output() {
  local code="$1"
  CLAUDE_LOOP_STDOUT="$RUN_DIR/claude.out" \
    CLAUDE_LOOP_STDERR="$RUN_DIR/claude.err" \
    CLAUDE_LOOP_PARSED="$RUN_DIR/parsed.json" \
    CLAUDE_LOOP_EXIT="$code" \
    node <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const stdout = fs.existsSync(process.env.CLAUDE_LOOP_STDOUT)
  ? fs.readFileSync(process.env.CLAUDE_LOOP_STDOUT, "utf8")
  : "";
const stderr = fs.existsSync(process.env.CLAUDE_LOOP_STDERR)
  ? fs.readFileSync(process.env.CLAUDE_LOOP_STDERR, "utf8")
  : "";
const exitCode = process.env.CLAUDE_LOOP_EXIT || "";

function collect(text) {
  const found = [];
  function push(value) {
    if (Array.isArray(value)) {
      for (const entry of value) push(entry);
      return;
    }
    if (value && typeof value === "object") found.push(value);
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      push(JSON.parse(trimmed));
    } catch {
      // A log line can start with "{" without being JSON.
    }
  }
  if (found.length === 0 && text.trim()) {
    try {
      push(JSON.parse(text.trim()));
    } catch {
      // No JSON result.
    }
  }
  return found;
}

function looksLikeResult(value) {
  return (
    Object.prototype.hasOwnProperty.call(value, "subtype") ||
    Object.prototype.hasOwnProperty.call(value, "total_cost_usd") ||
    Object.prototype.hasOwnProperty.call(value, "total_cost") ||
    Object.prototype.hasOwnProperty.call(value, "session_id") ||
    Object.prototype.hasOwnProperty.call(value, "sessionId")
  );
}

function safeToken(value, fallback) {
  const text = String(value ?? "")
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .slice(0, 200);
  return text || fallback;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 1e6) / 1e6;
}

const objects = collect(`${stdout}\n${stderr}`);
let chosen = null;
for (const entry of objects) {
  if (looksLikeResult(entry)) chosen = entry;
}
if (!chosen && objects.length > 0) chosen = objects[objects.length - 1];
chosen = chosen || {};

let subtype = safeToken(chosen.subtype, "");
if (!subtype && exitCode === "124") subtype = "timeout";
if (!subtype) subtype = "unknown";
const sessionId = safeToken(chosen.session_id || chosen.sessionId, "unknown");
const cost = money(
  chosen.total_cost_usd !== undefined ? chosen.total_cost_usd : chosen.total_cost,
);
const errorish =
  chosen.is_error === true || exitCode !== "0" || /error|fail/i.test(subtype);
const blob = `${subtype}\n${chosen.result || ""}\n${chosen.error || ""}`.toLowerCase();
let backoff = "";
if (/rate[_ -]?limit|too many requests|overloaded|\b429\b/.test(subtype.toLowerCase())) {
  backoff = "rate_limit";
} else if (/auth/.test(subtype.toLowerCase())) {
  backoff = "auth";
} else if (errorish && /rate[_ -]?limit|too many requests|overloaded|\b429\b/.test(blob)) {
  backoff = "rate_limit";
} else if (
  errorish &&
  /unauthori[sz]ed|\b401\b|not logged in|please log in|invalid api key|authentication|oauth token/.test(
    blob,
  )
) {
  backoff = "auth";
}

const body = {
  session_id: sessionId,
  total_cost_usd: cost,
  subtype,
  backoff,
};
const file = process.env.CLAUDE_LOOP_PARSED;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
JS
}

build_prompt() {
  CLAUDE_LOOP_BOARD="$WT/board/board.json" \
    CLAUDE_LOOP_ITEM="$ITEM_ID" \
    CLAUDE_LOOP_PROMPT="$RUN_DIR/prompt.txt" \
    node <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const items = JSON.parse(fs.readFileSync(process.env.CLAUDE_LOOP_BOARD, "utf8"));
const item = items.find((entry) => entry.id === process.env.CLAUDE_LOOP_ITEM);
if (!item) process.exit(1);
let prompt = [
  "Read CLAUDE.md and PRODUCT.md in this repository and follow them.",
  "Complete the task below on the current git branch.",
  "Commit your changes. Do not push. Do not commit to main.",
  "Do not read or write secrets (.env files, private keys, or tokens).",
  "",
  "Task:",
  JSON.stringify(item, null, 2),
  "",
].join("\n");

const names = Object.keys(process.env).filter((name) =>
  /(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE)/i.test(name),
);
for (const name of names) {
  const value = process.env[name];
  if (typeof value === "string" && value.length >= 8) {
    prompt = prompt.split(value).join("[redacted]");
  }
}

const file = process.env.CLAUDE_LOOP_PROMPT;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, prompt);
JS
}

prepare_branch() {
  local id="$1"
  if git -C "$REPO" worktree list --porcelain | grep -F -x "worktree ${WT}" >/dev/null 2>&1; then
    git -C "$REPO" worktree remove --force "$WT" || true
  fi
  rm -rf "$WT"
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
  if git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/claude/${id}"; then
    git -C "$REPO" branch -f "claude/${id}" "refs/remotes/origin/claude/${id}" >/dev/null
  else
    git -C "$REPO" branch -f "claude/${id}" origin/main >/dev/null
  fi
  mkdir -p "$(dirname "$WT")"
  git -C "$REPO" worktree add "$WT" "claude/${id}" >/dev/null
}

prepare_checkout() {
  ensure_git_identity
  prepare_branch "$ITEM_ID"
}

fetch_origin() {
  git -C "$REPO" fetch origin
}

# Writes the ordered list of items this run may take, as JSON:
# [{id, mode}] in board order, or {reason} when CLAUDE_LOOP_ONLY is ineligible.
list_candidates() {
  local list_file="$1"
  local out_file="$2"
  (
    cd "$REPO" || exit 1
    if [[ -n "$ONLY_ID" ]]; then
      node scripts/board.mjs list --json
    else
      node scripts/board.mjs list --status todo --json
    fi
  ) > "$list_file"
  CLAUDE_LOOP_REPO="$REPO" CLAUDE_LOOP_TODOS="$list_file" CLAUDE_LOOP_ONLY="$ONLY_ID" \
    node > "$out_file" <<'JS'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const repo = process.env.CLAUDE_LOOP_REPO;
const only = process.env.CLAUDE_LOOP_ONLY || "";
const todos = JSON.parse(fs.readFileSync(process.env.CLAUDE_LOOP_TODOS, "utf8"));

function attemptsOf(notes) {
  let count = 0;
  const re = /(?:^|\n)\s*attempts\s*=\s*(\d+)\s*(?=\n|$)/g;
  let match = re.exec(String(notes || ""));
  while (match) {
    count = Number(match[1]);
    match = re.exec(String(notes || ""));
  }
  return count;
}

function blocked(notes) {
  return /(?:^|\n)\s*blocked\s*(?=\n|$)/.test(String(notes || ""));
}

function boardAt(ref) {
  let raw = "";
  try {
    raw = execFileSync("git", ["-C", repo, "show", `${ref}:board/board.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  try {
    const items = JSON.parse(raw);
    return Array.isArray(items) ? items : null;
  } catch {
    return null;
  }
}

function branchItem(id) {
  const items = boardAt(`origin/claude/${id}`);
  return items ? items.find((entry) => entry.id === id) || null : null;
}

// A dependency counts as finished only when origin/main says it is done.
const mainBoard = boardAt("origin/main") || [];
function unmetDependency(item, remote) {
  const deps = Array.isArray(remote && remote.depends_on)
    ? remote.depends_on
    : Array.isArray(item.depends_on)
      ? item.depends_on
      : [];
  for (const dep of deps) {
    const found = mainBoard.find((entry) => entry.id === dep);
    if (!found || found.status !== "done") return String(dep);
  }
  return "";
}

// Notes and status on origin/claude/<id> win over the control checkout.
function eligibility(item) {
  const remote = branchItem(item.id);
  const notes = remote ? remote.notes : item.notes;
  const status = remote ? remote.status : item.status;
  const owner = remote ? remote.owner : item.owner;
  if (blocked(notes)) return { reason: "blocked" };
  const attempts = attemptsOf(notes);
  if (attempts >= 2) return { reason: `attempts=${attempts}` };
  const waiting = unmetDependency(item, remote);
  if (waiting) return { reason: `waiting on ${waiting}` };
  if (status === "todo") return { mode: "claim" };
  if (status === "doing" && owner === "claude") return { mode: "resume" };
  if (status === "doing") return { reason: `doing for ${owner || "nobody"}` };
  return { reason: `status ${status}` };
}

let output;
if (only) {
  const item = todos.find((entry) => entry.id === only);
  const result = item ? eligibility(item) : { reason: "not on the board" };
  output = result.mode ? [{ id: only, mode: result.mode }] : { reason: result.reason };
} else {
  output = [];
  for (const item of todos) {
    if (item.lane !== "claude" && item.lane !== "any") continue;
    const result = eligibility(item);
    if (result.mode) output.push({ id: item.id, mode: result.mode });
  }
}
process.stdout.write(JSON.stringify(output));
JS
}

# Under locks.lock: drop stale item locks, stop at the parallel cap, and take
# the first candidate whose lock is free. Prints JSON: {id, mode}, {reason},
# or null when no candidate is left.
acquire_item() {
  local cand_file="$1"
  CLAUDE_LOOP_LOCKS_DIR="$LOCKS_DIR" \
    CLAUDE_LOOP_LOCKS_META="$LOCKS_META" \
    CLAUDE_LOOP_MAX_PARALLEL="$MAX_PARALLEL" \
    CLAUDE_LOOP_CANDIDATES="$cand_file" \
    CLAUDE_LOOP_ONLY="$ONLY_ID" \
    CLAUDE_LOOP_PID="$$" \
    node <<'JS'
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.CLAUDE_LOOP_LOCKS_DIR;
const meta = process.env.CLAUDE_LOOP_LOCKS_META;
const max = Number(process.env.CLAUDE_LOOP_MAX_PARALLEL);
const only = process.env.CLAUDE_LOOP_ONLY || "";
const pid = process.env.CLAUDE_LOOP_PID;
const raw = fs.readFileSync(process.env.CLAUDE_LOOP_CANDIDATES, "utf8").trim();
const candidates = raw ? JSON.parse(raw) : [];

function alive(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function readPid(lock) {
  try {
    return fs.readFileSync(path.join(lock, "pid"), "utf8").trim();
  } catch {
    return "";
  }
}

function discard(lock) {
  const stale = `${lock}.stale.${process.pid}`;
  try {
    fs.renameSync(lock, stale);
    fs.rmSync(stale, { recursive: true, force: true });
  } catch {
    // Another run removed it first.
  }
}

function acquireMeta() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      fs.mkdirSync(meta);
      fs.writeFileSync(path.join(meta, "pid"), `${pid}\n`);
      return true;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    const holder = readPid(meta);
    if (holder && !alive(holder)) {
      discard(meta);
      continue;
    }
    spawnSync("sleep", ["0.05"]);
  }
  return false;
}

if (!Array.isArray(candidates)) {
  process.stdout.write(JSON.stringify(candidates));
  process.exit(0);
}

if (!acquireMeta()) {
  process.stderr.write(`error: timed out waiting for ${meta}\n`);
  process.exit(1);
}
let picked = null;
try {
  fs.mkdirSync(dir, { recursive: true });
  let live = 0;
  const held = new Set();
  for (const name of fs.readdirSync(dir)) {
    const lock = path.join(dir, name);
    const holder = readPid(lock);
    if (holder && !alive(holder)) {
      discard(lock);
      continue;
    }
    live += 1;
    held.add(name);
  }
  if (live >= max) {
    picked = { reason: "at_cap" };
  } else {
    for (const candidate of candidates) {
      if (held.has(candidate.id)) continue;
      const lock = path.join(dir, candidate.id);
      try {
        fs.mkdirSync(lock);
      } catch (err) {
        if (err && err.code === "EEXIST") continue;
        throw err;
      }
      fs.writeFileSync(path.join(lock, "pid"), `${pid}\n`);
      picked = candidate;
      break;
    }
    if (!picked && only && candidates.length > 0) picked = { reason: "locked by another run" };
  }
} finally {
  if (readPid(meta) === pid) fs.rmSync(meta, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(picked));
JS
}

record_attempt() {
  local today="$1"
  local reason="$2"
  local attempts=0
  local next=0
  local note=""
  local result_label="attempt"
  attempts=$(current_attempts)
  next=$((attempts + 1))
  note=$(
    printf 'session_id=%s\ntotal_cost_usd=%s\nsubtype=%s\n%s\nattempts=%s' \
      "$SESSION_ID" "$COST" "$SUBTYPE" "$reason" "$next"
  )
  if [[ "$next" -ge 2 ]]; then
    note=$(printf '%s\nblocked' "$note")
    result_label="blocked"
  fi
  board_cmd set "$ITEM_ID" todo --note "$note" >/dev/null
  commit_board "claude-loop: retry ${ITEM_ID}"
  push_feature
  if [[ "$result_label" == "blocked" ]]; then
    printf 'claude-loop: %s blocked\n' "$ITEM_ID"
  else
    printf 'claude-loop: %s attempts=%s\n' "$ITEM_ID" "$next"
  fi
  refresh_spend "$today"
  finish 0 idle "$result_label"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

set_today() {
  TODAY=$(date -u +%Y-%m-%d)
  SPEND_FILE="$LOOP_DIR/spend-${TODAY}.jsonl"
}

mkdir -p "$LOOP_DIR" "$TMP_DIR"

if [[ -f "$STOP_FILE" ]]; then
  set_today
  STARTED_AT=$(now_iso || true)
  write_status stopped "stopped" || true
  exit 0
fi

# Nothing above this line may need a tool outside bash and mkdir.
resolve_timeout
set_today
STARTED_AT=$(now_iso)

case "${CLAUDE_LOOP_HEARTBEAT_SEC:-60}" in
  [1-9] | [1-9][0-9] | [1-9][0-9][0-9] | [1-9][0-9][0-9][0-9])
    HEARTBEAT_SEC=${CLAUDE_LOOP_HEARTBEAT_SEC:-60}
    ;;
  *)
    die "CLAUDE_LOOP_HEARTBEAT_SEC must be a positive integer"
    ;;
esac
require_number_setting CLAUDE_LOOP_BACKOFF_SEC "$BACKOFF_SEC"
case "$MAX_PARALLEL" in
  [1-9] | [1-9][0-9] | [1-9][0-9][0-9]) ;;
  *)
    die "CLAUDE_LOOP_MAX_PARALLEL must be a positive integer"
    ;;
esac
case "$ONLY_ID" in
  "") ;;
  *[!a-z0-9-]* | -*)
    die "CLAUDE_LOOP_ONLY must be a board item id"
    ;;
esac

# Quick cap check before any network or auth work. The authoritative check
# happens again under locks.lock in acquire_item.
if [[ "$(live_lock_count)" -ge "$MAX_PARALLEL" ]]; then
  exit 0
fi

if [[ -n "${ANTHROPIC_API_KEY:-}" && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  printf 'error: both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set\n' >&2
  write_status idle "auth_conflict" || true
  exit 1
fi

if ! auth_is_logged_in; then
  printf 'error: claude auth status must report loggedIn true\n' >&2
  write_status idle "logged_out" || true
  exit 1
fi

refresh_spend "$TODAY"
case "$(cap_state)" in
  ok) ;;
  capped)
    printf 'error: daily spend %s >= %s (CLAUDE_LOOP_DAILY_USD)\n' "$SPEND_TODAY" "$DAILY_USD" >&2
    write_status capped "capped" || true
    exit 1
    ;;
  *)
    die "CLAUDE_LOOP_DAILY_USD is not a number"
    ;;
esac

if backoff_active; then
  printf 'claude-loop: backoff\n'
  write_status backoff "backoff" || true
  exit 0
fi
clear_backoff_file

if [[ -n "${CLAUDE_LOOP_REPO:-}" ]]; then
  REPO=$CLAUDE_LOOP_REPO
else
  REPO=$(git rev-parse --show-toplevel 2>/dev/null || true)
fi
if [[ -z "$REPO" ]] || ! git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  die "run this from the control checkout (or set CLAUDE_LOOP_REPO)"
fi
if ! with_repo_lock fetch_origin; then
  die "git fetch origin failed"
fi
if ! git -C "$REPO" show-ref --verify --quiet refs/remotes/origin/main; then
  die "origin/main is missing after fetch"
fi

LIST_FILE="$TMP_DIR/$$-todos.json"
CAND_FILE="$TMP_DIR/$$-candidates.json"
PICK_FILE="$TMP_DIR/$$-pick.json"
list_candidates "$LIST_FILE" "$CAND_FILE"
acquire_item "$CAND_FILE" > "$PICK_FILE"
pick_code=0
set +e
pick_out=$(
  CLAUDE_LOOP_PICK="$PICK_FILE" node <<'JS'
const fs = require("node:fs");
const raw = fs.readFileSync(process.env.CLAUDE_LOOP_PICK, "utf8").trim();
if (!raw || raw === "null") process.exit(2);
const pick = JSON.parse(raw);
if (pick && pick.reason === "at_cap") process.exit(4);
if (pick && typeof pick.reason === "string") {
  process.stdout.write(pick.reason.replace(/\s+/g, " "));
  process.exit(3);
}
if (!pick || !pick.id || !pick.mode) process.exit(1);
process.stdout.write(`${pick.id}\n${pick.mode}`);
JS
)
pick_code=$?
set -e
if [[ "$pick_code" -eq 4 ]]; then
  exit 0
fi
if [[ "$pick_code" -eq 2 ]]; then
  printf 'claude-loop: no eligible todo item\n'
  finish 0 idle "no_item"
fi
if [[ "$pick_code" -eq 3 ]]; then
  printf 'claude-loop: CLAUDE_LOOP_ONLY=%s skipped: %s\n' "$ONLY_ID" "$pick_out" >&2
  finish 0 idle "only_skipped"
fi
if [[ "$pick_code" -ne 0 ]]; then
  die "failed to choose a todo item"
fi
ITEM_ID=${pick_out%%$'\n'*}
ITEM_MODE=${pick_out#*$'\n'}
case "$ITEM_ID" in
  "" | *[!a-z0-9-]* | -*)
    die "refusing unsafe item id"
    ;;
esac
case "$ITEM_MODE" in
  claim | resume) ;;
  *)
    die "unknown pick mode"
    ;;
esac
ITEM_LOCK="$LOCKS_DIR/$ITEM_ID"
LOCK_HELD=1
RUN_DIR="$LOOP_DIR/runs/$ITEM_ID"
mkdir -p "$RUN_DIR"

if [[ -n "$LOG_DIR" ]]; then
  mkdir -p "$LOG_DIR"
  printf 'claude-loop: %s log %s\n' "$ITEM_ID" "$LOG_DIR/$ITEM_ID.log"
  exec >> "$LOG_DIR/$ITEM_ID.log" 2>&1
fi

write_status running "running"
start_heartbeat
WT="$LOOP_DIR/worktrees/$ITEM_ID"
if ! with_repo_lock prepare_checkout; then
  die "could not prepare the worktree for ${ITEM_ID}"
fi

if [[ "$ITEM_MODE" == "claim" ]]; then
  board_cmd claim "$ITEM_ID" --owner claude >/dev/null
  commit_board "claude-loop: claim ${ITEM_ID}"
  push_feature
fi

build_prompt
PROMPT=$(cat "$RUN_DIR/prompt.txt")
: > "$RUN_DIR/claude.out"
: > "$RUN_DIR/claude.err"
set +e
(
  cd "$WT" || exit 1
  "$TIMEOUT_BIN" -s INT "$TIMEOUT_DUR" \
    "$CLAUDE_BIN" -p "$PROMPT" \
    --output-format json \
    --max-turns "$MAX_TURNS" \
    --max-budget-usd "$MAX_USD" \
    --strict-mcp-config \
    --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm *),Bash(node *),Bash(git add *),Bash(git commit *)" \
    --disallowedTools "Bash(git push *),Read(.env*),Read(**/*.key)"
) > "$RUN_DIR/claude.out" 2> "$RUN_DIR/claude.err"
claude_code=$?
set -e

stop_heartbeat
parse_claude_output "$claude_code"
SESSION_ID=$(read_parsed_field session_id)
COST=$(read_parsed_field total_cost_usd)
SUBTYPE=$(read_parsed_field subtype)
BACKOFF=$(read_parsed_field backoff)
append_spend "$TODAY"
refresh_spend "$TODAY"

if [[ -n "$BACKOFF" ]]; then
  note=$(
    printf 'session_id=%s\ntotal_cost_usd=%s\nsubtype=%s\nbackoff' \
      "$SESSION_ID" "$COST" "$SUBTYPE"
  )
  board_cmd set "$ITEM_ID" todo --note "$note" >/dev/null
  commit_board "claude-loop: backoff ${ITEM_ID}"
  push_feature
  write_backoff_file "$BACKOFF"
  printf 'claude-loop: %s backoff\n' "$ITEM_ID"
  refresh_spend "$TODAY"
  finish 0 backoff "$BACKOFF"
fi

if [[ "$claude_code" -ne 0 ]]; then
  record_attempt "$TODAY" "claude_exit=${claude_code}"
fi

write_status running "running"
start_heartbeat

commit_session_edits
session_note=$(
  printf 'session_id=%s\ntotal_cost_usd=%s\nsubtype=%s' \
    "$SESSION_ID" "$COST" "$SUBTYPE"
)
board_cmd changed "$ITEM_ID" --note "$session_note" >/dev/null
commit_board "claude-loop: note ${ITEM_ID}"

verify_code=0
verify_out=""
set +e
if [[ -f "$WT/scripts/verify.sh" ]]; then
  verify_out=$(
    cd "$WT" || exit 1
    bash scripts/verify.sh 2>&1
  )
  verify_code=$?
else
  verify_out="result: FAIL"
  verify_code=1
fi
set -e
printf '%s\n' "$verify_out"

verify_pass=0
if [[ "$verify_code" -eq 0 ]] && printf '%s\n' "$verify_out" | grep -q 'result: PASS'; then
  verify_pass=1
fi

stop_heartbeat
if [[ "$verify_pass" -eq 1 ]] && has_product_diff; then
  board_cmd set "$ITEM_ID" review --note "verify=PASS" >/dev/null
  commit_board "claude-loop: review ${ITEM_ID}"
  push_feature
  printf 'claude-loop: %s review\n' "$ITEM_ID"
  refresh_spend "$TODAY"
  finish 0 idle "review"
fi

if [[ "$verify_pass" -eq 1 ]]; then
  record_attempt "$TODAY" "verify=PASS"
else
  record_attempt "$TODAY" "verify=FAIL"
fi
