# What each track gets

This file states, per track, what `main` ships, the command a judge runs, and
what they see. The outputs below were copied from real runs on `main`
(c8e48d8), offline, in mock mode. `PRODUCT.md` ("Tracks") decides which tracks
are claimed, and the human makes the final choice at submission. Today
`PRODUCT.md` and the README name `nfts`, `swarms` and `agents`. The "Build"
lines are quoted from the Tracks table in `docs/HACKATHON.md`.

Facts that hold for every track below:

- Nothing is deployed on testnet. Deploy and mint are dry runs that sign
  nothing unless a human adds `--send --i-approve`
  (`scripts/testnet-deploy.mjs`). `scripts/anchor.mjs` has no send mode; the
  only path that can send an anchor is
  `npm run live-proof -- --send --i-approve`, which has not been run.
- The demo runs mock inference only (`MOCK_INFERENCE=1`). The live client in
  `src/inference/client.mjs` (`createLiveClient`) has been tested only against
  a local stub, not NEAR AI Cloud.
- Mock agents are scripted persona lists in `src/swarm/personas.mjs`
  (`PERSONA_LINES`, `REPLY_LINES`), not models. Mock sheets come from a
  counting stand-in, `src/memory/sheet-responder.mjs`.
- Not part of any track claim: a dry-run shade / chain-signature spike
  (`spikes/shade/`, `docs/spikes/shade-agent.md`) is on `main`, and a yield vault
  is planned. Nothing in this file relies on them.

## nfts (strongest fit)

Build: "NFTs as accounts — assets that own money, earn royalties, hold
inventory, carry credentials, memberships or access rights. Ownership with
behavior."

Why it fits: each token is a NEP-171 NFT that carries a sheet anchor (hash and
memory depth) which stays with the token on transfer, and
`nft_transfer_expecting_anchor` refuses a transfer unless the anchor is the one
the caller expected.

Evidence: `contracts/personality-nft/src/lib.rs` (`nft_mint`, `anchor_sheet`,
`sheet_anchor`, `nft_transfer_expecting_anchor`). Needs a Rust toolchain.

Command:

```sh
npm run test:contract
```

The judge sees: `test result: ok. 125 passed; 0 failed` (first run compiles
the crates first). Seven of those tests name the transfer check, for example
`transfer_expecting_anchor_checks_hash_and_depth` and
`transfer_expecting_anchor_refuses_an_in_flight_token_and_works_after`; others
cover a non-owner anchor panicking and a non-sha256 hash being rejected.

Second command, no Rust needed:

```sh
npm run mint
```

The judge sees: `dry-run: nothing is signed or sent. Add --send --i-approve to
broadcast on testnet.`, then `[1/4] mint aloof` through `[4/4] mint skeptic`,
each an `nft_mint` call with NEP-177 `token_metadata` (title, description and
the trait JSON in `extra`).

What does not ship:

- The anchor check is opt-in. Plain `nft_transfer` and `nft_transfer_call`
  do not look at the anchor.
- `anchor_sheet` is advisory: the chain holds a hash, not the sheet.
- The token does not hold money, royalties, inventory or sub-accounts.

## swarms (weak fit, only the "agents interact" part)

Build: "coordination markets, bidding, collective purchasing, intent-based
settlement and emergent economies between agents."

Why it fits: four agents with different traits post and reply on one shared
channel, and every round is hash-chained so an edited transcript is detected.
That is multi-agent interaction, not a market.

Evidence: `runSwarm`, `hashRound` and `verifyRounds` in `src/swarm/runner.mjs`;
agents in `src/traits/agents.mjs`.

Command:

```sh
npm run swarm -- --rounds 3
```

The judge sees three round headers with four lines each, such as
`[Skeptic] gas is "basically free"? receipts or it did not happen. ...` and
`[Chaotic -> Skeptic] @Skeptic receipts?? bro I AM the receipts 💀`, then
`final round hash: 37f98c2d28c8a5d0a5909ec2d3a62640e2a42e4792e3063fda68790459eed944`,
`verify: ok (3 rounds)`, four `sheet <agent> round 3 <hash> ... ->
anchor_sheet dry-run (not sent)` lines, and `4 anchor dry-runs, each linked to
its round hash; ... (MOCK, not on-chain)`.

What does not ship: no bidding, payment, settlement, negotiation, hiring or
earning between agents; no coordination market or collective purchasing; NEAR
Intents and sub-accounts are not used. A judge looking for a market will not
find one.

## agents (weak fit, only the "persistent agent" part)

Build: "agents that earn, spend, negotiate, hire other agents and pay for
APIs, compute or data — with crypto directly or through NEAR Intents."

Why it fits: each agent has a persistent identity (a system prompt built from
the traits it was minted with) and a memory loop that condenses its history into
a character sheet whose hash is prepared for `anchor_sheet`. It does not
transact.

Evidence: `personaPrompt` in `src/swarm/runner.mjs`, `runMemoryLoop` in
`src/memory/loop.mjs`, the inference client in `src/inference/client.mjs`
(live mode untested against the real service).

Commands (the first writes `out/memory`, which the second reads):

```sh
npm run demo
npm run ask -- chaotic "what do you think of Skeptic?"
```

The judge sees from `ask`:
`Chaotic (mock): Skeptic?? 5 fights and counting, bro I did not read the contract and it SHOWS 💀`,
then `memory: out/memory/chaotic/log.jsonl +2 events (round 7: your question,
its answer)`, a sheet diff in which `Owner: 0 fights, 0 hugs, 1 shrug` joins the
scorecard, and `sheet chaotic round 7 e031d4f7...c89ec (+4 -4) -> anchor_sheet
dry-run (not sent)`. The demo run ends with `Open the page: open
out/index.html`. Run `npm run demo` again afterwards to reset `out/memory`.

What does not ship: agents do not earn, spend, negotiate, hire other agents or
pay for anything, and hold no funds. NEAR Intents and sub-accounts are not
used.

## privacy (not claimed)

`privacy` is not claimed. Command:

```sh
npm run attest:check
```

The judge sees `CONSISTENT, NOT VERIFIED`: an offline check of a hand-made
fixture (`src/privacy/fixture.mjs`), not a live TEE report. See
`docs/privacy.md`.

## Why there is no inter-agent economy

`PRODUCT.md` lists "Token economics or payments", "Marketplace or trading" and
"Intents" as out of scope for the Nov 11 freeze. A bidding or settlement
mechanic would also change every round hash, sheet and quote that the README
and its tests pin. The README's "Track fit, plainly" paragraph already says
there is no bidding, payment or settlement between agents.

The human has two options, and this file does not choose:

- (a) Amend `PRODUCT.md` and add a mechanic, then claim `swarms` and `agents`.
- (b) Submit `nfts` plus `open` instead of `swarms` and `agents`.
