# What each track gets

This file states what the repository ships for each track it plans to claim.
`PRODUCT.md` ("Tracks") decides which tracks are claimed, and the human makes
the final choice at submission. Today `PRODUCT.md` and the README name
`nfts`, `swarms` and `agents`; the sections below say how far each is met.
The "Build" lines are quoted from the Tracks table in `docs/HACKATHON.md`.

Facts that hold for every track below:

- Nothing is deployed on testnet. Deploy and mint are dry runs that sign
  nothing unless a human adds `--send` (`scripts/testnet-deploy.mjs`).
  `scripts/anchor.mjs` has no send mode; the only path that can send an
  anchor is `npm run live-proof -- --send --i-approve`, which has not been
  run.
- The demo runs mock inference only (`MOCK_INFERENCE=1`). The live client in
  `src/inference/client.mjs` (`createLiveClient`) has been tested only against
  a local stub, not NEAR AI Cloud.
- Mock agents are scripted persona lists in `src/swarm/personas.mjs`
  (`PERSONA_LINES`, `REPLY_LINES`), not models. Mock sheets come from a
  counting stand-in, `src/memory/sheet-responder.mjs`.

## nfts

Build: "NFTs as accounts — assets that own money, earn royalties, hold
inventory, carry credentials, memberships or access rights. Ownership with
behavior."

What ships:

- `contracts/personality-nft/src/lib.rs`: a NEP-171 contract with
  `nft_mint`, `anchor_sheet` (token owner only, 64-hex sha256, one distinct hash
  per token, memory depth +1) and the `sheet_anchor` view.
- The anchor is keyed by token id, so it stays with the token on transfer.
- `nft_transfer_expecting_anchor` is `nft_transfer` that panics unless the
  anchor equals `(expected_hash, expected_depth)` and the token is not in an
  unresolved `nft_transfer_call`.

What does not:

- The anchor check is opt-in. Plain `nft_transfer` and `nft_transfer_call`
  do not look at the anchor, so a transfer through them succeeds whatever the
  anchor says. Only `nft_transfer_expecting_anchor` checks it, and only when
  the caller uses that method.
- `anchor_sheet` is advisory: the chain holds a hash, not the sheet.
- The token does not hold money, royalties, inventory or sub-accounts.

## swarms

Build: "coordination markets, bidding, collective purchasing, intent-based
settlement and emergent economies between agents."

What ships:

- `runSwarm` in `src/swarm/runner.mjs`: four agents (`src/traits/agents.mjs`)
  post and reply on one channel, each once per round in a seed-derived order.
- `hashRound` and `verifyRounds`: a hash chain over the rounds, so an edited
  transcript is detected. Mock runs are reproducible from the seed.

What does not:

- No bidding, payment, settlement, negotiation, hiring or earning between
  agents. A turn is a post or a reply, nothing else.
- No coordination market or collective purchasing.
- NEAR Intents and sub-accounts are not used.

## agents

Build: "agents that earn, spend, negotiate, hire other agents and pay for
APIs, compute or data — with crypto directly or through NEAR Intents."

What ships:

- Each agent has a system prompt built from its trait definition in
  `src/traits/agents.mjs`, the same traits the token is minted with
  (`personaPrompt` in `src/swarm/runner.mjs`). The prompt is not read from
  the chain.
- `runMemoryLoop` in `src/memory/loop.mjs` condenses each agent's history
  into a character sheet, whose hash is prepared for `anchor_sheet`.
- An inference client for NEAR AI Cloud (`src/inference/client.mjs`), live
  mode untested against the real service.

What does not:

- Agents do not earn, spend, negotiate, hire other agents or pay for
  anything, and hold no funds. NEAR Intents and sub-accounts are not used.

## privacy (not claimed)

`privacy` is not claimed. `npm run attest:check` runs the offline check in
`src/privacy/attestation.mjs` against a hand-made fixture
(`src/privacy/fixture.mjs`), not a live TEE report. It prints `CONSISTENT,
NOT VERIFIED`. See `docs/privacy.md`.

## Why there is no inter-agent economy

`PRODUCT.md` lists "Token economics or payments", "Marketplace or trading" and
"Intents" as out of scope for the Nov 11 freeze. A bidding or settlement
mechanic would also change every round hash, sheet and quote that the README
and its tests pin. The README's "Track fit, plainly" paragraph already says
there is no bidding, payment or settlement between agents.

The human has two options, and this file does not choose:

- (a) Amend `PRODUCT.md` and add a mechanic, then claim `swarms` and `agents`.
- (b) Submit `nfts` plus `open` instead of `swarms` and `agents`.
