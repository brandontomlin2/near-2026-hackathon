# Audit: contracts/personality-nft

Scope: `contracts/personality-nft/src/lib.rs` (near-sdk 5.30, near-contract-standards 5.30).
Method: manual review against the NEAR audit checklist, plus unit tests for every
finding below (`cargo test` in the contract dir, 64 tests). No transactions were
sent and no keys were used.

**State layout:** the contract state layout changed in audit 2 and its follow-up (`seen_hashes`, `in_flight` with block height and nonce, `next_lock_nonce`). Nothing is deployed yet, so no migration is needed.

Public method names are unchanged. `anchor_sheet` and `nft_mint` gained new
panic conditions (listed below); their signatures are the same.

## Findings

| # | Severity | Location | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | Medium | `nft_mint` | No bounds on `token_id` or any `TokenMetadata` string. A mint could store arbitrarily large metadata, bloating storage and making every `nft_token` / `nft_tokens` view (and the viewer that calls it) heavy. `extra` could also be non-JSON, breaking consumers that parse traits. | Fixed: token_id 1-64 bytes, title 128, description 1024, extra 2048 and must be a JSON object, media/reference/date strings 512. |
| 2 | Medium | `anchor_sheet` | Re-anchoring the same hash still bumped `memory_depth`, so the owner could inflate the token's "reputation" for 1 yoctoNEAR without any new sheet. A seller could pump depth before a sale. | Fixed: re-anchoring the current hash panics. |
| 3 | Low | `anchor_sheet` | Owner can still alternate between two hashes to raise depth. Depth proves "anchored N times", not "N genuine summaries". | Fixed (audit 2, M3): a hash can be anchored once per token, so alternating A, B, A, B is rejected. Depth is still advisory (no sheet contents on chain). |
| 4 | Low | `anchor_sheet` / sale flow | Front-running a sale: the seller can anchor a different sheet just before `nft_transfer`. The buyer's pre-trade check can go stale. | Mitigated (audit 2, M2): `nft_transfer_expecting_anchor` reverts if the anchor differs from the expected `(hash, depth)`; README tells buyers to pin the anchor. |
| 5 | Low | `new` / `new_default_meta` | Initialization is public. Whoever calls it first picks the owner. `#[init]` blocks a second call, but deploy and init must be one batch. | Operational: deploy with `--initFunction new_default_meta` (testnet-deploy). |
| 6 | Low | contract | `owner_id` (minter) is immutable; no rotation. A lost key means no more mints. Existing tokens are unaffected. | Accepted for a hackathon. |
| 7 | Info | views | `nft_tokens*` take a caller-chosen `limit`; a huge limit only affects the caller's own view call. | No change. |
| 9 | Low | `validate_token_metadata` | `media_hash` / `reference_hash` were unbounded `Base64VecU8`, allowing view bloat (self-grief by the minter). | Fixed: each must be `None` or exactly 32 bytes (sha256). |
| 10 | Low | `scripts/testnet-deploy.mjs` | `deploy --send` defaulted the contract account to `NEAR_ACCOUNT_ID`, which could overwrite the owner's personal account code. | Fixed: `deploy --send` requires an explicit `NEAR_CONTRACT_ACCOUNT_ID`; dry-run unchanged. |
| 11 | Info | `validate_token_id` | Contract accepted any 1-64 byte id; JS builders only accept `[a-z0-9_-]`. | Fixed: contract now enforces the same charset. |
| 12 | Info | contract | Follow-up audit notes, no change: no owner rotation/migration (see #6); validation order in `anchor_sheet` runs hash/deposit checks before the ownership check (harmless); refund dust of <= 1 yocto per call is kept by the contract; JS first-anchor deposit (0.01 NEAR) is generous but excess is refunded; mint deposit (0.05 NEAR) is refunded minus storage. | No change. |
| 13 | Medium | `nft_transfer_call` / `anchor_sheet` | The receiver owns the token during `nft_on_transfer` and could re-anchor, then revert the transfer, leaving the original owner with a tampered anchor. | Fixed (audit 2, M1): the token is frozen for `anchor_sheet` while in flight (cleared in `nft_resolve_transfer`); a nested `nft_transfer_call` is rejected. Follow-up: the lock stores its block height and expires after `IN_FLIGHT_EXPIRY_BLOCKS` (1000, about 17 minutes), so a failed `nft_resolve_transfer` callback cannot freeze the anchor forever. Follow-up 2 (fixed): a late callback of an earlier transfer could clear the lock of a later one. Each lock now stores a per-transfer nonce (`next_lock_nonce`, wrapping, never panics). `nft_transfer_call` is reimplemented on `internal_transfer` and keeps the NEP-171 callback shape: it schedules the standard `nft_resolve_transfer` (unchanged name, signature and 5 Tgas budget, so wallets and indexers that match on it keep working) and chains a second private callback, `release_lock(token_id, nonce)` (5 Tgas), after it. The standard callback's fixed arguments leave no room for the nonce, so the chained callback carries it: it clears the lock only if the stored nonce matches, never panics, and forwards the resolve result as the NEP-171 bool (a resolve that ran out of gas counts as completed, since ownership was not rolled back). A stale callback still settles its own transfer but leaves a newer lock alone. `nft_resolve_transfer` never touches the lock. Cost: 8 more bytes per lock, freed on clear; an uncleared lock is overwritten after expiry, so no token can freeze. Tests: `transfer_call_schedules_standard_resolve_then_release_lock_with_its_nonce` (receipt chain and nonce via `get_created_receipts`), `release_lock_forwards_resolve_result_and_survives_a_failed_resolve`, `stale_callback_cannot_clear_a_later_transfers_lock`. |
| 14 | Low | `nft_mint` / metadata | Mint to the contract account itself strands the token; `copies` unchecked. | Fixed (audit 2, L2, L4): receiver must not be the contract account; `copies` must be 1. |
| 8 | Info | `nft_resolve_transfer` | Marked `#[private]` by the macro. The check is in the generated wrapper, so it cannot be hit from a plain Rust unit test. Covered by SDK. | No change. |

## Checked and found sound

- **Mint auth**: only `owner_id` can mint (test: `mint_by_non_owner_panics`).
- **Token id collisions**: duplicate id panics before any write; the existing
  owner and anchor are untouched (`duplicate_mint_cannot_reset_anchor_or_owner`).
  `LookupMap` keyed by token id with a distinct `StorageKey` prefix, no prefix collisions.
- **Storage deposits**: the minter pays for token + anchor storage, the excess is
  refunded to the minter (not the receiver), and `internal_mint_with_refund(.., None)`
  is used so the refund happens once (`mint_charges_exact_storage_and_refunds_the_rest`,
  `anchor_refunds_excess_deposit_to_the_token_owner`). Insufficient deposit panics
  (`mint_with_half_the_storage_cost_panics`, `first_anchor_with_only_one_yocto_cannot_cover_new_storage`).
- **Transfer**: needs exactly 1 yocto, owner or an approved account with the right
  approval id; transfer to self rejected; approvals are cleared on transfer so a
  previous spender cannot take the token back.
- **Approvals**: only the owner can approve/revoke; revoked accounts lose the right
  to transfer; an approved account cannot approve others.
- **Sheet-hash anchoring permission**: only the *current* token owner. Not the
  contract owner, not an approved account, not the previous owner after transfer.
  The anchor is keyed by token id so it follows the token. Hash must be
  64 lowercase hex chars. Requires >= 1 yocto, which excludes function-call keys.
- **Arithmetic**: `memory_depth` uses `checked_add`; release profile has `overflow-checks = true`.
- **Reentrancy / callbacks**: no cross-contract calls added beyond the standard
  `nft_transfer_call` / `nft_approve` flows.

## Tests added

`cargo test` in `contracts/personality-nft`: 43 pass (11 existing, 32 new), clippy clean,
release wasm builds.
