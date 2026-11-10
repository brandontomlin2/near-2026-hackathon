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
