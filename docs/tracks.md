# What each track gets

This file states, per track, what the repository ships, the command a judge runs, and what they see. The claimed tracks are exactly `security` (AI Security & Defense), `defi` (Unstoppable DeFi) and `nfts` (NFTs That Do Something); the submission `tracks` value is `["security","defi","nfts"]`. Brandon decided this on 2026-11-09. `PRODUCT.md` ("Tracks"), the README ("Tracks and how NEAR fits") and `docs/release/RELEASE.md` ("Tracks") say the same. The "Build" lines are quoted from the Tracks table in `docs/HACKATHON.md`; hints in that table are not requirements (Q-011), and testnet-only projects are eligible for every track (Q-010).

The lead is the Yield Optimizer vault: `security` and `defi` are scored on it. `nfts` is supporting.

Facts that hold for every track below:

- One approved testnet run happened on 2026-11-09, testnet only, nothing on mainnet: the vault and the NFT contract are deployed, one NFT token (`aloof`) was minted, and one swap went through the vault's `execute_swap` on Rhea (Ref Finance). The ids, transaction hashes and explorer links are in the README section "Live on testnet", along with a read-only `curl` check. The owner sent that swap by hand from printed commands; no agent picked it, and the vault has not refused a live transaction. Rejections are shown by the contract's tests and by the offline demo.
- Everything a judge runs from this repository is offline and sends nothing. The demos run mock inference only (`MOCK_INFERENCE=1`). The live client in `src/inference/client.mjs` (`createLiveClient`) has been tested only against a local stub, not NEAR AI Cloud. The account and vault ids the demos print are placeholders, not the live accounts.
- Mock agents are scripted persona lists in `src/swarm/personas.mjs` (`PERSONA_LINES`, `REPLY_LINES`), not models. Mock sheets come from a counting stand-in, `src/memory/sheet-responder.mjs`.
- Not part of any track claim: the Shade Agent runner (cut, see the README section "Not done: Shade Agent runner"; only an offline dry run exists) and the TEE attestation fixture check.

## security (lead)

Build: "Build spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without giving it the keys to everything."

What exists: the vault contract (`contracts/yield-vault/src/lib.rs`) holds the agent's NEP-141 tokens, and the limits sit in the contract, not in the agent. The owner sets them in `VaultConfig`: a pool allowlist, a per-token `max_trade` and `daily_cap` (a token with no limit cannot be sold), a price floor per pool direction on `min_amount_out`, and a runner allowlist (`execute_swap` from any other account fails with `ERR_NOT_RUNNER`). The owner can pause the vault and revoke runners, and only the owner can withdraw. A refused proposal returns a named error (`ERR_POOL_NOT_ALLOWED`, `ERR_MAX_TRADE`, `ERR_DAILY_CAP`, `ERR_PRICE_FLOOR`, `ERR_PAUSED`). The same rules run off chain first (`src/yield/rules.mjs`) and are tested against the contract's own vectors in `contracts/yield-vault/tests/rule-vectors.json`.

Command, no Rust needed:

```sh
npm run yield:demo
```

The judge sees: four agents and a planner each propose a swap, three are refused as off the reference price, Chaotic is vetoed by Skeptic, one optimizer swap passes every check, four more proposals are rejected by the on-chain rules with the contract's own messages (`ERR_MAX_TRADE`, `ERR_DAILY_CAP`, `ERR_PRICE_FLOOR`, `ERR_PAUSED`), and the last line is `1 unsigned execute_swap call planned, 0 signed, 0 sent`. The same run is the page `out/yield-demo/index.html`. For the contract's own tests, `cd contracts/yield-vault && cargo test` (needs Rust).

What does not exist:

- No function-call access key limits the runner's signing key. The runner allowlist is enforced by the contract, not by the account's keys.
- No TEE attestation is part of the vault. The Shade Agent runner that would have used one is cut.
- No reputation or scam detection.
- The price check against a reference price runs off chain only. The contract's rule is a floor the owner sets per pool direction.
- One live swap only, sent by the owner by hand. The contract's refund and recovery paths have run only against a mock Ref. The contract was reviewed by AI review agents, not a professional auditor.

## defi (lead)

Build: "Build exchanges, perps, lending, vaults and trading agents that settle across chains through NEAR Intents. Deep liquidity, no custodian, nobody to switch it off."

What exists: a vault that holds NEP-141 tokens and swaps them only through Ref Finance pools on Rhea. A runner proposes a swap with `execute_swap`; the contract checks it against the owner's rules and, if it passes, makes the Ref swap through cross-contract promises and reconciles the result in callbacks. The planner (`node scripts/yield-optimizer.mjs`) picks among pools from a committed snapshot. Live: one swap, 0.01 wNEAR to `rft` on Ref pool 0, signed by the runner account, recorded in the README section "Live on testnet".

Command: `npm run yield:demo` (above), then the explorer page of the swap transaction or the `curl` check in the README section "Live on testnet".

What does not exist:

- NEAR Intents is not used, and nothing settles across chains. The track text leans on Intents, which has no testnet; no code in `src/`, `scripts/` or `contracts/` calls it.
- Nothing is on mainnet.
- One live swap, on a pool the owner could fund by wrapping testnet NEAR. The offline demo plans a different swap (pool 747, shallow fake-token testnet liquidity) that was never sent.
- The vault is not unstoppable in the track's sense: the owner can pause it, revoke runners and withdraw.

## nfts (supporting)

Build: "Build NFTs as accounts — assets that own money, earn royalties, hold inventory, carry credentials, memberships or access rights. Ownership with behavior."

What exists: each of the four personality agents is a NEP-171 NFT (`contracts/personality-nft/src/lib.rs`: `nft_mint`, `anchor_sheet`, `sheet_anchor`, `nft_transfer_expecting_anchor`). The token carries a sheet anchor (hash and memory depth) that stays with the token on transfer, and `nft_transfer_expecting_anchor` refuses a transfer unless the anchor is exactly the one the caller expected. The contract is deployed on testnet and one token, `aloof`, was minted in the live run (README section "Live on testnet"). Needs a Rust toolchain for the tests:

```sh
npm run test:contract
```

The judge sees `test result: ok.` with `0 failed` (the first run compiles the crates first). Several tests name the transfer check, for example `transfer_expecting_anchor_checks_hash_and_depth` and `transfer_expecting_anchor_refuses_an_in_flight_token_and_works_after`; others cover a non-owner anchor panicking and a non-sha256 hash being rejected.

Second command, no Rust needed:

```sh
npm run mint
```

The judge sees: `dry-run: nothing is signed or sent. Add --send --i-approve to broadcast on testnet.`, then `[1/4] mint aloof` through `[4/4] mint skeptic`, each an `nft_mint` call with NEP-177 `token_metadata` (title, description and the trait JSON in `extra`).

What does not exist:

- The anchor check is opt-in. Plain `nft_transfer` and `nft_transfer_call` do not look at the anchor.
- `anchor_sheet` is advisory: the chain holds a hash, not the sheet.
- The token does not hold money, royalties, inventory or sub-accounts.
- The vault records an NFT id as metadata and never checks it, so the NFT does not control the vault.
- One token minted live. The sheets come from a deterministic stand-in, not a model.

## Not claimed

`swarms`, `agents` and `privacy` are not claimed, and neither is `business`.

- `swarms` (AI Swarms). Build: "Build coordination markets, bidding, collective purchasing, intent-based settlement and emergent economies between agents." What exists is four agents taking turns on one channel (`runSwarm`, `hashRound`, `verifyRounds` in `src/swarm/runner.mjs`) with a hash chain over the rounds. There is no market, bidding, collective purchasing or settlement between agents, and NEAR Intents and sub-accounts are not used.
- `agents` (Agent Economy). Build: "Build agents that earn, spend, negotiate, hire other agents and pay for APIs, compute or data — with crypto directly or through NEAR Intents." The agents have a persistent identity and a memory loop (`runMemoryLoop` in `src/memory/loop.mjs`), but no agent earns, spends, negotiates, hires or pays, and none holds funds. In the vault, agents only propose; the runner account signs.
- `privacy` (Privacy & Private AI). `npm run attest:check` prints `CONSISTENT, NOT VERIFIED`: an offline check of a hand-made fixture (`src/privacy/fixture.mjs`), not a live TEE report. See `docs/privacy.md`. Every demo uses mock inference.
- `business` (Autonomous Business). The user is a treasury and humans set the constraints, but nothing here has sales, payments or revenue.

A bidding or settlement mechanic would also change every round hash, sheet and quote that the README and its tests pin, and `PRODUCT.md` lists Intents and mainnet as out of scope.
