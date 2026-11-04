# yield-vault

A per-personality-NFT trading vault. Each personality NFT (aloof, chaotic, social, skeptic) is an AI agent running a strategy off chain. The agent acts only through approved **runner** accounts, and this contract enforces hard limits on chain regardless of what the strategy proposes. Approved swaps run on the Rhea (Ref Finance) testnet exchange `ref-finance-101.testnet` with the deposit -> swap -> withdraw pattern. wNEAR is `wrap.testnet`.

**Status: NOT deployed.** A testnet deploy needs the human's explicit yes. Tested with unit tests only (`cargo test`).

## Interface

Init: `new(owner_id, nft_contract_id, token_id, ref_exchange_id, config: VaultConfig)`.

```
VaultConfig   { strategy, allowed_pools: [AllowedPool], max_trade: U128, daily_cap: U128, runners: [AccountId] }
AllowedPool   { pool_id: u64, token_a, token_b }
SwapProposal  { pool_id: u64, token_in, token_out, amount_in: U128, min_amount_out: U128 }
CheckResult   { ok: bool, reason: String }   // reason = "ERR_CODE: detail" when not ok
VaultState    { owner_id, nft_contract_id, token_id, ref_exchange_id, paused, swap_in_flight, day,
                spent_today: U128, balances: [(AccountId, U128)], stranded_on_ref: [(AccountId, U128)],
                swaps_executed: u64 }
```

| Method | Who | Yocto | Notes |
| --- | --- | --- | --- |
| `execute_swap(proposal) -> Promise` | runner | none | needs >= 250 TGas prepaid |
| `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>` | token contract | n/a | owner deposits of pool tokens only, else full refund |
| `withdraw(token_id, amount) -> Promise` | owner | 1 | debits, `ft_transfer` to owner, callback restores on failure |
| `pause()`, `unpause()` | owner | 1 | |
| `add_runner(id)`, `revoke_runner(id)` | owner | 1 | |
| `revoke_all_runners()` | owner | 1 | kill switch: clears runners and pauses |
| `update_config(config)` | owner | 1 | validated; rejected while a swap is in flight |
| `register_on_ref() -> Promise` | owner | payable (NEAR for Ref storage) | `storage_deposit` on Ref |
| `recover_from_ref(token_id, amount) -> Promise` | owner | 1 | pulls stranded funds back from Ref |
| `force_release_lock()` | owner | 1 | only if a swap has been in flight >= 10 min; moves the debited amount to `stranded_on_ref` |
| `get_config()`, `get_state()`, `get_balance(token_id)` | anyone | | views |
| `check_proposal(proposal, runner_id) -> CheckResult` | anyone | | same rules as `execute_swap`, no side effects |
| `on_deposit`, `on_swap`, `on_withdraw_done`, `on_owner_withdraw`, `on_recover` | self only | | private callbacks |

Consistency rule: every owner method that moves value or changes permissions requires exactly 1 yoctoNEAR (`assert_one_yocto`) after the owner check, except `register_on_ref`, which needs a real deposit. Non-owners get `ERR_NOT_OWNER` first.

## Hard rules (checked in this order)

| Rule | Error code |
| --- | --- |
| Caller is an approved runner | `ERR_NOT_RUNNER` |
| Vault not paused | `ERR_PAUSED` |
| No other swap in flight (reentrancy lock) | `ERR_SWAP_IN_FLIGHT` |
| Pool is in `allowed_pools` | `ERR_POOL_NOT_ALLOWED` |
| `token_in`/`token_out` are exactly the pool's pair (either direction, different) | `ERR_TOKEN_NOT_IN_POOL` |
| `amount_in > 0` | `ERR_ZERO_AMOUNT` |
| `min_amount_out > 0` | `ERR_ZERO_MIN_OUT` |
| `amount_in <= max_trade` | `ERR_MAX_TRADE` |
| `spent_today + amount_in <= daily_cap` | `ERR_DAILY_CAP` |
| Vault balance of `token_in >= amount_in` | `ERR_INSUFFICIENT_BALANCE` |
| Prepaid gas >= 250 TGas | `ERR_INSUFFICIENT_GAS` |

Other codes: `ERR_NOT_OWNER`, `ERR_BAD_CONFIG` (strategy not one of the four, `max_trade == 0`, `daily_cap < max_trade`, duplicate pool or runner, `token_a == token_b`), `ERR_RUNNER_EXISTS`, `ERR_RUNNER_NOT_FOUND`, `ERR_DEPOSIT_REQUIRED`, `ERR_INSUFFICIENT_STRANDED`, `ERR_NO_SWAP_IN_FLIGHT`, `ERR_LOCK_NOT_STALE`, `ERR_PRIVATE_CALLBACK`, `ERR_OVERFLOW`. Rejections panic, so no log survives; they show up as failed transactions. `check_proposal` returns the same code in `reason`.

The day is `block_timestamp / 86_400 s` (UTC). The counter resets on the first swap or view of a new day. **Simplification:** the daily cap is counted in `token_in` units of each swap, summed across tokens without conversion.

`min_amount_out > 0` is a floor, not a price check: the vault does not know prices, so the runner supplies a meaningful minimum and Ref enforces it.

## Promise chain and gas

```
execute_swap  (>= 250 TGas prepaid; debits balance + spent_today, sets lock)
 -> token_in.ft_transfer_call(ref, amount_in, "")   70 TGas, 1 yocto   (deposit into the vault's Ref account)
 -> on_deposit                                     160 TGas  (own ~10, then:)
     -> ref.swap({actions:[{pool_id,token_in,token_out,amount_in,min_amount_out}], referral_id:null})
                                                    50 TGas, 1 yocto
     -> on_swap                                    100 TGas  (own ~10, then:)
         -> ref.withdraw({token_id: token_out, amount: amount_out, unregister:null, skip_unwrap_near:true})
                                                    40 TGas, 1 yocto
         -> on_withdraw_done                        15 TGas  (credits balance[token_out], releases lock, emits swap_executed)
```

The owner must call `register_on_ref` once (Ref requires storage registration) before the first swap.

## Failure handling

All callbacks use `#[callback_result]` (or `promise_result_checked`) and never panic on a failed step. Every failure releases the lock and emits `swap_failed`.

| Step failed | Funds | Action |
| --- | --- | --- |
| Deposit failed or used amount 0 | still with the vault | roll back the debit and the day spend (day spend only if the day has not rolled) |
| Deposit used less than `amount_in` | remainder with the vault | refund the remainder, swap only the used part |
| `ref.swap` failed | token_in is on Ref | `stranded_on_ref[token_in] += amount`, `stranded` event |
| `amount_out < min_amount_out` (or 0) | token_out is on Ref | `stranded_on_ref[token_out] += amount_out` |
| `ref.withdraw` failed | token_out is on Ref | `stranded_on_ref[token_out] += amount_out` |
| Callback never ran (e.g. out of gas) | unknown | after 10 minutes the owner calls `force_release_lock`; each swap carries an id passed to its callbacks, so late callbacks of a released swap are no-ops |

The owner recovers stranded funds with `recover_from_ref(token_id, amount)`. A failed recovery restores the stranded record.

Known limitations:

- A failed `ft_transfer_call` is treated as "tokens still with the vault". If only the final resolve step fails, tokens could be on Ref while the vault credits them back. The owner can see this in Ref's `get_deposits`.
- Ref's `withdraw` callback may swallow an inner `ft_transfer` failure and report success. The vault then credits a balance it does not hold. A later swap or withdraw of that token would fail harmlessly (the token contract rejects it). Reconcile with `ft_balance_of` off chain.
- No on-chain price oracle, so slippage beyond `min_amount_out > 0` is the runner's responsibility.

## Events

NEP-297, `standard: "yield_vault"`, `version: "1.0.0"`: `deposit`, `withdraw`, `withdraw_failed`, `swap_proposed`, `swap_executed`, `swap_failed`, `stranded`, `recovered`, `paused`, `unpaused`, `runner_added`, `runner_revoked`, `config_updated`.

## Develop

```
cd contracts/yield-vault
cargo test                                          # 91 unit tests
cargo clippy --all-targets
cargo build --target wasm32-unknown-unknown --release
```
