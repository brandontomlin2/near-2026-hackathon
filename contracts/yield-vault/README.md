# yield-vault

What it is: a near-sdk Rust smart contract that holds NEP-141 token balances for one agent and swaps them on Rhea (Ref Finance) through cross-contract promises (`ft_transfer_call` to deposit, `swap`, `withdraw`), with callbacks that read Ref's `get_deposit` before crediting or rolling back.

A per-personality-NFT trading vault. Each personality NFT (aloof, chaotic, social, skeptic) is an AI agent running a strategy off chain. The agent acts only through approved **runner** accounts, and this contract enforces hard limits on chain regardless of what the strategy proposes. Approved swaps run on the Rhea (Ref Finance) testnet exchange `ref-finance-101.testnet` with the deposit -> swap -> withdraw pattern. wNEAR is `wrap.testnet`.

**Status: NOT deployed.** A testnet deploy needs the human's explicit yes. Tested with unit tests (`cargo test`, 254 tests) and 14 integration tests in a throwaway local sandbox against a mock Ref and mock NEP-141 tokens (`sandbox/`, see "Sandbox measurements"). See "Known risks".

Live testnet runbook (every step, cost, failure handling, verification table): [../../docs/yield-vault-live-runbook.md](../../docs/yield-vault-live-runbook.md).

**Measured in a local sandbox, not against real Ref:**
- The gas figures in `src/lib.rs` are now checked against gas measured in a local near-workspaces sandbox (a throwaway chain on this machine; no testnet, no mainnet, no real keys). The vault wasm runs the full swap, recovery, owner withdraw, sync and register chains against a mock Ref exchange and mock NEP-141 tokens, each at exactly its documented minimum prepaid gas. `force_release_lock` was measured at its minimum in an earlier sandbox run (see "Sandbox measurements") and is now covered by unit tests only. `withdraw_ref_storage` has not run in the sandbox. See "Sandbox measurements".
- What the sandbox cannot tell: what real Ref's `ft_on_transfer`, `swap`, `withdraw` and `get_deposit` bodies cost. The mock uses Ref's method names and JSON argument shapes (`ft_transfer_call` with `msg: ""`, `swap { actions, referral_id }`, `withdraw { token_id, amount, unregister, skip_unwrap_near }`, `get_deposit { account_id, token_id }`, `storage_deposit`, `storage_withdraw`) and Ref's inner withdraw gas (20 TGas `ft_transfer` + 20 TGas callback). Those were taken from a public fork of Ref's source, because the canonical `ref-finance/ref-contracts` repository is no longer public. The mock bodies are much lighter than Ref's, so the sandbox measures how much heavier each Ref hop may be before the chain fails (headroom), not Ref's real cost.

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
| `execute_swap(proposal) -> Promise` | runner | none | needs >= 280 TGas prepaid |
| `ft_on_transfer(sender_id, amount, msg) -> PromiseOrValue<U128>` | token contract | n/a | owner deposits of pool tokens only, else full refund |
| `withdraw(token_id, amount) -> Promise` | owner | 1 | needs >= 80 TGas prepaid (`ERR_INSUFFICIENT_GAS`, checked before the debit) so `on_owner_withdraw` cannot be starved; debits, `ft_transfer` to owner, callback restores on failure. Refused while a force release is pending (`ERR_RELEASE_PENDING`) |
| `pause()`, `unpause()` | owner | 1 | |
| `add_runner(id)`, `revoke_runner(id)` | owner | 1 | |
| `revoke_all_runners()` | owner | 1 | kill switch: clears runners and pauses |
| `update_config(config)` | owner | 1 | validated; rejected while a swap is in flight (`ERR_SWAP_IN_FLIGHT`) |
| `register_on_ref() -> Promise` | owner | payable (NEAR for Ref storage) | needs >= 60 TGas. `storage_deposit { registration_only: false }` on Ref, so the whole deposit stays as the vault's Ref storage balance; `on_register` forwards the deposit to the owner if it fails. See "Ref storage" |
| `recover_from_ref(token_id, amount) -> Promise` | owner | 1 | needs >= 170 TGas. Pulls stranded funds back from Ref; rejected while a swap or another recovery is in flight (`ERR_SWAP_IN_FLIGHT`). Reads Ref's deposit before and after the withdraw and credits only the measured drop. Holds a recovery lock until its last reconcile has run; while it is held, `execute_swap` and `update_config` are refused with `ERR_SWAP_IN_FLIGHT` (`get_state().recovery_in_flight` is `true`) |
| `force_release_lock() -> Promise` | owner | 1 | needs >= 100 TGas. Only if a swap or recovery has been in flight >= 10 min. Reads where the held amount really is (see "Force release") and then credits, rolls back or strands it. Late callbacks of a released swap or recovery are ignored (ids from one counter) |
| `sync_balance(token_id) -> Promise` | owner | 1 | needs >= 50 TGas. Reads the vault's own `ft_balance_of` and `on_sync_balance` makes the tracked balance equal it: credits `ft_balance - tracked` when higher (recovers an `ft_transfer` donation or funds that `abort_release` / an unverified strand wrongly marked as on Ref), debits `tracked - ft_balance` when lower (heals a phantom credit; an idle vault sends no tokens out, so a lower balance can only be a phantom). Refused with `ERR_SYNC_BUSY` while a swap, recovery, release or owner withdrawal is in flight. Every call has an id; any swap, recovery, release or withdraw start clears it, so a stale callback is a no-op (it also re-checks the vault is idle). Deposits are refunded while a read is pending. Any `ft_on_transfer` call (any sender, any token) that arrives while a read is pending invalidates it (`sync_invalidated`; its callback is then a no-op), because a refundable `ft_transfer_call` may have been visible to the read as a transient credit; call `sync_balance` again. Emits `balance_synced` (with `credited` and `debited`), `sync_invalidated` or `sync_failed` |
| `abort_release()` | owner | 1 | Only if a force release has been pending >= 10 min. Clears it and strands the held amount as unverified. Escape if the reconcile callback can never succeed |
| `withdraw_near(amount) -> Promise` | owner | 1 | Sends NEAR from the vault account to the owner (a `register_failed` refund that could not be forwarded, or NEAR returned by `withdraw_ref_storage`). At most `get_withdrawable_near()`: account balance minus storage cost minus a 0.1 NEAR reserve (`ERR_INSUFFICIENT_NEAR`). Emits `near_withdrawn`. Does not touch token balances |
| `withdraw_ref_storage(amount?) -> Promise` | owner | 1 | needs >= 40 TGas. Calls Ref's NEP-145 `storage_withdraw { amount }` (1 yocto; omit `amount` for all Ref considers available), which returns NEAR to the vault account; then use `withdraw_near`. Refused with `ERR_SWAP_IN_FLIGHT` while a swap or recovery is in flight and `ERR_RELEASE_PENDING` during a force release (a swap into a new token needs that storage). Emits `ref_storage_withdraw`. Not run against Ref |
| `get_config()`, `get_state()`, `get_balance(token_id)`, `get_withdrawable_near()` | anyone | | views |
| `check_proposal(proposal, runner_id) -> CheckResult` | anyone | | same rules as `execute_swap` except the gas check, no side effects |
| `on_deposit`, `on_deposit_reconciled`, `on_swap`, `on_withdraw_pre`, `on_withdraw_reconciled`, `on_owner_withdraw`, `on_recover_pre`, `on_recover`, `on_recover_reconciled`, `on_force_release_swap`, `on_force_release_recovery`, `on_register`, `on_sync_balance` | self only | | private callbacks |

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

After the rules, `execute_swap` (not `check_proposal`) also requires prepaid gas >= 280 TGas (`ERR_INSUFFICIENT_GAS`).

Other codes: `ERR_NOT_OWNER`, `ERR_PRIVATE_INIT` (`new` called by anyone but the contract account), `ERR_BAD_CONFIG` (strategy not one of the four, a limit with `max_trade == 0`, `daily_cap < max_trade`, duplicate limit token, rate `num` or `den` equal to 0, `token_a == token_b`, duplicate pool, duplicate runner), `ERR_RUNNER_EXISTS`, `ERR_RUNNER_NOT_FOUND`, `ERR_DEPOSIT_REQUIRED`, `ERR_INSUFFICIENT_STRANDED`, `ERR_NO_SWAP_IN_FLIGHT`, `ERR_LOCK_NOT_STALE`, `ERR_PRIVATE_CALLBACK`, `ERR_OVERFLOW`, `ERR_NO_RELEASE` (`abort_release` with no force release pending), `ERR_RELEASE_NOT_STALE` (`abort_release` before 10 minutes), `ERR_RELEASE_PENDING` (`withdraw` while a release reconciles), `ERR_SYNC_BUSY` (`sync_balance` while the vault is moving tokens), `ERR_INSUFFICIENT_GAS`. `ERR_ZERO_AMOUNT` and `ERR_INSUFFICIENT_BALANCE` are also raised by `withdraw` and `recover_from_ref` (zero amount) and by the balance debit. Rejections panic, so no log survives; they show up as failed transactions. `check_proposal` returns the same code in `reason`.

The day is `block_timestamp / 86_400 s` (UTC). The per-token counters reset on the first swap of a new day; `get_state` shows an empty `spent_today` once the stored day is stale.

Limits are in each token's own base units and are never summed across tokens. The price floor is a static owner-set rate per pool and direction, not a live quote: it bounds how bad a price a runner can accept, it does not track the market. The runner still chooses the actual `min_amount_out` at or above the floor, and Ref enforces it.

## Promise chain and gas

The numbers are the static constants in `src/lib.rs`. They were checked in the local sandbox against a mock Ref (see "Sandbox measurements"), not against real Ref. If a real Ref hop costs more than its constant, the chain stops mid-way; the sandbox shows the vault then ends consistent (lock released, funds stranded or credited, never lost).

```
execute_swap  (>= 280 TGas prepaid; debits balance + spent_today, sets lock)
 -> token_in.ft_transfer_call(ref, amount_in, "")   70 TGas, 1 yocto   (deposit into the vault's Ref account)
 -> on_deposit                                     190 TGas  (own ~2.5 measured, then:)
     -> ref.swap({actions:[{pool_id,token_in,token_out,amount_in,min_amount_out}], referral_id:null})
                                                    50 TGas, 1 yocto
     -> on_swap                                    135 TGas  (own ~2.5 measured, then:)
         -> ref.get_deposit(vault, token_out)       10 TGas, view    (pre-withdraw snapshot)
         -> on_withdraw_pre                        115 TGas  (own ~3 measured, records the snapshot, then:)
             -> ref.withdraw({token_id: token_out, amount: amount_out, unregister:null, skip_unwrap_near:true})
                                                    80 TGas, 1 yocto (Ref attaches 20 + 20 inside)
             -> ref.get_deposit(vault, token_out)   10 TGas, view    (runs even if withdraw failed)
             -> on_withdraw_reconciled              15 TGas  (credits balance[token_out] only if the deposit fell by amount_out from the snapshot; releases lock, emits swap_executed)
```

Reconciliation branches:

- `on_deposit` with a failed `ft_transfer_call` result: `ref.get_deposit(vault, token_in)` (10 TGas) -> `on_deposit_reconciled` (15 TGas).
- `recover_from_ref` (>= 170 TGas): `ref.get_deposit` (10 TGas) -> `on_recover_pre` (130 TGas) -> `ref.withdraw` (80 TGas) -> `on_recover` (40 TGas) -> `ref.get_deposit` (10 TGas) -> `on_recover_reconciled` (15 TGas).
- Owner `withdraw` (>= 80 TGas): `ft_transfer` (30 TGas) -> `on_owner_withdraw` (15 TGas).
- `force_release_lock` (>= 100 TGas): `token.ft_balance_of(vault)` + `ref.get_deposit(vault, held token)` (+ `ref.get_deposit(vault, token_out)` for a swap), 10 TGas each, joined -> `on_force_release_swap` / `on_force_release_recovery` (20 TGas).
- `register_on_ref` (>= 60 TGas): `ref.storage_deposit` (30 TGas) -> `on_register` (10 TGas).

The unit tests check that `execute_swap`, `withdraw`, `recover_from_ref`, `force_release_lock` and `register_on_ref` each fit in exactly their minimum in the unit-test VM, which charges receipt fees. The first `withdraw` (60 TGas) and `force_release_lock` (70 TGas) minimums did not fit there and were raised. That is a lower bound; the sandbox measurements below are the real check.

## Sandbox measurements

Integration tests live in a separate crate, `sandbox/`, so the fast `cargo test` above (and `scripts/verify.sh`) does not build them. They deploy the vault wasm, a mock Ref exchange (`sandbox/mocks/mock-ref`) and mock NEP-141 tokens (`sandbox/mocks/mock-ft`) into a local near-workspaces sandbox. The sandbox binary is downloaded by near-workspaces on first run; all accounts and keys are generated for the throwaway chain.

```
cd contracts/yield-vault/sandbox
gtimeout 1800 cargo test -- --nocapture --test-threads=1   # 14 tests, about 12 minutes (headroom.rs is most of it)
```

Each test prints a per-receipt gas table (from the sandbox RPC `EXPERIMENTAL_tx_status`); the `lib.rs` constants are parsed from the source, so tables cannot drift from the code. Full tables are in `sandbox/README.md`.

Gas burnt, Ref inner withdraw gas 20 + 20 (TGas; subtree = the receipt plus everything it triggers):

| Step | lib.rs constant | Measured subtree |
| --- | --- | --- |
| `execute_swap` (whole chain, 14 receipts) | `MIN_EXECUTE_GAS` 280 | 30.8 |
| `ft_transfer_call` to Ref | `GAS_FT_TRANSFER_CALL` 70 | 5.9 |
| `on_deposit` | `GAS_CB_DEPOSIT` 190 | 22.0 |
| `ref.swap` | `GAS_REF_SWAP` 50 | 1.8 (mock) |
| `on_swap` | `GAS_CB_SWAP` 135 | 17.5 |
| `ref.get_deposit` | `GAS_REF_VIEW` 10 | 1.8 (mock) |
| `on_withdraw_pre` | `GAS_CB_WITHDRAW_PRE` 115 | 13.0 |
| `ref.withdraw` | `GAS_REF_WITHDRAW` 80 | 6.1 (mock body) |
| `on_withdraw_reconciled` | `GAS_CB_RECONCILE` 15 | 2.1 |
| `recover_from_ref` (whole chain) | `MIN_RECOVER_GAS` 170 | 19.6 |
| `on_recover_pre` | `GAS_CB_RECOVER_PRE` 130 | 15.2 |
| `on_recover` | `GAS_CB_WITHDRAW_DONE` 40 | 6.5 |
| owner `withdraw` | `MIN_WITHDRAW_GAS` 80 | 6.3 |
| `sync_balance` | `MIN_SYNC_GAS` 50 | 6.2 |
| `register_on_ref` | `MIN_REGISTER_GAS` 60 | 6.4 |
| `force_release_lock` | `MIN_FORCE_RELEASE_GAS` 100 | 10.8 (earlier run; no sandbox flow sticks a lock now) |

The vault's own callback bodies burn 1.8 to 2.9 TGas each. Callbacks often receive more than their constant, because near-sdk hands unused gas to them.

Headroom (`sandbox/tests/headroom.rs`): a mock knob makes one Ref hop burn extra gas, stepping up until the chain fails, at exactly 280 / 170 TGas. The chain still completes when a Ref hop burns this much extra on top of the mock body: `ft_on_transfer` +35, `swap` +45, each `get_deposit` +9, `withdraw` +35 (on top of Ref's inner 20 + 20), the post-withdraw callback +55. At the first failing step the tests assert the vault stays consistent: lock released, wallet plus Ref deposit equal to credited plus stranded plus unverified, nothing lost or double counted.

What the sandbox changed: `GAS_REF_WITHDRAW` was 40. With Ref's inner 20 + 20 that left nothing for Ref's own body, and every `ref.withdraw` failed with "Exceeded the prepaid gas", so no swap or recovery could finish (funds were stranded, not lost). It is now 80, and the chain above it was rebudgeted: `on_withdraw_pre` 80 -> 115, `on_swap` 110 -> 135, `on_deposit` 180 -> 190, `on_recover_pre` 100 -> 130, `recover_from_ref` minimum 150 -> 170. `execute_swap` stays at 280.

Failure paths run end to end (`sandbox/tests/refunds.rs`, `failure_paths.rs`, `happy_path.rs`), each matching the "Failure handling" table: Ref refunds the whole deposit (rolled back), `ref.swap` panics (token_in stranded, then `recover_from_ref`), token_out's `ft_transfer` fails inside Ref's withdraw (Ref re-credits, vault strands, then recovers), token_in's `ft_transfer_call` fails (reconciled rollback), owner `withdraw`'s `ft_transfer` fails (re-credited), deposits from non-owners or of non-allowed tokens (refunded in full), and malformed `get_deposit` replies (before and after the withdraw: the chain ends cleanly, the lock is released, the amount is stranded or unverified, never credited; then `recover_from_ref` or `sync_balance` books it). `force_release_lock` is covered by the unit tests only: with malformed replies handled, no sandbox flow at the documented minimum gas leaves the lock stuck any more.

Still only a mock: Ref's real body costs, pool math, token whitelist, storage byte sizes and wNEAR unwrap. The method names, argument shapes and the 20 + 20 inner gas come from a public fork, not from deployed Ref. A testnet run against `ref-finance-101.testnet` would close that, and needs the owner's explicit approval.

## Ref storage

Funding the vault account: the vault account itself needs NEAR for its contract storage (about 1 NEAR per 100 KB of wasm plus state; check the built wasm size) and, through `register_on_ref`, the Ref storage deposit (read Ref's `storage_balance_bounds` first). Gas for swaps is paid by the caller, not the vault. As a starting point, fund at least 5 NEAR on testnet; this number is a rough estimate, not measured, and no vault is deployed.

The owner must call `register_on_ref` once before the first swap. It calls Ref's `storage_deposit` with `registration_only: false`, so the whole attached deposit becomes the vault's storage balance on Ref. On success nothing is refunded to the vault, so no NEAR gets stuck on the vault account. That balance also pays for the storage Ref needs each time a new token first lands in the vault's Ref account: the first deposit of a token_in and the first swap into a new token_out. Attach enough for the account plus every token in `allowed_pools`; read Ref's `storage_balance_bounds` and `storage_balance_of(vault)` first (these amounts are not checked here). Calling `register_on_ref` again tops up the balance.

If the storage runs short anyway (expected from Ref's interface, not tested against Ref):
- first deposit of a token_in: Ref refuses it, `ft_transfer_call` reports 0 used, the vault rolls back (`deposit_failed`);
- first swap into a new token_out: Ref's `swap` fails, token_in stays in the vault's Ref account, and `on_swap` strands it (`swap_failed`). After a top-up, `recover_from_ref` pulls it back.

If `storage_deposit` itself fails, the protocol refunds the deposit to the vault, and `on_register` sends the same amount on to the owner (`register_failed` event). This is best effort. If the refund has not landed when `on_register` runs and the vault's own balance cannot cover the transfer, the transfer fails and the NEAR stays on the vault account. The owner then takes it out with `withdraw_near`. To get the Ref storage balance back, call `withdraw_ref_storage` (Ref returns the NEAR to the vault account), then `withdraw_near`.

## Force release

`force_release_lock` does not assume where a stuck amount is. The held amount is token_out if `on_swap` already recorded an output, otherwise token_in (for a recovery, the recovery's token). It reads:

- `ft_balance_of(vault)` of the held token: "in the vault" means the balance is at least `balances[token] + amount`;
- Ref's `get_deposit` of the held token: "on Ref" means the deposit is at least `stranded[token] + amount`;
- for a swap, also Ref's `get_deposit` of token_out.

| Reads show | Swap holding token_in | Swap holding token_out | Recovery |
| --- | --- | --- | --- |
| in the vault only | roll back the debit and day spend (`lock_force_released_in_vault`) | credit token_out, count the swap (`swap_executed`, `via: force_release`) | credit (`recovered`, `via: force_release`) |
| on Ref (alone or also in the vault) | strand on Ref (`lock_force_released`; `..._ambiguous` if both) | strand on Ref | restore to stranded |
| neither, all reads ok | the swap ran: strand Ref's untracked token_out (`deposit - stranded`) (`lock_force_released_swapped`); if a stranded record already covers Ref's whole token_out deposit, nothing new is booked and `ref_balance_untracked` names the token and deposit (recover it with `recover_from_ref`) | strand unverified | restore to stranded (`..._unverified`) |
| a read failed | strand on Ref if the Ref read shows it, else strand unverified (`lock_force_released_unverified`); never roll back | same; never credit | restore to stranded; never credit |

Amounts that are only maybe on Ref (a failed read, or `abort_release`) go to a separate `unverified_on_ref` record (`get_state()`), not `stranded`. No swap or recovery reconcile credits on the strength of either record: swap withdraws and recoveries measure their own before/after drop of Ref's deposit, and a failed deposit is rolled back only when Ref's deposit is below the deposited amount itself. `stranded` is used only to mark an ambiguous deposit as verified and by force release. `recover_from_ref` takes verified strands first, then unverified ones. `sync_balance` recovers tokens an unverified record wrongly marks as on Ref.

Each branch books the amount in at most one place, so a force release never counts the same funds twice. While the reconcile is pending (`get_state().release_in_flight`), the lock stays held, the stuck operation's own callbacks are no-ops, owner `withdraw` is refused (`ERR_RELEASE_PENDING`) and owner deposits are refunded. That keeps the balances being compared from moving. A token transfer that reaches `ft_on_transfer` while the release is pending (refunded, as above) also marks the release as tainted, because its transient credit may be visible to the release's `ft_balance_of` read. A tainted release treats that read as failed when it resolves, so the outcome is a strand (verified if Ref shows it, otherwise unverified), never a rollback or a credit. If the reconcile callback never runs, call `force_release_lock` again; the newer call replaces the older one. The release callbacks read their results as raw bytes: a read that fails or returns a payload that is not a `U128` counts as a failed read (strand unverified), it does not panic. If the callback still cannot run (for example `GAS_CB_RELEASE` is too small), the owner calls `abort_release` (1 yocto) once 10 minutes have passed since `force_release_lock`. It clears the release and strands the held amount as unverified (`lock_force_released_unverified`, event `force_release_aborted`), so withdrawals and deposits work again. A late callback of an aborted release is a no-op.

## Failure handling

Every callback that reads a `U128` from Ref or a token (`on_deposit`, `on_deposit_reconciled`, `on_swap`, `on_withdraw_pre`, `on_withdraw_reconciled`, `on_recover_pre`, `on_recover_reconciled`, `on_sync_balance`, and the two force-release callbacks) reads the raw promise result and treats a reply that is not a valid `U128` (wrong JSON type, not JSON, empty, negative, over 4096 bytes) exactly like a failed promise: the same strand, strand-unverified or rollback-only-if-provable branch runs, nothing is credited, and the lock is released. A malformed reply therefore cannot hold the lock. `on_recover`, `on_register` and `on_owner_withdraw` only look at success or failure. `ERR_OVERFLOW` can still panic a callback (a balance that would exceed `u128`). Every failure of a swap releases the lock and emits `swap_failed`. Each swap carries an id passed to its callbacks, so a late callback of a force-released swap is a no-op.

A failed promise result is not trusted as proof of what happened. The vault asks Ref for `get_deposit(vault, token)`. A credit or rollback needs a per-operation proof, never the absolute `stranded` record (which can overstate Ref, for example after a `swap_failed` strand whose swap really ran).

| Step failed | Funds | Action |
| --- | --- | --- |
| `ft_transfer_call` failed, Ref deposit below `amount_in` | still with the vault | roll back the debit and the day spend (day spend only if the day has not rolled); `swap_failed: deposit_failed` |
| `ft_transfer_call` failed, Ref deposit at or above `stranded[token_in] + amount_in` | on Ref | `stranded_on_ref[token_in] += amount`; reason `deposit_landed_on_ref` |
| `ft_transfer_call` failed, deposit in between, or `get_deposit` failed | unknown | `unverified_on_ref[token_in] += amount`; reason `deposit_unverified`; no rollback (if the tokens are really in the vault, `sync_balance` recovers them) |
| Deposit reported used amount 0 | still with the vault | roll back the debit and day spend; `deposit_failed` |
| Deposit used less than `amount_in` | remainder with the vault | refund the remainder, swap only the used part |
| `ref.swap` failed | token_in is on Ref | `stranded_on_ref[token_in] += amount`, `stranded` event |
| `amount_out < min_amount_out` (or 0) | token_out is on Ref | `stranded_on_ref[token_out] += amount_out` |
| pre-withdraw `get_deposit` failed | token_out is on Ref (the swap reported it) | `stranded_on_ref[token_out] += amount_out`; reason `withdraw_pre_unverified`; nothing withdrawn |
| pre-withdraw `get_deposit` below `amount_out` | unknown | `unverified_on_ref[token_out] += amount_out`; reason `withdraw_pre_mismatch`; nothing withdrawn |
| `ref.withdraw` failed, or ok but Ref deposit fell by less than `amount_out` from the snapshot | token_out still on Ref | strand, reason `withdraw_not_reconciled`; no credit |
| post-withdraw `get_deposit` failed | unknown | unverified, reason `withdraw_unverified`; no credit |
| Callback never ran (e.g. out of gas) | unknown | after 10 minutes the owner calls `force_release_lock`, which reads the vault's FT balance and Ref's deposit and then rolls back, credits or strands (see "Force release") |

Balance is credited after a withdraw only once `get_deposit` shows Ref's deposit fell by `amount_out` from the snapshot taken just before the withdraw. The swap lock keeps every other vault operation off Ref meanwhile, so the drop can only come from this withdraw. This covers Ref's `withdraw`, which can re-credit its internal balance and still return success when the token transfer fails.

Auto-pause: a runner picks `min_amount_out`, so a value Ref cannot fill makes every swap end stranded. After 3 swaps in a row that end stranded (`MAX_CONSECUTIVE_STRANDS`: `swap_failed`, `amount_out_below_min`, `deposit_landed_on_ref`, `deposit_unverified`, `withdraw_pre_*`, `withdraw_not_reconciled`, `withdraw_unverified`) the vault pauses itself and emits `auto_paused` (`reason: consecutive_strands`). A completed swap and the owner's `unpause` reset the count. Rolled-back failures (`deposit_failed`) and force-release outcomes do not count. The swap in flight is not cancelled.

The owner recovers stranded funds with `recover_from_ref(token_id, amount)`, only while no swap or other recovery is in flight, and no swap can start until the recovery's reconcile has run. The stranded record is reduced up front. `on_recover_pre` reads Ref's deposit first. If Ref holds less than `amount`, or the read fails, the recovery stops and the record is restored (`recover_refused`). A failed withdraw restores it too. After a withdraw that reports success, the vault credits only if Ref's deposit fell by at least `amount` since the first read. Otherwise it strands the amount again (`withdraw_not_reconciled` or `withdraw_unverified`). The recovery lock keeps every other vault operation off Ref meanwhile, so the drop can only come from this withdraw. Success credits the balance and emits `recovered`.

Other limitation: there is no on-chain market price. Slippage is bounded only by the owner-set per-pool floor and the runner's `min_amount_out`.

## Events

NEP-297, `standard: "yield_vault"`, `version: "1.0.0"`: `deposit`, `withdraw`, `withdraw_failed`, `swap_proposed`, `swap_executed`, `swap_failed`, `stranded`, `recovered`, `recover_refused`, `force_release_started`, `force_release_aborted`, `ref_balance_untracked`, `balance_synced`, `sync_failed`, `sync_invalidated`, `registered_on_ref`, `register_failed`, `near_withdrawn`, `ref_storage_withdraw`, `paused`, `auto_paused`, `unpaused`, `runner_added`, `runner_revoked`, `config_updated`.

## Develop

```
cd contracts/yield-vault
cargo test                                          # 254 unit tests
(cd sandbox && cargo test -- --test-threads=1)      # 14 local sandbox tests, see "Sandbox measurements"
cargo clippy --all-targets
cargo build --target wasm32-unknown-unknown --release
```

## Known risks

Source: an independent audit of the earlier version (`/Users/brandont/.claude-loop/logs/review-vault-audit20.md`). Later follow-up reviews were done by AI agents, not by a professional auditor.

Fixed after the audit:

- High, phantom balance after Ref `withdraw` (swap and recovery): credit only after Ref `get_deposit` shows the funds left Ref; otherwise strand (`withdraw_not_reconciled`, `withdraw_unverified`).
- High, failed `ft_transfer_call` treated as "nothing reached Ref": the vault queries `get_deposit` and rolls back only if Ref's deposit is below the deposited amount; otherwise it strands (`deposit_landed_on_ref`, `deposit_unverified`).
- High, one `max_trade`/`daily_cap` across tokens with different decimals: per-token `limits`, per-token `spent_today`, and a token without a limit cannot be sold.
- High, only `min_amount_out > 0` as price protection: per-pool, per-direction `min_rate` floor (`ERR_PRICE_FLOOR`), compared in 256 bits.
- Medium, `new` had no caller check: requires predecessor == contract account (`ERR_PRIVATE_INIT`).
- Medium, no escape from a stuck `in_flight` lock: `started_at` plus owner `force_release_lock` after 10 minutes, with swap ids so late callbacks cannot touch a newer swap.
- Medium, `recover_from_ref` during a swap: rejected with `ERR_SWAP_IN_FLIGHT`. `update_config` is rejected the same way. A follow-up review found the reverse case (a swap or second recovery starting while a recovery's reconcile was still pending, so the two reconciles misread each other's Ref balance); a recovery now holds its own lock until its reconcile runs.
- Low, dead `_reserved` storage map: removed.
- The audit found zero tests; there are now 254 unit tests and 14 local sandbox tests against a mock Ref. No testnet test exists.

Fixed after a second review (`/tmp/yrev26-report.md`):

- Medium, `force_release_lock` always stranded the debited amount, even when the lock stuck before any token left the vault. The tokens stayed in the vault's FT balance, untracked and unwithdrawable. It now reads the vault's FT balance and Ref's deposits and books the amount where it really is (see "Force release"). Tests cover both the "never left the vault" and the "on Ref" cases.
- Medium, `withdraw` had no prepaid gas check: now >= 80 TGas, checked before the debit.
- Medium, `register_on_ref` had no callback and used `registration_only: true`: now `registration_only: false` plus `on_register` (see "Ref storage").
- Medium, the gas plan (then 270 TGas, now 280) and the Ref call shapes were presented without saying they are unmeasured and untested against Ref: stated at the top of this file and in the root README.
- Low, the UTC daily-cap boundary: documented under the rules (up to 2x `daily_cap` around midnight).
- The deferred phantom-stranded case for recoveries (a `stranded` entry larger than what is on Ref making a later withdraw look successful): `recover_from_ref` now reads Ref's deposit before and after and credits only the measured drop.

Fixed after a third review (`/tmp/secyv-review.md`, M2):

- Medium, the swap-path reconcile compared Ref's deposit with the absolute `stranded[token] + amount`. A `stranded` record larger than what Ref really holds (for example a `swap_failed` strand whose swap actually ran) let a silently re-credited swap withdraw look successful, so token_out was credited while still on Ref; it also let a landed deposit look rolled back. Now `on_swap` snapshots Ref's token_out deposit before the withdraw (`on_withdraw_pre`) and `on_withdraw_reconciled` credits only if the deposit fell by `amount_out` from that snapshot. A failed deposit is rolled back only if Ref's deposit is below `amount_in`; an ambiguous one is stranded unverified, never credited. The extra hop raised `execute_swap`'s minimum from 270 to 280 TGas (still under the 300 TGas limit). Tests: `m2_phantom_stranded_does_not_fake_withdraw_credit`, `m2_phantom_stranded_does_not_fake_deposit_rollback` (both failed before the fix), plus snapshot, partial-drop and pre-read-failure cases.

- Medium, NEAR stranded on the vault account: a `register_failed` refund that `on_register` could not forward stayed on the vault account for good, and the Ref storage balance could not be taken back (no method withdrew NEAR). Now `withdraw_ref_storage` calls Ref's NEP-145 `storage_withdraw` and `withdraw_near` sends free NEAR (balance minus storage cost minus a 0.1 NEAR reserve) to the owner. Tests: `withdraw_near_*`, `withdrawable_near_is_zero_when_balance_below_storage`, `withdraw_ref_storage_*`. The `storage_withdraw` call shape is the NEP-145 standard and has not run against Ref.

Open (not fixed). Severity is the impact on funds if the item happens, not its likelihood:

- Low, the vault is not tied to the NFT. `nft_contract_id` and `token_id` are stored and never checked. The owner is the account set at `new` and there is no ownership transfer, so if the NFT is sold the old owner keeps the vault and its funds. Only the owner can deposit, so no one else's funds are ever in the vault; the gap is that a buyer of the NFT does not get the vault. Do not sell the NFT as if it came with the vault.
- Low, `force_release_lock` compares FT and Ref balances read in separate receipts. A transfer in transit at that moment can skew a read. Examples: an owner `withdraw` sent just before the release whose `ft_transfer` has not run yet. While a release is pending, new withdrawals are refused and new deposits are refunded, but transfers already in transit are not covered. Such a skew can make "in the vault" true when the amount is really gone, so the vault credits a balance that has no tokens behind it. A later withdraw of that balance fails and `on_owner_withdraw` restores it. No one else's funds are taken. Avoid owner transfers in the minutes around a force release. The "neither" branch also strands Ref's whole untracked token_out excess, which can include unrelated dust. The "ambiguous" branch (both reads show the amount) records it on Ref. If the real tokens are the ones in the vault, the vault copy goes untracked and the Ref record is a phantom. Recovery's before/after check keeps that phantom from ever being credited. A plain `ft_transfer` donation to the vault can also make "in the vault" true for a swap whose token_in was really consumed on Ref; the rollback is then backed by the donated tokens, while the swap's token_out stays on Ref with no record (only the owner's own funds are affected). A third party's refundable `ft_transfer_call` in transit no longer skews the read: its `ft_on_transfer` taints the release (see "Force release"), unless that call is starved of gas (see the next item). Low because it needs a stuck callback (the runner under-attaching gas, or a gas constant too small) plus a transfer in transit or a donation at that moment, and no third party can take funds through it.
- Low, a gas-starved `ft_on_transfer` can still leave a transient credit. The sender of an `ft_transfer_call` picks the receiver's gas. If it is too little, `ft_on_transfer` panics, its state change (the sync invalidation or release taint) is reverted, and the token still refunds. If a `sync_balance` read lands inside that window it credits the refundable amount (a phantom: `balances` above the real FT balance). The attacker takes nothing: it needs the read to land in the few-block transient window, the phantom portion fails safely on `withdraw` (restored by `on_owner_withdraw`) and on `execute_swap` (the `ft_transfer_call` fails and the vault rolls back or strands), and the next `sync_balance` with no transfer in transit debits it (`debited` in `balance_synced`). Mitigation: call `sync_balance` twice, or when no transfers are in transit, and compare `credited` with what you expect. For a force release the same starvation can skew its `ft_balance_of` read (see the previous item).
- Low, a phantom `stranded` record can hide a swap that really ran during a force release. If the record for token_out is at least Ref's whole token_out deposit, the "neither location holds token_in" branch has no untracked excess to book (it records token_in as unverified, which is harmless). The real token_out stays on Ref with no record of its own, but the phantom record covers it: `recover_from_ref(token_out, ref_deposit)` pulls it (its pre-read and before/after check still apply), and the `ref_balance_untracked` event tells the owner the token and amount. Only the owner's own funds are involved, and a phantom record needs an earlier failure (see the next item).
- Info, `on_recover` records a failed Ref `withdraw` as verified on Ref (`put_back(.., true)`). If Ref's `withdraw` failed only in its post-transfer callback, after the tokens had already left, that record is a phantom. This is kept deliberately: the usual cause of a failed `withdraw` is that Ref still holds the funds, and an unverified record would lower the baselines used by `on_deposit_reconciled` and force release (`ref_holds`), so a later release with the tokens still in the vault could be stranded instead of rolled back. A phantom record is never a credit baseline (recovery and swap withdraws measure their own before/after drop), is refused by `on_recover_pre` once Ref lacks the amount, and the tokens it stands for are picked up by `sync_balance`.
- Low, a compromised runner can strand funds on purpose by proposing a `min_amount_out` at or above the owner's floor that Ref cannot fill; `on_swap` then strands `amount_in` and the owner must call `recover_from_ref`. Loss is bounded by `daily_cap` per day and fully recoverable; it is a nuisance, not theft. Mitigated: 3 strands in a row pause the vault (see "Failure handling"). The runner can still strand up to 3 swaps before the pause, and can interleave one completed swap to reset the count; `revoke_runner` is the real remedy. There is no on-chain price ceiling.
- Info, spend accounting: a stranded swap keeps its `amount_in` counted in `spent_today` (the funds sit on Ref and only the owner moves them back); a rollback (tokens never left) gives it back, for the same UTC day only. So the daily cap is conservative and cannot be exceeded through either path. Pinned by `strand_keeps_spend_counted_and_rollback_restores_it`.
- Low, the `d < amount_in` rollback in `on_deposit_reconciled` assumes a failed `ft_transfer_call` that landed nowhere. If the tokens did reach Ref's FT account, Ref's `ft_on_transfer` failed (for example the vault is not registered) and the token's resolve step also ran out of gas, nothing refunds them, Ref's deposit stays below `amount_in`, and the vault rolls back and credits a balance with no tokens behind it. A double failure; a phantom internal balance, not theft. Withdrawing or swapping the phantom portion fails safely, and the next quiet `sync_balance` debits it (`debited`). Not fixed in the deposit path: the reviewer's fix (an extra `ft_balance_of` read there) adds a cross-contract hop and changes the gas plan, which waits for the measured gas run.
- Low (liveness), anyone can grief `sync_balance` by calling `ft_on_transfer` (directly or through any token) while a read is pending; the sync is then invalidated and the owner calls it again. No funds are affected.
- Low (liveness), a pending force release is normally cleared by its callback, which parses its reads leniently and so does not panic on a malformed payload. If it still fails every time (for example the unmeasured 20 TGas `GAS_CB_RELEASE` is too small), `withdraw` stays refused until the owner calls `abort_release` 10 minutes after the release started. The abort strands the held amount as unverified; it is not credited or rolled back.
- Low (was Medium), nested callback gas: now exercised end to end in the local sandbox (see "Sandbox measurements"). That run found `GAS_REF_WITHDRAW` 40 too small and it was raised. What remains is the cost of real Ref bodies, which the sandbox replaces with a mock. The headroom tests bound how much heavier each Ref hop may be. Too little gas stops a chain mid-way; funds then need `force_release_lock` and `recover_from_ref`.
- Low, if `ref.swap`'s promise fails, the vault strands the full `amount_in` as token_in on Ref without asking Ref. NEAR reverts a failed receipt's state, so if Ref's `swap` is a single receipt (it updates Ref's internal deposits only; this has not been checked against Ref's source) a failed swap did not execute and the record is correct. If it did execute, token_out would sit on Ref with no record. Since the M2 fix no reconcile credits on the strength of that record.
- Info, tokens sent with a plain `ft_transfer` (not `ft_transfer_call`) are not recorded at arrival; the owner recovers them with `sync_balance(token_id)`, which works for any token. Unknown-token deposits through `ft_on_transfer` are refunded in full.
- Info, `check_proposal` (view) cannot show `ERR_INSUFFICIENT_GAS`, so it can return ok for a call that fails on gas. The sender must attach at least 280 TGas.
- Info, `strategy` is validated but not used by any on-chain rule. Config size (pools, limits, runners) is unbounded; only the owner can set it.
- Low, pause and revoke do not cancel a swap already in flight. The only way out of a stuck swap is `force_release_lock` after 10 minutes.
- Low, runners are accounts, not keys, and are trusted for timing and for the exact price at or above the floor. The floor is static and owner-set; a stale floor can be too loose or too tight. Loss per trade is bounded by `max_trade`, the floor and `daily_cap`.
- High, deploy blocker, not fixable in code: gas constants are measured in a local sandbox against a mock Ref, not against real Ref costs on any network (the audit asked for a gas test on testnet). The Ref method names and argument shapes (`ft_transfer_call` msg, `swap`, `withdraw`, `get_deposit`, `storage_deposit`, `storage_withdraw`) run against a mock built from a public fork of Ref's source, never against a real Ref contract (see the top of this file). A wrong `withdraw` shape would leave deposited funds on Ref, because `recover_from_ref` uses the same call. Do not deploy or fund the vault until a sandbox or testnet run against Ref has passed; that run needs the owner's explicit approval.
- Low, `daily_cap` is per UTC calendar day, so up to 2x `daily_cap` can be spent within minutes around 00:00 UTC.
- Info, the off-chain JS and Rust rule order and the JS side of the rules are outside this contract and are covered elsewhere in the repository, not here.

Not deployed. No professional audit. Any deploy, funding or mainnet use needs the owner's explicit approval.

---

## Proposal, not built: the runner as a Shade Agent (chain signatures)

Separate from everything above, and not part of the demo. It is a dry-run plan for an open go/no-go decision. Nothing here is deployed, signed or sent.

- **Idea:** the runner account that calls `execute_swap` holds no private key of ours. Its access key is a function-call key (receiver = this vault, method = `execute_swap`) whose public key is derived by the NEAR MPC network (`v1.signer-prod.testnet`, ed25519, domain 1) for a Shade agent contract. The vault does not change. The owner still authorizes the runner with `add_runner` and still revokes it with `revoke_runner` / `revoke_all_runners`. `DeleteKey` on the runner account is a second, independent kill switch.
- **Plan, sources, confirmed/unconfirmed table and go/no-go:** `docs/yield-shade-agent-plan.md`. The Shade Agent Framework has been unmaintained since 2026-04-19 (https://docs.near.org/ai/shade-agents/introduction).
- **Try it offline:** `npm run yield:shade:dry-run` (add `-- --json` for JSON) prints the unsigned `add_runner`, `AddKey`, `execute_swap` transaction and MPC `sign` request, with `dry_run: true, signed: false, sent: false`. Tests: `node --test src/yield/shade/*.test.mjs scripts/yield-shade-dry-run.test.mjs spikes/shade/*.test.mjs`.
- **Deploy drafts:** `deploy/shade/` contains files that have never been built, pushed or deployed.
