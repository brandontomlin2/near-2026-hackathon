# Live readiness checklist (testnet)

For the owner, for the moment of "yes, deploy". Every command below was run in dry-run mode with placeholder accounts (`demo-owner.testnet`, `personality-nft-demo.testnet`) and behaved as written. Nothing here signs anything until you add `--send --i-approve`. Mainnet is refused everywhere.

## Before you start (once)

- near-cli-rs v0.14 or later on `PATH` (`near --version`). Dry runs do not need it; `--send` does.
- A funded testnet **contract account** (a named `<name>.testnet`) and an **owner account**, each with its key in the near-cli-rs keychain (`near login`). The scripts never read, print or create keys, and never create accounts.
- A public HTTPS (or ipfs/ar) folder that will serve `aloof.svg`, `chaotic.svg`, `social.svg`, `skeptic.svg`, exactly the bytes `npm run render` writes. `media_hash` on each token is the sha256 of those bytes, so any re-render or edit breaks the match.

```sh
export NEAR_NETWORK=testnet                        # or leave unset; anything else is refused
export NEAR_ACCOUNT_ID=<owner>.testnet             # signer and token owner
export NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet # must be set explicitly for deploy; must end in .testnet
```

## Commands, in order

| # | Command | Signs? | Success looks like |
| --- | --- | --- | --- |
| 1 | `npm run build:contract` | no | `Contract successfully built!`; `contracts/personality-nft/target/near/personality_nft.wasm` exists (about 279 KB). Takes about 2 minutes. |
| 2 | `npm run live:check` | no (one read-only RPC call per account; `-- --offline` skips it) | Every line `[ok]`, then `ready: yes.` and exit 0. Any `[todo]` gives `ready: no.` and exit 1. Account ids are never printed. |
| 3 | `npm run render` | no | Four lines: `out/aloof.svg` ... `out/skeptic.svg`. Upload exactly these files to your media folder. |
| 4 | `npm run deploy:nft` | no (dry run) | `[1/1] deploy`, a call to `<contract>.new_default_meta`, a `near contract deploy ...` command. Exit 0. Without the wasm: `error: wasm not found ... Run npm run build:contract first.`, exit 1. |
| 5 | `npm run mint -- --media-base <url>` | no (dry run) | `[1/4] mint aloof` ... `[4/4] mint skeptic`, `media` under your URL, 0.05 NEAR deposit each. Add `--count 3` for only the first three agents (aloof, chaotic, social). |
| 6 | `npm run live-proof -- --media-base <url>` | no (dry run) | Six steps: deploy, four mints, `anchor_sheet`. Writes `out/live-proof/evidence.example.json` (`"example": true`, placeholder hashes). Exit 0. |
| 7 | `npm run live-proof -- --send --i-approve --media-base <url>` | **yes** | `send: deploy, mint x4, anchor_sheet on testnet as ...`, each near-cli-rs transaction streamed, then `wrote 6 of 6 transaction hashes to out/live-proof/txs.json`, `done.` and the evidence command (step 8). Exit 0. |
| 8 | `EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence` | no (read-only RPC views) | `out/evidence.json` with real hashes and `nft_total_supply`, `nft_token` and `sheet_anchor` view results; `mock` is false. |
| 9 | `NEAR_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet EVIDENCE_TX_FILE="$PWD/out/live-proof/txs.json" bash scripts/verify.sh --live` | runs `deploy nft` and `mint` as dry runs | 13 rows, `result: PASS`. The path in `EVIDENCE_TX_FILE` must be absolute. |

Step 7 is the only command that spends anything. It is one command for the whole run; the separate `npm run deploy:nft -- --send --i-approve` and `npm run mint -- --send --i-approve --media-base <url>` do the same deploy and mint but write no `txs.json`, so use `live-proof` if you want the hashes recorded.

`live-proof` always mints all four agents. If you want only three, send the steps by hand with `npm run deploy:nft -- --send --i-approve` then `npm run mint -- --send --i-approve --count 3 --media-base <url>`, and write `txs.json` yourself (below).

## Refusals you will see if something is off

| Situation | Message | Exit |
| --- | --- | --- |
| `--send` without `--i-approve` | `--send needs --i-approve (explicit human approval). Nothing was sent.` | 2 |
| `live-proof --send` without `--media-base` | `--send needs --media-base <url> ... Nothing was sent.` | 2 |
| `NEAR_NETWORK` set to anything but `testnet` | `NEAR_NETWORK must be unset or testnet; ...` (`live:check` shows `[todo]`) | 2 (`live:check`: 1) |
| `NEAR_ACCOUNT_ID` unset with `--send` | `NEAR_ACCOUNT_ID is unset or not a valid NEAR account id (value not shown)` | 2 |
| `deploy --send` with `NEAR_CONTRACT_ACCOUNT_ID` unset | `NEAR_CONTRACT_ACCOUNT_ID must be set explicitly for deploy --send ...` | 2 |
| Contract account not `.testnet` (for example `.near`) | `NEAR_CONTRACT_ACCOUNT_ID must be a named .testnet account ...` | 2 |
| `near` not installed, or no keychain key for a signer | `near-cli-rs ... is not on PATH` or `no testnet key for <account> in the near-cli-rs keychain` | 1 |
| Wasm not built | `wasm not found at ... Run npm run build:contract first.` | 1 |

## Recording the transaction hashes for the README

1. `live-proof --send` writes `out/live-proof/txs.json`: `{network, contract, owner, transactions: [{label, hash}, ...]}` with labels `deploy`, `mint aloof`, `mint chaotic`, `mint social`, `mint skeptic`, `anchor_sheet`. Only steps that exited 0 are recorded.
2. If it prints `WARN: no hash found ... for: <labels>`, find the hash in the explorer (`https://explorer.testnet.near.org/accounts/<contract>.testnet`) and add `{"label": "<label>", "hash": "<hash>"}` to `transactions`. If a step failed it prints `FAILED:` and the labels that were not recorded; redo that step, add its hash, then continue.
3. Run step 8, then open `out/evidence.json`. Check each hash resolves at `https://explorer.testnet.near.org/transactions/<hash>`.
4. Replace the "Not run yet" paragraph in README "Live on testnet" with: the contract account id, the six explorer links, and the `nft_total_supply` / `sheet_anchor` view results copied from `out/evidence.json`. Then update README "Status" and `docs/submission-checklist.md` ("Live testnet evidence section filled") and re-run `bash scripts/verify.sh`. The docs tests currently pin the "nothing is deployed" wording, so expect to adjust `scripts/readme-facts.test.mjs` and `scripts/docs-facts.test.mjs` in the same change.
5. Never paste keys, `.env` contents or the keychain path into the README or a PR.
