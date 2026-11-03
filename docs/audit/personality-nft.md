# Audit: contracts/personality-nft

Scope: `contracts/personality-nft/src/lib.rs` (near-sdk 5.30, near-contract-standards 5.30).
Method: manual review against the NEAR audit checklist, plus unit tests for every
finding below (`cargo test` in the contract dir, 43 tests). No transactions were
sent and no keys were used.

Public method names are unchanged. `anchor_sheet` and `nft_mint` gained new
panic conditions (listed below); their signatures are the same.

## Findings

| # | Severity | Location | Finding | Status |
| --- | --- | --- | --- | --- |
| 1 | Medium | `nft_mint` | No bounds on `token_id` or any `TokenMetadata` string. A mint could store arbitrarily large metadata, bloating storage and making every `nft_token` / `nft_tokens` view (and the viewer that calls it) heavy. `extra` could also be non-JSON, breaking consumers that parse traits. | Fixed: token_id 1-64 bytes, title 128, description 1024, extra 2048 and must be a JSON object, media/reference/date strings 512. |
| 2 | Medium | `anchor_sheet` | Re-anchoring the same hash still bumped `memory_depth`, so the owner could inflate the token's "reputation" for 1 yoctoNEAR without any new sheet. A seller could pump depth before a sale. | Fixed: re-anchoring the current hash panics. |
| 3 | Low | `anchor_sheet` | Owner can still alternate between two hashes to raise depth. Depth proves "anchored N times", not "N genuine summaries". | Accepted, by design: depth is a counter. Buyers must check the hash and, off-chain, the history. |
| 4 | Low | `anchor_sheet` / sale flow | Front-running a sale: the seller can anchor a different sheet just before `nft_transfer`. The buyer's pre-trade check can go stale. | Accepted/documented. Mitigation is off-chain: re-read `sheet_anchor` in the same block as the transfer, or use a marketplace that pins the hash. |
| 5 | Low | `new` / `new_default_meta` | Initialization is public. Whoever calls it first picks the owner. `#[init]` blocks a second call, but deploy and init must be one batch. | Operational: deploy with `--initFunction new_default_meta` (testnet-deploy). |
| 6 | Low | contract | `owner_id` (minter) is immutable; no rotation. A lost key means no more mints. Existing tokens are unaffected. | Accepted for a hackathon. |
| 7 | Info | views | `nft_tokens*` take a caller-chosen `limit`; a huge limit only affects the caller's own view call. | No change. |
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
