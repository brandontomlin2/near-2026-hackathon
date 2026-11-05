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
//! Limits are per `token_in`, in that token's own base units (`limits`), and
//! each allowed pool carries an owner-set price floor per direction.
//!
//! NOT DEPLOYED. See README.md.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
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
/// `on_recover` / `on_owner_withdraw` bodies.
pub const GAS_CB_FINAL: Gas = Gas::from_tgas(15);
/// Ref view `get_deposit`.
pub const GAS_REF_VIEW: Gas = Gas::from_tgas(10);
/// Reconciliation callbacks (`on_*_reconciled`) bodies.
pub const GAS_CB_RECONCILE: Gas = Gas::from_tgas(15);
/// `on_recover`: own body (~10) + `get_deposit` (10) + reconcile (15) + margin.
pub const GAS_CB_WITHDRAW_DONE: Gas = Gas::from_tgas(40);
/// `on_withdraw_pre`: own body (~10) + withdraw (40) + `get_deposit` (10) + reconcile (15) + margin.
pub const GAS_CB_WITHDRAW_PRE: Gas = Gas::from_tgas(80);
/// `on_swap`: own body (~10) + `get_deposit` (10) + `on_withdraw_pre` (80) + margin.
pub const GAS_CB_SWAP: Gas = Gas::from_tgas(110);
/// `on_deposit`: own body (~10) + swap (50) + `on_swap` (110) + margin.
pub const GAS_CB_DEPOSIT: Gas = Gas::from_tgas(180);
/// Minimum prepaid gas for `execute_swap` (70 + 180 + own body + margin). Max tx gas is 300.
pub const MIN_EXECUTE_GAS: Gas = Gas::from_tgas(280);
/// A swap lock older than this (ns, 10 minutes) may be force-released by the owner.
pub const STALE_LOCK_NS: u64 = 600 * 1_000_000_000;
/// A pending force release older than this (ns, 10 minutes) may be aborted by the owner.
pub const RELEASE_ABORT_NS: u64 = 600 * 1_000_000_000;
/// Gas for an owner `ft_transfer` out.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(30);
/// Minimum prepaid gas for owner `withdraw`: ft_transfer (30) + on_owner_withdraw (15)
/// + own body + receipt fees + margin (60 is too little even in the unit-test VM).
pub const MIN_WITHDRAW_GAS: Gas = Gas::from_tgas(80);
/// Gas for `ref.storage_deposit`.
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(30);
/// `on_recover_pre`: own body (~10) + Ref withdraw (40) + `on_recover` (40) + margin.
pub const GAS_CB_RECOVER_PRE: Gas = Gas::from_tgas(100);
/// Minimum prepaid gas for `recover_from_ref`: `get_deposit` (10) + `on_recover_pre` (100) + body + fees + margin.
pub const MIN_RECOVER_GAS: Gas = Gas::from_tgas(150);
/// `on_register` body (may create one transfer).
pub const GAS_CB_REGISTER: Gas = Gas::from_tgas(10);
/// Minimum prepaid gas for `register_on_ref`: storage_deposit (30) + on_register (10) + fees + margin.
pub const MIN_REGISTER_GAS: Gas = Gas::from_tgas(60);
/// NEP-141 view `ft_balance_of`.
pub const GAS_FT_VIEW: Gas = Gas::from_tgas(10);
/// `on_force_release_*` bodies.
pub const GAS_CB_RELEASE: Gas = Gas::from_tgas(20);
/// Minimum prepaid gas for `force_release_lock`: three 10 TGas views + 20 callback
/// + own body + four receipts' fees + margin (70 is too little even in the unit-test VM).
pub const MIN_FORCE_RELEASE_GAS: Gas = Gas::from_tgas(100);

/// `on_sync_balance` body.
pub const GAS_CB_SYNC: Gas = Gas::from_tgas(15);
/// Minimum prepaid gas for `sync_balance`: view (10) + callback (15) + body + fees + margin.
pub const MIN_SYNC_GAS: Gas = Gas::from_tgas(50);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// A pool the vault may trade in. `token_a`/`token_b` are the pool's pair.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AllowedPool {
    pub pool_id: u64,
    pub token_a: AccountId,
    pub token_b: AccountId,
    /// Floor for token_a -> token_b: `min_amount_out * den >= amount_in * num`.
    pub min_rate_a_to_b: Rate,
    /// Floor for token_b -> token_a.
    pub min_rate_b_to_a: Rate,
}

/// A rational `num/den` price floor, in output base units per input base unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rate {
    pub num: U128,
    pub den: U128,
}

/// Per-`token_in` limits, in that token's own base units.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenLimit {
    pub token_id: AccountId,
    /// Max `amount_in` of a single swap.
    pub max_trade: U128,
    /// Max sum of `amount_in` per UTC day.
    pub daily_cap: U128,
}

/// Owner-set hard limits and approvals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    /// "aloof" | "chaotic" | "social" | "skeptic".
    pub strategy: String,
    pub allowed_pools: Vec<AllowedPool>,
    /// Per-token_in limits; a token without an entry cannot be sold.
    pub limits: Vec<TokenLimit>,
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
    pub recovery_in_flight: bool,
    /// A `force_release_lock` reconcile is pending.
    pub release_in_flight: bool,
    pub day: u64,
    pub spent_today: Vec<(AccountId, U128)>,
    pub balances: Vec<(AccountId, U128)>,
    pub stranded_on_ref: Vec<(AccountId, U128)>,
    /// Amounts recorded as maybe-on-Ref after a failed read or an aborted
    /// release. Never used as a reconcile baseline (they may be phantom).
    pub unverified_on_ref: Vec<(AccountId, U128)>,
    pub swaps_executed: u64,
}

/// Book-keeping for the single swap that may be in flight.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InFlight {
    /// Monotonic id; callbacks of a force-released swap cannot touch a newer one.
    pub id: u64,
    pub pool_id: u64,
    pub token_in: AccountId,
    pub token_out: AccountId,
    /// Amount debited; shrinks to the amount Ref actually accepted.
    pub amount_in: u128,
    pub min_amount_out: u128,
    /// `day` the spend was counted on (rollback only applies the same day).
    pub day: u64,
    pub amount_out: u128,
    /// Block timestamp (ns) when the swap started; used by the stale-lock escape.
    pub started_at: u64,
    /// Ref's `get_deposit` of token_out read after the swap and before the
    /// withdraw (set by `on_withdraw_pre`). The withdraw is credited only if
    /// Ref's deposit dropped by `amount_out` from this snapshot.
    pub ref_pre_out: u128,
}

impl InFlight {
    /// The token and amount the vault is owed by this swap right now:
    /// token_out once `on_swap` recorded an output, token_in before that.
    pub fn held(&self) -> (AccountId, u128) {
        if self.amount_out > 0 {
            (self.token_out.clone(), self.amount_out)
        } else {
            (self.token_in.clone(), self.amount_in)
        }
    }
}

/// The single `recover_from_ref` that may be in flight. While it is, swaps,
/// config updates and other recoveries are refused, so no reconcile reads a
/// Ref balance another operation is still moving.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recovery {
    /// Shares the swap id counter; callbacks of a force-released recovery are no-ops.
    pub id: u64,
    pub token_id: AccountId,
    pub amount: u128,
    pub started_at: u64,
    /// Ref's `get_deposit` of `token_id` read before the withdraw (set by `on_recover_pre`).
    pub pre: u128,
    /// Part of `amount` taken from `unverified` rather than `stranded`.
    pub unv: u128,
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
    recovery: Option<Recovery>,
    /// Id of a pending `force_release_lock` reconcile. While set, the stuck
    /// swap/recovery's own callbacks are no-ops, owner withdrawals are refused
    /// and deposits are refunded, so the balances it reads cannot move.
    release: Option<u64>,
    /// Block timestamp (ns) at which `release` was set; gates `abort_release`.
    release_started_at: u64,
    day: u64,
    spent_today: BTreeMap<AccountId, u128>,
    balances: BTreeMap<AccountId, u128>,
    /// Known to sit on Ref (a read showed it). The only reconcile baseline.
    stranded: BTreeMap<AccountId, u128>,
    /// Maybe on Ref: the read failed or the release was aborted. Not a baseline,
    /// so a phantom record cannot cause a false credit. Recoverable like `stranded`.
    unverified: BTreeMap<AccountId, u128>,
    swaps_executed: u64,
    next_swap_id: u64,
    /// Id of the pending `sync_balance` read; 0 when none. Any operation that
    /// moves tokens clears it, so a stale read cannot credit.
    sync_id: u64,
    /// Owner withdrawals whose `on_owner_withdraw` has not run yet.
    withdrawals_pending: u32,
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
    for (i, l) in c.limits.iter().enumerate() {
        require!(l.max_trade.0 > 0, "ERR_BAD_CONFIG: max_trade must be > 0");
        require!(
            l.daily_cap.0 >= l.max_trade.0,
            "ERR_BAD_CONFIG: daily_cap must be >= max_trade"
        );
        require!(
            !c.limits[..i].iter().any(|q| q.token_id == l.token_id),
            "ERR_BAD_CONFIG: duplicate limit token"
        );
    }
    for (i, p) in c.allowed_pools.iter().enumerate() {
        for r in [&p.min_rate_a_to_b, &p.min_rate_b_to_a] {
            require!(
                r.num.0 > 0 && r.den.0 > 0,
                "ERR_BAD_CONFIG: rate num and den must be > 0"
            );
        }
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

/// Full 256-bit product of two u128 as `(hi, lo)`; tuples compare numerically.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    const M: u128 = u64::MAX as u128;
    let (a0, a1) = (a & M, a >> 64);
    let (b0, b1) = (b & M, b >> 64);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 & M) + (p10 & M);
    let lo = (p00 & M) | (mid << 64);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    (hi, lo)
}

/// `min_out * rate.den >= amount_in * rate.num`, without overflow.
fn meets_floor(amount_in: u128, min_out: u128, rate: &Rate) -> bool {
    mul_wide(min_out, rate.den.0) >= mul_wide(amount_in, rate.num.0)
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
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "ERR_PRIVATE_INIT: only the contract account can initialize"
        );
        validate_config(&config);
        let this = Self {
            owner_id,
            nft_contract_id,
            token_id,
            ref_exchange_id,
            config,
            paused: false,
            in_flight: None,
            recovery: None,
            release: None,
            release_started_at: 0,
            day: day_of(env::block_timestamp()),
            spent_today: BTreeMap::new(),
            balances: BTreeMap::new(),
            stranded: BTreeMap::new(),
            unverified: BTreeMap::new(),
            swaps_executed: 0,
            next_swap_id: 0,
            sync_id: 0,
            withdrawals_pending: 0,
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
            recovery_in_flight: self.recovery.is_some(),
            release_in_flight: self.release.is_some(),
            day: self.day,
            spent_today: if now_day == self.day {
                self.spent_today
                    .iter()
                    .map(|(k, v)| (k.clone(), U128(*v)))
                    .collect()
            } else {
                Vec::new()
            },
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
            unverified_on_ref: self
                .unverified
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
        if sender_id != self.owner_id || !known || amount.0 == 0 || self.release.is_some() || self.sync_id != 0 {
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
        require!(
            self.release.is_none(),
            "ERR_RELEASE_PENDING: a force release is reconciling balances"
        );
        // Without this, on_owner_withdraw could be starved after the debit and
        // a failed ft_transfer would never be re-credited.
        require!(
            env::prepaid_gas() >= MIN_WITHDRAW_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 80 TGas"
        );
        self.debit(&token_id, amount.0);
        self.sync_id = 0;
        self.withdrawals_pending += 1;
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
            "ERR_INSUFFICIENT_GAS: attach at least 280 TGas"
        );
        let amount = proposal.amount_in.0;
        let today = day_of(env::block_timestamp());
        self.roll_day(today);
        self.debit(&proposal.token_in, amount);
        self.sync_id = 0;
        // Bounded by the daily_cap check.
        *self.spent_today.entry(proposal.token_in.clone()).or_insert(0) += amount;
        self.next_swap_id += 1;
        let swap_id = self.next_swap_id;
        self.in_flight = Some(InFlight {
            id: swap_id,
            pool_id: proposal.pool_id,
            token_in: proposal.token_in.clone(),
            token_out: proposal.token_out.clone(),
            amount_in: amount,
            min_amount_out: proposal.min_amount_out.0,
            day: today,
            amount_out: 0,
            started_at: env::block_timestamp(),
            ref_pre_out: 0,
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
                    .on_deposit(swap_id),
            )
    }

    /// Hop 1 callback: checks how much Ref accepted, then swaps.
    #[private]
    pub fn on_deposit(
        &mut self,
        swap_id: u64,
        #[callback_result] used: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        Self::assert_self();
        let Some(mut fl) = self.current(swap_id) else {
            return PromiseOrValue::Value(U128(0));
        };
        let used = match used {
            Ok(u) => u.0.min(fl.amount_in),
            Err(_) => {
                // A failed promise result does not prove nothing reached Ref
                // (e.g. the resolve step ran out of gas). Ask Ref.
                return PromiseOrValue::Promise(self.ref_deposit_query(&fl.token_in).then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CB_RECONCILE)
                        .on_deposit_reconciled(swap_id),
                ));
            }
        };
        if used == 0 {
            // Ref reported it used nothing: the tokens are still with the vault.
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
                    .on_swap(swap_id),
            );
        PromiseOrValue::Promise(p)
    }

    /// After a failed `ft_transfer_call`: roll back only if Ref's deposit is
    /// below `amount_in` (then the tokens cannot have landed, whatever the
    /// stranded records say). A deposit covering `stranded + amount_in` is
    /// stranded as verified. Anything in between is ambiguous (the stranded
    /// record may overstate Ref) and is stranded as unverified: never credited.
    #[private]
    pub fn on_deposit_reconciled(
        &mut self,
        swap_id: u64,
        #[callback_result] deposit: Result<U128, PromiseError>,
    ) -> U128 {
        Self::assert_self();
        let Some(fl) = self.current(swap_id) else {
            return U128(0);
        };
        let covered = self.stranded_of(&fl.token_in).saturating_add(fl.amount_in);
        match deposit {
            Ok(d) if d.0 < fl.amount_in => {
                self.rollback(&fl, fl.amount_in);
                self.fail(&fl, "deposit_failed");
            }
            Ok(d) if d.0 >= covered => {
                self.strand(&fl.token_in, fl.amount_in, "deposit_landed_on_ref");
                self.fail(&fl, "deposit_landed_on_ref");
            }
            Ok(_) | Err(_) => {
                self.strand_unverified(&fl.token_in, fl.amount_in, "deposit_unverified");
                self.fail(&fl, "deposit_unverified");
            }
        }
        U128(0)
    }

    /// Hop 2 callback: reads `amount_out`, then withdraws it from Ref.
    #[private]
    pub fn on_swap(
        &mut self,
        swap_id: u64,
        #[callback_result] out: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        Self::assert_self();
        let Some(mut fl) = self.current(swap_id) else {
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
                // Snapshot Ref's token_out deposit before the withdraw, so the
                // reconcile measures this withdraw's own drop.
                PromiseOrValue::Promise(self.ref_deposit_query(&fl.token_out).then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_CB_WITHDRAW_PRE)
                        .on_withdraw_pre(swap_id),
                ))
            }
        }
    }

    /// Hop 3 callback: records Ref's pre-withdraw deposit of token_out, then
    /// withdraws `amount_out` and re-reads the deposit. Ref's `withdraw`
    /// re-credits and returns normally when its token transfer fails, and a
    /// failed `withdraw` leaves the deposit unchanged; the re-read catches both.
    #[private]
    pub fn on_withdraw_pre(
        &mut self,
        swap_id: u64,
        #[callback_result] pre: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        Self::assert_self();
        let Some(mut fl) = self.current(swap_id) else {
            return PromiseOrValue::Value(U128(0));
        };
        let pre = match pre {
            Ok(p) if p.0 >= fl.amount_out => p.0,
            // Ref's swap reported amount_out, so it sits on Ref; nothing was
            // withdrawn. Strand it (recoverable) without crediting.
            Ok(_) => {
                self.strand_unverified(&fl.token_out, fl.amount_out, "withdraw_pre_mismatch");
                self.fail(&fl, "withdraw_pre_mismatch");
                return PromiseOrValue::Value(U128(0));
            }
            Err(_) => {
                self.strand(&fl.token_out, fl.amount_out, "withdraw_pre_unverified");
                self.fail(&fl, "withdraw_pre_unverified");
                return PromiseOrValue::Value(U128(0));
            }
        };
        fl.ref_pre_out = pre;
        self.in_flight = Some(fl.clone());
        let p = Promise::new(self.ref_exchange_id.clone())
            .function_call(
                "withdraw".to_string(),
                json_bytes(json!({
                    "token_id": fl.token_out,
                    "amount": U128(fl.amount_out),
                    "unregister": null,
                    "skip_unwrap_near": true,
                })),
                ONE_YOCTO,
                GAS_REF_WITHDRAW,
            )
            .then(self.ref_deposit_query(&fl.token_out))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_RECONCILE)
                    .on_withdraw_reconciled(swap_id),
            );
        PromiseOrValue::Promise(p)
    }

    /// Credits token_out only if Ref's deposit dropped by `amount_out` from
    /// the pre-withdraw snapshot (a per-operation delta, independent of the
    /// `stranded` records).
    #[private]
    pub fn on_withdraw_reconciled(
        &mut self,
        swap_id: u64,
        #[callback_result] deposit: Result<U128, PromiseError>,
    ) -> U128 {
        Self::assert_self();
        let Some(fl) = self.current(swap_id) else {
            return U128(0);
        };
        match deposit {
            Ok(d) if d.0.saturating_add(fl.amount_out) <= fl.ref_pre_out => {}
            Ok(_) => {
                self.strand(&fl.token_out, fl.amount_out, "withdraw_not_reconciled");
                self.fail(&fl, "withdraw_not_reconciled");
                return U128(0);
            }
            Err(_) => {
                self.strand_unverified(&fl.token_out, fl.amount_out, "withdraw_unverified");
                self.fail(&fl, "withdraw_unverified");
                return U128(0);
            }
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
        Self::assert_self();
        self.withdrawals_pending = self.withdrawals_pending.saturating_sub(1);
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
            self.in_flight.is_none() && self.recovery.is_none(),
            "ERR_SWAP_IN_FLIGHT: cannot update config during a swap or recovery"
        );
        validate_config(&config);
        self.config = config;
        emit("config_updated", json!({ "config": self.config }));
    }

    /// Escape hatch for a lock stuck because a callback never ran (for example
    /// out of gas). Only after `STALE_LOCK_NS`. It does not guess where the
    /// held amount is: it reads the vault's own FT balance and its Ref deposit
    /// of the held token (and, for a swap, Ref's deposit of token_out), then
    /// `on_force_release_swap` / `on_force_release_recovery` credit, roll back
    /// or strand it. The lock stays held until that callback runs; if it never
    /// does, call this again (a newer call supersedes the older one).
    #[payable]
    pub fn force_release_lock(&mut self) -> Promise {
        self.owner_one_yocto();
        require!(
            env::prepaid_gas() >= MIN_FORCE_RELEASE_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 100 TGas"
        );
        let (token, other, started_at, is_recovery) = if let Some(r) = &self.recovery {
            (r.token_id.clone(), None, r.started_at, true)
        } else if let Some(fl) = &self.in_flight {
            let (held, _) = fl.held();
            (held, Some(fl.token_out.clone()), fl.started_at, false)
        } else {
            env::panic_str("ERR_NO_SWAP_IN_FLIGHT: nothing to release");
        };
        require!(
            env::block_timestamp().saturating_sub(started_at) >= STALE_LOCK_NS,
            "ERR_LOCK_NOT_STALE: wait 10 minutes after the swap or recovery started"
        );
        self.next_swap_id += 1;
        let release_id = self.next_swap_id;
        self.sync_id = 0;
        self.release = Some(release_id);
        self.release_started_at = env::block_timestamp();
        emit(
            "force_release_started",
            json!({ "release_id": release_id, "token_id": token }),
        );
        let reads = Promise::new(token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                json_bytes(json!({ "account_id": env::current_account_id() })),
                NearToken::from_yoctonear(0),
                GAS_FT_VIEW,
            )
            .and(self.ref_deposit_query(&token));
        let cb = Self::ext(env::current_account_id()).with_static_gas(GAS_CB_RELEASE);
        if is_recovery {
            reads.then(cb.on_force_release_recovery(release_id))
        } else {
            let out = other.expect("swap has token_out");
            reads
                .and(self.ref_deposit_query(&out))
                .then(cb.on_force_release_swap(release_id))
        }
    }

    /// Resolves a force-released swap from the three reads of `force_release_lock`.
    /// - only the vault holds the amount: token_in is rolled back, or token_out
    ///   is credited (the swap completed but its last callback never ran);
    /// - Ref holds it (alone or also the vault): it is stranded, recoverable;
    /// - neither, while token_in was held: the swap ran on Ref, so Ref's
    ///   untracked token_out (deposit minus stranded) is stranded instead;
    /// - otherwise (or a read failed): stranded as `lock_force_released_unverified`.
    /// No branch credits more than one place, so nothing is double counted.
    #[private]
    pub fn on_force_release_swap(
        &mut self,
        release_id: u64,
    ) {
        Self::assert_self();
        self.resolve_release_swap(
            release_id,
            read_u128(0),
            read_u128(1),
            read_u128(2),
        );
    }

    /// Resolves a force-released recovery: credited if only the vault holds the
    /// amount (Ref's withdraw went through), otherwise restored to stranded.
    #[private]
    pub fn on_force_release_recovery(&mut self, release_id: u64) {
        Self::assert_self();
        self.resolve_release_recovery(release_id, read_u128(0), read_u128(1));
    }

    /// Escape for a reconcile whose callback can never succeed (it panics or
    /// is out of gas). Owner only, 1 yocto, `RELEASE_ABORT_NS` after the
    /// release started. Clears the release and strands the held amount as
    /// unverified, exactly like a reconcile whose reads all failed; any late
    /// callback of the aborted release is a no-op.
    #[payable]
    pub fn abort_release(&mut self) {
        self.owner_one_yocto();
        let id = self
            .release
            .unwrap_or_else(|| env::panic_str("ERR_NO_RELEASE: no force release is pending"));
        require!(
            env::block_timestamp().saturating_sub(self.release_started_at) >= RELEASE_ABORT_NS,
            "ERR_RELEASE_NOT_STALE: wait 10 minutes after force_release_lock"
        );
        emit("force_release_aborted", json!({ "release_id": id }));
        let fail = || Err(PromiseError::Failed);
        if self.recovery.is_some() {
            self.resolve_release_recovery(id, fail(), fail());
        } else {
            self.resolve_release_swap(id, fail(), fail(), fail());
        }
    }

    /// Credits tokens the vault holds but does not track: an `ft_transfer`
    /// donation, or funds `abort_release` / an unverified strand wrongly marked
    /// as on Ref. Owner only, 1 yocto, only while nothing is in flight. Reads
    /// the vault's own FT balance and `on_sync_balance` credits the excess over
    /// the tracked balance. A newer call supersedes an older one.
    #[payable]
    pub fn sync_balance(&mut self, token_id: AccountId) -> Promise {
        self.owner_one_yocto();
        require!(
            self.sync_idle(),
            "ERR_SYNC_BUSY: a swap, recovery, release or withdrawal is in flight"
        );
        require!(
            env::prepaid_gas() >= MIN_SYNC_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 50 TGas"
        );
        self.next_swap_id += 1;
        let id = self.next_swap_id;
        self.sync_id = id;
        Promise::new(token_id.clone())
            .function_call(
                "ft_balance_of".to_string(),
                json_bytes(json!({ "account_id": env::current_account_id() })),
                NearToken::from_yoctonear(0),
                GAS_FT_VIEW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_SYNC)
                    .on_sync_balance(id, token_id),
            )
    }

    /// Credits `max(0, ft_balance - tracked)`. A no-op unless this is still the
    /// latest `sync_balance` and the vault is still idle.
    #[private]
    pub fn on_sync_balance(
        &mut self,
        sync_id: u64,
        token_id: AccountId,
        #[callback_result] ft: Result<U128, PromiseError>,
    ) {
        Self::assert_self();
        if self.sync_id != sync_id || !self.sync_idle() {
            return;
        }
        self.sync_id = 0;
        let Ok(ft) = ft else {
            emit("sync_failed", json!({ "token_id": token_id }));
            return;
        };
        let tracked = self.balances.get(&token_id).copied().unwrap_or(0);
        let extra = ft.0.saturating_sub(tracked);
        if extra > 0 {
            self.credit(&token_id, extra);
        }
        emit(
            "balance_synced",
            json!({
                "token_id": token_id,
                "credited": extra.to_string(),
                "ft_balance": ft.0.to_string(),
            }),
        );
    }
}

/// Raw read of promise result `i` as a `U128`. A failed promise and a payload
/// that does not parse are both `Err`, so a callback never panics on bad data.
fn read_u128(i: u64) -> Result<U128, PromiseError> {
    let bytes = env::promise_result_checked(i, 4096).map_err(|_| PromiseError::Failed)?;
    near_sdk::serde_json::from_slice::<U128>(&bytes).map_err(|_| PromiseError::Failed)
}

impl YieldVault {
    pub(crate) fn resolve_release_swap(
        &mut self,
        release_id: u64,
        vault_ft: Result<U128, PromiseError>,
        ref_held: Result<U128, PromiseError>,
        ref_out: Result<U128, PromiseError>,
    ) {
        if self.release != Some(release_id) {
            return;
        }
        self.release = None;
        let Some(fl) = self.in_flight.clone() else {
            return;
        };
        let (token, amount) = fl.held();
        let held_out = fl.amount_out > 0;
        // Roll back or credit only on a complete picture: every read succeeded.
        let all_ok = vault_ft.is_ok() && ref_held.is_ok() && ref_out.is_ok();
        let in_vault = all_ok && self.vault_holds(&token, amount, &vault_ft);
        let on_ref = self.ref_holds(&token, amount, &ref_held);
        if in_vault && !on_ref {
            if held_out {
                self.credit(&token, amount);
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
                        "via": "force_release",
                    }),
                );
            } else {
                self.rollback(&fl, amount);
                self.fail(&fl, "lock_force_released_in_vault");
            }
            return;
        }
        if on_ref {
            let why = if in_vault {
                "lock_force_released_ambiguous"
            } else {
                "lock_force_released"
            };
            self.strand(&token, amount, why);
            self.fail(&fl, why);
            return;
        }
        if !held_out && all_ok {
            let d = ref_out.map(|d| d.0).unwrap_or(0);
            let extra = d.saturating_sub(self.stranded_of(&fl.token_out));
            if extra > 0 {
                self.strand(&fl.token_out, extra, "lock_force_released_swapped");
                self.fail(&fl, "lock_force_released_swapped");
                return;
            }
        }
        self.strand_unverified(&token, amount, "lock_force_released_unverified");
        self.fail(&fl, "lock_force_released_unverified");
    }

    pub(crate) fn resolve_release_recovery(
        &mut self,
        release_id: u64,
        vault_ft: Result<U128, PromiseError>,
        ref_held: Result<U128, PromiseError>,
    ) {
        if self.release != Some(release_id) {
            return;
        }
        self.release = None;
        let Some(r) = self.recovery.take() else {
            return;
        };
        let in_vault =
            ref_held.is_ok() && self.vault_holds(&r.token_id, r.amount, &vault_ft);
        let on_ref = self.ref_holds(&r.token_id, r.amount, &ref_held);
        if in_vault && !on_ref {
            self.credit(&r.token_id, r.amount);
            emit(
                "recovered",
                json!({ "token_id": r.token_id, "amount": r.amount.to_string(), "via": "force_release" }),
            );
        } else if on_ref {
            self.put_back(&r, true, "recovery_force_released");
        } else {
            self.put_back(&r, false, "recovery_force_released_unverified");
        }
    }
}

#[near]
impl YieldVault {
    /// Owner pays Ref storage for the vault's internal Ref account.
    ///
    /// `registration_only: false`: the whole deposit stays on Ref as the vault's
    /// storage balance, so it also pays the per-token storage Ref needs the
    /// first time a new token lands in the account (the first swap into a new
    /// token_out). Nothing is refunded to the vault on success, so no NEAR gets
    /// stuck here. Attach the account minimum plus per-token storage for every
    /// token in `allowed_pools` (see Ref's `storage_balance_bounds`). If the
    /// storage is short anyway, the swap fails on Ref and `on_swap` strands
    /// token_in, which `recover_from_ref` can pull back after a top-up.
    /// If `storage_deposit` fails, `on_register` forwards the deposit to the owner.
    #[payable]
    pub fn register_on_ref(&mut self) -> Promise {
        self.assert_owner();
        let deposit = env::attached_deposit();
        require!(
            !deposit.is_zero(),
            "ERR_DEPOSIT_REQUIRED: attach NEAR for Ref storage"
        );
        require!(
            env::prepaid_gas() >= MIN_REGISTER_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 60 TGas"
        );
        Promise::new(self.ref_exchange_id.clone())
            .function_call(
                "storage_deposit".to_string(),
                json_bytes(json!({
                    "account_id": env::current_account_id(),
                    "registration_only": false,
                })),
                deposit,
                GAS_STORAGE_DEPOSIT,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_REGISTER)
                    .on_register(U128(deposit.as_yoctonear())),
            )
    }

    /// After `storage_deposit`: on failure the protocol refunds the deposit to
    /// the vault, so forward that amount to the owner. Best effort: if the
    /// refund has not landed yet and the vault cannot cover it, the transfer
    /// fails and the NEAR stays on the vault account (see Known risks).
    #[private]
    pub fn on_register(&mut self, deposit: U128) {
        Self::assert_self();
        if env::promise_result_checked(0, 4096).is_ok() {
            emit("registered_on_ref", json!({ "deposit": deposit.0.to_string() }));
            return;
        }
        emit(
            "register_failed",
            json!({ "deposit": deposit.0.to_string(), "refund_to": self.owner_id }),
        );
        Promise::new(self.owner_id.clone())
            .transfer(NearToken::from_yoctonear(deposit.0))
            .detach();
    }

    /// Pulls stranded funds from the vault's Ref account back into the vault.
    #[payable]
    pub fn recover_from_ref(&mut self, token_id: AccountId, amount: U128) -> Promise {
        self.owner_one_yocto();
        require!(
            self.in_flight.is_none(),
            "ERR_SWAP_IN_FLIGHT: cannot recover during a swap"
        );
        require!(
            self.recovery.is_none(),
            "ERR_SWAP_IN_FLIGHT: another recovery is in flight"
        );
        require!(amount.0 > 0, "ERR_ZERO_AMOUNT: amount must be > 0");
        require!(
            env::prepaid_gas() >= MIN_RECOVER_GAS,
            "ERR_INSUFFICIENT_GAS: attach at least 150 TGas"
        );
        let verified = self.stranded_of(&token_id);
        let unv_have = self.unverified.get(&token_id).copied().unwrap_or(0);
        require!(
            verified.saturating_add(unv_have) >= amount.0,
            "ERR_INSUFFICIENT_STRANDED: not that much stranded on Ref"
        );
        // Verified strands first; the rest comes from the unverified record.
        let unv = amount.0.saturating_sub(verified);
        Self::take(&mut self.stranded, &token_id, amount.0 - unv);
        Self::take(&mut self.unverified, &token_id, unv);
        self.sync_id = 0;
        self.next_swap_id += 1;
        let recovery_id = self.next_swap_id;
        self.recovery = Some(Recovery {
            id: recovery_id,
            token_id: token_id.clone(),
            amount: amount.0,
            started_at: env::block_timestamp(),
            pre: 0,
            unv,
        });
        self.ref_deposit_query(&token_id).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_RECOVER_PRE)
                .on_recover_pre(recovery_id),
        )
    }

    /// Recovery hop 1: records Ref's deposit before the withdraw, so the
    /// reconcile can credit exactly what left Ref. Refuses (restoring the
    /// stranded record) if Ref does not hold `amount` or the read failed.
    #[private]
    pub fn on_recover_pre(
        &mut self,
        recovery_id: u64,
        #[callback_result] pre: Result<U128, PromiseError>,
    ) -> PromiseOrValue<U128> {
        Self::assert_self();
        let Some(mut r) = self.current_recovery(recovery_id) else {
            return PromiseOrValue::Value(U128(0));
        };
        let pre = match pre {
            Ok(d) if d.0 >= r.amount => d.0,
            other => {
                self.recovery = None;
                // Ref does not show the amount: it is no longer a trusted baseline.
                self.put_back(&r, false, "");
                emit(
                    "recover_refused",
                    json!({
                        "token_id": r.token_id,
                        "amount": r.amount.to_string(),
                        "on_ref": other.ok().map(|d| d.0.to_string()),
                    }),
                );
                return PromiseOrValue::Value(U128(0));
            }
        };
        r.pre = pre;
        self.recovery = Some(r.clone());
        let p = Promise::new(self.ref_exchange_id.clone())
            .function_call(
                "withdraw".to_string(),
                json_bytes(json!({
                    "token_id": r.token_id,
                    "amount": U128(r.amount),
                    "unregister": null,
                    "skip_unwrap_near": true,
                })),
                ONE_YOCTO,
                GAS_REF_WITHDRAW,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CB_WITHDRAW_DONE)
                    .on_recover(recovery_id),
            );
        PromiseOrValue::Promise(p)
    }

    /// Hop after Ref `withdraw` in a recovery: restores the stranded record if
    /// it failed, otherwise verifies against Ref's deposit. The recovery lock
    /// stays held until the reconcile has read the balance.
    #[private]
    pub fn on_recover(&mut self, recovery_id: u64) -> PromiseOrValue<U128> {
        Self::assert_self();
        let ok = env::promise_result_checked(0, 4096).is_ok();
        let Some(r) = self.current_recovery(recovery_id) else {
            return PromiseOrValue::Value(U128(0));
        };
        if !ok {
            self.recovery = None;
            self.put_back(&r, true, "");
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(self.ref_deposit_query(&r.token_id).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_CB_RECONCILE)
                .on_recover_reconciled(recovery_id),
        ))
    }

    /// Credits recovered funds only if Ref's deposit dropped by at least
    /// `amount` since `on_recover_pre` read it (exact: the recovery lock keeps
    /// every other vault operation off Ref meanwhile), then releases the lock.
    /// A stranded record larger than what Ref holds cannot fake a success.
    #[private]
    pub fn on_recover_reconciled(
        &mut self,
        recovery_id: u64,
        #[callback_result] deposit: Result<U128, PromiseError>,
    ) -> U128 {
        Self::assert_self();
        let Some(r) = self.current_recovery(recovery_id) else {
            return U128(0);
        };
        self.recovery = None;
        let (token_id, amount, pre) = (r.token_id.clone(), r.amount, r.pre);
        match deposit {
            Ok(d) if pre.saturating_sub(d.0) >= amount => {
                self.credit(&token_id, amount);
                emit(
                    "recovered",
                    json!({ "token_id": token_id, "amount": amount.to_string() }),
                );
                U128(amount)
            }
            Ok(_) => {
                self.put_back(&r, true, "withdraw_not_reconciled");
                U128(0)
            }
            Err(_) => {
                self.put_back(&r, false, "withdraw_unverified");
                U128(0)
            }
        }
    }
}

// ------------------------------------------------------------------- internals

impl YieldVault {
    /// Defence in depth on top of `#[private]`: callbacks only run for the contract itself.
    fn assert_self() {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "ERR_PRIVATE_CALLBACK: Method is private"
        );
    }

    /// The in-flight swap, only if it is the one `swap_id` belongs to and no
    /// force release is reconciling it.
    fn current(&self, swap_id: u64) -> Option<InFlight> {
        if self.release.is_some() {
            return None;
        }
        self.in_flight.clone().filter(|f| f.id == swap_id)
    }

    /// The recovery in flight, if it is `recovery_id` and not being force-released.
    fn current_recovery(&self, recovery_id: u64) -> Option<Recovery> {
        if self.release.is_some() {
            return None;
        }
        self.recovery.clone().filter(|r| r.id == recovery_id)
    }

    /// The vault's FT balance shows `amount` on top of what it already tracks.
    fn vault_holds(&self, token: &AccountId, amount: u128, ft: &Result<U128, PromiseError>) -> bool {
        let tracked = self.balances.get(token).copied().unwrap_or(0);
        matches!(ft, Ok(b) if b.0 >= tracked.saturating_add(amount))
    }

    /// The vault's Ref deposit shows `amount` on top of what is already stranded.
    fn ref_holds(&self, token: &AccountId, amount: u128, dep: &Result<U128, PromiseError>) -> bool {
        matches!(dep, Ok(d) if d.0 >= self.stranded_of(token).saturating_add(amount))
    }

    /// No swap, recovery, release or owner withdrawal is moving tokens.
    fn sync_idle(&self) -> bool {
        self.in_flight.is_none()
            && self.recovery.is_none()
            && self.release.is_none()
            && self.withdrawals_pending == 0
    }

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

    /// Spent amount of `token` for `now_day` (0 if the stored day is older).
    fn spent_on(&self, now_day: u64, token: &AccountId) -> u128 {
        if now_day == self.day {
            self.spent_today.get(token).copied().unwrap_or(0)
        } else {
            0
        }
    }

    fn roll_day(&mut self, now_day: u64) {
        if now_day != self.day {
            self.day = now_day;
            self.spent_today.clear();
        }
    }

    fn stranded_of(&self, token: &AccountId) -> u128 {
        self.stranded.get(token).copied().unwrap_or(0)
    }

    /// Ref view: the vault's internal Ref balance of `token`.
    fn ref_deposit_query(&self, token: &AccountId) -> Promise {
        Promise::new(self.ref_exchange_id.clone()).function_call(
            "get_deposit".to_string(),
            json_bytes(json!({
                "account_id": env::current_account_id(),
                "token_id": token,
            })),
            NearToken::from_yoctonear(0),
            GAS_REF_VIEW,
        )
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

    /// Gives `amount` back to the vault balance and un-counts it from today's
    /// spend (only if the day has not rolled since the debit).
    fn rollback(&mut self, fl: &InFlight, amount: u128) {
        self.credit(&fl.token_in, amount);
        if self.day == fl.day {
            if let Some(v) = self.spent_today.get_mut(&fl.token_in) {
                *v = v.saturating_sub(amount);
                if *v == 0 {
                    self.spent_today.remove(&fl.token_in);
                }
            }
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

    fn strand_unverified(&mut self, token: &AccountId, amount: u128, why: &str) {
        if amount == 0 {
            return;
        }
        let e = self.unverified.entry(token.clone()).or_insert(0);
        *e = e.checked_add(amount).expect("ERR_OVERFLOW: unverified");
        emit(
            "stranded",
            json!({ "token_id": token, "amount": amount.to_string(), "reason": why, "verified": false }),
        );
    }

    /// Removes up to `amount` from a strand map.
    fn take(map: &mut BTreeMap<AccountId, u128>, token: &AccountId, amount: u128) {
        if let Some(v) = map.get_mut(token) {
            *v = v.saturating_sub(amount);
            if *v == 0 {
                map.remove(token);
            }
        }
    }

    /// Puts a recovery's amount back. If `verified` (a read showed it on Ref)
    /// the part that came from `stranded` returns there; the rest, and
    /// everything when not verified, returns to `unverified`.
    fn put_back(&mut self, r: &Recovery, verified: bool, why: &str) {
        let s = if verified { r.amount - r.unv } else { 0 };
        for (map, amt) in [(&mut self.stranded, s), (&mut self.unverified, r.amount - s)] {
            if amt > 0 {
                let e = map.entry(r.token_id.clone()).or_insert(0);
                *e = e.checked_add(amt).expect("ERR_OVERFLOW: stranded");
            }
        }
        if !why.is_empty() {
            emit(
                "stranded",
                json!({ "token_id": r.token_id, "amount": r.amount.to_string(), "reason": why, "verified": verified }),
            );
        }
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
        if self.recovery.is_some() {
            return Err("ERR_SWAP_IN_FLIGHT: a Ref recovery is in flight".to_string());
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
        let rate = if fwd {
            &pool.min_rate_a_to_b
        } else {
            &pool.min_rate_b_to_a
        };
        if !meets_floor(p.amount_in.0, p.min_amount_out.0, rate) {
            return Err(format!(
                "ERR_PRICE_FLOOR: min_amount_out {} below floor {}/{} of amount_in {}",
                p.min_amount_out.0, rate.num.0, rate.den.0, p.amount_in.0
            ));
        }
        let Some(limit) = self.config.limits.iter().find(|l| l.token_id == p.token_in) else {
            return Err(format!("ERR_NO_LIMIT: no limit for {}", p.token_in));
        };
        if p.amount_in.0 > limit.max_trade.0 {
            return Err(format!(
                "ERR_MAX_TRADE: {} exceeds max_trade {}",
                p.amount_in.0, limit.max_trade.0
            ));
        }
        let spent = self.spent_on(day_of(env::block_timestamp()), &p.token_in);
        match spent.checked_add(p.amount_in.0) {
            Some(total) if total <= limit.daily_cap.0 => {}
            _ => {
                return Err(format!(
                    "ERR_DAILY_CAP: spent {} + {} exceeds daily_cap {}",
                    spent, p.amount_in.0, limit.daily_cap.0
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
