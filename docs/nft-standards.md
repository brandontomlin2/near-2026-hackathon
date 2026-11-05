# NEAR NFT standards compliance

The contract at `contracts/personality-nft` is built on `near-contract-standards` 5.30. It implements NEP-171 (core), NEP-177 (metadata), NEP-178 (approvals), NEP-181 (enumeration) and NEP-297 (events). Run `npm run test:contract` (needs Rust) to execute every test named below. `npm run build:contract` produces `contracts/personality-nft/target/near/personality_nft.wasm`. Tests live in the `tests` module of `contracts/personality-nft/src/lib.rs`.

## Method coverage

| Method / behaviour | Standard | Test(s) |
| --- | --- | --- |
| `nft_transfer` | NEP-171 | `transfer_without_yocto_panics`, `approved_transfer_with_wrong_approval_id_panics`, `transfer_to_self_panics` |
| `nft_transfer` clears approvals | NEP-171 | `approved_account_transfers_with_right_approval_id_and_approvals_clear` |
| `nft_transfer_call` | NEP-171 | `transfer_call_forwards_sender_owner_and_msg_to_receiver`, `transfer_call_without_yocto_panics`, `transfer_call_with_two_yocto_panics` |
| `nft_resolve_transfer` | NEP-171 | `resolve_treats_failed_or_garbage_receiver_result_as_return_the_token`, `resolve_success_keeps_token_with_receiver_and_clears_lock`, `revert_drops_approvals_the_receiver_added_and_restores_the_owners` |
| `nft_token` | NEP-171 | `nft_token_shape_and_collection_metadata_follow_nep177`, `views_on_unknown_token_or_account_are_empty_not_panics` |
| `nft_metadata` | NEP-177 | `nft_token_shape_and_collection_metadata_follow_nep177`, `metadata_is_valid_and_owner_is_recorded` |
| `nft_approve` | NEP-178 | `approve_without_any_deposit_panics`, `approve_with_msg_schedules_nft_on_approve_with_the_issued_id`, `non_owner_cannot_approve` |
| `nft_revoke` | NEP-178 | `revoke_and_revoke_all_require_exactly_one_yocto`, `stranger_cannot_revoke` |
| `nft_revoke_all` | NEP-178 | `revoke_all_removes_every_approval`, `revoke_and_revoke_all_require_exactly_one_yocto` |
| `nft_is_approved` | NEP-178 | `approval_ids_increment_per_token_and_never_reset_on_transfer`, `nft_is_approved_on_unknown_token_panics` |
| `nft_total_supply` | NEP-181 | `enumeration_pagination_bounds_follow_the_reference_implementation`, `enumeration_follows_a_transfer` |
| `nft_tokens` | NEP-181 | `enumeration_pagination_bounds_follow_the_reference_implementation` |
| `nft_supply_for_owner` | NEP-181 | `enumeration_follows_a_transfer` |
| `nft_tokens_for_owner` | NEP-181 | `enumeration_pagination_bounds_follow_the_reference_implementation`, `enumeration_follows_a_transfer` |
| `nft_mint` event (`nft_mint`) | NEP-297 | `mint_emits_exactly_one_nep171_mint_event` |
| `nft_transfer` event | NEP-297 | `transfer_event_is_exact_nep171_json_with_memo` |
| Refund event (reverse transfer on failed `nft_transfer_call`) | NEP-297 | `transfer_call_emits_transfer_event_and_revert_emits_the_reverse_event` |
| `nft_mint` | project | `mint_stores_token_traits_and_initial_anchor`, `mint_by_non_owner_panics`, `mint_without_storage_deposit_panics` |
| `anchor_sheet` | project | `anchor_sheet_by_token_owner_updates_hash_and_depth`, `anchor_sheet_by_contract_owner_panics`, `anchor_sheet_rejects_non_sha256_hash` |
| `anchor_sheet` event | project | `anchor_event_is_exact_json_and_names_the_caller_as_owner` |
| `sheet_anchor` | project | `sheet_anchor_for_unknown_token_is_none`, `mint_stores_token_traits_and_initial_anchor` |
| `nft_transfer_expecting_anchor` | project | `transfer_expecting_anchor_without_yocto_panics`, `transfer_expecting_anchor_clears_approvals`, `transfer_expecting_anchor_refuses_an_in_flight_token_and_works_after` |
| `nft_in_flight` | project | `nft_in_flight_view_tracks_the_lock` |
| `release_lock` | project | `release_lock_forwards_resolve_result_and_survives_a_failed_resolve`, `release_lock_never_panics_on_malformed_results_and_clears_matching_lock`, `stale_callback_cannot_clear_a_later_transfers_lock` |

The custom events (anchor) use their own standard name, `personality_nft` 1.0.0, not an `nep171` event.

## Known deviations

- `authorized_id` is never set in `nft_transfer` events. The SDK drops it, and the field is optional in NEP-297/NEP-171. Accepted as A16-S3 in `docs/contract-audit.md`.
- `nft_tokens_for_owner` panics when `from_index` is greater than or equal to the owner's token count (for an owner with tokens). This matches the reference implementation. `nft_tokens` accepts `from_index` equal to supply and returns an empty list.
- A second `nft_transfer_call` on a token that is already in flight is refused until `release_lock` runs. This is the in-flight lock; see README "`nft_transfer_call` caveats" and `docs/audit/personality-nft.md`.
- There is no burn method, so there is no `nft_burn` event.
