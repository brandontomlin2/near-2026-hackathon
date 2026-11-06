//! Token wallets.
//!
//! Every personality token owns a NEAR balance, held by this contract and
//! keyed by token id, so it moves with the token on transfer: whoever owns
//! the token controls its money. The wallet is created empty at mint.
//!
//! - Anyone can tip a token with `wallet_deposit`.
//! - The current owner can spend with `wallet_send` (1 yoctoNEAR, so a
//!   full-access key must sign).
//! - The owner can grant one *agent* account the right to pay one *payee*
//!   (for example the account that bills the token's inference) up to an
//!   allowance, with `wallet_set_agent`. The agent pays with
//!   `wallet_agent_pay`, which needs no deposit, so a function-call key on
//!   the agent's account is enough. A grant counts only while the account
//!   that made it still owns the token: after a transfer the old owner's
//!   agent can no longer spend, and the new owner sets their own.
//!
//! Spending is frozen while the token is inside an unresolved
//! `nft_transfer_call`, because the pending resolve may still hand the token
//! back to its previous owner. If a payout transfer fails (for example the
//! receiver account does not exist), `on_wallet_transfer` credits the amount
//! back to the wallet, and back to the agent's allowance for an agent payment.

use crate::{emit_event, Contract, ContractExt};
use near_contract_standards::non_fungible_token::refund_deposit_to_account;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, Gas, NearToken, Promise};

/// Longest accepted wallet memo, in bytes.
pub const MAX_WALLET_MEMO_LEN: usize = 256;

/// Gas reserved for the `on_wallet_transfer` callback: one promise result read
/// and at most two map writes.
const GAS_FOR_WALLET_CALLBACK: Gas = Gas::from_tgas(10);

/// A spending grant stored for a token.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletAgent {
    /// The account allowed to call `wallet_agent_pay`.
    pub agent_id: AccountId,
    /// The only account the agent may pay.
    pub payee_id: AccountId,
    /// yoctoNEAR the agent may still spend. Each payment lowers it.
    pub allowance: u128,
    /// The token owner who made the grant. The grant is void once someone
    /// else owns the token.
    pub granted_by: AccountId,
}

/// JSON view of an active grant.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalletAgentView {
    pub agent_id: AccountId,
    pub payee_id: AccountId,
    pub allowance: U128,
}

/// JSON view of a token's wallet.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenWallet {
    pub token_id: TokenId,
    /// The account that controls the wallet: the token's current owner.
    pub owner_id: AccountId,
    /// Balance in yoctoNEAR.
    pub balance: U128,
    /// The spending grant, only while it is active (made by the current owner).
    pub agent: Option<WalletAgentView>,
}

#[near(serializers = [json])]
struct WalletDepositData {
    token_id: TokenId,
    from_id: AccountId,
    amount: U128,
    balance: U128,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<String>,
}

#[near(serializers = [json])]
struct WalletSpentData {
    token_id: TokenId,
    /// `"owner"` for `wallet_send`, `"agent"` for `wallet_agent_pay`.
    kind: String,
    by_id: AccountId,
    receiver_id: AccountId,
    amount: U128,
    balance: U128,
    #[serde(skip_serializing_if = "Option::is_none")]
    memo: Option<String>,
}

#[near(serializers = [json])]
struct WalletAgentData {
    token_id: TokenId,
    owner_id: AccountId,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<AccountId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payee_id: Option<AccountId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowance: Option<U128>,
}

#[near(serializers = [json])]
struct WalletRefundData {
    token_id: TokenId,
    amount: U128,
    balance: U128,
}

fn validate_memo(memo: &Option<String>) {
    if let Some(m) = memo {
        require!(
            m.len() <= MAX_WALLET_MEMO_LEN,
            format!("memo is too long (max {MAX_WALLET_MEMO_LEN} bytes)")
        );
    }
}

#[near]
impl Contract {
    /// Tips the token: the attached deposit goes into the token's wallet.
    /// Anyone may call it, also while the token is in flight. Returns the new
    /// balance. Emits `wallet_deposit`.
    #[payable]
    pub fn wallet_deposit(&mut self, token_id: TokenId, memo: Option<String>) -> U128 {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the NEAR to deposit");
        validate_memo(&memo);
        let balance = self.wallet_balance_of(&token_id);
        let balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("wallet balance overflow"));
        self.wallets.insert(token_id.clone(), balance);
        emit_event(
            "wallet_deposit",
            WalletDepositData {
                token_id,
                from_id: env::predecessor_account_id(),
                amount: U128(amount),
                balance: U128(balance),
                memo,
            },
        );
        U128(balance)
    }

    /// The token's wallet: balance, controlling owner and active grant.
    /// `None` if the token does not exist.
    pub fn token_wallet(&self, token_id: TokenId) -> Option<TokenWallet> {
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let balance = self.wallets.get(&token_id).copied().unwrap_or(0);
        let agent = self
            .wallet_agents
            .get(&token_id)
            .filter(|a| a.granted_by == owner_id)
            .map(|a| WalletAgentView {
                agent_id: a.agent_id.clone(),
                payee_id: a.payee_id.clone(),
                allowance: U128(a.allowance),
            });
        Some(TokenWallet {
            token_id,
            owner_id,
            balance: U128(balance),
            agent,
        })
    }

    /// Sends `amount` yoctoNEAR from the token's wallet to `receiver_id`.
    /// Only the current token owner may call it, with exactly 1 yoctoNEAR.
    /// Refused while the token is in an `nft_transfer_call`. If the transfer
    /// fails, the amount returns to the wallet. Emits `wallet_spent`.
    #[payable]
    pub fn wallet_send(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        assert_one_yocto();
        validate_memo(&memo);
        let owner_id = self.require_wallet_owner(&token_id);
        self.require_not_in_flight_for_wallet(&token_id);
        require!(
            receiver_id != env::current_account_id(),
            "cannot send to the contract account itself"
        );
        let balance = self.debit(&token_id, amount.0);
        emit_event(
            "wallet_spent",
            WalletSpentData {
                token_id: token_id.clone(),
                kind: "owner".to_string(),
                by_id: owner_id,
                receiver_id: receiver_id.clone(),
                amount,
                balance: U128(balance),
                memo,
            },
        );
        self.payout(token_id, receiver_id, amount.0, false)
    }

    /// Lets `agent_id` pay `payee_id` from the token's wallet, up to
    /// `allowance` yoctoNEAR in total. Replaces any earlier grant. Only the
    /// current token owner may call it; attach enough NEAR for the grant's
    /// storage (0.01 NEAR is plenty), the rest is refunded. Emits
    /// `wallet_agent_set`.
    #[payable]
    pub fn wallet_set_agent(
        &mut self,
        token_id: TokenId,
        agent_id: AccountId,
        payee_id: AccountId,
        allowance: U128,
    ) -> WalletAgentView {
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "attach at least 1 yoctoNEAR"
        );
        let owner_id = self.require_wallet_owner(&token_id);
        self.require_not_in_flight_for_wallet(&token_id);
        require!(
            payee_id != env::current_account_id(),
            "the payee cannot be the contract account itself"
        );
        let initial_storage = env::storage_usage();
        self.wallet_agents.insert(
            token_id.clone(),
            WalletAgent {
                agent_id: agent_id.clone(),
                payee_id: payee_id.clone(),
                allowance: allowance.0,
                granted_by: owner_id.clone(),
            },
        );
        self.wallet_agents.flush();
        let storage_used = env::storage_usage().saturating_sub(initial_storage);
        refund_deposit_to_account(storage_used, env::predecessor_account_id());
        emit_event(
            "wallet_agent_set",
            WalletAgentData {
                token_id,
                owner_id,
                agent_id: Some(agent_id.clone()),
                payee_id: Some(payee_id.clone()),
                allowance: Some(allowance),
            },
        );
        WalletAgentView {
            agent_id,
            payee_id,
            allowance,
        }
    }

    /// Removes the token's spending grant, whoever made it. Only the current
    /// token owner may call it, with exactly 1 yoctoNEAR. Emits
    /// `wallet_agent_revoked`.
    #[payable]
    pub fn wallet_revoke_agent(&mut self, token_id: TokenId) {
        assert_one_yocto();
        let owner_id = self.require_wallet_owner(&token_id);
        require!(
            self.wallet_agents.remove(&token_id).is_some(),
            "the token has no agent grant"
        );
        emit_event(
            "wallet_agent_revoked",
            WalletAgentData {
                token_id,
                owner_id,
                agent_id: None,
                payee_id: None,
                allowance: None,
            },
        );
    }

    /// Pays the granted payee `amount` yoctoNEAR from the token's wallet.
    /// Only the granted agent may call it, and only while the owner who made
    /// the grant still owns the token. Takes no deposit, so a function-call
    /// key works. Lowers the allowance. Refused while the token is in an
    /// `nft_transfer_call`. If the transfer fails, the amount returns to the
    /// wallet and the allowance. Emits `wallet_spent`.
    pub fn wallet_agent_pay(
        &mut self,
        token_id: TokenId,
        amount: U128,
        memo: Option<String>,
    ) -> Promise {
        // The generated entry point already refuses a deposit on a method
        // that is not payable; this keeps the rule explicit and unit-tested.
        require!(
            env::attached_deposit().is_zero(),
            "wallet_agent_pay doesn't accept deposit"
        );
        validate_memo(&memo);
        let mut grant = self
            .wallet_agents
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("the token has no agent grant"));
        let caller = env::predecessor_account_id();
        require!(caller == grant.agent_id, "only the granted agent can pay");
        let owner_id = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("token not found"));
        require!(
            grant.granted_by == owner_id,
            "the agent grant was made by a previous owner"
        );
        self.require_not_in_flight_for_wallet(&token_id);
        require!(
            amount.0 <= grant.allowance,
            "amount exceeds the agent's allowance"
        );
        let balance = self.debit(&token_id, amount.0);
        grant.allowance -= amount.0;
        let payee_id = grant.payee_id.clone();
        self.wallet_agents.insert(token_id.clone(), grant);
        emit_event(
            "wallet_spent",
            WalletSpentData {
                token_id: token_id.clone(),
                kind: "agent".to_string(),
                by_id: caller,
                receiver_id: payee_id.clone(),
                amount,
                balance: U128(balance),
                memo,
            },
        );
        self.payout(token_id, payee_id, amount.0, true)
    }

    /// Callback after a wallet payout. On failure, credits the amount back to
    /// the wallet and, for an agent payment, back to the allowance of the
    /// grant if it still exists. Never panics. Returns true if the payout
    /// went through.
    #[private]
    pub fn on_wallet_transfer(
        &mut self,
        token_id: TokenId,
        amount: U128,
        restore_allowance: bool,
    ) -> bool {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Method on_wallet_transfer is private"
        );
        let ok = env::promise_results_count() == 1 && env::promise_result_checked(0, 0).is_ok();
        if ok {
            return true;
        }
        let balance = self
            .wallets
            .get(&token_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(amount.0);
        self.wallets.insert(token_id.clone(), balance);
        if restore_allowance {
            if let Some(mut grant) = self.wallet_agents.get(&token_id).cloned() {
                grant.allowance = grant.allowance.saturating_add(amount.0);
                self.wallet_agents.insert(token_id.clone(), grant);
            }
        }
        emit_event(
            "wallet_refund",
            WalletRefundData {
                token_id,
                amount,
                balance: U128(balance),
            },
        );
        false
    }
}

impl Contract {
    fn wallet_balance_of(&self, token_id: &TokenId) -> u128 {
        require!(
            self.tokens.owner_by_id.contains_key(token_id),
            "token not found"
        );
        self.wallets.get(token_id).copied().unwrap_or(0)
    }

    /// Panics unless the caller owns the token. Returns the owner.
    fn require_wallet_owner(&self, token_id: &TokenId) -> AccountId {
        let owner_id = self
            .tokens
            .owner_by_id
            .get(token_id)
            .unwrap_or_else(|| env::panic_str("token not found"));
        require!(
            env::predecessor_account_id() == owner_id,
            "only the token owner can manage its wallet"
        );
        owner_id
    }

    fn require_not_in_flight_for_wallet(&self, token_id: &TokenId) {
        require!(
            !self.in_flight.contains_key(token_id),
            "token is in an nft_transfer_call; use its wallet after it resolves"
        );
    }

    /// Takes `amount` out of the wallet and returns the new balance.
    fn debit(&mut self, token_id: &TokenId, amount: u128) -> u128 {
        require!(amount > 0, "amount must be greater than 0");
        let balance = self.wallet_balance_of(token_id);
        require!(amount <= balance, "amount exceeds the token's wallet balance");
        let balance = balance - amount;
        self.wallets.insert(token_id.clone(), balance);
        balance
    }

    fn payout(
        &self,
        token_id: TokenId,
        receiver_id: AccountId,
        amount: u128,
        restore_allowance: bool,
    ) -> Promise {
        Promise::new(receiver_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_WALLET_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_wallet_transfer(token_id, U128(amount), restore_allowance),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_contract_standards::non_fungible_token::core::{
        NonFungibleTokenCore, NonFungibleTokenResolver,
    };
    use near_contract_standards::non_fungible_token::metadata::TokenMetadata;
    use near_sdk::test_utils::{accounts, get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, PromiseResult};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const MINT_DEPOSIT: NearToken = NearToken::from_millinear(100);
    const GRANT_DEPOSIT: NearToken = NearToken::from_millinear(10);
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const TOKEN: &str = "chaotic";

    fn context(predecessor: AccountId, deposit: NearToken) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(1_700_000_000_000_000_000);
        builder
    }

    fn set(predecessor: AccountId, deposit: NearToken) {
        testing_env!(context(predecessor, deposit).build());
    }

    fn callback(result: PromiseResult) {
        testing_env!(
            context(accounts(0), NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    fn metadata() -> TokenMetadata {
        TokenMetadata {
            title: Some("Chaotic".to_string()),
            description: None,
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(r#"{"temperament":"neon","role":"trickster"}"#.to_string()),
            reference: None,
            reference_hash: None,
        }
    }

    /// Contract owner accounts(1); token "chaotic" minted to accounts(2).
    fn minted() -> Contract {
        set(accounts(1), MINT_DEPOSIT);
        let mut c = Contract::new_default_meta(accounts(1));
        c.nft_mint(TOKEN.to_string(), accounts(2), metadata());
        c
    }

    fn tok() -> TokenId {
        TOKEN.to_string()
    }

    fn balance(c: &Contract) -> u128 {
        c.token_wallet(tok()).expect("wallet").balance.0
    }

    fn tip(c: &mut Contract, from: AccountId, yocto: u128) -> u128 {
        set(from, NearToken::from_yoctonear(yocto));
        c.wallet_deposit(tok(), Some("tip".to_string())).0
    }

    fn panics_with<F: FnOnce()>(f: F, needle: &str) -> bool {
        match catch_unwind(AssertUnwindSafe(f)) {
            Ok(()) => false,
            Err(p) => p
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| p.downcast_ref::<&str>().copied())
                .is_some_and(|m| m.contains(needle)),
        }
    }

    fn transfers_to(to: &AccountId) -> Vec<u128> {
        get_created_receipts()
            .iter()
            .filter(|r| &r.receiver_id == to)
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => {
                    Some(deposit.as_yoctonear())
                }
                _ => None,
            })
            .collect()
    }

    fn grant(c: &mut Contract, allowance: u128) {
        set(accounts(2), GRANT_DEPOSIT);
        c.wallet_set_agent(tok(), accounts(3), accounts(4), U128(allowance));
    }

    // -- wallet basics -------------------------------------------------------

    #[test]
    fn minted_token_has_an_empty_wallet_owned_by_its_owner() {
        let c = minted();
        let w = c.token_wallet(tok()).expect("wallet");
        assert_eq!(w.balance, U128(0));
        assert_eq!(w.owner_id, accounts(2));
        assert_eq!(w.agent, None);
        assert!(c.token_wallet("nope".to_string()).is_none());
    }

    #[test]
    fn anyone_can_tip_and_the_event_records_it() {
        let mut c = minted();
        assert_eq!(tip(&mut c, accounts(5), 3 * ONE_NEAR / 100), 3 * ONE_NEAR / 100);
        assert_eq!(tip(&mut c, accounts(3), ONE_NEAR / 100), 4 * ONE_NEAR / 100);
        assert_eq!(balance(&c), 4 * ONE_NEAR / 100);
        let logs = get_logs();
        let last = logs.last().expect("event");
        assert!(last.starts_with("EVENT_JSON:"));
        assert!(last.contains(r#""event":"wallet_deposit""#));
        assert!(last.contains(r#""memo":"tip""#));
    }

    #[test]
    fn deposit_without_near_or_to_unknown_token_panics() {
        let mut c = minted();
        set(accounts(5), NearToken::from_yoctonear(0));
        assert!(panics_with(
            || {
                c.wallet_deposit(tok(), None);
            },
            "attach the NEAR to deposit"
        ));
        set(accounts(5), ONE_YOCTO);
        assert!(panics_with(
            || {
                c.wallet_deposit("ghost".to_string(), None);
            },
            "token not found"
        ));
    }

    #[test]
    fn overlong_memo_is_rejected() {
        let mut c = minted();
        set(accounts(5), ONE_YOCTO);
        assert!(panics_with(
            || {
                c.wallet_deposit(tok(), Some("x".repeat(MAX_WALLET_MEMO_LEN + 1)));
            },
            "memo is too long"
        ));
    }

    // -- owner spending ------------------------------------------------------

    #[test]
    fn owner_sends_from_the_wallet() {
        let mut c = minted();
        tip(&mut c, accounts(5), ONE_NEAR);
        set(accounts(2), ONE_YOCTO);
        let _ = c.wallet_send(tok(), accounts(4), U128(ONE_NEAR / 4), None);
        assert_eq!(balance(&c), 3 * ONE_NEAR / 4);
        assert_eq!(transfers_to(&accounts(4)), vec![ONE_NEAR / 4]);
        assert!(get_logs()
            .last()
            .expect("event")
            .contains(r#""kind":"owner""#));
    }

    #[test]
    fn non_owner_cannot_send_and_sends_need_one_yocto() {
        let mut c = minted();
        tip(&mut c, accounts(5), ONE_NEAR);
        set(accounts(5), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(5), U128(1), None);
            },
            "only the token owner can manage its wallet"
        ));
        set(accounts(2), NearToken::from_yoctonear(0));
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(4), U128(1), None);
            },
            "Requires attached deposit of exactly 1 yoctoNEAR"
        ));
        assert_eq!(balance(&c), ONE_NEAR);
    }

    #[test]
    fn cannot_overdraw_send_zero_or_send_to_the_contract() {
        let mut c = minted();
        tip(&mut c, accounts(5), 10);
        set(accounts(2), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(4), U128(11), None);
            },
            "amount exceeds the token's wallet balance"
        ));
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(4), U128(0), None);
            },
            "amount must be greater than 0"
        ));
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(0), U128(1), None);
            },
            "cannot send to the contract account itself"
        ));
        assert_eq!(balance(&c), 10);
    }

    #[test]
    fn failed_send_is_credited_back() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        set(accounts(2), ONE_YOCTO);
        let _ = c.wallet_send(tok(), accounts(4), U128(60), None);
        assert_eq!(balance(&c), 40);
        callback(PromiseResult::Failed);
        assert!(!c.on_wallet_transfer(tok(), U128(60), false));
        assert_eq!(balance(&c), 100);
        assert!(get_logs()
            .last()
            .expect("event")
            .contains(r#""event":"wallet_refund""#));
    }

    #[test]
    fn successful_send_is_not_credited_back() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        set(accounts(2), ONE_YOCTO);
        let _ = c.wallet_send(tok(), accounts(4), U128(60), None);
        callback(PromiseResult::Successful(vec![]));
        assert!(c.on_wallet_transfer(tok(), U128(60), false));
        assert_eq!(balance(&c), 40);
    }

    #[test]
    fn wallet_callback_is_private() {
        let mut c = minted();
        set(accounts(2), ONE_YOCTO);
        assert!(panics_with(
            || {
                c.on_wallet_transfer(tok(), U128(1_000), false);
            },
            "Method on_wallet_transfer is private"
        ));
        assert_eq!(balance(&c), 0);
    }

    // -- the wallet moves with the token ---------------------------------------

    #[test]
    fn wallet_travels_with_the_token_and_old_owner_loses_control() {
        let mut c = minted();
        tip(&mut c, accounts(5), ONE_NEAR);
        set(accounts(2), ONE_YOCTO);
        c.nft_transfer(accounts(3), tok(), None, None);
        let w = c.token_wallet(tok()).expect("wallet");
        assert_eq!(w.owner_id, accounts(3));
        assert_eq!(w.balance, U128(ONE_NEAR));
        set(accounts(2), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(2), U128(1), None);
            },
            "only the token owner can manage its wallet"
        ));
        set(accounts(3), ONE_YOCTO);
        let _ = c.wallet_send(tok(), accounts(3), U128(ONE_NEAR), None);
        assert_eq!(balance(&c), 0);
    }

    #[test]
    fn spending_is_frozen_while_the_token_is_in_flight() {
        let mut c = minted();
        tip(&mut c, accounts(5), ONE_NEAR);
        grant(&mut c, ONE_NEAR);
        set(accounts(2), ONE_YOCTO);
        let _ = c.nft_transfer_call(accounts(3), tok(), None, None, "".to_string());
        // The receiver now owns the token but the transfer may still revert.
        set(accounts(3), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(3), U128(1), None);
            },
            "use its wallet after it resolves"
        ));
        set(accounts(3), GRANT_DEPOSIT);
        assert!(panics_with(
            || {
                c.wallet_set_agent(tok(), accounts(3), accounts(3), U128(ONE_NEAR));
            },
            "use its wallet after it resolves"
        ));
        // Tips still land.
        assert_eq!(tip(&mut c, accounts(5), 1), ONE_NEAR + 1);
        // The receiver hands it back: the original owner keeps the money.
        testing_env!(
            context(accounts(0), NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(b"true".to_vec())]
        );
        c.nft_resolve_transfer(accounts(2), accounts(3), tok(), None);
        assert_eq!(c.token_wallet(tok()).expect("wallet").owner_id, accounts(2));
        assert_eq!(balance(&c), ONE_NEAR + 1);
    }

    // -- agent grants --------------------------------------------------------

    #[test]
    fn agent_pays_the_payee_within_its_allowance() {
        let mut c = minted();
        tip(&mut c, accounts(5), ONE_NEAR);
        grant(&mut c, ONE_NEAR / 10);
        let view = c.token_wallet(tok()).expect("wallet").agent.expect("agent");
        assert_eq!(view.agent_id, accounts(3));
        assert_eq!(view.payee_id, accounts(4));
        assert_eq!(view.allowance, U128(ONE_NEAR / 10));

        set(accounts(3), NearToken::from_yoctonear(0));
        let _ = c.wallet_agent_pay(tok(), U128(ONE_NEAR / 100), Some("inference".to_string()));
        assert_eq!(transfers_to(&accounts(4)), vec![ONE_NEAR / 100]);
        let w = c.token_wallet(tok()).expect("wallet");
        assert_eq!(w.balance, U128(ONE_NEAR - ONE_NEAR / 100));
        assert_eq!(w.agent.expect("agent").allowance, U128(9 * ONE_NEAR / 100));
        let log = get_logs().last().cloned().expect("event");
        assert!(log.contains(r#""kind":"agent""#));
        assert!(log.contains(r#""memo":"inference""#));
    }

    #[test]
    fn agent_cannot_exceed_allowance_or_balance() {
        let mut c = minted();
        tip(&mut c, accounts(5), 50);
        grant(&mut c, 30);
        set(accounts(3), NearToken::from_yoctonear(0));
        assert!(panics_with(
            || {
                let _ = c.wallet_agent_pay(tok(), U128(31), None);
            },
            "amount exceeds the agent's allowance"
        ));
        let _ = c.wallet_agent_pay(tok(), U128(30), None);
        assert!(panics_with(
            || {
                let _ = c.wallet_agent_pay(tok(), U128(1), None);
            },
            "amount exceeds the agent's allowance"
        ));
        assert_eq!(balance(&c), 20);
        // A bigger allowance than the balance still stops at the balance.
        grant(&mut c, 1_000);
        set(accounts(3), NearToken::from_yoctonear(0));
        assert!(panics_with(
            || {
                let _ = c.wallet_agent_pay(tok(), U128(21), None);
            },
            "amount exceeds the token's wallet balance"
        ));
    }

    #[test]
    fn only_the_agent_can_pay_and_only_to_the_payee() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 100);
        for who in [accounts(2), accounts(4), accounts(5)] {
            set(who, NearToken::from_yoctonear(0));
            assert!(panics_with(
                || {
                    let _ = c.wallet_agent_pay(tok(), U128(1), None);
                },
                "only the granted agent can pay"
            ));
        }
        // The agent has no way to name another receiver: the payee is fixed.
        set(accounts(3), NearToken::from_yoctonear(0));
        let _ = c.wallet_agent_pay(tok(), U128(5), None);
        assert!(transfers_to(&accounts(3)).is_empty());
        assert_eq!(transfers_to(&accounts(4)), vec![5]);
    }

    #[test]
    fn agent_pay_rejects_attached_deposit() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 100);
        set(accounts(3), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_agent_pay(tok(), U128(1), None);
            },
            "doesn't accept deposit"
        ));
    }

    #[test]
    fn grant_by_previous_owner_is_void_after_transfer() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 100);
        set(accounts(2), ONE_YOCTO);
        c.nft_transfer(accounts(5), tok(), None, None);
        assert_eq!(c.token_wallet(tok()).expect("wallet").agent, None);
        set(accounts(3), NearToken::from_yoctonear(0));
        assert!(panics_with(
            || {
                let _ = c.wallet_agent_pay(tok(), U128(1), None);
            },
            "the agent grant was made by a previous owner"
        ));
        // Transferring back does not resurrect anything new: the grant was
        // made by accounts(2), so it counts again only if accounts(2) owns it.
        set(accounts(5), ONE_YOCTO);
        c.nft_transfer(accounts(2), tok(), None, None);
        assert!(c.token_wallet(tok()).expect("wallet").agent.is_some());
    }

    #[test]
    fn new_owner_replaces_or_revokes_the_grant() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 100);
        set(accounts(2), ONE_YOCTO);
        c.nft_transfer(accounts(5), tok(), None, None);
        set(accounts(5), GRANT_DEPOSIT);
        c.wallet_set_agent(tok(), accounts(5), accounts(4), U128(7));
        let a = c.token_wallet(tok()).expect("wallet").agent.expect("agent");
        assert_eq!((a.agent_id, a.allowance), (accounts(5), U128(7)));
        set(accounts(5), ONE_YOCTO);
        c.wallet_revoke_agent(tok());
        assert_eq!(c.token_wallet(tok()).expect("wallet").agent, None);
        assert!(panics_with(
            || c.wallet_revoke_agent(tok()),
            "the token has no agent grant"
        ));
    }

    #[test]
    #[should_panic(expected = "to cover storage")]
    fn grant_without_storage_deposit_panics() {
        let mut c = minted();
        set(accounts(2), ONE_YOCTO);
        c.wallet_set_agent(tok(), accounts(3), accounts(4), U128(1));
    }

    #[test]
    fn only_the_owner_can_grant_and_grants_pay_their_storage() {
        let mut c = minted();
        set(accounts(3), GRANT_DEPOSIT);
        assert!(panics_with(
            || {
                c.wallet_set_agent(tok(), accounts(3), accounts(3), U128(1));
            },
            "only the token owner can manage its wallet"
        ));
        set(accounts(2), GRANT_DEPOSIT);
        assert!(panics_with(
            || {
                c.wallet_set_agent(tok(), accounts(3), accounts(0), U128(1));
            },
            "the payee cannot be the contract account itself"
        ));
        set(accounts(2), GRANT_DEPOSIT);
        c.wallet_set_agent(tok(), accounts(3), accounts(4), U128(1));
        let refunded: u128 = transfers_to(&accounts(2)).iter().sum();
        assert!(refunded > 0 && refunded < GRANT_DEPOSIT.as_yoctonear());
    }

    #[test]
    fn failed_agent_payment_restores_balance_and_allowance() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 50);
        set(accounts(3), NearToken::from_yoctonear(0));
        let _ = c.wallet_agent_pay(tok(), U128(20), None);
        callback(PromiseResult::Failed);
        assert!(!c.on_wallet_transfer(tok(), U128(20), true));
        let w = c.token_wallet(tok()).expect("wallet");
        assert_eq!(w.balance, U128(100));
        assert_eq!(w.agent.expect("agent").allowance, U128(50));
    }

    #[test]
    fn failed_agent_payment_after_revoke_restores_only_the_balance() {
        let mut c = minted();
        tip(&mut c, accounts(5), 100);
        grant(&mut c, 50);
        set(accounts(3), NearToken::from_yoctonear(0));
        let _ = c.wallet_agent_pay(tok(), U128(20), None);
        set(accounts(2), ONE_YOCTO);
        c.wallet_revoke_agent(tok());
        callback(PromiseResult::Failed);
        assert!(!c.on_wallet_transfer(tok(), U128(20), true));
        let w = c.token_wallet(tok()).expect("wallet");
        assert_eq!(w.balance, U128(100));
        assert_eq!(w.agent, None);
    }

    #[test]
    fn wallets_of_different_tokens_are_separate() {
        let mut c = minted();
        set(accounts(1), MINT_DEPOSIT);
        c.nft_mint("skeptic".to_string(), accounts(3), metadata());
        tip(&mut c, accounts(5), 70);
        set(accounts(5), NearToken::from_yoctonear(30));
        c.wallet_deposit("skeptic".to_string(), None);
        assert_eq!(balance(&c), 70);
        assert_eq!(
            c.token_wallet("skeptic".to_string()).expect("wallet").balance,
            U128(30)
        );
        // Skeptic's owner cannot spend Chaotic's money.
        set(accounts(3), ONE_YOCTO);
        assert!(panics_with(
            || {
                let _ = c.wallet_send(tok(), accounts(3), U128(1), None);
            },
            "only the token owner can manage its wallet"
        ));
    }
}
