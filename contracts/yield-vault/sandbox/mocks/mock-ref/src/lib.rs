//! Mock Ref Finance (Rhea) exchange for the local sandbox harness.
//!
//! SOURCE NOTE: the canonical ref-finance/ref-contracts repository returned HTTP 404
//! when this mock was written (2026-11), so the shapes below were checked against two
//! GitHub copies of `ref-exchange/src`: jumbo-exchange/contracts (a later fork; same
//! method names and JSON shapes, plus an AML check this mock omits) and
//! rozgo/ref-contracts (an early 2021 snapshot). `skip_unwrap_near` is taken from the
//! vault's own call shape and Ref's public docs, NOT from fetched source; see the
//! README of this harness.
//!
//! Mirrored (file in ref-exchange/src); inner withdraw gas defaults come from utils.rs
//! (GAS_FOR_FT_TRANSFER = 20 TGas, GAS_FOR_RESOLVE_TRANSFER = 20 TGas):
//! - `ft_on_transfer(sender_id, amount, msg)` (token_receiver.rs): empty msg deposits
//!   to `sender_id`'s inner account and returns `U128(0)` unused. The account must be
//!   registered (E10), and a panic here makes the token's `ft_resolve_transfer` refund.
//! - `swap(actions, referral_id) -> U128` (lib.rs, action.rs): payable, `assert_one_yocto`,
//!   `SwapAction { pool_id, token_in, amount_in: Option<U128>, token_out, min_amount_out }`
//!   serialized untagged, sequential actions (`amount_in: None` takes the previous
//!   output), `min_amount_out` enforced, inner deposits debited/credited, returns the
//!   last output amount.
//! - `withdraw(token_id, amount, unregister, skip_unwrap_near)` (account_deposit.rs):
//!   payable, 1 yocto, debits the inner deposit BEFORE the transfer, then
//!   `token.ft_transfer(sender, amount)` with 20 TGas (GAS_FOR_FT_TRANSFER) `.then`
//!   `exchange_callback_post_withdraw` with 20 TGas (GAS_FOR_RESOLVE_TRANSFER) which
//!   re-credits the deposit when the transfer failed.
//! - `get_deposit(account_id, token_id) -> U128`, `get_deposits(account_id)`.
//! - NEP-145 `storage_deposit(account_id, registration_only)`, `storage_balance_of`,
//!   `storage_withdraw(amount)` (1 yocto), `storage_balance_bounds` (storage_impl.rs),
//!   with an `E11: insufficient $NEAR storage deposit` check when an account grows.
//!
//! Simplified: pools are fixed-rate (owner-set `rate_num/rate_den` of token_b per
//! token_a, no fee, no curve, no shares); `skip_unwrap_near` is ignored (no wNEAR
//! unwrap); `msg` other than "" is rejected (no instant-swap path); no token
//! whitelist; no frozen tokens; storage byte sizes are rough constants; lost-and-found
//! on a failed re-credit is not implemented.
//!
//! Test knobs (owner only): `set_swap_panic`, `set_refund_all_deposits`,
//! `set_get_deposit_panic`, `set_garbage_get_deposit_call(n)` (the n-th `get_deposit`
//! call after arming returns a non-numeric string, which makes the vault's
//! `#[callback_result]` decode panic and leaves its lock held). Because of the
//! counter, `get_deposit` takes `&mut self` here (real Ref: `&self`); the JSON call
//! shape is identical. Use `get_deposits` / `get_deposit_view` for plain views.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::BTreeMap;

const ACCOUNT_BASE_BYTES: u128 = 500;
const TOKEN_BYTES: u128 = 100;

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
struct Account {
    near_amount: u128,
    tokens: BTreeMap<AccountId, u128>,
}

impl Account {
    fn storage_usage(&self) -> u128 {
        (ACCOUNT_BASE_BYTES + TOKEN_BYTES * self.tokens.len() as u128)
            * env::storage_byte_cost().as_yoctonear()
    }
    fn storage_available(&self) -> u128 {
        self.near_amount.saturating_sub(self.storage_usage())
    }
    fn assert_storage(&self) {
        require!(
            self.storage_usage() <= self.near_amount,
            "E11: insufficient $NEAR storage deposit"
        );
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Pool {
    token_a: AccountId,
    token_b: AccountId,
    /// token_b out per token_a in = num/den.
    rate_num: u128,
    rate_den: u128,
    reserve_a: u128,
    reserve_b: u128,
}

#[near(serializers = [json])]
pub struct SwapAction {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub amount_in: Option<U128>,
    pub token_out: AccountId,
    pub min_amount_out: U128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockRef {
    owner_id: AccountId,
    accounts: BTreeMap<AccountId, Account>,
    pools: BTreeMap<u64, Pool>,
    swap_panic: bool,
    refund_all_deposits: bool,
    get_deposit_panic: bool,
    garbage_at: u32,
    get_deposit_calls: u32,
    /// TGas attached to the inner `ft_transfer` / `exchange_callback_post_withdraw` of `withdraw`.
    withdraw_transfer_tgas: u64,
    withdraw_resolve_tgas: u64,
}

#[near]
impl MockRef {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            accounts: BTreeMap::new(),
            pools: BTreeMap::new(),
            swap_panic: false,
            refund_all_deposits: false,
            get_deposit_panic: false,
            garbage_at: 0,
            get_deposit_calls: 0,
            withdraw_transfer_tgas: 20,
            withdraw_resolve_tgas: 20,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "mock-ref: owner only");
    }

    // ---- owner / test setup -------------------------------------------------

    pub fn add_pool(
        &mut self,
        pool_id: u64,
        token_a: AccountId,
        token_b: AccountId,
        rate_num: U128,
        rate_den: U128,
    ) {
        self.assert_owner();
        require!(rate_num.0 > 0 && rate_den.0 > 0, "bad rate");
        self.pools.insert(
            pool_id,
            Pool { token_a, token_b, rate_num: rate_num.0, rate_den: rate_den.0, reserve_a: 0, reserve_b: 0 },
        );
    }

    pub fn set_rate(&mut self, pool_id: u64, rate_num: U128, rate_den: U128) {
        self.assert_owner();
        let p = self.pools.get_mut(&pool_id).expect("no pool");
        p.rate_num = rate_num.0;
        p.rate_den = rate_den.0;
    }

    /// Book-keeping of pool liquidity. The test also mints the real mock-ft to this
    /// account so that `withdraw` transfers are backed by real tokens.
    pub fn fund_pool(&mut self, pool_id: u64, amount_a: U128, amount_b: U128) {
        self.assert_owner();
        let p = self.pools.get_mut(&pool_id).expect("no pool");
        p.reserve_a += amount_a.0;
        p.reserve_b += amount_b.0;
    }

    pub fn set_swap_panic(&mut self, v: bool) {
        self.assert_owner();
        self.swap_panic = v;
    }

    /// `ft_on_transfer` returns the whole amount as unused (nothing is deposited).
    pub fn set_refund_all_deposits(&mut self, v: bool) {
        self.assert_owner();
        self.refund_all_deposits = v;
    }

    pub fn set_get_deposit_panic(&mut self, v: bool) {
        self.assert_owner();
        self.get_deposit_panic = v;
    }

    pub fn set_garbage_get_deposit_call(&mut self, n: u32) {
        self.assert_owner();
        self.garbage_at = n;
        self.get_deposit_calls = 0;
    }

    /// Overrides the gas `withdraw` attaches to its inner calls (default 20 + 20 TGas, the
    /// values of ref-exchange `GAS_FOR_FT_TRANSFER` / `GAS_FOR_RESOLVE_TRANSFER`).
    pub fn set_withdraw_gas(&mut self, transfer_tgas: u64, resolve_tgas: u64) {
        self.assert_owner();
        self.withdraw_transfer_tgas = transfer_tgas;
        self.withdraw_resolve_tgas = resolve_tgas;
    }

    // ---- token receiver (token_receiver.rs) ---------------------------------

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(msg.is_empty(), "mock-ref: only empty-msg deposits are supported");
        if self.refund_all_deposits {
            return PromiseOrValue::Value(amount);
        }
        let mut acc = self
            .accounts
            .get(&sender_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("E10: account not registered"));
        *acc.tokens.entry(token).or_insert(0) += amount.0;
        acc.assert_storage();
        self.accounts.insert(sender_id, acc);
        PromiseOrValue::Value(U128(0))
    }

    // ---- swap (lib.rs / action.rs) -------------------------------------------

    #[payable]
    pub fn swap(&mut self, actions: Vec<SwapAction>, referral_id: Option<AccountId>) -> U128 {
        assert_one_yocto();
        let _ = referral_id;
        require!(!self.swap_panic, "mock-ref: swap disabled by test knob");
        require!(!actions.is_empty(), "ERR_AT_LEAST_ONE_SWAP");
        let sender = env::predecessor_account_id();
        let mut acc = self
            .accounts
            .get(&sender)
            .cloned()
            .unwrap_or_else(|| env::panic_str("E10: account not registered"));
        let mut prev_out: Option<u128> = None;
        for a in actions {
            let amount_in = a
                .amount_in
                .map(|x| x.0)
                .or(prev_out)
                .unwrap_or_else(|| env::panic_str("E41: wrong action result"));
            let pool = self.pools.get_mut(&a.pool_id).unwrap_or_else(|| env::panic_str("E40: pool not found"));
            let (num, den, fwd) = if a.token_in == pool.token_a && a.token_out == pool.token_b {
                (pool.rate_num, pool.rate_den, true)
            } else if a.token_in == pool.token_b && a.token_out == pool.token_a {
                (pool.rate_den, pool.rate_num, false)
            } else {
                env::panic_str("E12: token not in pool")
            };
            let out = amount_in * num / den;
            require!(out >= a.min_amount_out.0, "E68: slippage error");
            let (res_in, res_out) = if fwd {
                (&mut pool.reserve_a, &mut pool.reserve_b)
            } else {
                (&mut pool.reserve_b, &mut pool.reserve_a)
            };
            require!(*res_out >= out, "E22: not enough tokens in pool");
            *res_in += amount_in;
            *res_out -= out;
            let bal_in = acc.tokens.get_mut(&a.token_in).unwrap_or_else(|| env::panic_str("E21: token not registered"));
            require!(*bal_in >= amount_in, "E22: not enough tokens in deposit");
            *bal_in -= amount_in;
            *acc.tokens.entry(a.token_out).or_insert(0) += out;
            prev_out = Some(out);
        }
        acc.assert_storage();
        self.accounts.insert(sender, acc);
        U128(prev_out.unwrap())
    }

    // ---- withdraw (account_deposit.rs) -----------------------------------------

    #[payable]
    pub fn withdraw(
        &mut self,
        token_id: AccountId,
        amount: U128,
        unregister: Option<bool>,
        skip_unwrap_near: Option<bool>,
    ) -> Promise {
        assert_one_yocto();
        let _ = skip_unwrap_near;
        require!(amount.0 > 0, "E29: Illegal withdraw amount");
        let sender = env::predecessor_account_id();
        let acc = self
            .accounts
            .get_mut(&sender)
            .unwrap_or_else(|| env::panic_str("E10: account not registered"));
        let bal = acc.tokens.get_mut(&token_id).unwrap_or_else(|| env::panic_str("E21: token not registered"));
        require!(*bal >= amount.0, "E22: not enough tokens in deposit");
        *bal -= amount.0;
        if unregister == Some(true) {
            require!(*bal == 0, "E24: non-zero token balance");
            acc.tokens.remove(&token_id);
        }
        Promise::new(token_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                json!({ "receiver_id": sender, "amount": amount, "memo": null })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(self.withdraw_transfer_tgas),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(self.withdraw_resolve_tgas))
                    .exchange_callback_post_withdraw(token_id, sender, amount),
            )
    }

    #[private]
    pub fn exchange_callback_post_withdraw(
        &mut self,
        token_id: AccountId,
        sender_id: AccountId,
        amount: U128,
    ) {
        require!(env::promise_results_count() == 1, "E25: expected 1 promise result");
        match env::promise_result_checked(0, 4096) {
            Ok(_) => {}
            Err(_) => {
                // Re-credit (reverts the withdraw). Lost-and-found is not mirrored.
                if let Some(acc) = self.accounts.get_mut(&sender_id) {
                    *acc.tokens.entry(token_id).or_insert(0) += amount.0;
                    env::log_str("mock-ref: ft_transfer failed, deposit re-credited");
                }
            }
        }
    }

    // ---- views ---------------------------------------------------------------

    pub fn get_deposit(&mut self, account_id: AccountId, token_id: AccountId) -> Value {
        require!(!self.get_deposit_panic, "mock-ref: get_deposit disabled by test knob");
        if self.garbage_at > 0 {
            self.get_deposit_calls += 1;
            if self.get_deposit_calls == self.garbage_at {
                return Value::String("not-a-number".to_string());
            }
        }
        Value::String(self.get_deposit_view(account_id, token_id).0.to_string())
    }

    pub fn get_deposit_view(&self, account_id: AccountId, token_id: AccountId) -> U128 {
        U128(
            self.accounts
                .get(&account_id)
                .and_then(|a| a.tokens.get(&token_id).copied())
                .unwrap_or(0),
        )
    }

    pub fn get_deposits(&self, account_id: AccountId) -> BTreeMap<AccountId, U128> {
        self.accounts
            .get(&account_id)
            .map(|a| a.tokens.iter().map(|(k, v)| (k.clone(), U128(*v))).collect())
            .unwrap_or_default()
    }

    // ---- NEP-145 (storage_impl.rs) -------------------------------------------

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let amount = env::attached_deposit().as_yoctonear();
        let id = account_id.unwrap_or_else(env::predecessor_account_id);
        let min = self.min_storage();
        let registered = self.accounts.contains_key(&id);
        require!(
            amount >= min || registered,
            "ERR_DEPOSIT_LESS_THAN_MIN_STORAGE"
        );
        let acc = self.accounts.entry(id.clone()).or_default();
        if registration_only.unwrap_or(false) {
            if !registered {
                acc.near_amount = min;
                let refund = amount - min;
                if refund > 0 {
                    Promise::new(env::predecessor_account_id())
                        .transfer(NearToken::from_yoctonear(refund))
                        .detach();
                }
            } else if amount > 0 {
                Promise::new(env::predecessor_account_id())
                    .transfer(NearToken::from_yoctonear(amount))
                    .detach();
            }
        } else {
            acc.near_amount += amount;
        }
        self.storage_balance_of(id).unwrap()
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let id = env::predecessor_account_id();
        let acc = self
            .accounts
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("E10: account not registered"));
        let avail = acc.storage_available();
        let take = amount.map(|a| a.0).unwrap_or(avail);
        require!(take <= avail, "E13: storage withdraw exceeds available");
        acc.near_amount -= take;
        if take > 0 {
            Promise::new(id.clone())
                .transfer(NearToken::from_yoctonear(take))
                .detach();
        }
        self.storage_balance_of(id).unwrap()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.accounts.get(&account_id).map(|a| StorageBalance {
            total: U128(a.near_amount),
            available: U128(a.storage_available()),
        })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(self.min_storage()), max: None }
    }

    fn min_storage(&self) -> u128 {
        ACCOUNT_BASE_BYTES * env::storage_byte_cost().as_yoctonear()
    }
}
