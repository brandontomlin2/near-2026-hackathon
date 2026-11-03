# Costs

What this project costs to run. Every number below cites the file and line it comes from. Where the repo does not state a number, this page says so.

## The default demo is free

`npm run demo` is offline: "Mock mode only: no keys, no network, nothing signed" (`scripts/demo.mjs:3`). Inference defaults to mock: an unset `MOCK_INFERENCE` means mock (`src/inference/client.mjs:4`, `src/inference/client.mjs:56`). Mock mode costs nothing.

## Testnet actions

Testnet only. Mainnet is not supported: `scripts/testnet-deploy.mjs:16` ("Never targets mainnet"), `scripts/testnet-deploy.mjs:85` (mainnet and implicit accounts are refused), `src/anchor/anchor.mjs:131` (`only testnet anchors may be submitted`).

| Action | Deposit | Gas | Who pays | Source |
| --- | --- | --- | --- | --- |
| Deploy + init | 0 NEAR | 100 Tgas prepaid | The contract account signs (`signer: contract`) | `scripts/testnet-deploy.mjs:31`, `:30`, `:165-166`, `:172` |
| Mint (`nft_mint`), per agent | 0.05 NEAR attached; the contract refunds what the token's storage does not use | 100 Tgas prepaid | The owner account (`sign-as owner`) | `scripts/testnet-deploy.mjs:33`, `:191-193`; refund: `contracts/personality-nft/src/lib.rs:183-184`, `:221-222`; README mention: `README.md:113` |
| Anchor (`anchor_sheet`), per sheet | 0.01 NEAR upper bound (1e22 yocto); contract needs at least 1 yocto and refunds the remainder | 30 Tgas | The token owner | `src/anchor/anchor.mjs:11-15`; `contracts/personality-nft/src/lib.rs:240-244`, `:251-252`, `:295-296`; `README.md:93` |
| `nft_transfer_expecting_anchor` | 1 yoctoNEAR | Not stated in this repo | The token owner or an approved account | `contracts/personality-nft/src/lib.rs:321`; `README.md:94` |
| Check sheet (`npm run check-sheet`), `sheet_anchor`, `nft_in_flight` | None (read-only views) | None | Anyone | `README.md:95-96`; `scripts/check-sheet.mjs:13-15` |
| Inference, live mode | Not stated in this repo | n/a | The holder of `NEAR_AI_API_KEY` | see below |

The mint refund is stated in the contract doc comment and implemented by `refund_deposit_to_account(storage_used, ...)`. How much of the 0.05 NEAR is actually kept as storage cost is not stated in the repo.

## Inference price

The per-call price of NEAR AI Cloud is not stated in this repo and depends on the model set in `NEAR_AI_MODEL` (`src/inference/client.mjs:9`, `src/inference/client.mjs:400`). The repo points to the live pricing list: `GET https://cloud-api.near.ai/v1/models`, documented at https://docs.near.ai/api-reference/models/list-models-with-pricing.md (`.agents/skills/near-ai-cloud/references/private-vs-anonymised.md:3`). Live mode is opt-in with `MOCK_INFERENCE=0` (`src/inference/client.mjs:7`).

## Testnet tokens

The organizers' FAQ says "Testnet NEAR is free (near-cli faucet, near-faucet.io)" (`docs/HACKATHON.md:78`). No other product doc in this repo mentions one; the vendored near-cli-rs skill documents the faucet command (`.agents/skills/near-cli-rs/SKILL.md:39`). Testnet tokens are not real money.

## Worked total for the demo on testnet

Deploy + 4 mints + N anchors, deposits only: 4 x 0.05 + N x 0.01 = **0.2 + 0.01 x N NEAR**, an upper bound on attached deposits because the contract refunds unused deposit. It leaves out the storage the deployed wasm locks on the contract account's balance, which the repo does not state. The 4 mints are the four agents (`README.md:113`).

With the defaults (`rounds: 6`, `every: 3` in `DEMO_DEFAULTS`, `src/demo/pipeline.mjs:23-26`), `npm run demo` prints `[4/5] anchor (dry run): 8 calls prepared, 0 signed` (`scripts/demo.mjs:95`; value observed by running `node scripts/demo.mjs --out <tmpdir>`). So N = 8 if you anchor every prepared call: 0.2 + 0.08 = **0.28 NEAR** in deposits, upper bound.

Gas is on top of that. The repo gives prepaid gas (100 Tgas per deploy and mint, 30 Tgas per anchor) but no gas price, so this page does not convert gas to NEAR or to USD. No NEAR/USD rate is stated in the repo either.
