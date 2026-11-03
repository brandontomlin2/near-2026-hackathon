#!/usr/bin/env bash
# Launches background claude-loop.sh runs up to CLAUDE_LOOP_MAX_PARALLEL.
#   bash scripts/claude-swarm.sh [--wait] [id ...]
# With ids, each run gets CLAUDE_LOOP_ONLY=<id> and logs to
# ~/.claude-loop/logs/<id>.log. Without ids, each run picks its own item and
# switches its log to logs/<id>.log once it knows the item.
set -euo pipefail
unset CDPATH

: "${HOME:?HOME is required}"
MAX_PARALLEL=${CLAUDE_LOOP_MAX_PARALLEL:-3}
STAGGER_SEC=${CLAUDE_SWARM_STAGGER_SEC:-1}
LOOP_DIR="$HOME/.claude-loop"
LOGS_DIR="$LOOP_DIR/logs"
HERE=$(cd "$(dirname "$0")" && pwd)
LOOP="$HERE/claude-loop.sh"

WAIT=0
IDS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wait) WAIT=1 ;;
    -h | --help)
      printf 'usage: bash scripts/claude-swarm.sh [--wait] [id ...]\n'
      exit 0
      ;;
    -* )
      printf 'error: unknown option %s\n' "$1" >&2
      exit 2
      ;;
    *)
      case "$1" in
        *[!a-z0-9-]*)
          printf 'error: %s is not a board item id\n' "$1" >&2
          exit 2
          ;;
      esac
      IDS+=("$1")
      ;;
  esac
  shift
done

case "$MAX_PARALLEL" in
  [1-9] | [1-9][0-9] | [1-9][0-9][0-9]) ;;
  *)
    printf 'error: CLAUDE_LOOP_MAX_PARALLEL must be a positive integer\n' >&2
    exit 1
    ;;
esac
case "$STAGGER_SEC" in
  0 | [1-9] | [1-9][0-9]) ;;
  *)
    printf 'error: CLAUDE_SWARM_STAGGER_SEC must be a non-negative integer\n' >&2
    exit 1
    ;;
esac

if [[ -f "$LOOP_DIR/STOP" ]]; then
  exit 0
fi
mkdir -p "$LOGS_DIR"

live=$(
  CLAUDE_LOOP_LOCKS_DIR="$LOOP_DIR/locks" node <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.CLAUDE_LOOP_LOCKS_DIR;
let live = 0;
if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    let pid = NaN;
    try {
      pid = Number(fs.readFileSync(path.join(dir, name, "pid"), "utf8").trim());
    } catch {
      live += 1;
      continue;
    }
    try {
      process.kill(pid, 0);
      live += 1;
    } catch (err) {
      if (err && err.code === "EPERM") live += 1;
    }
  }
}
process.stdout.write(String(live));
JS
)
slots=$((MAX_PARALLEL - live))
if [[ "$slots" -le 0 ]]; then
  printf 'claude-swarm: %s of %s runs already live; nothing launched\n' "$live" "$MAX_PARALLEL"
  exit 0
fi

count=${#IDS[@]}
if [[ "$count" -eq 0 ]]; then
  count=$slots
elif [[ "$count" -gt "$slots" ]]; then
  printf 'claude-swarm: %s slot(s) free; skipping: %s\n' "$slots" "${IDS[*]:$slots}" >&2
  count=$slots
fi

PIDS=()
stamp=$(date -u +%Y%m%dT%H%M%SZ)
i=0
while [[ "$i" -lt "$count" ]]; do
  if [[ ${#IDS[@]} -gt 0 ]]; then
    id=${IDS[$i]}
    log="$LOGS_DIR/$id.log"
    CLAUDE_LOOP_ONLY="$id" CLAUDE_LOOP_LOG_DIR="$LOGS_DIR" \
      bash "$LOOP" >> "$log" 2>&1 &
    PIDS+=("$!")
    printf 'claude-swarm: started pid=%s only=%s log=%s\n' "$!" "$id" "$log"
  else
    log="$LOGS_DIR/swarm-${stamp}-$((i + 1)).log"
    CLAUDE_LOOP_LOG_DIR="$LOGS_DIR" bash "$LOOP" >> "$log" 2>&1 &
    PIDS+=("$!")
    printf 'claude-swarm: started pid=%s log=%s\n' "$!" "$log"
  fi
  i=$((i + 1))
  if [[ "$i" -lt "$count" && "$STAGGER_SEC" -gt 0 ]]; then
    sleep "$STAGGER_SEC"
  fi
done

if [[ "$WAIT" -eq 0 ]]; then
  exit 0
fi
failed=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    failed=1
  fi
done
exit "$failed"
