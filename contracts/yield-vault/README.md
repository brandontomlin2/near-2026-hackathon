# yield-vault

A per-personality-NFT trading vault. Each personality NFT (aloof, chaotic, social, skeptic) is an AI agent running a strategy off chain. The agent acts only through approved **runner** accounts, and this contract enforces hard limits on chain regardless of what the strategy proposes. Approved swaps run on the Rhea (Ref Finance) testnet exchange `ref-finance-101.testnet` with the deposit -> swap -> withdraw pattern. wNEAR is `wrap.testnet`.

**Status: NOT deployed.** A testnet deploy needs the human's explicit yes. Tested with unit tests only (`cargo test`, 126 tests). See "Known risks".

## Interface

Init: `new(owner_id, nft_contract_id, token_id, ref_exchange_id, config: VaultConfig)`. The caller must be the contract account itself (`ERR_PRIVATE_INIT`), so deploy and init belong in one batch transaction signed by the contract account.

```
VaultConfig   { strategy, allowed_pools: [AllowedPool], limits: [TokenLimit], runners: [AccountId] }
AllowedPool   { pool_id: u64, token_a, token_b, min_rate_a_to_b: Rate, min_rate_b_to_a: Rate }
Rate          { num: U128, den: U128 }          // floor: min_amount_out * den >= amount_in * num
TokenLimit    { token_id, max_trade: U128, daily_cap: U128 }   // per token_in, in that token's base units
SwapProposal  { pool_id: u64, token_in, token_out, amount_in: U128, min_amount_out: U128 }
CheckResult   { ok: bool, reason: String }   // reason = "ERR_CODE: detail" when not ok
VaultState    { owner_id, nft_contract_id, token_id, ref_exchange_id, paused, swap_in_flight, day,
                spent_today: [(AccountId, U128)], balances: [(AccountId, U128)],
                stranded_on_ref: [(AccountId, U128)], swaps_executed: u64 }
```

A token with no `limits` entry cannot be sold (`ERR_NO_LIMIT`). `spent_today` is tracked per token. Each pool carries an owner-set price floor per direction.

| Method | Who | Yocto | Notes |
| --- | --- | --- | --- |
| `execute_swap(proposal) -> Promise` | runner | none | needs >= 270 TGas prepaid |
| `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>` | token contract | n/a | owner deposits of pool tokens only, else full refund |
| `withdraw(token_id, amount) -> Promise` | owner | 1 | debits, `ft_transfer` to owner, callback restores on failure |
| `pause()`, `unpause()` | owner | 1 | |
| `add_runner(id)`, `revoke_runner(id)` | owner | 1 | |
| `revoke_all_runners()` | owner | 1 | kill switch: clears runners and pauses |
| `update_config(config)` | owner | 1 | validated; rejected while a swap is in flight (`ERR_SWAP_IN_FLIGHT`) |
| `register_on_ref() -> Promise` | owner | payable (NEAR for Ref storage) | `storage_deposit` on Ref |
| `recover_from_ref(token_id, amount) -> Promise` | owner | 1 | pulls stranded funds back from Ref; rejected while a swap is in flight (`ERR_SWAP_IN_FLIGHT`) |
| `force_release_lock()` | owner | 1 | only if a swap has been in flight >= 10 min; moves the debited amount to `stranded_on_ref` |
| `get_config()`, `get_state()`, `get_balance(token_id)` | anyone | | views |
| `check_proposal(proposal, runner_id) -> CheckResult` | anyone | | same rules as `execute_swap` except the gas check, no side effects |
| `on_deposit`, `on_deposit_reconciled`, `on_swap`, `on_withdraw_done`, `on_withdraw_reconciled`, `on_owner_withdraw`, `on_recover`, `on_recover_reconciled` | self only | | private callbacks |

Consistency rule: every owner method that moves value or changes permissions requires exactly 1 yoctoNEAR (`assert_one_yocto`) after the owner check, except `register_on_ref`, which needs a real deposit. Non-owners get `ERR_NOT_OWNER` first.

## Hard rules (checked in this order)

`check_proposal` and `execute_swap` run the same function, in this order:

| # | Rule | Error code |
| --- | --- | --- |
| 1 | Caller is an approved runner | `ERR_NOT_RUNNER` |
| 2 | Vault not paused | `ERR_PAUSED` |
| 3 | No other swap in flight (reentrancy lock) | `ERR_SWAP_IN_FLIGHT` |
| 4 | Pool is in `allowed_pools` | `ERR_POOL_NOT_ALLOWED` |
| 5 | `token_in`/`token_out` are exactly the pool's pair (either direction) | `ERR_TOKEN_NOT_IN_POOL` |
| 6 | `amount_in > 0` | `ERR_ZERO_AMOUNT` |
| 7 | `min_amount_out > 0` | `ERR_ZERO_MIN_OUT` |
| 8 | `min_amount_out * den >= amount_in * num` for the pool's direction (256-bit compare, no overflow) | `ERR_PRICE_FLOOR` |
| 9 | `token_in` has a `limits` entry | `ERR_NO_LIMIT` |
| 10 | `amount_in <= max_trade` of that token | `ERR_MAX_TRADE` |
| 11 | `spent_today[token_in] + amount_in <= daily_cap` of that token | `ERR_DAILY_CAP` |
| 12 | Vault balance of `token_in >= amount_in` | `ERR_INSUFFICIENT_BALANCE` |

After the rules, `execute_swap` (not `check_proposal`) also requires prepaid gas >= 270 TGas (`ERR_INSUFFICIENT_GAS`).

Other codes: `ERR_NOT_OWNER`, `ERR_PRIVATE_INIT` (`new` called by anyone but the contract account), `ERR_BAD_CONFIG` (strategy not one of the four, a limit with `max_trade == 0`, `daily_cap < max_trade`, duplicate limit token, rate `num` or `den` equal to 0, `token_a == token_b`, duplicate pool, duplicate runner), `ERR_RUNNER_EXISTS`, `ERR_RUNNER_NOT_FOUND`, `ERR_DEPOSIT_REQUIRED`, `ERR_INSUFFICIENT_STRANDED`, `ERR_NO_SWAP_IN_FLIGHT`, `ERR_LOCK_NOT_STALE`, `ERR_PRIVATE_CALLBACK`, `ERR_OVERFLOW`. `ERR_ZERO_AMOUNT` and `ERR_INSUFFICIENT_BALANCE` are also raised by `withdraw` and `recover_from_ref` (zero amount) and by the balance debit. Rejections panic, so no log survives; they show up as failed transactions. `check_proposal` returns the same code in `reason`.

The day is `block_timestamp / 86_400 s` (UTC). The per-token counters reset on the first swap of a new day; `get_state` shows an empty `spent_today` once the stored day is stale.

Limits are in each token's own base units and are never summed across tokens. The price floor is a static owner-set rate per pool and direction, not a live quote: it bounds how bad a price a runner can accept, it does not track the market. The runner still chooses the actual `min_amount_out` at or above the floor, and Ref enforces it.

## Promise chain and gas

```
execute_swap  (>= 270 TGas prepaid; debits balance + spent_today, sets lock)
 -> token_in.ft_transfer_call(ref, amount_in, "")   70 TGas, 1 yocto   (deposit into the vault's Ref account)
 -> on_deposit                                     170 TGas  (own ~10, then:)
     -> ref.swap({actions:[{pool_id,token_in,token_out,amount_in,min_amount_out}], referral_id:null})
                                                    50 TGas, 1 yocto
     -> on_swap                                    100 TGas  (own ~10, then:)
         -> ref.withdraw({token_id: token_out, amount: amount_out, unregister:null, skip_unwrap_near:true})
                                                    40 TGas, 1 yocto
         -> on_withdraw_done                        40 TGas  (own ~10, then:)
             -> ref.get_deposit(vault, token_out)   10 TGas, view
             -> on_withdraw_reconciled              15 TGas  (credits balance[token_out], releases lock, emits swap_executed)
```

Reconciliation branches:

- `on_deposit` with a failed `ft_transfer_call` result: `ref.get_deposit(vault, token_in)` (10 TGas) -> `on_deposit_reconciled` (15 TGas).
- `recover_from_ref`: `ref.withdraw` (40 TGas) -> `on_recover` (40 TGas) -> `ref.get_deposit` (10 TGas) -> `on_recover_reconciled` (15 TGas).
- Owner `withdraw`: `ft_transfer` (30 TGas) -> `on_owner_withdraw` (15 TGas).

The owner must call `register_on_ref` once (Ref requires storage registration) before the first swap.

## Failure handling

All callbacks use `#[callback_result]` (or `promise_result_checked`) and never panic on a failed step. Every failure of a swap releases the lock and emits `swap_failed`. Each swap carries an id passed to its callbacks, so a late callback of a force-released swap is a no-op.

A failed promise result is not trusted as proof of what happened. The vault asks Ref for `get_deposit(vault, token)` and compares it with a baseline of `stranded[token] + amount`.

| Step failed | Funds | Action |
| --- | --- | --- |
| `ft_transfer_call` failed, Ref deposit below baseline | still with the vault | roll back the debit and the day spend (day spend only if the day has not rolled); `swap_failed: deposit_failed` |
| `ft_transfer_call` failed, Ref deposit at or above baseline | on Ref | `stranded_on_ref[token_in] += amount`; reason `deposit_landed_on_ref` |
| `ft_transfer_call` failed, `get_deposit` also failed | unknown | `stranded_on_ref[token_in] += amount`; reason `deposit_unverified` |
| Deposit reported used amount 0 | still with the vault | roll back the debit and day spend; `deposit_failed` |
| Deposit used less than `amount_in` | remainder with the vault | refund the remainder, swap only the used part |
| `ref.swap` failed | token_in is on Ref | `stranded_on_ref[token_in] += amount`, `stranded` event |
| `amount_out < min_amount_out` (or 0) | token_out is on Ref | `stranded_on_ref[token_out] += amount_out` |
| `ref.withdraw` failed | token_out is on Ref | `stranded_on_ref[token_out] += amount_out`; `withdraw_failed` |
| `ref.withdraw` ok but Ref deposit still at or above baseline | token_out still on Ref | strand, reason `withdraw_not_reconciled`; no credit |
| `ref.withdraw` ok but `get_deposit` failed | unknown | strand, reason `withdraw_unverified`; no credit |
| Callback never ran (e.g. out of gas) | unknown | after 10 minutes the owner calls `force_release_lock`, which strands the debited amount (token_out if `amount_out` is already known, else token_in) |

Balance is credited after a withdraw only once `get_deposit` shows the funds left Ref. This covers Ref's `withdraw`, which can re-credit its internal balance and still return success when the token transfer fails.

The owner recovers stranded funds with `recover_from_ref(token_id, amount)`, only while no swap is in flight. The stranded record is reduced up front. A failed withdraw restores it. A withdraw that succeeds but is not confirmed by `get_deposit` strands it again (`withdraw_not_reconciled` or `withdraw_unverified`) instead of crediting. Success credits the balance and emits `recovered`.

Other limitation: there is no on-chain market price. Slippage is bounded only by the owner-set per-pool floor and the runner's `min_amount_out`.

## Events

NEP-297, `standard: "yield_vault"`, `version: "1.0.0"`: `deposit`, `withdraw`, `withdraw_failed`, `swap_proposed`, `swap_executed`, `swap_failed`, `stranded`, `recovered`, `paused`, `unpaused`, `runner_added`, `runner_revoked`, `config_updated`.

## Develop

```
cd contracts/yield-vault
cargo test                                          # 126 unit tests
cargo clippy --all-targets
cargo build --target wasm32-unknown-unknown --release
```

## Known risks

Source: an independent audit of the earlier version (`/Users/brandont/.claude-loop/logs/review-vault-audit20.md`). No audit has been done on the code after the fixes.

Fixed after the audit:

- High, phantom balance after Ref `withdraw` (swap and recovery): credit only after Ref `get_deposit` shows the funds left Ref; otherwise strand (`withdraw_not_reconciled`, `withdraw_unverified`).
- High, failed `ft_transfer_call` treated as "nothing reached Ref": the vault queries `get_deposit` and rolls back only if Ref's deposit is below `stranded + amount`; otherwise it strands (`deposit_landed_on_ref`, `deposit_unverified`).
- High, one `max_trade`/`daily_cap` across tokens with different decimals: per-token `limits`, per-token `spent_today`, and a token without a limit cannot be sold.
- High, only `min_amount_out > 0` as price protection: per-pool, per-direction `min_rate` floor (`ERR_PRICE_FLOOR`), compared in 256 bits.
- Medium, `new` had no caller check: requires predecessor == contract account (`ERR_PRIVATE_INIT`).
- Medium, no escape from a stuck `in_flight` lock: `started_at` plus owner `force_release_lock` after 10 minutes, with swap ids so late callbacks cannot touch a newer swap.
- Medium, `recover_from_ref` during a swap: rejected with `ERR_SWAP_IN_FLIGHT`. `update_config` is rejected the same way.
- Low, dead `_reserved` storage map: removed.
- The audit found zero tests; there are now 126 unit tests. No sandbox or testnet test exists.

Open (not fixed):

- The vault is not tied to the NFT. `nft_contract_id` and `token_id` are stored and never checked. The owner is the account set at `new` and there is no ownership transfer, so if the NFT is sold the old owner keeps the funds.
- `register_on_ref` has no callback. If Ref's `storage_deposit` fails, the attached NEAR is refunded to the vault contract, and no method takes NEAR out of the vault. It uses `registration_only: true`, so Ref storage for each new token is not covered by the vault and the first swap into a new token_out may fail on Ref storage (audit marked this as unverified).
- If `ref.swap` returns an error that is really a timeout or out-of-gas, the swap may have executed. The vault strands the full `amount_in` as token_in without asking Ref, so token_out could sit on Ref untracked. Only the deposit and withdraw steps are reconciled, not the swap step.
- `withdraw` has no minimum prepaid gas check. With too little gas the `on_owner_withdraw` callback can be starved and the debit is not restored.
- Tokens sent with a plain `ft_transfer` (not `ft_transfer_call`) are not recorded and cannot be recovered. There is no sweep method. Unknown-token deposits through `ft_on_transfer` are refunded in full.
- `check_proposal` (view) cannot show `ERR_INSUFFICIENT_GAS`, so it can return ok for a call that fails on gas. The sender must attach at least 270 TGas.
- `strategy` is validated but not used by any on-chain rule. Config size (pools, limits, runners) is unbounded; only the owner can set it.
- Pause and revoke do not cancel a swap already in flight. The only way out of a stuck swap is `force_release_lock` after 10 minutes.
- Runners are accounts, not keys, and are trusted for timing and for the exact price at or above the floor. The floor is static and owner-set; a stale floor can be too loose or too tight.
- The reconciliation baseline (`stranded + amount`) assumes the vault's Ref balance of that token only holds funds the vault tracks. Funds sent to the vault's Ref account by other means can make a deposit or withdraw look unreconciled and strand it. The owner can then use `recover_from_ref`.
- Gas constants are static and have not been tested against real Ref testnet costs (the audit asked for a gas test on testnet).
- The off-chain JS and Rust rule order and the JS side of the rules are outside this contract and are covered elsewhere in the repository, not here.

Not deployed. No audit after the fixes. Any deploy, funding or mainnet use needs the owner's explicit approval.
