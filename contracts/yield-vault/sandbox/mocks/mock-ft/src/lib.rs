//! Mock NEP-141 fungible token with NEP-145 storage, for the local sandbox harness.
//!
//! Mirrored from the NEP-141 / NEP-145 reference implementation
//! (near-contract-standards `FungibleToken`):
//! - `ft_transfer` (1 yocto, receiver must be registered, balance checked)
//! - `ft_transfer_call`: debits the sender, calls `receiver.ft_on_transfer` with
//!   `prepaid_gas - 30 TGas` (GAS_FOR_FT_TRANSFER_CALL), then `ft_resolve_transfer`
//!   with 5 TGas (GAS_FOR_RESOLVE_TRANSFER). The resolve refunds the unused amount
//!   (capped by the receiver's remaining balance) back to the sender, returns the
//!   amount actually used, and treats a failed `ft_on_transfer` as "all unused".
//! - `ft_balance_of`, `ft_total_supply`
//! - `storage_deposit` / `storage_balance_of` / `storage_balance_bounds` (NEP-145)
//!
//! Simplified: no metadata, no `storage_unregister`, `storage_deposit` keeps the whole
//! attached deposit (no refund of the excess), NEP-297 events are not emitted.
//!
//! Test-only additions: `mint`, `set_fail_transfers`, `set_fail_transfer_calls`
//! (owner only). `set_fail_transfers(true)` makes `ft_transfer` panic, which is
//! what a Ref `withdraw` and the vault's owner `withdraw` use.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::BTreeMap;

const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);
const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(30);
/// Minimum storage deposit (about 0.00125 NEAR, the reference token's bound).
const STORAGE_MIN: u128 = 1_250_000_000_000_000_000_000;

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
pub struct MockFt {
    owner_id: AccountId,
    balances: BTreeMap<AccountId, u128>,
    registered: BTreeMap<AccountId, u128>,
    total_supply: u128,
    fail_transfers: bool,
    fail_transfer_calls: bool,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            balances: BTreeMap::new(),
            registered: BTreeMap::new(),
            total_supply: 0,
            fail_transfers: false,
            fail_transfer_calls: false,
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "mock-ft: owner only");
    }

    /// Test setup: mint to `account_id` (registers it implicitly).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.assert_owner();
        self.registered.entry(account_id.clone()).or_insert(0);
        *self.balances.entry(account_id).or_insert(0) += amount.0;
        self.total_supply += amount.0;
    }

    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.assert_owner();
        self.fail_transfers = fail;
    }

    pub fn set_fail_transfer_calls(&mut self, fail: bool) {
        self.assert_owner();
        self.fail_transfer_calls = fail;
    }

    fn internal_transfer(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "The amount should be a positive number");
        require!(from != to, "Sender and receiver should be different");
        require!(
            self.registered.contains_key(to),
            format!("The account {to} is not registered")
        );
        let fb = self.balances.get(from).copied().unwrap_or(0);
        require!(fb >= amount, "The account doesn't have enough balance");
        self.balances.insert(from.clone(), fb - amount);
        *self.balances.entry(to.clone()).or_insert(0) += amount;
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        let _ = memo;
        require!(!self.fail_transfers, "mock-ft: ft_transfer disabled by test knob");
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        let _ = memo;
        require!(
            !self.fail_transfer_calls,
            "mock-ft: ft_transfer_call disabled by test knob"
        );
        require!(
            env::prepaid_gas() > GAS_FOR_FT_TRANSFER_CALL,
            "More gas is required"
        );
        let sender = env::predecessor_account_id();
        self.internal_transfer(&sender, &receiver_id, amount.0);
        let receiver_gas = env::prepaid_gas()
            .checked_sub(GAS_FOR_FT_TRANSFER_CALL)
            .unwrap_or_else(|| env::panic_str("More gas is required"));
        Promise::new(receiver_id.clone())
            .function_call(
                "ft_on_transfer".to_string(),
                json!({ "sender_id": sender, "amount": amount, "msg": msg })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                receiver_gas,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 4096) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let rb = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let refund = unused.min(rb);
            if refund > 0 {
                self.balances.insert(receiver_id, rb - refund);
                if self.registered.contains_key(&sender_id) {
                    *self.balances.entry(sender_id).or_insert(0) += refund;
                } else {
                    self.total_supply -= refund; // sender gone: burn, as the reference does
                }
                return U128(amount.0 - refund);
            }
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    // NEP-145
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        let account_id = account_id.unwrap_or_else(env::predecessor_account_id);
        let amount = env::attached_deposit().as_yoctonear();
        if !self.registered.contains_key(&account_id) {
            require!(amount >= STORAGE_MIN, "The attached deposit is less than the minimum storage balance");
        }
        *self.registered.entry(account_id.clone()).or_insert(0) += amount;
        self.storage_balance_of(account_id).unwrap()
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.registered.get(&account_id).map(|t| StorageBalance {
            total: U128(*t),
            available: U128(t.saturating_sub(STORAGE_MIN)),
        })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(STORAGE_MIN),
            max: None,
        }
    }
}
