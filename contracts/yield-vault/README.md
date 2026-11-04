# yield-vault

A per-personality-NFT trading vault. Each personality NFT (aloof, chaotic, social, skeptic) is an AI agent running a strategy off chain. The agent acts only through approved **runner** accounts, and this contract enforces hard limits on chain regardless of what the strategy proposes. Approved swaps run on the Rhea (Ref Finance) testnet exchange `ref-finance-101.testnet` with the deposit -> swap -> withdraw pattern. wNEAR is `wrap.testnet`.

**Status: NOT deployed.** A testnet deploy needs the human's explicit yes. Tested with unit tests only (`cargo test`, 165 tests). See "Known risks".

**Not measured, not tested against Ref:**
- Every gas figure here, including the 270 TGas `execute_swap` minimum, is arithmetic over the static constants in `src/lib.rs`. None was measured on a sandbox, testnet or mainnet. The unit-test VM charges receipt fees, and tests check that each entry point fits in exactly its minimum there. That catches a minimum too small to pay for its own promises. It says nothing about what Ref's `ft_on_transfer`, `swap`, `withdraw` or `get_deposit` really cost.
- The Ref method names and argument shapes (`ft_transfer_call` with `msg: ""`, `swap { actions, referral_id }`, `withdraw { token_id, amount, unregister, skip_unwrap_near }`, `get_deposit { account_id, token_id }`, `storage_deposit { account_id, registration_only }`) were written from Ref's public interface and have never run against a real Ref contract. The unit tests feed hand-built promise results to the callbacks. They cannot catch a wrong method name, a wrong argument or a wrong return shape.

## Interface

Init: `new(owner_id, nft_contract_id, token_id, ref_exchange_id, config: VaultConfig)`. The caller must be the contract account itself (`ERR_PRIVATE_INIT`), so deploy and init belong in one batch transaction signed by the contract account.

```
VaultConfig   { strategy, allowed_pools: [AllowedPool], limits: [TokenLimit], runners: [AccountId] }
AllowedPool   { pool_id: u64, token_a, token_b, min_rate_a_to_b: Rate, min_rate_b_to_a: Rate }
Rate          { num: U128, den: U128 }          // floor: min_amount_out * den >= amount_in * num
TokenLimit    { token_id, max_trade: U128, daily_cap: U128 }   // per token_in, in that token's base units
SwapProposal  { pool_id: u64, token_in, token_out, amount_in: U128, min_amount_out: U128 }
CheckResult   { ok: bool, reason: String }   // reason = "ERR_CODE: detail" when not ok
VaultState    { owner_id, nft_contract_id, token_id, ref_exchange_id, paused, swap_in_flight,
                recovery_in_flight, release_in_flight, day,
                spent_today: [(AccountId, U128)], balances: [(AccountId, U128)],
                stranded_on_ref: [(AccountId, U128)], swaps_executed: u64 }
```

A token with no `limits` entry cannot be sold (`ERR_NO_LIMIT`). `spent_today` is tracked per token. Each pool carries an owner-set price floor per direction.

`daily_cap` is per UTC calendar day (`block_timestamp / 86_400 s`), not a rolling 24 hours. `spent_today` resets at 00:00 UTC, so a runner can spend up to `daily_cap` just before midnight and another `daily_cap` just after: up to 2x `daily_cap` within minutes. Set `daily_cap` with that in mind. A rolling window would need a per-trade history in state and is not done.

| Method | Who | Yocto | Notes |
| --- | --- | --- | --- |
| `execute_swap(proposal) -> Promise` | runner | none | needs >= 270 TGas prepaid |
| `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>` | token contract | n/a | owner deposits of pool tokens only, else full refund |
| `withdraw(token_id, amount) -> Promise` | owner | 1 | needs >= 80 TGas prepaid (`ERR_INSUFFICIENT_GAS`, checked before the debit) so `on_owner_withdraw` cannot be starved; debits, `ft_transfer` to owner, callback restores on failure. Refused while a force release is pending (`ERR_RELEASE_PENDING`) |
| `pause()`, `unpause()` | owner | 1 | |
| `add_runner(id)`, `revoke_runner(id)` | owner | 1 | |
| `revoke_all_runners()` | owner | 1 | kill switch: clears runners and pauses |
| `update_config(config)` | owner | 1 | validated; rejected while a swap is in flight (`ERR_SWAP_IN_FLIGHT`) |
| `register_on_ref() -> Promise` | owner | payable (NEAR for Ref storage) | needs >= 60 TGas. `storage_deposit { registration_only: false }` on Ref, so the whole deposit stays as the vault's Ref storage balance; `on_register` forwards the deposit to the owner if it fails. See "Ref storage" |
| `recover_from_ref(token_id, amount) -> Promise` | owner | 1 | needs >= 150 TGas. Pulls stranded funds back from Ref; rejected while a swap or another recovery is in flight (`ERR_SWAP_IN_FLIGHT`). Reads Ref's deposit before and after the withdraw and credits only the measured drop. Holds a recovery lock until its last reconcile has run; while it is held, `execute_swap` and `update_config` are refused with `ERR_SWAP_IN_FLIGHT` (`get_state().recovery_in_flight` is `true`) |
| `force_release_lock() -> Promise` | owner | 1 | needs >= 100 TGas. Only if a swap or recovery has been in flight >= 10 min. Reads where the held amount really is (see "Force release") and then credits, rolls back or strands it. Late callbacks of a released swap or recovery are ignored (ids from one counter) |
| `get_config()`, `get_state()`, `get_balance(token_id)` | anyone | | views |
| `check_proposal(proposal, runner_id) -> CheckResult` | anyone | | same rules as `execute_swap` except the gas check, no side effects |
| `on_deposit`, `on_deposit_reconciled`, `on_swap`, `on_withdraw_done`, `on_withdraw_reconciled`, `on_owner_withdraw`, `on_recover_pre`, `on_recover`, `on_recover_reconciled`, `on_force_release_swap`, `on_force_release_recovery`, `on_register` | self only | | private callbacks |

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

This is a plan, not a measurement. The numbers are the static constants in `src/lib.rs`, added up by hand. They have not been profiled against Ref on any network (see "Not measured" at the top). If a real Ref hop costs more than its constant, the chain stops mid-way and the only way out is `force_release_lock` after 10 minutes.

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
- `recover_from_ref` (>= 150 TGas): `ref.get_deposit` (10 TGas) -> `on_recover_pre` (100 TGas) -> `ref.withdraw` (40 TGas) -> `on_recover` (40 TGas) -> `ref.get_deposit` (10 TGas) -> `on_recover_reconciled` (15 TGas).
- Owner `withdraw` (>= 80 TGas): `ft_transfer` (30 TGas) -> `on_owner_withdraw` (15 TGas).
- `force_release_lock` (>= 100 TGas): `token.ft_balance_of(vault)` + `ref.get_deposit(vault, held token)` (+ `ref.get_deposit(vault, token_out)` for a swap), 10 TGas each, joined -> `on_force_release_swap` / `on_force_release_recovery` (20 TGas).
- `register_on_ref` (>= 60 TGas): `ref.storage_deposit` (30 TGas) -> `on_register` (10 TGas).

The unit tests check that `execute_swap`, `withdraw`, `recover_from_ref`, `force_release_lock` and `register_on_ref` each fit in exactly their minimum in the unit-test VM, which charges receipt fees. The first `withdraw` (60 TGas) and `force_release_lock` (70 TGas) minimums did not fit there and were raised. That is a lower bound, not a measurement.

## Ref storage

The owner must call `register_on_ref` once before the first swap. It calls Ref's `storage_deposit` with `registration_only: false`, so the whole attached deposit becomes the vault's storage balance on Ref. On success nothing is refunded to the vault, so no NEAR gets stuck on the vault account. That balance also pays for the storage Ref needs each time a new token first lands in the vault's Ref account: the first deposit of a token_in and the first swap into a new token_out. Attach enough for the account plus every token in `allowed_pools`; read Ref's `storage_balance_bounds` and `storage_balance_of(vault)` first (these amounts are not checked here). Calling `register_on_ref` again tops up the balance.

If the storage runs short anyway (expected from Ref's interface, not tested against Ref):
- first deposit of a token_in: Ref refuses it, `ft_transfer_call` reports 0 used, the vault rolls back (`deposit_failed`);
- first swap into a new token_out: Ref's `swap` fails, token_in stays in the vault's Ref account, and `on_swap` strands it (`swap_failed`). After a top-up, `recover_from_ref` pulls it back.

If `storage_deposit` itself fails, the protocol refunds the deposit to the vault, and `on_register` sends the same amount on to the owner (`register_failed` event). This is best effort. If the refund has not landed when `on_register` runs and the vault's own balance cannot cover the transfer, the transfer fails and the NEAR stays on the vault account. No method withdraws NEAR from the vault.

## Force release

`force_release_lock` does not assume where a stuck amount is. The held amount is token_out if `on_swap` already recorded an output, otherwise token_in (for a recovery, the recovery's token). It reads:

- `ft_balance_of(vault)` of the held token: "in the vault" means the balance is at least `balances[token] + amount`;
- Ref's `get_deposit` of the held token: "on Ref" means the deposit is at least `stranded[token] + amount`;
- for a swap, also Ref's `get_deposit` of token_out.

| Reads show | Swap holding token_in | Swap holding token_out | Recovery |
| --- | --- | --- | --- |
| in the vault only | roll back the debit and day spend (`lock_force_released_in_vault`) | credit token_out, count the swap (`swap_executed`, `via: force_release`) | credit (`recovered`, `via: force_release`) |
| on Ref (alone or also in the vault) | strand on Ref (`lock_force_released`; `..._ambiguous` if both) | strand on Ref | restore to stranded |
| neither, all reads ok | the swap ran: strand Ref's untracked token_out (`deposit - stranded`) (`lock_force_released_swapped`) | strand unverified | restore to stranded (`..._unverified`) |
| a read failed | strand unverified (`lock_force_released_unverified`) | strand unverified | restore to stranded (`..._unverified`) |

Each branch books the amount in at most one place, so a force release never counts the same funds twice. While the reconcile is pending (`get_state().release_in_flight`), the lock stays held, the stuck operation's own callbacks are no-ops, owner `withdraw` is refused (`ERR_RELEASE_PENDING`) and owner deposits are refunded. That keeps the balances being compared from moving. If the reconcile callback never runs, call `force_release_lock` again; the newer call replaces the older one.

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
| Callback never ran (e.g. out of gas) | unknown | after 10 minutes the owner calls `force_release_lock`, which reads the vault's FT balance and Ref's deposit and then rolls back, credits or strands (see "Force release") |

Balance is credited after a withdraw only once `get_deposit` shows the funds left Ref. This covers Ref's `withdraw`, which can re-credit its internal balance and still return success when the token transfer fails.

The owner recovers stranded funds with `recover_from_ref(token_id, amount)`, only while no swap or other recovery is in flight, and no swap can start until the recovery's reconcile has run. The stranded record is reduced up front. `on_recover_pre` reads Ref's deposit first. If Ref holds less than `amount`, or the read fails, the recovery stops and the record is restored (`recover_refused`). A failed withdraw restores it too. After a withdraw that reports success, the vault credits only if Ref's deposit fell by at least `amount` since the first read. Otherwise it strands the amount again (`withdraw_not_reconciled` or `withdraw_unverified`). The recovery lock keeps every other vault operation off Ref meanwhile, so the drop can only come from this withdraw. Success credits the balance and emits `recovered`.

Other limitation: there is no on-chain market price. Slippage is bounded only by the owner-set per-pool floor and the runner's `min_amount_out`.

## Events

NEP-297, `standard: "yield_vault"`, `version: "1.0.0"`: `deposit`, `withdraw`, `withdraw_failed`, `swap_proposed`, `swap_executed`, `swap_failed`, `stranded`, `recovered`, `recover_refused`, `force_release_started`, `registered_on_ref`, `register_failed`, `paused`, `unpaused`, `runner_added`, `runner_revoked`, `config_updated`.

## Develop

```
cd contracts/yield-vault
cargo test                                          # 165 unit tests
cargo clippy --all-targets
cargo build --target wasm32-unknown-unknown --release
```

## Known risks

Source: an independent audit of the earlier version (`/Users/brandont/.claude-loop/logs/review-vault-audit20.md`). Later follow-up reviews were done by AI agents, not by a professional auditor.

Fixed after the audit:

- High, phantom balance after Ref `withdraw` (swap and recovery): credit only after Ref `get_deposit` shows the funds left Ref; otherwise strand (`withdraw_not_reconciled`, `withdraw_unverified`).
- High, failed `ft_transfer_call` treated as "nothing reached Ref": the vault queries `get_deposit` and rolls back only if Ref's deposit is below `stranded + amount`; otherwise it strands (`deposit_landed_on_ref`, `deposit_unverified`).
- High, one `max_trade`/`daily_cap` across tokens with different decimals: per-token `limits`, per-token `spent_today`, and a token without a limit cannot be sold.
- High, only `min_amount_out > 0` as price protection: per-pool, per-direction `min_rate` floor (`ERR_PRICE_FLOOR`), compared in 256 bits.
- Medium, `new` had no caller check: requires predecessor == contract account (`ERR_PRIVATE_INIT`).
- Medium, no escape from a stuck `in_flight` lock: `started_at` plus owner `force_release_lock` after 10 minutes, with swap ids so late callbacks cannot touch a newer swap.
- Medium, `recover_from_ref` during a swap: rejected with `ERR_SWAP_IN_FLIGHT`. `update_config` is rejected the same way. A follow-up review found the reverse case (a swap or second recovery starting while a recovery's reconcile was still pending, so the two reconciles misread each other's Ref balance); a recovery now holds its own lock until its reconcile runs.
- Low, dead `_reserved` storage map: removed.
- The audit found zero tests; there are now 165 unit tests. No sandbox or testnet test exists.

Fixed after a second review (`/tmp/yrev26-report.md`):

- Medium, `force_release_lock` always stranded the debited amount, even when the lock stuck before any token left the vault. The tokens stayed in the vault's FT balance, untracked and unwithdrawable. It now reads the vault's FT balance and Ref's deposits and books the amount where it really is (see "Force release"). Tests cover both the "never left the vault" and the "on Ref" cases.
- Medium, `withdraw` had no prepaid gas check: now >= 80 TGas, checked before the debit.
- Medium, `register_on_ref` had no callback and used `registration_only: true`: now `registration_only: false` plus `on_register` (see "Ref storage").
- Medium, the 270 TGas plan and the Ref call shapes were presented without saying they are unmeasured and untested against Ref: stated at the top of this file and in the root README.
- Low, the UTC daily-cap boundary: documented under the rules (up to 2x `daily_cap` around midnight).
- The deferred phantom-stranded case for recoveries (a `stranded` entry larger than what is on Ref making a later withdraw look successful): `recover_from_ref` now reads Ref's deposit before and after and credits only the measured drop.

Open (not fixed):

- The vault is not tied to the NFT. `nft_contract_id` and `token_id` are stored and never checked. The owner is the account set at `new` and there is no ownership transfer, so if the NFT is sold the old owner keeps the funds.
- `register_on_ref` failure forwarding is best effort (see "Ref storage"); NEAR that ends up on the vault account cannot be withdrawn. The Ref storage balance itself cannot be withdrawn either (no `storage_withdraw` method).
- `force_release_lock` compares FT and Ref balances read in separate receipts. A transfer in transit at that moment can skew a read. Examples: a third party's `ft_transfer_call` that `ft_on_transfer` will refund, or an owner `withdraw` sent just before the release whose `ft_transfer` has not run yet. While a release is pending, new withdrawals are refused and new deposits are refunded, but transfers already in transit are not covered. Such a skew can make "in the vault" true when the amount is really gone, so the vault credits a balance that has no tokens behind it. A later withdraw of that balance fails and `on_owner_withdraw` restores it. No one else's funds are taken. Avoid owner transfers in the minutes around a force release. The "neither" branch also strands Ref's whole untracked token_out excess, which can include unrelated dust.
- If `ref.swap` returns an error that is really a timeout or out-of-gas, the swap may have executed. The vault strands the full `amount_in` as token_in without asking Ref, so token_out could sit on Ref untracked. Only the deposit and withdraw steps are reconciled, not the swap step.
- Tokens sent with a plain `ft_transfer` (not `ft_transfer_call`) are not recorded and cannot be recovered. There is no sweep method. Unknown-token deposits through `ft_on_transfer` are refunded in full.
- `check_proposal` (view) cannot show `ERR_INSUFFICIENT_GAS`, so it can return ok for a call that fails on gas. The sender must attach at least 270 TGas.
- `strategy` is validated but not used by any on-chain rule. Config size (pools, limits, runners) is unbounded; only the owner can set it.
- Pause and revoke do not cancel a swap already in flight. The only way out of a stuck swap is `force_release_lock` after 10 minutes.
- Runners are accounts, not keys, and are trusted for timing and for the exact price at or above the floor. The floor is static and owner-set; a stale floor can be too loose or too tight.
- The reconciliation baseline (`stranded + amount`) assumes the vault's Ref balance of that token only holds funds the vault tracks. Funds sent to the vault's Ref account by other means can make a deposit or withdraw look unreconciled and strand it. The owner can then use `recover_from_ref`. The reverse also holds for the swap path: a `stranded` entry larger than what is really on Ref (from an unverified strand when the tokens never left the vault) raises the baseline. A later swap withdraw that Ref silently re-credited can then look like it left Ref, and the vault credits token_out while the tokens are still on Ref (an internal double count, not a third-party theft). Recoveries no longer use the baseline (they measure the before/after drop). The swap path still does, because a pre-withdraw `get_deposit` hop does not fit in the 300 TGas transaction limit next to the 270 TGas plan.
- Gas constants are static and have not been measured against real Ref costs on any network (the audit asked for a gas test on testnet). The Ref method names and argument shapes have never run against a real Ref contract (see "Not measured" at the top).
- `daily_cap` is per UTC calendar day, so up to 2x `daily_cap` can be spent within minutes around 00:00 UTC.
- The off-chain JS and Rust rule order and the JS side of the rules are outside this contract and are covered elsewhere in the repository, not here.

Not deployed. No professional audit. Any deploy, funding or mainnet use needs the owner's explicit approval.
