# Validation, 2026-11-09

Run on branch `claude/release-doc-1109b` at commit `38a9dc3` (the commit before this file was updated; this update changes no code or test). macOS on Apple silicon, Node v22.22.0, cargo installed, gitleaks not installed. Both commands ran with a private `TMPDIR` and under `gtimeout 1800`. Nothing was signed or sent and no `near` CLI was run.

| Command | Result | Detail | Log (local, not committed) |
| --- | --- | --- | --- |
| `npm test` | PASS, exit 0 | 4615 tests in 251 suites: 4605 pass, 0 fail, 0 cancelled, 0 skipped, 10 todo; 31 s | `/tmp/release1109b-rbKLiF/npm-test.log` |
| `bash scripts/verify.sh` | PASS, exit 0 | 18 rows: 17 `PASS`, 1 `SKIP` (`deploy nft`, live testnet not requested), 0 `FAIL`; `result: PASS` | `/tmp/release1109b-rbKLiF/verify.log` |

The `verify.sh` table:

```text
STATUS    STAGE           DETAIL
------    -----           ------
PASS      fresh clone     38a9dc31d0a1
PASS      workflows       no workflow files; CI disabled
PASS      symlinks        tracked symlinks resolve
PASS      secret files    no tracked env or key files
PASS      npm install     npm ci
PASS      tests           300 file(s)
PASS      secret scan     FALLBACK scan, no findings (gitleaks not installed; narrower than gitleaks)
SKIP      deploy nft      npm run deploy:nft exists; live testnet not requested
PASS      mint            npm run mint (mock)
PASS      swarm           npm run swarm (mock)
PASS      demo            npm run demo (mock)
PASS      round hash      npm run anchor (mock)
PASS      yield           npm run yield (mock)
PASS      yield demo      npm run yield:demo:check (mock)
PASS      yield shade     npm run yield:shade:check (mock)
PASS      yield live      npm run yield:live:check (mock)
PASS      vault tests     cargo test (contracts/yield-vault)
PASS      evidence        wrote out/evidence.json (mock, not on-chain proof)

result: PASS
```

Notes:

- The secret scan is the fallback scan, not gitleaks. Run `gitleaks detect` over the full history once before the repository is made public.
- `vault tests` ran because cargo is installed here: `cargo test` in `contracts/yield-vault` reported `278 passed; 0 failed` in this run. No contract code changed on this branch.
- Read-only live check, 2026-11-09 (America/Chicago): the two `curl` commands in the README section "Live on testnet" were run by hand against `https://test.rpc.fastnear.com` (`get_state`) and `https://archival-rpc.testnet.near.org` (`tx`), and both returned HTTP 200 with the output the README quotes (`"swaps_executed":1`, `"swap_in_flight":false`, `"stranded_on_ref":[]`; `swap_executed` with `amount_out` 94246798). These are JSON-RPC view queries; nothing was signed or sent. The unit test for that step (`scripts/readme-live-verify.test.mjs`) uses committed fixtures and no network.
- Tests changed in this follow-up (commits `4ddaf7e` to `38a9dc3`), each to pin the new vault-first truth:
  - `scripts/readme-facts.test.mjs`: section order (Live on testnet directly after the quick path, the vault before the supporting NFT sections, one "Not done" heading) and the track list (exactly `security`, `defi`, `nfts`, names checked against `docs/HACKATHON.md`).
  - `scripts/yield-shade.readme.test.mjs`: the Shade status is the recorded No-go, not "not decided".
  - `scripts/readme-live-verify.test.mjs` (new, 8 tests) with fixtures in `scripts/fixtures/live-verify/`: pins the documented `curl` commands and their expected output.
  - `scripts/docs-facts.test.mjs`, `scripts/docs-accuracy.test.mjs`: the X post drafts are vault-first (the two assertions that pinned memory-NFT wording in the drafts were replaced), and the vault lines quoted in the video docs are checked against real `yield:demo` output.
- An independent review of the README reorder and the `PRODUCT.md` replacement (a separate Sonnet agent, read-only) found no P1 or P2 issue. Two of its P3 notes were applied in `f107972` (the UTC date of the swap, one `PRODUCT.md` sentence). Left as they are: the supporting `npm run demo` steps stay inside the judge quick path, ahead of "Live on testnet".
- Earlier on this PR (before this follow-up): the headline change (`438635c`) updated five tests that pinned the old page text, and the README status fix (`43c70a6`) changed runbook wording to keep a pinned sentence.
- Paste the `verify.sh` table above into the `## Proof` section of the pull request, or rerun it on the final commit.

## Follow-up, 2026-11-10: "Try to break the live vault"

Run on branch `claude/break-the-vault-1110` at commit `2e1c272` (`2608a4a`, the #201 squash, plus two commits: the README subsection "Try to break the live vault" and its drift test `scripts/readme-break-the-vault.test.mjs` with fixtures in `scripts/fixtures/break-the-vault/`). macOS on Apple silicon, Node v26.3.0, cargo installed, gitleaks 8.30.1 now installed. Both commands ran with a private `TMPDIR`, `npm test` under `gtimeout 1800` and `verify.sh` under `gtimeout 2400`. Nothing was signed or sent and no `near` CLI was run.

| Command | Result | Detail |
| --- | --- | --- |
| `npm test` | PASS, exit 0 | 4623 tests in 251 suites: 4613 pass, 0 fail, 0 cancelled, 0 skipped, 10 todo; 62 s |
| `bash scripts/verify.sh` | FAIL, exit 1 | 18 rows: 16 `PASS`, 1 `SKIP` (`deploy nft`, live testnet not requested), 1 `FAIL` (`secret scan`); `result: FAIL` |

- The one `FAIL` is not from this follow-up. gitleaks is installed on this machine now, so the stage ran real gitleaks over the full history (974 commits) instead of the fallback scan, and it reported 8 `generic-api-key` findings. All 8 are one line each in three test files, in commits dated 2026-11-03: `src/inference/client.gaps14.test.mjs` line 19, `src/inference/hardening.test.mjs` line 9 and `src/memory/memory.gaps17.test.mjs` line 15. Each line is a made-up test constant (`const KEY = "test-fake-key-..."` or `"stub-key-..."`), not a credential. None is in a file this follow-up touched. Not fixed here: allow-listing them in `.gitleaks.toml` is a separate decision, and it is needed before `verify.sh` can pass on a machine with gitleaks.
- Every other row is `PASS` (`tests` 301 file(s); `vault tests` `278 passed; 0 failed`) apart from the usual `deploy nft` `SKIP`.
- Read-only live check, 2026-11-10 (America/Chicago): the four `curl` commands in the README subsection "Try to break the live vault" were run against `https://test.rpc.fastnear.com` (`check_proposal` on `vault.near-2026-hackathon.testnet`) by the author, again by an independent read-only Sonnet reviewer, and again through the test's live mode (`README_BREAK_THE_VAULT_LIVE=1`, 9 of 9 pass). Each printed the output the README quotes: `ERR_NOT_RUNNER`, `ERR_POOL_NOT_ALLOWED`, `ERR_PRICE_FLOOR`, `ERR_MAX_TRADE`; the control (the base trade from the real runner) returned `{"ok":true,"reason":""}`. These are JSON-RPC view queries; nothing was signed or sent. The reviewer found no P1; its two P2 wording notes (step 4 changes two fields; steps 2 to 4 also need the vault idle) were applied before the commit.
