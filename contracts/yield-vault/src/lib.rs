//! Yield Vault.
//!
//! A per-personality-NFT trading vault. Each personality NFT (aloof, chaotic,
//! social, skeptic) is an AI agent running a strategy off chain. The agent can
//! only act through approved *runner* accounts, and this contract enforces HARD
//! limits regardless of what the strategy proposes: an allow-list of pools, a
//! per-trade cap, a per-day cap, a minimum output, a pause switch and a
//! revoke-all kill switch. Approved swaps run on Rhea (Ref Finance) with the
//! deposit -> swap -> withdraw pattern through a chain of private callbacks.
//!
//! Daily cap simplification: the cap is counted in `token_in` units of each
//! swap, summed across tokens without conversion. Operators should therefore
//! set the cap with a single quote token in mind (or allow only pools whose
//! input tokens have the same decimals/value).
//!
//! NOT DEPLOYED. See README.md.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use std::collections::BTreeMap;

#[cfg(test)]
mod tests;

/// NEP-297 `standard` field.
pub const EVENT_STANDARD: &str = "yield_vault";
/// NEP-297 `version` field.
pub const EVENT_VERSION: &str = "1.0.0";
/// Nanoseconds in one UTC day.
pub const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;
/// The four personality strategies.
pub const STRATEGIES: [&str; 4] = ["aloof", "chaotic", "social", "skeptic"];

// Gas plan (see README). Each hop's callback is attached enough gas to run its
// own body and attach gas to the rest of the chain.
/// `ft_transfer_call` of token_in to Ref (includes Ref `ft_on_transfer` and resolve).
pub const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(70);
/// `ref.swap`.
pub const GAS_REF_SWAP: Gas = Gas::from_tgas(50);
/// `ref.withdraw` (includes its inner ft_transfer and callback).
pub const GAS_REF_WITHDRAW: Gas = Gas::from_tgas(40);
/// `on_withdraw_done` / `on_recover` / `on_owner_withdraw` bodies.
pub const GAS_CB_FINAL: Gas = Gas::from_tgas(15);
/// `on_swap`: own body (~10) + withdraw (40) + final callback (15) + margin.
pub const GAS_CB_SWAP: Gas = Gas::from_tgas(100);
/// `on_deposit`: own body (~10) + swap (50) + `on_swap` (100).
pub const GAS_CB_DEPOSIT: Gas = Gas::from_tgas(160);
/// Minimum prepaid gas for `execute_swap` (70 + 160 + own body + margin).
pub const MIN_EXECUTE_GAS: Gas = Gas::from_tgas(250);
/// Gas for an owner `ft_transfer` out.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
/// Gas for `ref.storage_deposit`.
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(30);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// A pool the vault may trade in. `token_a`/`token_b` are the pool's pair.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedPool {
    pub pool_id: u64,
    pub token_a: AccountId,
    pub token_b: AccountId,
}

/// Owner-set hard limits and approvals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    /// "aloof" | "chaotic" | "social" | "skeptic".
    pub strategy: String,
    pub allowed_pools: Vec<AllowedPool>,
    /// Max `amount_in` of a single swap (token_in units).
    pub max_trade: U128,
    /// Max sum of `amount_in` per UTC day (token_in units, see crate docs).
    pub daily_cap: U128,
    /// Accounts allowed to call `execute_swap`.
    pub runners: Vec<AccountId>,
}

/// A swap the runner wants to execute.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapProposal {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    pub amount_in: U128,
    pub min_amount_out: U128,
}

/// Result of the side-effect-free rule check.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckResult {
    pub ok: bool,
    /// Empty when ok, otherwise `ERR_CODE: detail`.
    pub reason: String,
}

/// Public snapshot of the vault.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultState {
    pub owner_id: AccountId,
    pub nft_contract_id: AccountId,
    pub token_id: String,
    pub ref_exchange_id: AccountId,
    pub paused: bool,
    pub swap_in_flight: bool,
    pub day: u64,
    pub spent_today: U128,
    pub balances: Vec<(AccountId, U128)>,
    pub stranded_on_ref: Vec<(AccountId, U128)>,
    pub swaps_executed: u64,
}

/// Book-keeping for the single swap that may be in flight.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InFlight {
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    /// Amount debited; shrinks to the amount Ref actually accepted.
    pub amount_in: u128,
    pub min_amount_out: u128,
    /// `day` the spend was counted on (rollback only applies the same day).
    pub day: u64,
    pub amount_out: u128,
}

/// Ref `swap` action.
#[near(serializers = [json])]
struct RefSwapAction {
    pool_id: u64,
    token_in: AccountId,
    token_out: AccountId,
    amount_in: Option<U128>,
    min_amount_out: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct YieldVault {
    owner_id: AccountId,
    nft_contract_id: AccountId,
    token_id: String,
    ref_exchange_id: AccountId,
    config: VaultConfig,
    paused: bool,
    in_flight: Option<InFlight>,
    day: u64,
    spent_today: u128,
    balances: BTreeMap<AccountId, u128>,
    stranded: BTreeMap<AccountId, u128>,
    swaps_executed: u64,
    /// Unused marker keeping a typed map available for future per-runner data.
    _reserved: LookupMap<AccountId, u8>,
}

fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{line}"));
}

fn day_of(ts: u64) -> u64 {
    ts / NS_PER_DAY
}

fn validate_config(c: &VaultConfig) {
    require!(
        STRATEGIES.contains(&c.strategy.as_str()),
        "ERR_BAD_CONFIG: strategy must be aloof, chaotic, social or skeptic"
    );
    require!(c.max_trade.0 > 0, "ERR_BAD_CONFIG: max_trade must be > 0");
    require!(
        c.daily_cap.0 >= c.max_trade.0,
        "ERR_BAD_CONFIG: daily_cap must be >= max_trade"
    );
    for (i, p) in c.allowed_pools.iter().enumerate() {
        require!(
            p.token_a != p.token_b,
            "ERR_BAD_CONFIG: token_a must differ from token_b"
        );
        require!(
            !c.allowed_pools[..i].iter().any(|q| q.pool_id == p.pool_id),
            "ERR_BAD_CONFIG: duplicate pool"
        );
    }
    for (i, r) in c.runners.iter().enumerate() {
        require!(
            !c.runners[..i].contains(r),
            "ERR_BAD_CONFIG: duplicate runner"
        );
    }
}

#[near]
impl YieldVault {
    #[init]
    pub fn new(
        owner_id: AccountId,
        nft_contract_id: AccountId,
        token_id: String,
        ref_exchange_id: AccountId,
        config: VaultConfig,
    ) -> Self {
        validate_config(&config);
        let this = Self {
            owner_id,
            nft_contract_id,
            token_id,
            ref_exchange_id,
            config,
            paused: false,
            in_flight: None,
            day: day_of(env::block_timestamp()),
            spent_today: 0,
            balances: BTreeMap::new(),
            stranded: BTreeMap::new(),
            swaps_executed: 0,
            _reserved: LookupMap::new(b"r".to_vec()),
        };
        emit("config_updated", json!({ "config": this.config }));
        this
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> VaultConfig {
        self.config.clone()
    }

    pub fn get_state(&self) -> VaultState {
        let now_day = day_of(env::block_timestamp());
        VaultState {
            owner_id: self.owner_id.clone(),
            nft_contract_id: self.nft_contract_id.clone(),
            token_id: self.token_id.clone(),
            ref_exchange_id: self.ref_exchange_id.clone(),
            paused: self.paused,
            swap_in_flight: self.in_flight.is_some(),
            day: self.day,
            spent_today: U128(self.spent_on(now_day)),
            balances: self
                .balances
                .iter()
                .map(|(k, v)| (k.clone(), U128(*v)))
                .collect(),
            stranded_on_ref: self
                .stranded
                .iter()
                .map(|(k, v)| (k.clone(), U128(*v)))
                .collect(),
            swaps_executed: self.swaps_executed,
        }
    }

    pub fn get_balance(&self, token_id: AccountId) -> U128 {
        U128(self.balances.get(&token_id).copied().unwrap_or(0))
    }

    /// Runs the exact rules of `execute_swap` without side effects.
    pub fn check_proposal(&self, proposal: SwapProposal, runner_id: AccountId) -> CheckResult {
        match self.check_rules(&proposal, &runner_id) {
            Ok(()) => CheckResult {
                ok: true,
                reason: String::new(),
            },
            Err(reason) => CheckResult { ok: false, reason },
        }
    }

    // ---------------------------------------------------------------- deposits

    /// NEP-141 receiver. Accepts only the owner's deposits of tokens that
    /// appear in an allowed pool; everything else is refunded in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        #[allow(unused_variables)] msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        let known = self
            .config
            .allowed_pools
            .iter()
            .any(|p| p.token_a == token || p.token_b == token);
        if sender_id != self.owner_id || !known || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        self.credit(&token, amount.0);
        emit(
            "deposit",
            json!({ "token_id": token, "amount": amount.0.to_string(), "sender_id": sender_id }),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Owner withdraws `amount` of `token_id` to the owner account.
    #[payable]
    pub fn withdraw(&mut self, token_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        assert_one_yocto();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT: amount must be > 0");
        self.debit(&token_id, amount.0);
        emit(
            "withdraw",
            json!({ "token_id": token_id, "amount": amount.0.to_string(), "owner_id": self.owner_id }),
        );
        Promise::new(token_id.clone())
            .function_call(
                "ft_transfer".to_string(),
                json_bytes(json!({ "receiver_id": self.owner_id, "amount": amount })),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINAL)
                    .on_owner_withdraw(token_id, amount),
            )
    }

    // -------------------------------------------------------------------- swap

    /// Validates `proposal` against the hard limits and starts the
    /// deposit -> swap -> withdraw chain on Ref. Panics with an `ERR_*` code
    /// on any violation.
    pub fn execute_swap(&mut self, proposal: SwapProposal) -> Promise {
        let runner = env::predecessor_account_id();
        if let Err(reason) = self.check_rules(&proposal, &runner) {
            env::panic_str(&reason);
        }
        require!(
            env::prepaid_gas() >= MIN_EXECUTE_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 250 TGas"
        );
        let amount = proposal.amount_in.0;
        let today = day_of(env::block_timestamp());
        self.roll_day(today);
        self.debit(&proposal.token_in, amount);
        self.spent_today += amount; // bounded by daily_cap check
        self.in_flight = Some(InFlight {
            pool_id: proposal.pool_id,
            token_in: proposal.token_in.clone(),
            token_out: proposal.token_out.clone(),
            amount_in: amount,
            min_amount_out: proposal.min_amount_out.0,
            day: today,
            amount_out: 0,
        });
        emit(
            "swap_proposed",
            json!({
                "runner_id": runner,
                "pool_id": proposal.pool_id,
                "token_in": proposal.token_in,
                "token_out": proposal.token_out,
                "amount_in": amount.to_string(),
                "min_amount_out": proposal.min_amount_out.0.to_string(),
            }),
        );
        Promise::new(proposal.token_in)
            .function_call(
                "ft_transfer_call".to_string(),
                json_bytes(json!({
                    "receiver_id": self.ref_exchange_id,
                    "amount": proposal.amount_in,
                    "msg": "",
                })),
                ONE_YOCTO,
                GAS_FT_TRANSFER_CALL,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_DEPOSIT)
                    .on_deposit(),
            )
    }

    /// Hop 1 callback: checks how much Ref accepted, then swaps.
    #[private]
    pub fn on_deposit(
        &mut self,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        let Some(mut fl) = self.in_flight.clone() else {
            return PromiseOrValue::Value(U128(0));
        };
        let used = match used {
            Ok(u) => u.0.min(fl.amount_in),
            Err(_) => 0,
        };
        if used == 0 {
            // Nothing reached Ref: the tokens are still with the vault.
            self.rollback(&fl, fl.amount_in);
            self.fail(&fl, "deposit_failed");
            return PromiseOrValue::Value(U128(0));
        }
        if used < fl.amount_in {
            self.rollback(&fl, fl.amount_in - used);
            fl.amount_in = used;
            self.in_flight = Some(fl.clone());
        }
        let action = RefSwapAction {
            pool_id: fl.pool_id,
            token_in: fl.token_in.clone(),
            token_out: fl.token_out.clone(),
            amount_in: Some(U128(fl.amount_in)),
            min_amount_out: U128(fl.min_amount_out),
        };
        let p = Promise::new(self.ref_exchange_id.clone())
            .function_call(
                "swap".to_string(),
                json_bytes(json!({ "actions": [action], "referral_id": null })),
                ONE_YOCTO,
                GAS_REF_SWAP,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_SWAP)
                    .on_swap(),
            );
        PromiseOrValue::Promise(p)
    }

    /// Hop 2 callback: reads `amount_out`, then withdraws it from Ref.
    #[private]
    pub fn on_swap(
        &mut self,
        #[callback_result] out: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        let Some(mut fl) = self.in_flight.clone() else {
            return PromiseOrValue::Value(U128(0));
        };
        match out {
            Err(_) => {
                // Deposit succeeded, swap failed: token_in sits in the vault's Ref account.
                self.strand(&fl.token_in, fl.amount_in, "swap_failed");
                self.fail(&fl, "swap_failed");
                PromiseOrValue::Value(U128(0))
            }
            Ok(out) if out.0 == 0 || out.0 < fl.min_amount_out => {
                self.strand(&fl.token_out, out.0, "amount_out_below_min");
                self.fail(&fl, "amount_out_below_min");
                PromiseOrValue::Value(U128(0))
            }
            Ok(out) => {
                fl.amount_out = out.0;
                self.in_flight = Some(fl.clone());
                let p = Promise::new(self.ref_exchange_id.clone())
                    .function_call(
                        "withdraw".to_string(),
                        json_bytes(json!({
                            "token_id": fl.token_out,
                            "amount": out,
                            "unregister": null,
                            "skip_unwrap_near": true,
                        })),
                        ONE_YOCTO,
                        GAS_REF_WITHDRAW,
                    )
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_CB_FINAL)
                            .on_withdraw_done(),
                    );
                PromiseOrValue::Promise(p)
            }
        }
    }

    /// Hop 3 callback: credits token_out, releases the lock.
    #[private]
    pub fn on_withdraw_done(&mut self) -> U128 {
        let ok = env::promise_result_checked(0, 4096).is_ok();
        let Some(fl) = self.in_flight.clone() else {
            return U128(0);
        };
        if !ok {
            self.strand(&fl.token_out, fl.amount_out, "withdraw_failed");
            self.fail(&fl, "withdraw_failed");
            return U128(0);
        }
        self.credit(&fl.token_out, fl.amount_out);
        self.swaps_executed += 1;
        self.in_flight = None;
        emit(
            "swap_executed",
            json!({
                "pool_id": fl.pool_id,
                "token_in": fl.token_in,
                "token_out": fl.token_out,
                "amount_in": fl.amount_in.to_string(),
                "amount_out": fl.amount_out.to_string(),
            }),
        );
        U128(fl.amount_out)
    }

    /// Restores the balance if the owner's `ft_transfer` failed.
    #[private]
    pub fn on_owner_withdraw(&mut self, token_id: AccountId, amount: U128) {
        if env::promise_result_checked(0, 4096).is_err() {
            self.credit(&token_id, amount.0);
            emit(
                "withdraw_failed",
                json!({ "token_id": token_id, "amount": amount.0.to_string() }),
            );
        }
    }

    // ------------------------------------------------------------ owner admin

    #[payable]
    pub fn pause(&mut self) {
        self.owner_one_yocto();
        self.paused = true;
        emit("paused", json!({ "by": env::predecessor_account_id() }));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.owner_one_yocto();
        self.paused = false;
        emit("unpaused", json!({ "by": env::predecessor_account_id() }));
    }

    #[payable]
    pub fn add_runner(&mut self, runner_id: AccountId) {
        self.owner_one_yocto();
        require!(
            !self.config.runners.contains(&runner_id),
            "ERR_RUNNER_EXISTS: already a runner"
        );
        self.config.runners.push(runner_id.clone());
        emit("runner_added", json!({ "runner_id": runner_id }));
    }

    #[payable]
    pub fn revoke_runner(&mut self, runner_id: AccountId) {
        self.owner_one_yocto();
        let before = self.config.runners.len();
        self.config.runners.retain(|r| r != &runner_id);
        require!(
            self.config.runners.len() < before,
            "ERR_RUNNER_NOT_FOUND: not a runner"
        );
        emit("runner_revoked", json!({ "runner_id": runner_id }));
    }

    /// Kill switch: removes every runner and pauses the vault.
    #[payable]
    pub fn revoke_all_runners(&mut self) {
        self.owner_one_yocto();
        let revoked = std::mem::take(&mut self.config.runners);
        self.paused = true;
        emit("runner_revoked", json!({ "runner_ids": revoked, "all": true }));
        emit("paused", json!({ "by": env::predecessor_account_id() }));
    }

    #[payable]
    pub fn update_config(&mut self, config: VaultConfig) {
        self.owner_one_yocto();
        require!(
            self.in_flight.is_none(),
            "ERR_SWAP_IN_FLIGHT: cannot update config during a swap"
        );
        validate_config(&config);
        self.config = config;
        emit("config_updated", json!({ "config": self.config }));
    }

    /// Owner pays Ref storage for the vault's internal Ref account.
    #[payable]
    pub fn register_on_ref(&mut self) -> Promise {
        self.assert_owner();
        let deposit = env::attached_deposit();
        require!(
            !deposit.is_zero(),
            "ERR_DEPOSIT_REQUIRED: attach NEAR for Ref storage"
        );
        Promise::new(self.ref_exchange_id.clone()).function_call(
            "storage_deposit".to_string(),
            json_bytes(json!({
                "account_id": env::current_account_id(),
                "registration_only": true,
            })),
            deposit,
            GAS_STORAGE_DEPOSIT,
        )
    }

    /// Pulls stranded funds from the vault's Ref account back into the vault.
    #[payable]
    pub fn recover_from_ref(&mut self, token_id: AccountId, amount: U128) -> Promise {
        self.owner_one_yocto();
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT: amount must be > 0");
        let have = self.stranded.get(&token_id).copied().unwrap_or(0);
        require!(
            have >= amount.0,
            "ERR_INSUFFICIENT_STRANDED: not that much stranded on Ref"
        );
        self.unstrand(&token_id, amount.0);
        Promise::new(self.ref_exchange_id.clone())
            .function_call(
                "withdraw".to_string(),
                json_bytes(json!({
                    "token_id": token_id,
                    "amount": amount,
                    "unregister": null,
                    "skip_unwrap_near": true,
                })),
                ONE_YOCTO,
                GAS_REF_WITHDRAW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_FINAL)
                    .on_recover(token_id, amount),
            )
    }

    /// Credits recovered funds, or restores the stranded record on failure.
    #[private]
    pub fn on_recover(&mut self, token_id: AccountId, amount: U128) {
        if env::promise_result_checked(0, 4096).is_ok() {
            self.credit(&token_id, amount.0);
            emit(
                "recovered",
                json!({ "token_id": token_id, "amount": amount.0.to_string() }),
            );
        } else {
            *self.stranded.entry(token_id).or_insert(0) += amount.0;
        }
    }
}

// ------------------------------------------------------------------- internals

impl YieldVault {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ERR_NOT_OWNER: only the owner can call this"
        );
    }

    /// Owner-only and exactly 1 yoctoNEAR (all owner methods except
    /// `register_on_ref`, which needs a real deposit).
    fn owner_one_yocto(&self) {
        self.assert_owner();
        assert_one_yocto();
    }

    /// Spent amount for `now_day` (0 if the stored day is older).
    fn spent_on(&self, now_day: u64) -> u128 {
        if now_day == self.day {
            self.spent_today
        } else {
            0
        }
    }

    fn roll_day(&mut self, now_day: u64) {
        if now_day != self.day {
            self.day = now_day;
            self.spent_today = 0;
        }
    }

    fn credit(&mut self, token: &AccountId, amount: u128) {
        let b = self.balances.entry(token.clone()).or_insert(0);
        *b = b.checked_add(amount).expect("ERR_OVERFLOW: balance");
    }

    fn debit(&mut self, token: &AccountId, amount: u128) {
        let b = self
            .balances
            .get_mut(token)
            .filter(|b| **b >= amount)
            .unwrap_or_else(|| env::panic_str("ERR_INSUFFICIENT_BALANCE: vault balance too low"));
        *b -= amount;
        if *b == 0 {
            self.balances.remove(token);
        }
    }

    fn unstrand(&mut self, token: &AccountId, amount: u128) {
        if let Some(v) = self.stranded.get_mut(token) {
            *v = v.saturating_sub(amount);
            if *v == 0 {
                self.stranded.remove(token);
            }
        }
    }

    /// Gives `amount` back to the vault balance and un-counts it from today's
    /// spend (only if the day has not rolled since the debit).
    fn rollback(&mut self, fl: &InFlight, amount: u128) {
        self.credit(&fl.token_in, amount);
        if self.day == fl.day {
            self.spent_today = self.spent_today.saturating_sub(amount);
        }
    }

    fn strand(&mut self, token: &AccountId, amount: u128, why: &str) {
        if amount == 0 {
            return;
        }
        let e = self.stranded.entry(token.clone()).or_insert(0);
        *e = e.checked_add(amount).expect("ERR_OVERFLOW: stranded");
        emit(
            "stranded",
            json!({ "token_id": token, "amount": amount.to_string(), "reason": why }),
        );
    }

    /// Releases the lock and emits `swap_failed`.
    fn fail(&mut self, fl: &InFlight, reason: &str) {
        self.in_flight = None;
        emit(
            "swap_failed",
            json!({
                "pool_id": fl.pool_id,
                "token_in": fl.token_in,
                "token_out": fl.token_out,
                "amount_in": fl.amount_in.to_string(),
                "reason": reason,
            }),
        );
    }

    /// Shared rule engine for `execute_swap` and `check_proposal`.
    fn check_rules(&self, p: &SwapProposal, runner: &AccountId) -> Result<(), String> {
        if !self.config.runners.contains(runner) {
            return Err(format!("ERR_NOT_RUNNER: {runner} is not an approved runner"));
        }
        if self.paused {
            return Err("ERR_PAUSED: vault is paused".to_string());
        }
        if self.in_flight.is_some() {
            return Err("ERR_SWAP_IN_FLIGHT: another swap is in flight".to_string());
        }
        let Some(pool) = self
            .config
            .allowed_pools
            .iter()
            .find(|a| a.pool_id == p.pool_id)
        else {
            return Err(format!("ERR_POOL_NOT_ALLOWED: pool {}", p.pool_id));
        };
        let fwd = p.token_in == pool.token_a && p.token_out == pool.token_b;
        let rev = p.token_in == pool.token_b && p.token_out == pool.token_a;
        if !(fwd || rev) {
            return Err(format!(
                "ERR_TOKEN_NOT_IN_POOL: tokens must be the pair of pool {}",
                p.pool_id
            ));
        }
        if p.amount_in.0 == 0 {
            return Err("ERR_ZERO_AMOUNT: amount_in must be > 0".to_string());
        }
        if p.min_amount_out.0 == 0 {
            return Err("ERR_ZERO_MIN_OUT: min_amount_out must be > 0".to_string());
        }
        if p.amount_in.0 > self.config.max_trade.0 {
            return Err(format!(
                "ERR_MAX_TRADE: {} exceeds max_trade {}",
                p.amount_in.0, self.config.max_trade.0
            ));
        }
        let spent = self.spent_on(day_of(env::block_timestamp()));
        match spent.checked_add(p.amount_in.0) {
            Some(total) if total <= self.config.daily_cap.0 => {}
            _ => {
                return Err(format!(
                    "ERR_DAILY_CAP: spent {} + {} exceeds daily_cap {}",
                    spent, p.amount_in.0, self.config.daily_cap.0
                ))
            }
        }
        let bal = self.balances.get(&p.token_in).copied().unwrap_or(0);
        if bal < p.amount_in.0 {
            return Err(format!(
                "ERR_INSUFFICIENT_BALANCE: have {} need {}",
                bal, p.amount_in.0
            ));
        }
        Ok(())
    }
}

fn json_bytes(v: Value) -> Vec<u8> {
    serde_json::to_vec(&v).expect("json")
}
