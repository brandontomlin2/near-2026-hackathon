# Local Claude Code loop

One invocation takes one task-board item, runs headless Claude Code in a git worktree, and exits. Run it again for the next item. It does not call Claude when the tests use a fake `CLAUDE_BIN`.

## Run

Use a clean control checkout on `main` with `origin` pointing at the shared remote. macOS does not ship GNU `timeout`; install it once:

```sh
brew install coreutils
```

The script uses `gtimeout` when that exists, and `timeout` otherwise. Log in with `claude auth login`. Do not export both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`.

```sh
bash scripts/claude-loop.sh
```

A passing item is pushed on `claude/<id>` and set to `review`. `main` is never committed or pushed.

To run one specific item instead of the first eligible one, set `CLAUDE_LOOP_ONLY`:

```sh
CLAUDE_LOOP_ONLY=nep-171-contract bash scripts/claude-loop.sh
```

The loop takes exactly that item when it is `todo`, or `doing` with owner `claude`, and its notes do not contain `blocked` or `attempts=2` or higher. The lane is not checked. Otherwise it prints one line to stderr with the reason (`blocked`, `attempts=2`, `doing for grok`, `status review`, `not on the board`), sets `last_result` to `only_skipped`, and exits 0 without claiming anything. Unset, the loop picks as described below.

## Stop

```sh
mkdir -p ~/.claude-loop
touch ~/.claude-loop/STOP
```

The next invocation exits 0 and prints nothing. Remove `STOP` to resume. A run that has already started Claude finishes that session; the file is read at the start.

## What one run does

1. Exits quietly when `~/.claude-loop/STOP` exists.
2. Requires `gtimeout` or `timeout`.
3. Refuses to start when both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are set, before launching Claude.
4. Requires `claude auth status` to report `"loggedIn": true`.
5. Sums `total_cost_usd` in `~/.claude-loop/spend-YYYY-MM-DD.jsonl` (UTC). Refuses when the sum is at least `CLAUDE_LOOP_DAILY_USD` (default 25).
6. If a previous rate-limit or auth failure is still inside its backoff window, exits without taking work.
7. Takes a single-instance lock by creating `~/.claude-loop/lock` with `mkdir`. That is atomic on macOS. `flock` is not required. A lock whose recorded pid is not running is replaced.
8. Fetches `origin` in the control checkout. Lists `todo` items with `node scripts/board.mjs list --status todo --json` and takes the first item whose lane is `claude` or `any`. Items whose notes contain `attempts=2` or higher, or a line that is exactly `blocked`, are skipped. Notes on `origin/claude/<id>` win over `main` when that branch exists, so a finished or blocked item is not claimed again from a stale `main` board.
9. Creates `claude/<id>` from that remote branch, or from `origin/main` the first time, in a temporary worktree. Claims it with `--owner claude` unless it is already `doing` for `claude`, commits the claim, and pushes `claude/<id>`.
10. Runs, from that worktree:

```sh
gtimeout -s INT 45m claude -p "<task JSON and a pointer to CLAUDE.md and PRODUCT.md>" \
  --output-format json \
  --max-turns "${CLAUDE_LOOP_MAX_TURNS:-40}" \
  --max-budget-usd "${CLAUDE_LOOP_MAX_USD:-5}" \
  --strict-mcp-config \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(npm *),Bash(node *),Bash(git add *),Bash(git commit *)" \
  --disallowedTools "Bash(git push *),Read(.env*),Read(**/*.key)"
```

The prompt is the item JSON plus instructions to read `CLAUDE.md` and `PRODUCT.md`. Values of environment variables whose names contain `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `PRIVATE` are replaced with `[redacted]` before the prompt is passed. The prompt is also saved at `~/.claude-loop/last-prompt.txt`.

11. Appends `session_id`, `total_cost_usd`, and `subtype` to today's spend log and to the item notes. Runs `bash scripts/verify.sh` in the worktree when Claude exits 0 and the output is not a rate-limit or auth error.
12. If verify prints `result: PASS` and the branch differs from `origin/main` outside `board/`, pushes `claude/<id>` and sets the item to `review`. Board-only commits are the claim and the notes; they do not count as the diff. Otherwise the loop appends `attempts=N`, sets the item back to `todo`, and pushes that note. The attempt that reaches 2 also appends a `blocked` line.
13. Rate-limit or auth errors in Claude's output set the item back to `todo` without increasing `attempts`, write `~/.claude-loop/backoff.json`, and set status to `backoff`. The next invocation stays idle until `CLAUDE_LOOP_BACKOFF_SEC` (default 900) has passed.

`~/.claude-loop/status.json` is rewritten at each transition. While a run is in progress a background loop refreshes `last_activity` every 60 seconds. The loop's exit trap kills that process.

```json
{
  "state": "idle",
  "item": null,
  "session_id": null,
  "started_at": "2026-11-03T00:00:00.000Z",
  "last_activity": "2026-11-03T00:00:00.000Z",
  "spend_today": 0,
  "last_result": ""
}
```

`state` is `idle`, `running`, `backoff`, `stopped`, or `capped`.

## Environment

| Name | Default | Role |
| --- | --- | --- |
| `HOME` | the current home | State directory `~/.claude-loop` |
| `CLAUDE_BIN` | `claude` | Claude Code binary. Tests point this at a stub |
| `CLAUDE_LOOP_DAILY_USD` | `25` | Refuse when today's recorded spend reaches this |
| `CLAUDE_LOOP_MAX_TURNS` | `40` | Passed as `--max-turns` |
| `CLAUDE_LOOP_MAX_USD` | `5` | Passed as `--max-budget-usd` |
| `CLAUDE_LOOP_TIMEOUT` | `45m` | GNU timeout duration for the Claude process |
| `CLAUDE_LOOP_HEARTBEAT_SEC` | `60` | How often `last_activity` is refreshed |
| `CLAUDE_LOOP_BACKOFF_SEC` | `900` | Pause after a rate-limit or auth error |
| `CLAUDE_LOOP_REPO` | git toplevel of the working directory | Control checkout |
| `CLAUDE_LOOP_ONLY` | unset | Take exactly this item id, or exit 0 with a reason on stderr |

## Tests

```sh
node --test scripts/claude-loop.test.mjs
shellcheck -s bash scripts/claude-loop.sh
bash scripts/verify.sh
```

The tests set `HOME` and `CLAUDE_BIN`. They do not run real Claude.
