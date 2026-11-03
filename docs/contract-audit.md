# Contract audit: personality-nft (audit 16)

Scope: `contracts/personality-nft/src/lib.rs` as on this branch after merging `main` at `edfd9f4` (the merge left `lib.rs` unchanged; every line reference below was re-checked against it; near-sdk 5.30, near-contract-standards 5.30). Earlier audits and their 20 findings are in [`docs/audit/personality-nft.md`](audit/personality-nft.md); this pass did not re-report them.

Method: an adversarial security review (access control, storage staking and refunds, panics, gas, NEP-171/177/178/181/297 compliance, the anchor pin in `nft_transfer_expecting_anchor` against plain `nft_transfer` and `nft_transfer_call`, overflow, upgrade and owner keys) and a separate review of the unit tests for gaps. Every security finding below was reproduced with a scratch unit test that fails on the audited code. No transactions were sent, nothing was deployed and no keys were used.

Result: no High or Medium security finding. The Low and Info items below are documented, not fixed. Each one comes from the stock `near-contract-standards` behaviour that this contract delegates to, or is bounded by the token supply, which only the owner can grow. The test gaps are closed with new or tightened unit tests (see "Test gaps closed").

## Findings

Line numbers are for `contracts/personality-nft/src/lib.rs` unless a path says otherwise.

| ID | Severity | Location | Finding | Status |
| --- | --- | --- | --- | --- |
| A16-S1 | Low | `lib.rs:375-384` (`nft_transfer`), `lib.rs:418-420` (`nft_transfer_call`), SDK `internal_transfer_unguarded` | A 1-yocto transfer to an account that holds no token creates that account's `tokens_per_owner` set (142 bytes in the unit-test VM, about 0.0014 NEAR). The contract account's balance pays for it, as in every stock NEP-171 contract built on `near-contract-standards`. An emptied set is removed again, so the unpaid storage is bounded by the number of distinct holders, which is at most the total supply. | Documented. Keep the contract account funded with a buffer that grows with supply (see also item 17 in the earlier audit). Reproduced by a scratch test asserting storage does not grow on such a transfer (it grew 142 bytes). |
| A16-S2 | Low | `lib.rs:510-518` (`nft_approve`), SDK `approval_impl.rs` | The SDK charges `nft_approve` only for the approved account id plus 12 bytes (17 bytes for the test account). The first approval on a token also creates the token's `approvals_by_id` and `next_approval_id_by_id` records, so real growth is 130 bytes, and the contract balance pays the difference. `nft_revoke_all` frees the map entry again, so the gap is bounded per token. | Documented. Same remedy as A16-S1. Reproduced by a scratch test (130 bytes grown, 17 charged). |
| A16-S3 | Low | `lib.rs:382`, `lib.rs:420`, SDK `near-contract-standards-5.30.0/src/non_fungible_token/core/core_impl.rs:266` | The NEP-171 `nft_transfer` event never carries `authorized_id`. The SDK sets `sender_id` only when the sender is not the owner and then keeps it only when it equals the owner, so the field is always dropped. An indexer cannot tell that an approved account (a marketplace) made the transfer. `authorized_id` is optional in NEP-171, so the event is still valid. | Documented, not fixed. A fix means re-implementing the SDK's transfer authorization (owner and approval checks) to emit our own event. That trades an optional event field for hand-written access control on the path that moves tokens. Reproduced by a scratch test (the log after an approved transfer has no `authorized_id`). |
| A16-S4 | Info | `lib.rs:375-384`, `lib.rs:397-409`, `lib.rs:323-346` | `nft_mint` refuses the contract account as receiver (`lib.rs:197-200`, earlier item 14). The transfer methods do not, so an owner can strand a token by sending it to the contract, which has no withdraw path. Only the owner's own token is affected. | Documented. Stock NEP-171 behaviour. Reproduced by a scratch test (the transfer succeeds). |
| A16-S5 | Info | `lib.rs:280-285` | `seen_hashes` is keyed by token, not by owner. A previous owner who anchored many hashes burns them for every later owner of the token. A new owner's sheets are new hashes in practice, so this only matters if a later sheet were byte-identical to an earlier one. | No change. The once-per-token rule is what stops depth inflation (earlier item 3). |
| A16-S6 | Info | `lib.rs:397-443` | The custom `nft_transfer_call` has no prepaid-gas guard, and neither does the SDK's. With less gas than the 5 + 10 Tgas of static callback gas, the call fails atomically and no lock is left. With too little left for the receiver, `nft_on_transfer` fails and the resolve returns the token. An owner with a very large approval map could make the 5 Tgas `nft_resolve_transfer` run out (same as the SDK). `release_lock` still clears the lock and reports `true` (earlier item 15). | No change. |
| A16-D1 | Info | `docs/audit/personality-nft.md` item 17, `README.md` "`nft_transfer_call` caveats" | Item 17 said the pinned lock balance is "about 0.008 NEAR per 100 tokens". At 10^19 yoctoNEAR per byte, 100 locks of about 80 bytes cost about 0.08 NEAR. The lock record is 53 bytes plus the token id's length, 54 to 117 bytes, so "about 80 bytes" was not exact either. | Fixed in both docs. `in_flight_lock_storage_is_53_bytes_plus_the_token_id` pins the size. |

## Checked and found sound

- **Access control:** `nft_mint` is owner-only. `nft_resolve_transfer` and `release_lock` are `#[private]`. `#[init]` refuses a second initialisation. `anchor_sheet` takes the current owner only, needs at least 1 yocto and honours the in-flight lock.
- **Mint:** `internal_mint_with_refund(.., None)` neither refunds nor emits, so the contract emits one `nft_mint` event and makes one refund, to the minter, for the measured storage delta (the anchor included, after `flush`).
- **Anchor storage:** `anchor_sheet` flushes both lazy maps before measuring, charges the caller for the anchor and the seen-hash record, and refunds the excess to the caller.
- **Storage keys:** the `StorageKey` prefixes do not collide with the SDK's sub-prefixes. The seen-hash key `"{token_id}:{hash}"` is unambiguous because token ids cannot contain `:` and the hash is fixed at 64 characters.
- **Lock and anchor pin:** a receiver inside `nft_on_transfer` can neither anchor, nor nest an `nft_transfer_call`, nor use `nft_transfer_expecting_anchor`. A plain `nft_transfer` or `nft_approve` by the receiver during the flight is allowed, as in stock NEP-171. The anchor stays frozen for whoever holds the token until `release_lock`. The resolve then keeps a forwarded token where it is and removes the receiver's approvals on a revert.
- **Callbacks:** the nonce stops a stale `release_lock` from clearing a later lock. `release_lock` cannot panic, and any malformed resolve result counts as `true`.
- **Arithmetic:** `memory_depth` uses `checked_add`. The lock nonce wraps without panicking. The release profile has `overflow-checks = true`.
- **Upgrade and keys:** there is no upgrade or migrate method and the minter cannot be rotated (earlier item 6). Whoever controls the contract account's full-access key controls the code.

## Test gaps closed

A test review found behaviour that no test pinned, or tests that passed for a weaker reason than their name says. No gap hid a production bug. Seven of the new or tightened tests were checked against a deliberate mutation of the production code, made temporarily and reverted: three by the author of the tests and four reproduced independently by the reviewer. No record of which tests or which mutations was kept, so this is not claimed for the rest. To re-check any one, break the production line named in the table (for example flip the hash comparison at `lib.rs:337`), run `cargo test` in `contracts/personality-nft` and expect the named test to fail, then revert.

| ID | Production code | Test |
| --- | --- | --- |
| A16-T1 | `lib.rs:427-429` arguments of `nft_on_transfer` | `transfer_call_forwards_sender_owner_and_msg_to_receiver` |
| A16-T2 | `lib.rs:336-345` approved spender with a stale anchor or a wrong approval id | `approved_spender_with_stale_anchor_cannot_sell_and_wrong_approval_id_is_rejected` |
| A16-T3 | `lib.rs:336-339` hash and depth pin, never-anchored token | `transfer_expecting_anchor_checks_hash_and_depth` (tightened) |
| A16-T4 | `lib.rs:265-268`, `340-343`, `406-409` lock messages | lock tests now match the panic message |
| A16-T5 | `lib.rs:491-505` malformed resolve results | `release_lock_never_panics_on_malformed_results_and_clears_matching_lock` |
| A16-T6 | `lib.rs:223-228`, `298-306` event JSON | `mint_emits_exactly_one_nep171_mint_event`, `anchor_event_is_exact_json_and_names_the_caller_as_owner` |
| A16-T7 | `lib.rs:626-630` URI-like length limits | `mint_overlong_uri_like_fields_panic` |
| A16-T8 | lazy `store::LookupMap` writes | `lock_and_anchor_survive_state_roundtrip` |
| A16-T9 | `lib.rs:280-285` seen-hash message | alternating-hash tests now match the message |
| A16-T10 | `lib.rs:271-275` missing anchor record | `anchor_sheet_on_token_without_anchor_record_panics` |
| A16-T11 | `lib.rs:423-424` nonce wrap | `lock_nonce_wraps_without_panicking` |
| A16-T12 | deposit and stranger panics | message-matched; `mint_with_no_extra_and_no_copies_is_accepted` |
