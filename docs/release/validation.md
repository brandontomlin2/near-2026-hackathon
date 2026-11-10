# Validation, 2026-11-09

Run on branch `claude/release-doc-1109` at commit `5b24a3f` (the commit before this file was added; this file changes no code). macOS on Apple silicon, Node v22.22.0, cargo installed, gitleaks not installed. Both commands ran with a private `TMPDIR` and under `gtimeout 1800`. Nothing was signed or sent and no `near` CLI was run.

| Command | Result | Detail | Log (local, not committed) |
| --- | --- | --- | --- |
| `npm test` | PASS, exit 0 | 4604 tests in 251 suites: 4594 pass, 0 fail, 0 cancelled, 0 skipped, 10 todo; 33 s | `/tmp/release1109-iUbAuW/npm-test.log` |
| `bash scripts/verify.sh` | PASS, exit 0 | 18 rows: 17 `PASS`, 1 `SKIP` (`deploy nft`, live testnet not requested), 0 `FAIL`; `result: PASS` | `/tmp/release1109-iUbAuW/verify.log` |

The `verify.sh` table:

```text
STATUS    STAGE           DETAIL
------    -----           ------
PASS      fresh clone     5b24a3f9f544
PASS      workflows       no workflow files; CI disabled
PASS      symlinks        tracked symlinks resolve
PASS      secret files    no tracked env or key files
PASS      npm install     npm ci
PASS      tests           299 file(s)
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
- `vault tests` ran because cargo is installed here: `cargo test` in `contracts/yield-vault` reported `278 passed; 0 failed` in the fresh-clone review run of `f605da2` (see [`judge-review.md`](judge-review.md)); no contract code has changed since.
- Tests that needed changes on this branch. The headline change (`438635c`) updated five tests that pinned the old page text: `src/demo/demo.test.mjs`, `src/demo/page.gaps14.test.mjs`, `src/demo/page.test.mjs`, `scripts/readme-commands.test.mjs` and `scripts/fresh-clone-judge-path.mjs`. The README status fix (`43c70a6`) first broke one runbook test (`scripts/yield-live-runbook.test.mjs`, which pins the sentence "No transaction in this document has been signed or sent"); the runbook wording was changed to keep that sentence, and the test was not edited.
- Paste the `verify.sh` table above into the `## Proof` section of the pull request, or rerun it on the final commit.
