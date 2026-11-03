# Build board

Shared backlog for the hackathon build pipeline. It is not the product. State is a list in `board/board.json`. Every CLI change is appended to `board/events.jsonl`.

Statuses: `suggested`, `todo`, `doing`, `review`, `done`, `dropped`.

Each item has `id`, `title`, `status`, `owner`, `kind` (`task` or `suggestion`), `lane` (`grok`, `claude`, or `any`), `notes`, `updated_at`, and `updated_by`. `lane` defaults to `any`. Items are sorted by `id`. Object keys stay in the order above so diffs stay small.

An event line is one JSON object: `ts`, `actor`, `item_id`, `action`, `from`, `to`, `note`. Append lines. Do not rewrite earlier lines.

Run the CLI from the repo root. The actor is `--actor` or `BOARD_ACTOR`.

## Claude Code (in the repo)

At the start of a session, read the board. Claim a `todo` item before working on it. Report work with `changed`, and move the status with `set` when it changes.

```sh
export BOARD_ACTOR=claude
node scripts/board.mjs list --lane claude
node scripts/board.mjs list --status todo --json
node scripts/board.mjs claim nep-171-contract --owner claude
node scripts/board.mjs changed nep-171-contract --note "added the mint entrypoint"
node scripts/board.mjs set nep-171-contract review --note "ready for another agent"
```

`claim` moves `todo` to `doing`. It fails if that item is already `doing` for another owner. `changed` writes a note and an event without changing status. `suggest` files a suggestion (`--note` is required); `accept` moves it from `suggested` to `todo`. Commit `board/board.json` and `board/events.jsonl` with the work.

## Grok Bot (through a pull request)

Grok Bot engineers reach this repo through GitHub. Open a pull request that edits `board/board.json` and appends one `board/events.jsonl` line per change. A board-only pull request is enough to suggest or add work. A pull request that does the work should set the item to `doing`, set `owner`, and include the matching event.

Use `lane` `grok` for Grok Bot work, `claude` for Claude Code, and `any` when either can take it. New tasks start at `todo`. A proposal starts as `kind` `suggestion`, status `suggested`, with the reason in `notes`. Keep the list sorted by `id` and keep the key order above.

```json
{"ts":"2026-11-03T00:00:00.000Z","actor":"grok","item_id":"walletless-sim","action":"suggest","from":null,"to":"suggested","note":"run without a wallet"}
```

Two pulls can touch the same lines. Keep both items, and keep every event line from both sides.

## Do X, see Y

From the repo root, with `BOARD_ACTOR=claude`:

1. Run `node scripts/board.mjs list --status todo --lane any --json`. See the seeded pipeline items, including `nep-171-contract`, each with `"status": "todo"` and `"lane": "any"`.
2. Run `node scripts/board.mjs claim nep-171-contract --owner claude`. See `nep-171-contract` move to `doing` with owner `claude` in `board/board.json`, and a `claim` line in `board/events.jsonl` whose `from` is `todo` and `to` is `doing`.
3. Run `node scripts/board.mjs changed nep-171-contract --note "contract compiles"`. See the status stay `doing`, the note on the item, and a `changed` line whose `from` and `to` are both `doing`.
