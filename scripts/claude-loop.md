# Local Claude Code loop

One invocation takes one task-board item, runs headless Claude Code in a git worktree, and exits. Run it again for the next item. Several invocations can run at once: each takes a different item under a per-item lock, up to `CLAUDE_LOOP_MAX_PARALLEL` (default 3). `scripts/claude-swarm.sh` launches that many in the background. It does not call Claude when the tests use a fake `CLAUDE_BIN`.

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

The loop takes exactly that item when it is `todo`, or `doing` with owner `claude`, its notes do not contain `blocked` or `attempts=2` or higher, every id in its `depends_on` is `done` on `origin/main`, and no other run holds its lock. The lane is not checked. Otherwise it prints one line to stderr with the reason (`blocked`, `attempts=2`, `waiting on nep-171-contract`, `locked by another run`, `doing for grok`, `status review`, `not on the board`), sets `last_result` to `only_skipped`, and exits 0 without claiming anything. Unset, the loop picks as described below.

## Parallel runs

```sh
bash scripts/claude-swarm.sh                         # up to CLAUDE_LOOP_MAX_PARALLEL runs; each picks its own item
bash scripts/claude-swarm.sh nep-171-contract viewer # one run per id, through CLAUDE_LOOP_ONLY
bash scripts/claude-swarm.sh --wait sim-mode         # wait for the runs; exit nonzero if one failed
```

The swarm counts live locks in `~/.claude-loop/locks/` and launches only the free slots. Extra ids are listed on stderr and skipped. Each run logs to `~/.claude-loop/logs/<id>.log`. A run started without an id writes to `logs/swarm-<stamp>-<n>.log` until it knows its item, then switches to `logs/<id>.log`, because the swarm sets `CLAUDE_LOOP_LOG_DIR`. Launches are spaced by `CLAUDE_SWARM_STAGGER_SEC` (default 1). The swarm exits quietly when `~/.claude-loop/STOP` exists.

Locks are `~/.claude-loop/locks/<id>`, created with `mkdir` and holding a `pid` file. A lock whose pid is gone is renamed away and replaced. Choosing an item and taking its lock happen under one short mutex, `~/.claude-loop/locks.lock`, so N concurrent invocations take N different items and the cap is never exceeded. When live locks already reach the cap, the invocation exits 0 and prints nothing. Git operations on the control checkout (`fetch`, worktree add and remove) are serialised through `~/.claude-loop/repo.lock`; pushes of `claude/<id>` branches run in parallel. Per-run scratch files live in `~/.claude-loop/runs/<id>/` (`prompt.txt`, `claude.out`, `claude.err`, `parsed.json`). Today's spend log is shared: each run appends one JSON line with a single `appendFileSync`, and the daily cap is checked at the start of every run.

## Dependencies

A board item may carry `depends_on`, a list of item ids. The loop skips the item until every dependency has status `done` in `board/board.json` on `origin/main`, so merged work unblocks the next item on the next fetch. An unknown id never counts as done. See `board/README.md`.

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
7. Counts live item locks in `~/.claude-loop/locks/`. At `CLAUDE_LOOP_MAX_PARALLEL` it exits 0 quietly. `mkdir` is atomic on macOS; `flock` is not required.
8. Fetches `origin` in the control checkout. Lists `todo` items with `node scripts/board.mjs list --status todo --json` and, under `locks.lock`, takes the first item whose lane is `claude` or `any` and whose lock is free, creating `locks/<id>`. Items whose notes contain `attempts=2` or higher, or a line that is exactly `blocked`, or whose `depends_on` ids are not `done` on `origin/main`, are skipped. Notes on `origin/claude/<id>` win over `main` when that branch exists, so a finished or blocked item is not claimed again from a stale `main` board.
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

The prompt is the item JSON plus instructions to read `CLAUDE.md` and `PRODUCT.md`. Values of environment variables whose names contain `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `PRIVATE` are replaced with `[redacted]` before the prompt is passed. The prompt is also saved at `~/.claude-loop/runs/<id>/prompt.txt`.

11. Appends `session_id`, `total_cost_usd`, and `subtype` to today's spend log and to the item notes. Runs `bash scripts/verify.sh` in the worktree when Claude exits 0 and the output is not a rate-limit or auth error.
12. If verify prints `result: PASS` and the branch differs from `origin/main` outside `board/`, pushes `claude/<id>` and sets the item to `review`. Board-only commits are the claim and the notes; they do not count as the diff. Otherwise the loop appends `attempts=N`, sets the item back to `todo`, and pushes that note. The attempt that reaches 2 also appends a `blocked` line.
13. Rate-limit or auth errors in Claude's output set the item back to `todo` without increasing `attempts`, write `~/.claude-loop/backoff.json`, and set status to `backoff`. The next invocation stays idle until `CLAUDE_LOOP_BACKOFF_SEC` (default 900) has passed.

`~/.claude-loop/status/<id>.json` is rewritten at each transition of that item. While a run is in progress a background loop refreshes `last_activity` every 60 seconds. The loop's exit trap kills that process.

```json
{
  "state": "running",
  "item": "nep-171-contract",
  "session_id": null,
  "started_at": "2026-11-03T00:00:00.000Z",
  "last_activity": "2026-11-03T00:01:00.000Z",
  "last_result": "running",
  "pid": 4242
}
```

`state` is `idle`, `running`, `backoff`, `stopped`, or `capped`.

`~/.claude-loop/status.json` is the summary, rewritten by every run and every heartbeat. `running` lists the items whose status file says `running` and whose pid is alive. `spend_today` is the sum of today's spend log. `last_item` and `last_result` come from the most recent run to write a transition; runs that stop before choosing an item (`stopped`, `capped`, `logged_out`, `backoff`, `no_item`) write only the summary.

```json
{
  "running": [
    {
      "item": "nep-171-contract",
      "session_id": null,
      "started_at": "2026-11-03T00:00:00.000Z",
      "last_activity": "2026-11-03T00:01:00.000Z",
      "pid": 4242
    }
  ],
  "spend_today": 1.25,
  "last_item": "viewer",
  "last_result": "review",
  "updated_at": "2026-11-03T00:01:00.000Z"
}
```

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
| `CLAUDE_LOOP_MAX_PARALLEL` | `3` | Live item locks allowed at once; at the cap a run exits 0 quietly |
| `CLAUDE_LOOP_LOG_DIR` | unset | Once an item is chosen, append all further output to `<dir>/<id>.log`; the swarm sets this |
| `CLAUDE_SWARM_STAGGER_SEC` | `1` | Seconds between swarm launches (swarm only) |

## Tests

```sh
node --test scripts/claude-loop.*.test.mjs
shellcheck -s bash scripts/claude-loop.sh scripts/claude-swarm.sh
bash scripts/verify.sh
```

The tests set `HOME` and `CLAUDE_BIN`. They do not run real Claude.
