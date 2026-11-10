# Yield Optimizer vault: release document

Status of this file: DRAFT for Brandon, written 2026-11-09 on branch `claude/release-doc-1109b`. Nothing in it has been submitted, posted or published. Every live fact is copied from the README section "Live on testnet"; no hash or account here is new. Companion files: [`judge-review.md`](judge-review.md) (what a fresh-clone judge hits) and [`validation.md`](validation.md) (test and verify results for this branch).

Settled: Brandon decided on 2026-11-09 that the tracks are `security`, `defi` and `nfts`, and that `PRODUCT.md` is vault-first. The README, `PRODUCT.md` and the checklists claim exactly these three (see "Tracks" and "PRODUCT.md (applied)").

Dates, in America/Chicago (CST): feature freeze Wed Nov 11; submit target Fri Nov 13 by 8:00pm; hard deadline Sat Nov 14 at 5:59pm (2026-11-14T23:59Z), which is also when the repository must be public.

## One-line pitch

AI agents propose trades, a NEAR vault contract's on-chain rules veto the bad ones, and only the trades that pass execute on Rhea (Ref Finance).

## Problem

A treasury that wants yield from an automated trader has to give the trader its tokens and then trust every trade it picks. One wrong model output, one bad prompt or one stolen bot key can drain the account, and the owner finds out afterwards.

## Who uses it

A small business or DAO treasury that wants yield without trusting a single bot. The owner sets the limits once, on chain. After that the agents can only propose, and the worst a wrong or compromised agent can do is a trade inside those limits, or holding the vault's swap lock for a few blocks with a swap that cannot fill (the owner's remedy is `revoke_runner`).

## How it works

1. Agents propose. Four personality agents (Aloof, Chaotic, Social, Skeptic) and a yield-optimizer planner each propose one swap from Rhea (Ref Finance) pool data. Skeptic can veto another agent's proposal. This runs off chain (`src/yield/`, `src/yield-optimizer/`).
2. On-chain rules decide. The vault contract (`contracts/yield-vault/`) checks every `execute_swap` against the owner's `VaultConfig`:
   - a pool allowlist (`ERR_POOL_NOT_ALLOWED`),
   - a per-token `max_trade` and `daily_cap` (`ERR_MAX_TRADE`, `ERR_DAILY_CAP`; a token with no limit cannot be sold, `ERR_NO_LIMIT`),
   - a per-pool price floor on `min_amount_out` (`ERR_PRICE_FLOOR`),
   - a runner allowlist (`ERR_NOT_RUNNER`),
   - pause, revoke runner, revoke all (`ERR_PAUSED`).
   The same rules are checked off chain first (`src/yield/rules.mjs`), and the JavaScript and the Rust are both tested against one shared set of vectors (`contracts/yield-vault/tests/rule-vectors.json`).
3. Rhea swap. A proposal that passes becomes a swap on a Rhea (Ref Finance) pool: the vault deposits the token with `ft_transfer_call`, calls `swap`, and withdraws, and its callbacks read Ref's `get_deposit` before crediting the result or rolling back. Only the owner can withdraw from the vault.

## NEAR primitives used

| Primitive | Where | State |
| --- | --- | --- |
| Rust smart contract (near-sdk 5.30) holding funds and enforcing policy | `contracts/yield-vault/src/lib.rs` | Deployed once on testnet (see below). Unit tests and a local sandbox suite against a mock Ref. |
| NEP-141 fungible tokens (`ft_transfer_call`, `ft_on_transfer`, storage deposits) | same contract | Used in the live swap (wNEAR `wrap.testnet` in, `rft` out). |
| Cross-contract promises and callbacks to Rhea (Ref Finance) testnet, `ref-finance-101.testnet` | same contract | One live swap on pool 0. |
| Named accounts and sub-accounts for separation of duties: owner, `vault.` and `runner.` | live run | Owner sets rules and withdraws; the runner account can only call `execute_swap`. |
| Contract events (`EVENT_JSON` logs such as `swap_executed`) | same contract | Visible on the live swap transaction. |
| NEP-171 NFT contract (with NEP-177, 178, 181, 297) | `contracts/personality-nft/` | Supporting only: one token (`aloof`) minted in the live run. The vault records an NFT id as metadata and never checks it. |
| Read-only RPC view calls for the pool snapshot | `src/yield/fixtures/` | One committed Ref testnet snapshot (block 276332963); the demo does not fetch. |

Not claimed: NEAR Intents (not used), NEAR AI Cloud inference (a live client exists, tested only against a local stub; every demo runs a deterministic mock), chain signatures and Shade Agents (an offline dry run only), TEE attestation (an offline check on a hand-made fixture only).

## What is live on testnet

One approved run on 2026-11-09, testnet only, nothing on mainnet. Each transaction was sent once and none was resent.

| Item | Value |
| --- | --- |
| Owner account | [`near-2026-hackathon.testnet`](https://testnet.nearblocks.io/address/near-2026-hackathon.testnet) |
| Vault contract | [`vault.near-2026-hackathon.testnet`](https://testnet.nearblocks.io/address/vault.near-2026-hackathon.testnet), deploy and `new` tx [JDNqTuqvuy4vZsfVQLMZ1g4vQr4jVSp7GrUt6FZzYvi5](https://testnet.nearblocks.io/txns/JDNqTuqvuy4vZsfVQLMZ1g4vQr4jVSp7GrUt6FZzYvi5) |
| Runner account (signed the swap) | [`runner.near-2026-hackathon.testnet`](https://testnet.nearblocks.io/address/runner.near-2026-hackathon.testnet) |
| Rhea (Ref) swap through `execute_swap` | [B4oDeCFzeEpDaKMJe6F5rDh5F2ie2qdTKTm7YQVg24Em](https://testnet.nearblocks.io/txns/B4oDeCFzeEpDaKMJe6F5rDh5F2ie2qdTKTm7YQVg24Em): 0.01 wNEAR to 0.94246798 `rft` on pool 0 (`swap_executed`, `amount_out` 94246798) |
| NFT contract (supporting) | [`near-hackathon-2026-vault-20261106.testnet`](https://testnet.nearblocks.io/address/near-hackathon-2026-vault-20261106.testnet), deploy tx [AAXAQtRSjamrmh96w57kREz11MHVXBN97uotKUfYGmFF](https://testnet.nearblocks.io/txns/AAXAQtRSjamrmh96w57kREz11MHVXBN97uotKUfYGmFF) |
| NFT mint, token `aloof` to the owner (supporting) | [BVYCpDrawU8ESY3qCNfq4StD1cFsHfjvT9kVpgRpiWcp](https://testnet.nearblocks.io/txns/BVYCpDrawU8ESY3qCNfq4StD1cFsHfjvT9kVpgRpiWcp) |

Read-only check from the README: `get_state` on the vault shows `swaps_executed: 1`, `swap_in_flight: false` and an empty `stranded_on_ref`.

What the live run does not show, so nobody over-claims it:

- It is one swap. The vault has not refused a live transaction on testnet; the rejections are shown by the contract's unit tests, the sandbox tests and the offline demo, which prints the exact messages the Rust `check_rules` returns.
- The live swap is pool 0 (wNEAR to `rft`). The offline demo plans a different swap (pool 747, 0.05 USDC.e to USDT.e). The README live-path section explains why: the owner could fund a pool 0 swap by wrapping testnet NEAR.
- The owner sent the live swap by hand from printed near-cli-rs commands, using the runbook's pool 0 fallback. The README does not record an agent proposing it, so do not present it as an agent-picked trade. No agent runs unattended.
- The NFT's `media` URL is a GitHub raw link to `docs/nft-media/aloof.svg` on `main`. PR #200 is merged and the repository is public, so that raw link should resolve. The art lives under `docs/nft-media/`.

## What was built during the hackathon

All of it. The first commit is `992acee` on 2026-11-02 (CST); there is no pre-hackathon code (`docs/DISCLOSURE.md`), so the annotated `pre-hackathon` tag points at that root commit. The work in the window is the diff from that tag to `main`: https://github.com/brandontomlin2/near-2026-hackathon/compare/pre-hackathon...main (that compare will point at `hackathon-submission` once that tag exists). The code was written by AI coding agents under Brandon's direction and review, which `docs/DISCLOSURE.md` states.

- The vault contract: about 2,000 lines of Rust plus about 4,200 lines of unit tests (`cargo test` in `contracts/yield-vault`; count in [`validation.md`](validation.md)), and a separate local sandbox suite against a mock Ref and mock tokens (`contracts/yield-vault/sandbox/`).
- One JavaScript copy of the vault rules (`src/yield/rules.mjs`) held to the contract by shared vectors.
- Four personality strategies with a veto, and the yield-optimizer planner (`src/yield/strategies.mjs`, `src/yield-optimizer/`).
- `npm run yield:demo`: the offline demo and its one-page HTML report.
- The live path tooling, all of which prints and never signs: `yield:live:preflight`, `yield:live:dry-run`, `yield:live:once`, and the runbook the owner followed (`docs/yield-vault-live-runbook.md`).
- `bash scripts/verify.sh`: the local judge screen (fresh clone, install, tests, secret scan, demos, vault tests).
- Supporting, earlier in the window: the NEP-171 personality NFT contract, the scripted swarm, the character sheets and `npm run demo`.
- No npm dependencies. Rust dependencies: `near-sdk` 5.30 for the vault; `near-sdk` and `near-contract-standards` 5.30 for the NFT contract.

## How to run

This is the README "Judge quick path". Needs Node 22 or later. No account, no key, no network after `npm install`. Everything here is mock or dry run and nothing is signed or sent.

1. `npm install && npm run yield:demo`. See `YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent`, three agents refused as off reference, Chaotic vetoed by Skeptic, the row `yield-optimizer  pool 747: 0.05 usdc -> min 0.050406 usdt  OK           execute`, four proposals the on-chain rules reject (for example `REJECTED ERR_MAX_TRADE: 1001 exceeds max_trade 1000`), and `1 unsigned execute_swap call planned, 0 signed, 0 sent`. Then open `out/yield-demo/index.html` for the same run as one page.
2. `npm run demo` (supporting: the four agents the proposals come from). See `[1/5] swarm: 6 rounds, 24 events, verify: ok`, `[4/5] anchor (dry run): 8 calls prepared, 0 signed` and `Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.`
3. Open `out/index.html`. See the headline `AI agents propose trades. On-chain rules decide.` over the four agents.
4. `bash scripts/verify.sh`. See an 18-row `STATUS / STAGE / DETAIL` table with no `FAIL` row, then `result: PASS`. Without gitleaks the `secret scan` row is a narrower `FALLBACK` scan. Without Rust the `vault tests` row is `SKIP` and the contract's Rust tests do not run.

To see the live result instead of the offline one, open the explorer links in the table above.

## Limits and next steps

Limits today:

- Testnet only, and one live swap. Gas figures were measured in a local sandbox against a mock Ref before the run; the one live swap succeeding is the only evidence against the real Ref contract.
- The demo's inference is a deterministic stand-in, not a model. The live NEAR AI Cloud client has only run against a local stub.
- The contract has no price oracle. It enforces the owner's static price floor; the peg and reference-price check is off chain, in the runner. A runner can pick any `min_amount_out` at or above the floor.
- `daily_cap` resets at 00:00 UTC, so up to twice the cap can be spent within minutes around midnight.
- The runner is an ordinary NEAR account (`runner.near-2026-hackathon.testnet`). There is no unattended agent, no TEE and no chain-signature runner.
- The contract was reviewed by AI review agents, not by a professional auditor. Known risks are listed in `contracts/yield-vault/README.md`.
- The vault is owned by one account. There is no multisig or DAO owner yet, which the treasury framing will need.

Next steps, in order:

1. Make a DAO or multisig (Sputnik DAO, Trezu) the vault owner, so rule changes and withdrawals need the treasury's own approval.
2. Run the agents with live NEAR AI Cloud inference, and show a live rejection on testnet next to the live swap.
3. Constrain the runner's signing key at the account level too, for example a function-call access key limited to `execute_swap` on the vault.
4. Move the reference-price check on chain, or bound it with an oracle.
5. A rolling 24-hour cap in place of the UTC-day cap.
6. A professional audit before any mainnet funds.

## Tracks

The track ids come from the Tracks table in `docs/HACKATHON.md` (checked against the live file on 2026-11-09; the 13 ids are unchanged). Brandon decided the tracks on 2026-11-09. Hints in that table are not requirements (Q-011), and testnet-only projects are eligible for every track (Q-010).

| Track id | Claim | One-line rationale |
| --- | --- | --- |
| `security` (AI Security & Defense) | Yes, lead | The track asks for "spending limits, policy engines, sandboxed wallets" to "Give AI money without giving it the keys to everything"; the vault is that: per-token trade and daily caps, pool allowlist, price floor, runner allowlist, pause and revoke, enforced by the contract. |
| `defi` (Unstoppable DeFi) | Yes, lead | The track lists "vaults and trading agents"; this is a vault that trades on Rhea (Ref Finance) pools, with one live testnet swap. It does not use NEAR Intents, which the track text leans on. |
| `nfts` (NFTs That Do Something) | Yes, supporting (decided by Brandon) | The personality NFT carries a sheet anchor and one token was minted live, but the vault does not check the NFT, so it supports the story and is not what the vault is scored on. |
| `business` (Autonomous Business) | No, for now | "Humans only set the constraints" matches the vault, and the user is a treasury, but nothing here is a business with sales, payments or revenue. |
| `swarms`, `agents` | No | Dropped by Brandon. What these tracks ask for does not exist here (no market, bidding or settlement between agents; no agent earns, spends or pays). |

## Submission form field drafts

The fields are the ones in `docs/HACKATHON.md` under "Submission API". That file says the human supplies every value and an agent must not guess or fill in placeholders, so the rows marked HUMAN are left empty on purpose. The drafts are suggestions for Brandon to edit. Nothing has been sent. The payload is never committed (it holds personal data), and it is printed in full for Brandon's yes before any send. One attempt per repository.

| Field | Rule | Draft |
| --- | --- | --- |
| `requestId` | UUID, generated once, reused on retries | Generate at submission time; not before. |
| `projectName` | 2-80 characters | Suggestion: `Yield Optimizer vault`. HUMAN decides. |
| `leadName` | 2-80 characters | HUMAN. |
| `email` | valid, max 160 characters | HUMAN. |
| `size` | one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | HUMAN. |
| `tracks` | one or more track ids | `["security","defi","nfts"]`, decided by Brandon 2026-11-09. |
| `nearAddress` | mainnet payout account | HUMAN. An agent never creates or invents one. The testnet accounts above are not valid here. |
| `projectUrl` | public repository URL, unique | HUMAN, after the repository is public. |
| `demoUrl` | public demo post on X | HUMAN, after Brandon publishes the post. |
| `idea` | 20-2000 characters | Draft below. |
| `consent` | `true` after the human agrees | HUMAN. Read aloud verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." |

Do not add any other field. `website` is a spam trap.

Draft for `idea` (1,535 characters; limit 2,000):

```text
Problem: a small business or DAO treasury that wants yield has to hand its tokens to a trading bot and trust every trade the bot picks.

Product: Yield Optimizer vault, a NEAR smart contract that holds the treasury's tokens and decides which trades can run. AI personality agents and a yield planner only propose swaps. The contract checks each proposal against rules the owner set on chain: a pool allowlist, a per-token max trade and daily cap, a price floor on min_amount_out, and a runner allowlist, with pause and revoke. A proposal that fails is refused with a named error such as ERR_MAX_TRADE. One that passes becomes an execute_swap on Rhea (Ref Finance).

How NEAR fits: the vault is a Rust near-sdk contract that holds NEP-141 tokens and swaps on Ref through cross-contract calls, with callbacks that check Ref's balance before crediting or rolling back. Owner, vault and runner are separate named accounts: the runner can only call execute_swap inside the limits, and only the owner can withdraw.

Live on testnet (2026-11-09): vault.near-2026-hackathon.testnet is deployed and one swap went through the rules: 0.01 wNEAR to 0.94 rft on Ref pool 0, tx B4oDeCFzeEpDaKMJe6F5rDh5F2ie2qdTKTm7YQVg24Em.

Try it: npm install && npm run yield:demo runs offline with no keys. It shows four agent proposals, the vetoes, four rule rejections with the contract's own error messages, and the one swap that passes.

Limits: testnet only, one live swap, the demo's inference is a deterministic mock, and the price-peg check is off chain.
```

Demo post (step 2 of the Procedure): Brandon writes and publishes it. It must say the project was built at NEAR HACKATHON, tag `@NEARProtocol` and `#NEARHackathon`, and carry the demo video (a video, not only screenshots, because there is no hosted demo: Q-012). The drafts in `docs/x-post.md` are now vault-first too (three drafts, each at most 280 characters, both tags, none posted); `docs/yield-demo-video-script.md` is the vault video script. A vault-first starting point (274 characters with the link counted as 23), not posted anywhere:

```text
Would you hand a trading bot your treasury? Ours can only propose. A NEAR vault contract checks each swap against on-chain limits and refuses the rest. Live on Rhea testnet. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> Which rule is missing?
```

Two things in the live `HACKATHON.md` differ from the copy in `docs/HACKATHON.md`, as reported by the fetch on 2026-11-09 (re-read the live file before submitting; it wins):

- After submission, changes go through `https://nearhackathon.com/request-changes`. Never resubmit.
- Q-000: the $10 of NEAR AI credits claimed through NEAR Builders use a separate API key and do not show in the cloud.near.ai dashboard.

## PRODUCT.md (applied)

Brandon approved the change on 2026-11-09. [`PRODUCT.md`](../../PRODUCT.md) was replaced with the vault version: the vault is the pitch, the personality agents sit under "Supporting: the personality agents", and the tracks are `security`, `defi` and `nfts`.
