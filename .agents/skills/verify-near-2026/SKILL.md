---
name: verify-near-2026
description: Run the local judge screen for this NEAR 2026 hackathon repository. Use before opening or updating a pull request, when asked to verify, prove, or reproduce the demo, or when GitHub Actions, gitleaks, testnet deploy, mint, swarm, or on-chain evidence comes up. CI workflows are intentionally absent.
---

# Verify NEAR 2026

GitHub Actions is intentionally disabled. Do not add `.github/workflows` files. Do not dispatch or re-run workflows. Validation is `bash scripts/verify.sh`.

## Run

From the repo root, on a committed HEAD (the script clones HEAD; a dirty tree is only a warning):

```sh
bash scripts/verify.sh
```

That is the mock screen. It uses no keys and does not write to a chain. `MOCK_INFERENCE=1` is forced for mock commands, and key-like environment variables are not passed to those commands.

Testnet, only when the human wants a live run. Never mainnet. Never put a key on the command line. The script does not read key files and does not print keys. The account id is not a key; the signer must already be in the environment if a live script needs it.

```sh
NEAR_NETWORK=testnet NEAR_ACCOUNT_ID=<testnet-account> bash scripts/verify.sh --live
```

`NEAR_NETWORK=mainnet` exits nonzero immediately. `--live` without `NEAR_NETWORK=testnet` and `NEAR_ACCOUNT_ID` exits nonzero.

Optional: `SWARM_ROUNDS` (positive integer, default 5).

## What it checks

1. Fresh clone of HEAD into a temp directory.
2. No files under `.github/workflows`.
3. Every tracked symlink resolves, and no `.env`, `.pem`, or `.key` file is tracked (`.env.example` is allowed).
4. `npm ci` when `package-lock.json` exists, otherwise `npm install`. No `package.json` yet: `SKIP (not built yet)`.
5. `node --test` on `*.test.js`, `*.test.mjs`, `*.test.cjs`, `*.spec.js`, `*.spec.mjs`, and `*.spec.cjs`, excluding `.agents`, `.claude`, and dependency or build directories. No test files: skip.
6. `gitleaks detect --redact` when `gitleaks` is on `PATH`. Findings fail the run. A missing binary prints a warning and skips; it does not fail. `.gitleaks.toml` is used when present.
7. Planned stages. Each one checks `package.json` scripts. If the script is absent, print `SKIP (not built yet)` and continue.

| Stage | npm script | When it runs |
| --- | --- | --- |
| Testnet deploy of the NFT contract | `deploy:nft` | `--live` only |
| Mint 4 tokens | `mint` | Mock with `MOCK_INFERENCE=1`, or testnet on `--live`. No extra arguments; the script mints 4 tokens. |
| Swarm | `swarm` | Always `MOCK_INFERENCE=1`, arguments `--rounds N` |
| On-chain evidence | `evidence` | `--live` only. Must write `out/evidence.json`. |

`out/evidence.json` must be a JSON object. `network`, when present, is `testnet`. `transactions` is a non-empty list of objects with base58 `hash` strings. `views` is a non-empty list of objects with `method` and `result` (RPC view calls). A passing live evidence stage copies the file to the checkout's `out/evidence.json` (gitignored).

## Result

The script prints a `STATUS` / `STAGE` / `DETAIL` table and `result: PASS` or `result: FAIL`. Exit 0 only when every row is `PASS` or `SKIP`. Any real failure exits nonzero.

Paste the full output under a `## Proof` section on every pull request. Pipeline Ops merges only after that proof is present.

Do not enable GitHub Actions to get a green check. Do not merge, do not push to `main`, and do not change repository visibility, settings, or billing.
