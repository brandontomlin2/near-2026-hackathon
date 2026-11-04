#![allow(deprecated)]
use super::*;
use near_sdk::test_utils::{get_logs, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::{testing_env, PromiseOrValue, PromiseResult};

const DAY: u64 = NS_PER_DAY;
const T0: u64 = 10 * DAY + 5;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn wrap() -> AccountId {
    acct("wrap.testnet")
}
fn rft() -> AccountId {
    acct("rft.tokenfactory.testnet")
}
fn usdt() -> AccountId {
    acct("nusdt.ft-fin.testnet")
}
fn usdc() -> AccountId {
    acct("nusdc.ft-fin.testnet")
}

fn ctx(pred: &str, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acct("vault.testnet"))
        .predecessor_account_id(acct(pred))
        .block_timestamp(ts);
    b
}
fn ctx1(pred: &str) -> VMContextBuilder {
    let mut b = ctx(pred, T0);
    b.attached_deposit(NearToken::from_yoctonear(1));
    b
}
fn at(pred: &str, ts: u64) {
    testing_env!(ctx(pred, ts).build());
}
fn ok_result<T: near_sdk::serde::Serialize>(v: &T) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(v).unwrap())
}
fn cb_ctx(result: PromiseResult, ts: u64) {
    testing_env_with_promise_results(ctx("vault.testnet", ts).build(), result);
}

/// Permissive floor: output must be at least 1/1_000_000 of the input.
fn lax_rate() -> Rate {
    Rate {
        num: U128(1),
        den: U128(1_000_000),
    }
}
fn pool(pool_id: u64, token_a: AccountId, token_b: AccountId) -> AllowedPool {
    AllowedPool {
        pool_id,
        token_a,
        token_b,
        min_rate_a_to_b: lax_rate(),
        min_rate_b_to_a: lax_rate(),
    }
}
fn limit(token_id: AccountId, max_trade: u128, daily_cap: u128) -> TokenLimit {
    TokenLimit {
        token_id,
        max_trade: U128(max_trade),
        daily_cap: U128(daily_cap),
    }
}
/// `spent_today` as shown by the view, for one token.
fn spent_view(v: &YieldVault, t: &AccountId) -> u128 {
    v.get_state()
        .spent_today
        .iter()
        .find(|(k, _)| k == t)
        .map(|(_, a)| a.0)
        .unwrap_or(0)
}

fn config() -> VaultConfig {
    VaultConfig {
        strategy: "chaotic".to_string(),
        allowed_pools: vec![
            pool(0, wrap(), rft()),
            pool(1, usdt(), usdc()),
        ],
        limits: vec![
            limit(wrap(), 1_000, 2_500),
            limit(rft(), 1_000, 2_500),
            limit(usdt(), 1_000, 2_500),
        ],
        runners: vec![acct("runner.testnet")],
    }
}

fn new_vault_with(c: VaultConfig) -> YieldVault {
    at("vault.testnet", T0);
    YieldVault::new(
        acct("owner.testnet"),
        acct("nft.testnet"),
        "1".to_string(),
        acct("ref-finance-101.testnet"),
        c,
    )
}
fn new_vault() -> YieldVault {
    new_vault_with(config())
}
fn deposit(v: &mut YieldVault, token: AccountId, amount: u128) {
    testing_env!(ctx(token.as_str(), T0).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(amount), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
}
fn funded() -> YieldVault {
    let mut v = new_vault();
    deposit(&mut v, wrap(), 10_000);
    deposit(&mut v, usdt(), 10_000);
    v
}
fn proposal(amount: u128) -> SwapProposal {
    SwapProposal {
        pool_id: 0,
        token_in: wrap(),
        token_out: rft(),
        amount_in: U128(amount),
        min_amount_out: U128(1),
    }
}
fn run(v: &mut YieldVault, p: SwapProposal) {
    run_at(v, p, T0);
}
fn run_at(v: &mut YieldVault, p: SwapProposal, ts: u64) {
    at("runner.testnet", ts);
    let _ = v.execute_swap(p);
}
fn bal(v: &YieldVault, t: &AccountId) -> u128 {
    v.get_balance(t.clone()).0
}
fn stranded(v: &YieldVault, t: &AccountId) -> u128 {
    v.stranded.get(t).copied().unwrap_or(0)
}

// ---------------------------------------------------------------- init

#[test]
fn init_ok_sets_state() {
    let v = new_vault();
    let s = v.get_state();
    assert_eq!(s.owner_id, acct("owner.testnet"));
    assert_eq!(s.token_id, "1");
    assert!(!s.paused && !s.swap_in_flight);
    assert_eq!(s.day, 10);
    assert!(s.spent_today.is_empty());
    assert_eq!(v.get_config(), config());
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: strategy")]
fn init_rejects_bad_strategy() {
    let mut c = config();
    c.strategy = "yolo".into();
    new_vault_with(c);
}

#[test]
fn init_accepts_all_four_strategies() {
    for s in ["aloof", "chaotic", "social", "skeptic"] {
        let mut c = config();
        c.strategy = s.into();
        new_vault_with(c);
    }
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: max_trade")]
fn init_rejects_zero_max_trade() {
    let mut c = config();
    c.limits[0].max_trade = U128(0);
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: daily_cap")]
fn init_rejects_cap_below_max_trade() {
    let mut c = config();
    c.limits[0].daily_cap = U128(999);
    new_vault_with(c);
}

#[test]
fn init_accepts_cap_equal_max_trade() {
    let mut c = config();
    for l in c.limits.iter_mut() {
        l.daily_cap = l.max_trade;
    }
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: duplicate pool")]
fn init_rejects_duplicate_pool() {
    let mut c = config();
    c.allowed_pools.push(c.allowed_pools[0].clone());
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: token_a must differ")]
fn init_rejects_same_tokens() {
    let mut c = config();
    c.allowed_pools[0].token_b = c.allowed_pools[0].token_a.clone();
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: duplicate runner")]
fn init_rejects_duplicate_runner() {
    let mut c = config();
    c.runners.push(c.runners[0].clone());
    new_vault_with(c);
}

// ------------------------------------------------------------ deposits

#[test]
fn deposit_from_owner_of_pool_token_is_credited() {
    let mut v = new_vault();
    deposit(&mut v, wrap(), 500);
    deposit(&mut v, wrap(), 250);
    assert_eq!(bal(&v, &wrap()), 750);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"deposit\"")));
}

#[test]
fn deposit_from_non_owner_is_refunded() {
    let mut v = new_vault();
    testing_env!(ctx("wrap.testnet", T0).build());
    let r = v.ft_on_transfer(acct("mallory.testnet"), U128(500), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(500))));
    assert_eq!(bal(&v, &wrap()), 0);
}

#[test]
fn deposit_of_unlisted_token_is_refunded() {
    let mut v = new_vault();
    testing_env!(ctx("random.testnet", T0).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(500), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(500))));
    assert_eq!(bal(&v, &acct("random.testnet")), 0);
}

#[test]
fn deposit_of_zero_is_refunded() {
    let mut v = new_vault();
    testing_env!(ctx("wrap.testnet", T0).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(0), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(v.balances.is_empty());
}

// ------------------------------------------------- execute_swap rejections

#[test]
#[should_panic(expected = "ERR_NOT_RUNNER")]
fn swap_rejects_non_runner() {
    let mut v = funded();
    at("mallory.testnet", T0);
    let _ = v.execute_swap(proposal(100));
}

#[test]
#[should_panic(expected = "ERR_PAUSED")]
fn swap_rejects_when_paused() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.pause();
    run(&mut v, proposal(100));
}

#[test]
#[should_panic(expected = "ERR_POOL_NOT_ALLOWED")]
fn swap_rejects_unknown_pool() {
    let mut v = funded();
    let mut p = proposal(100);
    p.pool_id = 99;
    run(&mut v, p);
}

#[test]
#[should_panic(expected = "ERR_TOKEN_NOT_IN_POOL")]
fn swap_rejects_foreign_token_in() {
    let mut v = funded();
    let mut p = proposal(100);
    p.token_in = usdt();
    run(&mut v, p);
}

#[test]
#[should_panic(expected = "ERR_TOKEN_NOT_IN_POOL")]
fn swap_rejects_foreign_token_out() {
    let mut v = funded();
    let mut p = proposal(100);
    p.token_out = usdc();
    run(&mut v, p);
}

#[test]
#[should_panic(expected = "ERR_TOKEN_NOT_IN_POOL")]
fn swap_rejects_same_token_both_sides() {
    let mut v = funded();
    let mut p = proposal(100);
    p.token_out = wrap();
    run(&mut v, p);
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn swap_rejects_zero_amount() {
    let mut v = funded();
    run(&mut v, proposal(0));
}

#[test]
#[should_panic(expected = "ERR_ZERO_MIN_OUT")]
fn swap_rejects_zero_min_out() {
    let mut v = funded();
    let mut p = proposal(100);
    p.min_amount_out = U128(0);
    run(&mut v, p);
}

#[test]
#[should_panic(expected = "ERR_MAX_TRADE")]
fn swap_rejects_over_max_trade() {
    let mut v = funded();
    run(&mut v, proposal(1_001));
}

#[test]
fn swap_accepts_exactly_max_trade() {
    let mut v = funded();
    run(&mut v, proposal(1_000));
    assert_eq!(bal(&v, &wrap()), 9_000);
}

#[test]
#[should_panic(expected = "ERR_DAILY_CAP")]
fn swap_rejects_over_daily_cap() {
    let mut v = funded();
    v.spent_today.insert(wrap(), 2_000);
    v.day = 10;
    run(&mut v, proposal(501));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn swap_rejects_insufficient_balance() {
    let mut v = new_vault();
    deposit(&mut v, wrap(), 50);
    run(&mut v, proposal(100));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn swap_rejects_low_gas() {
    let mut v = funded();
    let mut c = ctx("runner.testnet", T0);
    c.prepaid_gas(Gas::from_tgas(100));
    testing_env!(c.build());
    let _ = v.execute_swap(proposal(100));
}

#[test]
fn swap_works_in_reverse_direction() {
    let mut v = funded();
    let p = SwapProposal {
        pool_id: 1,
        token_in: usdt(),
        token_out: usdc(),
        amount_in: U128(10),
        min_amount_out: U128(9),
    };
    run(&mut v, p);
    assert_eq!(bal(&v, &usdt()), 9_990);
}

#[test]
fn pool_tokens_in_either_order_accepted() {
    let mut v = funded();
    deposit(&mut v, rft(), 100);
    let p = SwapProposal {
        pool_id: 0,
        token_in: rft(),
        token_out: wrap(),
        amount_in: U128(10),
        min_amount_out: U128(1),
    };
    run(&mut v, p);
    assert_eq!(bal(&v, &rft()), 90);
}

// ------------------------------------------------------------ happy path

#[test]
fn swap_happy_path_debits_and_locks() {
    let mut v = funded();
    run(&mut v, proposal(400));
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(spent_view(&v, &wrap()), 400);
    assert!(v.get_state().swap_in_flight);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"swap_proposed\"")));
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn second_swap_while_in_flight_rejected() {
    let mut v = funded();
    run(&mut v, proposal(100));
    run(&mut v, proposal(100));
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn update_config_blocked_while_in_flight() {
    let mut v = funded();
    run(&mut v, proposal(100));
    testing_env!(ctx1("owner.testnet").build());
    v.update_config(config());
}

#[test]
fn full_chain_success_credits_token_out() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    assert!(v.get_state().swap_in_flight);
    assert_eq!(v.in_flight.as_ref().unwrap().amount_in, 400);
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.on_swap(1, Ok(U128(390)));
    assert_eq!(v.in_flight.as_ref().unwrap().amount_out, 390);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_withdraw_done(1);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert!(v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 0, "not credited before reconciliation");
    cb_ctx(PromiseResult::Failed, T0);
    let out = v.on_withdraw_reconciled(1, Ok(U128(0)));
    assert_eq!(out.0, 390);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 390);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(v.get_state().swaps_executed, 1);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"swap_executed\"")));
    // The lock is free again.
    run(&mut v, proposal(100));
}

// ------------------------------------------------------------- daily cap

#[test]
fn daily_cap_accumulates_then_blocks() {
    let mut v = funded();
    for _ in 0..2 {
        run(&mut v, proposal(1_000));
        v.in_flight = None;
    }
    assert_eq!(spent_view(&v, &wrap()), 2_000);
    let r = v.check_proposal(proposal(501), acct("runner.testnet"));
    assert!(!r.ok && r.reason.starts_with("ERR_DAILY_CAP"));
    let r = v.check_proposal(proposal(500), acct("runner.testnet"));
    assert!(r.ok);
}

#[test]
fn daily_cap_resets_next_day() {
    let mut v = funded();
    for _ in 0..2 {
        run(&mut v, proposal(1_000));
        v.in_flight = None;
    }
    run(&mut v, proposal(500));
    v.in_flight = None;
    assert_eq!(v.spent_today.get(&wrap()).copied(), Some(2_500));
    // Next UTC day: view shows zero and the swap is allowed.
    at("runner.testnet", T0 + DAY);
    assert_eq!(spent_view(&v, &wrap()), 0);
    run_at(&mut v, proposal(1_000), T0 + DAY);
    assert_eq!(spent_view(&v, &wrap()), 1_000);
    assert_eq!(v.get_state().day, 11);
}

// ------------------------------------------------------ callback failures

#[test]
fn deposit_failed_rolls_back() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.on_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    // Ref's deposit shows the tokens did not land: roll back.
    v.on_deposit_reconciled(1, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert!(v.stranded.is_empty());
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"swap_failed\"")));
}

#[test]
fn deposit_used_zero_rolls_back() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(0)), T0);
    let _ = v.on_deposit(1, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
}

#[test]
fn deposit_partial_use_refunds_remainder_and_swaps_used() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(300)), T0);
    let r = v.on_deposit(1, Ok(U128(300)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(v.in_flight.as_ref().unwrap().amount_in, 300);
    assert_eq!(bal(&v, &wrap()), 9_700);
    assert_eq!(spent_view(&v, &wrap()), 300);
}

#[test]
fn deposit_used_over_amount_is_clamped() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(999)), T0);
    let _ = v.on_deposit(1, Ok(U128(999)));
    assert_eq!(v.in_flight.as_ref().unwrap().amount_in, 400);
    assert_eq!(bal(&v, &wrap()), 9_600);
}

#[test]
fn deposit_rollback_after_day_roll_keeps_new_day_counter() {
    let mut v = funded();
    run(&mut v, proposal(400));
    // Day rolls while the swap is in flight, and someone else's spend is booked.
    v.day = 11;
    v.spent_today.clear();
    v.spent_today.insert(wrap(), 50);
    cb_ctx(PromiseResult::Failed, T0 + DAY);
    let _ = v.on_deposit(1, Err(PromiseError::Failed));
    cb_ctx(PromiseResult::Failed, T0 + DAY);
    v.on_deposit_reconciled(1, Ok(U128(0)));
    assert_eq!(v.spent_today.get(&wrap()).copied(), Some(50));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn swap_failed_strands_token_in_and_releases_lock() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.on_swap(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(v.get_state().stranded_on_ref, vec![(wrap(), U128(400))]);
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"event\":\"stranded\"") && logs.contains("\"event\":\"swap_failed\""));
}

#[test]
fn amount_out_below_min_strands_token_out() {
    let mut v = funded();
    let mut p = proposal(400);
    p.min_amount_out = U128(390);
    run(&mut v, p);
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(389)), T0);
    let r = v.on_swap(1, Ok(U128(389)));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &rft()), 389);
    assert_eq!(bal(&v, &rft()), 0);
}

#[test]
fn amount_out_zero_releases_without_stranding() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(0)), T0);
    let _ = v.on_swap(1, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert!(v.stranded.is_empty());
}

#[test]
fn withdraw_failed_strands_token_out() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.on_swap(1, Ok(U128(390)));
    cb_ctx(PromiseResult::Failed, T0);
    let out = v.on_withdraw_done(1);
    assert!(matches!(out, PromiseOrValue::Value(U128(0))));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &rft()), 390);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(v.get_state().swaps_executed, 0);
}

#[test]
fn lock_is_free_after_each_failure() {
    let mut v = funded();
    run(&mut v, proposal(100));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_deposit(1, Err(PromiseError::Failed));
    v.on_deposit_reconciled(1, Ok(U128(0)));
    run(&mut v, proposal(100));
    assert!(v.get_state().swap_in_flight);
}

#[test]
fn callbacks_without_in_flight_are_noops() {
    let mut v = funded();
    cb_ctx(PromiseResult::Failed, T0);
    assert!(matches!(
        v.on_deposit(1, Err(PromiseError::Failed)),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        v.on_swap(1, Err(PromiseError::Failed)),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        v.on_withdraw_done(1),
        PromiseOrValue::Value(U128(0))
    ));
    assert_eq!(v.on_deposit_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(v.on_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &wrap()), 10_000);
}

// ------------------------------------------------- callbacks reject outsiders

#[test]
#[should_panic(expected = "Method is private")]
fn on_deposit_rejects_non_self() {
    let mut v = funded();
    testing_env_with_promise_results(ctx("mallory.testnet", T0).build(), PromiseResult::Failed);
    let _ = v.on_deposit(1, Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_swap_rejects_non_self() {
    let mut v = funded();
    at("mallory.testnet", T0);
    let _ = v.on_swap(1, Ok(U128(1)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_withdraw_done_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.on_withdraw_done(1);
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_owner_withdraw_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    v.on_owner_withdraw(wrap(), U128(1));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_recover_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.on_recover(wrap(), U128(1));
}

// ------------------------------------------------------- owner withdraw

#[test]
fn owner_withdraw_debits_balance() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(1_500));
    assert_eq!(bal(&v, &wrap()), 8_500);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"withdraw\"")));
}

#[test]
fn owner_withdraw_full_balance_removes_entry() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(10_000));
    assert!(!v.balances.contains_key(&wrap()));
}

#[test]
fn withdraw_callback_failure_restores_balance() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(1_500));
    cb_ctx(PromiseResult::Failed, T0);
    v.on_owner_withdraw(wrap(), U128(1_500));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn withdraw_callback_success_keeps_debit() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(1_500));
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    v.on_owner_withdraw(wrap(), U128(1_500));
    assert_eq!(bal(&v, &wrap()), 8_500);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn withdraw_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("mallory.testnet").build());
    let _ = v.withdraw(wrap(), U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_one_yocto() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.withdraw(wrap(), U128(1));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_BALANCE")]
fn withdraw_rejects_more_than_balance() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(10_001));
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn withdraw_rejects_zero() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.withdraw(wrap(), U128(0));
}

// ------------------------------------------------------------ owner admin

#[test]
fn pause_unpause_roundtrip() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.pause();
    assert!(v.get_state().paused);
    v.unpause();
    assert!(!v.get_state().paused);
    run(&mut v, proposal(10));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn pause_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.pause();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn unpause_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.unpause();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn add_runner_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.add_runner(acct("evil.testnet"));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn revoke_runner_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.revoke_runner(acct("runner.testnet"));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn revoke_all_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.revoke_all_runners();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn update_config_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.update_config(config());
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn recover_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    let _ = v.recover_from_ref(wrap(), U128(1));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn register_on_ref_rejects_non_owner() {
    let mut v = funded();
    let mut c = ctx("runner.testnet", T0);
    c.attached_deposit(NearToken::from_millinear(10));
    testing_env!(c.build());
    let _ = v.register_on_ref();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn force_release_rejects_non_owner() {
    let mut v = funded();
    testing_env!(ctx1("runner.testnet").build());
    v.force_release_lock();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pause_requires_one_yocto() {
    let mut v = funded();
    at("owner.testnet", T0);
    v.pause();
}

#[test]
fn register_on_ref_requires_deposit_and_forwards_it() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.attached_deposit(NearToken::from_millinear(10));
    testing_env!(c.build());
    let _ = v.register_on_ref();
}

#[test]
#[should_panic(expected = "ERR_DEPOSIT_REQUIRED")]
fn register_on_ref_rejects_zero_deposit() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.register_on_ref();
}

#[test]
fn add_and_revoke_runner() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.add_runner(acct("runner2.testnet"));
    assert_eq!(v.get_config().runners.len(), 2);
    run(&mut v, proposal(10)); // runner.testnet still fine
    v.in_flight = None;
    testing_env!(ctx1("owner.testnet").build());
    v.revoke_runner(acct("runner.testnet"));
    let r = v.check_proposal(proposal(10), acct("runner.testnet"));
    assert!(r.reason.starts_with("ERR_NOT_RUNNER"));
    let r = v.check_proposal(proposal(10), acct("runner2.testnet"));
    assert!(r.ok);
}

#[test]
#[should_panic(expected = "ERR_RUNNER_EXISTS")]
fn add_runner_rejects_duplicate() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.add_runner(acct("runner.testnet"));
}

#[test]
#[should_panic(expected = "ERR_RUNNER_NOT_FOUND")]
fn revoke_unknown_runner_fails() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.revoke_runner(acct("nobody.testnet"));
}

#[test]
fn revoke_all_clears_runners_and_pauses() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.revoke_all_runners();
    assert!(v.get_config().runners.is_empty());
    assert!(v.get_state().paused);
    let logs = get_logs().join("\n");
    assert!(logs.contains("runner_revoked") && logs.contains("\"event\":\"paused\""));
}

#[test]
#[should_panic(expected = "ERR_NOT_RUNNER")]
fn revoke_all_blocks_swaps_even_after_unpause() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.revoke_all_runners();
    v.unpause();
    run(&mut v, proposal(10));
}

#[test]
fn update_config_applies_and_validates() {
    let mut v = funded();
    let mut c = config();
    c.strategy = "skeptic".into();
    c.limits = vec![limit(wrap(), 50, 100)];
    testing_env!(ctx1("owner.testnet").build());
    v.update_config(c.clone());
    assert_eq!(v.get_config(), c);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("\"event\":\"config_updated\"")));
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG")]
fn update_config_rejects_invalid() {
    let mut v = funded();
    let mut c = config();
    c.strategy = "nope".into();
    testing_env!(ctx1("owner.testnet").build());
    v.update_config(c);
}

// --------------------------------------------------------- recover_from_ref

#[test]
fn recover_moves_stranded_then_credits_on_success() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    assert_eq!(stranded(&v, &rft()), 200);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_recover(rft(), U128(300));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(bal(&v, &rft()), 0, "not credited before reconciliation");
    cb_ctx(PromiseResult::Failed, T0);
    v.on_recover_reconciled(rft(), U128(300), Ok(U128(0)));
    assert_eq!(bal(&v, &rft()), 300);
}

#[test]
fn recover_failure_restores_stranded() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(500));
    assert_eq!(stranded(&v, &rft()), 0);
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_recover(rft(), U128(500));
    assert_eq!(stranded(&v, &rft()), 500);
    assert_eq!(bal(&v, &rft()), 0);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_STRANDED")]
fn recover_more_than_stranded_rejected() {
    let mut v = funded();
    v.stranded.insert(rft(), 5);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(6));
}

// ------------------------------------------------------- force release lock

#[test]
#[should_panic(expected = "ERR_LOCK_NOT_STALE")]
fn force_release_too_early_rejected() {
    let mut v = funded();
    run(&mut v, proposal(100));
    testing_env!(ctx1("owner.testnet").build());
    v.force_release_lock();
}

#[test]
#[should_panic(expected = "ERR_NO_SWAP_IN_FLIGHT")]
fn force_release_without_lock_rejected() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    v.force_release_lock();
}

#[test]
fn force_release_after_timeout_strands_and_unlocks() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(c.build());
    v.force_release_lock();
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 100);
}

// ------------------------------------------------------- check_proposal

fn reason(v: &YieldVault, p: SwapProposal, runner: &str) -> String {
    let r = v.check_proposal(p, acct(runner));
    assert!(!r.ok);
    r.reason
}

#[test]
fn check_proposal_ok() {
    let v = funded();
    let r = v.check_proposal(proposal(100), acct("runner.testnet"));
    assert!(r.ok && r.reason.is_empty());
}

#[test]
fn check_proposal_mirrors_every_rule() {
    let mut v = funded();
    let r = "runner.testnet";
    assert!(reason(&v, proposal(1), "mallory.testnet").starts_with("ERR_NOT_RUNNER"));
    let mut p = proposal(1);
    p.pool_id = 7;
    assert!(reason(&v, p, r).starts_with("ERR_POOL_NOT_ALLOWED"));
    let mut p = proposal(1);
    p.token_out = usdc();
    assert!(reason(&v, p, r).starts_with("ERR_TOKEN_NOT_IN_POOL"));
    assert!(reason(&v, proposal(0), r).starts_with("ERR_ZERO_AMOUNT"));
    let mut p = proposal(1);
    p.min_amount_out = U128(0);
    assert!(reason(&v, p, r).starts_with("ERR_ZERO_MIN_OUT"));
    assert!(reason(&v, proposal(1_001), r).starts_with("ERR_MAX_TRADE"));
    v.spent_today.insert(wrap(), 2_400);
    v.day = 10;
    assert!(reason(&v, proposal(101), r).starts_with("ERR_DAILY_CAP"));
    v.spent_today.clear();
    v.balances.insert(wrap(), 5);
    assert!(reason(&v, proposal(6), r).starts_with("ERR_INSUFFICIENT_BALANCE"));
    v.paused = true;
    assert!(reason(&v, proposal(1), r).starts_with("ERR_PAUSED"));
    v.paused = false;
    run(&mut v, proposal(1));
    at("owner.testnet", T0);
    assert!(reason(&v, proposal(1), r).starts_with("ERR_SWAP_IN_FLIGHT"));
}

#[test]
fn check_proposal_has_no_side_effects() {
    let v = funded();
    let before = v.get_state();
    let _ = v.check_proposal(proposal(100), acct("runner.testnet"));
    assert_eq!(v.get_state(), before);
}

#[test]
fn check_proposal_uses_fresh_day_for_cap() {
    let mut v = funded();
    v.spent_today.insert(wrap(), 2_500);
    v.day = 10;
    assert!(!v
        .check_proposal(proposal(1), acct("runner.testnet"))
        .ok);
    at("owner.testnet", T0 + DAY);
    assert!(v
        .check_proposal(proposal(1), acct("runner.testnet"))
        .ok);
}

#[test]
fn check_proposal_overflow_safe() {
    let mut c = config();
    c.limits = vec![limit(wrap(), u128::MAX, u128::MAX)];
    // Floor 1/u128::MAX so that amount_in = u128::MAX with min_out = 1 passes it.
    c.allowed_pools[0].min_rate_a_to_b.den = U128(u128::MAX);
    let mut v = new_vault_with(c);
    v.spent_today.insert(wrap(), u128::MAX);
    v.day = 10;
    deposit(&mut v, wrap(), 5);
    let r = v.check_proposal(proposal(u128::MAX), acct("runner.testnet"));
    assert!(r.reason.starts_with("ERR_DAILY_CAP"));
}

#[test]
fn events_follow_nep297() {
    let mut v = new_vault();
    deposit(&mut v, wrap(), 5);
    let line = get_logs()
        .into_iter()
        .find(|l| l.contains("\"event\":\"deposit\""))
        .unwrap();
    let json: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(json["standard"], "yield_vault");
    assert_eq!(json["version"], "1.0.0");
    assert_eq!(json["data"][0]["amount"], "5");
}

#[test]
fn late_callback_of_force_released_swap_cannot_touch_new_swap() {
    let mut v = funded();
    run(&mut v, proposal(100)); // id 1
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(c.build());
    v.force_release_lock();
    run_at(&mut v, proposal(200), T0 + STALE_LOCK_NS); // id 2
    cb_ctx(PromiseResult::Failed, T0 + STALE_LOCK_NS);
    let r = v.on_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(v.on_deposit_reconciled(1, Ok(U128(0))).0, 0);
    assert!(v.get_state().swap_in_flight);
    assert_eq!(v.in_flight.as_ref().unwrap().id, 2);
    assert_eq!(bal(&v, &wrap()), 9_700);
}

// ================================================ audit fixes: new coverage

fn runner() -> AccountId {
    acct("runner.testnet")
}
fn rate(num: u128, den: u128) -> Rate {
    Rate {
        num: U128(num),
        den: U128(den),
    }
}
fn stranded_view(v: &YieldVault, t: &AccountId) -> u128 {
    v.get_state()
        .stranded_on_ref
        .iter()
        .find(|(k, _)| k == t)
        .map(|(_, a)| a.0)
        .unwrap_or(0)
}

// ---- (1) per-token limits

fn two_limit_vault() -> YieldVault {
    let mut c = config();
    c.limits = vec![limit(wrap(), 1_000, 2_500), limit(usdt(), 100, 150)];
    let mut v = new_vault_with(c);
    deposit(&mut v, wrap(), 10_000);
    deposit(&mut v, usdt(), 10_000);
    v
}
fn usdt_proposal(amount: u128) -> SwapProposal {
    SwapProposal {
        pool_id: 1,
        token_in: usdt(),
        token_out: usdc(),
        amount_in: U128(amount),
        min_amount_out: U128(1),
    }
}

#[test]
fn max_trade_is_per_token() {
    let v = two_limit_vault();
    assert!(v.check_proposal(proposal(1_000), runner()).ok);
    assert!(v.check_proposal(usdt_proposal(100), runner()).ok);
    let r = v.check_proposal(usdt_proposal(101), runner());
    assert!(r.reason.starts_with("ERR_MAX_TRADE"), "{}", r.reason);
}

#[test]
fn daily_cap_is_independent_per_token() {
    let mut v = two_limit_vault();
    run(&mut v, usdt_proposal(100));
    v.in_flight = None;
    // usdt: 100 spent of 150, so 51 is too much; wrap is untouched.
    let r = v.check_proposal(usdt_proposal(51), runner());
    assert!(r.reason.starts_with("ERR_DAILY_CAP"), "{}", r.reason);
    assert!(v.check_proposal(usdt_proposal(50), runner()).ok);
    assert!(v.check_proposal(proposal(1_000), runner()).ok);
    // Spending wrap does not eat into usdt's cap.
    run(&mut v, proposal(1_000));
    v.in_flight = None;
    run(&mut v, proposal(1_000));
    v.in_flight = None;
    assert_eq!(spent_view(&v, &wrap()), 2_000);
    assert_eq!(spent_view(&v, &usdt()), 100);
    assert!(v.check_proposal(usdt_proposal(50), runner()).ok);
    let r = v.check_proposal(proposal(501), runner());
    assert!(r.reason.starts_with("ERR_DAILY_CAP"), "{}", r.reason);
}

#[test]
#[should_panic(expected = "ERR_NO_LIMIT")]
fn token_without_limit_cannot_be_sold() {
    let mut v = two_limit_vault();
    deposit(&mut v, rft(), 100);
    let p = SwapProposal {
        pool_id: 0,
        token_in: rft(),
        token_out: wrap(),
        amount_in: U128(10),
        min_amount_out: U128(1),
    };
    run(&mut v, p);
}

#[test]
fn per_token_spend_rolls_back_only_that_token() {
    let mut v = two_limit_vault();
    run(&mut v, usdt_proposal(100));
    v.in_flight = None;
    run(&mut v, proposal(300));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_deposit(2, Err(PromiseError::Failed));
    v.on_deposit_reconciled(2, Ok(U128(0)));
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert_eq!(spent_view(&v, &usdt()), 100);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: duplicate limit token")]
fn init_rejects_duplicate_limit_token() {
    let mut c = config();
    c.limits.push(limit(wrap(), 5, 5));
    new_vault_with(c);
}

#[test]
fn init_accepts_empty_limits_but_nothing_is_sellable() {
    let mut c = config();
    c.limits.clear();
    let mut v = new_vault_with(c);
    deposit(&mut v, wrap(), 100);
    let r = v.check_proposal(proposal(10), runner());
    assert!(r.reason.starts_with("ERR_NO_LIMIT"), "{}", r.reason);
}

// ---- (2) on-chain price floor

fn floor_vault() -> YieldVault {
    let mut c = config();
    c.allowed_pools[0].min_rate_a_to_b = rate(2, 1);
    c.allowed_pools[0].min_rate_b_to_a = rate(1, 4);
    let mut v = new_vault_with(c);
    deposit(&mut v, wrap(), 10_000);
    deposit(&mut v, rft(), 10_000);
    v
}
fn with_min_out(mut p: SwapProposal, out: u128) -> SwapProposal {
    p.min_amount_out = U128(out);
    p
}

#[test]
fn price_floor_refuses_below_and_accepts_exactly_at_floor() {
    let mut v = floor_vault();
    let r = v.check_proposal(with_min_out(proposal(100), 199), runner());
    assert!(!r.ok && r.reason.starts_with("ERR_PRICE_FLOOR"), "{}", r.reason);
    assert!(v.check_proposal(with_min_out(proposal(100), 200), runner()).ok);
    assert!(v.check_proposal(with_min_out(proposal(100), 201), runner()).ok);
    run(&mut v, with_min_out(proposal(100), 200));
    assert!(v.get_state().swap_in_flight);
}

#[test]
#[should_panic(expected = "ERR_PRICE_FLOOR")]
fn execute_swap_panics_below_price_floor() {
    let mut v = floor_vault();
    run(&mut v, with_min_out(proposal(100), 199));
}

#[test]
fn price_floor_is_per_direction() {
    let v = floor_vault();
    let rev = |amount: u128, out: u128| SwapProposal {
        pool_id: 0,
        token_in: rft(),
        token_out: wrap(),
        amount_in: U128(amount),
        min_amount_out: U128(out),
    };
    // b -> a floor is 1/4: amount_in 100 needs min_out >= 25.
    let r = v.check_proposal(rev(100, 24), runner());
    assert!(r.reason.starts_with("ERR_PRICE_FLOOR"), "{}", r.reason);
    assert!(v.check_proposal(rev(100, 25), runner()).ok);
}

#[test]
fn price_floor_rounds_exactly_with_fractions() {
    // Floor 1/3: 10 in needs out*3 >= 10, i.e. out >= 4 (3 is refused).
    let mut c = config();
    c.allowed_pools[0].min_rate_a_to_b = rate(1, 3);
    let mut v = new_vault_with(c);
    deposit(&mut v, wrap(), 100);
    assert!(!v.check_proposal(with_min_out(proposal(10), 3), runner()).ok);
    assert!(v.check_proposal(with_min_out(proposal(10), 4), runner()).ok);
}

#[test]
fn price_floor_does_not_overflow_with_huge_values() {
    assert_eq!(mul_wide(u128::MAX, u128::MAX), (u128::MAX - 1, 1));
    assert_eq!(mul_wide(u128::MAX, 1), (0, u128::MAX));
    assert_eq!(mul_wide(0, u128::MAX), (0, 0));
    assert_eq!(mul_wide(1u128 << 64, 1u128 << 64), (1, 0));
    // The naive u128 product would overflow in all of these.
    assert!(meets_floor(u128::MAX, u128::MAX, &rate(u128::MAX, u128::MAX)));
    assert!(!meets_floor(u128::MAX, u128::MAX - 1, &rate(u128::MAX, u128::MAX)));
    assert!(meets_floor(u128::MAX, 1, &rate(1, u128::MAX)));
    assert!(!meets_floor(u128::MAX, 1, &rate(2, u128::MAX)));
    assert!(meets_floor(1, u128::MAX, &rate(u128::MAX, 1)));
    assert!(!meets_floor(2, u128::MAX, &rate(u128::MAX, 1)));
}

#[test]
fn price_floor_huge_proposal_through_check_proposal() {
    let mut c = config();
    c.limits = vec![limit(wrap(), u128::MAX, u128::MAX)];
    c.allowed_pools[0].min_rate_a_to_b = rate(u128::MAX, u128::MAX);
    let mut v = new_vault_with(c);
    deposit(&mut v, wrap(), 5);
    let big = |out: u128| with_min_out(proposal(u128::MAX), out);
    let r = v.check_proposal(big(u128::MAX - 1), runner());
    assert!(r.reason.starts_with("ERR_PRICE_FLOOR"), "{}", r.reason);
    // Floor passed; the next rule (balance) now fires instead of a panic.
    let r = v.check_proposal(big(u128::MAX), runner());
    assert!(r.reason.starts_with("ERR_INSUFFICIENT_BALANCE"), "{}", r.reason);
}

#[test]
fn rule_order_floor_before_limit_and_limit_before_balance() {
    let mut c = config();
    c.limits.clear();
    c.allowed_pools[0].min_rate_a_to_b = rate(2, 1);
    let v = new_vault_with(c);
    // No balance, no limit, bad floor: floor is reported first.
    let r = v.check_proposal(with_min_out(proposal(100), 1), runner());
    assert!(r.reason.starts_with("ERR_PRICE_FLOOR"), "{}", r.reason);
    let r = v.check_proposal(with_min_out(proposal(100), 200), runner());
    assert!(r.reason.starts_with("ERR_NO_LIMIT"), "{}", r.reason);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: rate num and den")]
fn init_rejects_zero_rate_num() {
    let mut c = config();
    c.allowed_pools[0].min_rate_a_to_b = rate(0, 1);
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: rate num and den")]
fn init_rejects_zero_rate_den() {
    let mut c = config();
    c.allowed_pools[1].min_rate_b_to_a = rate(1, 0);
    new_vault_with(c);
}

#[test]
#[should_panic(expected = "ERR_BAD_CONFIG: rate num and den")]
fn update_config_rejects_zero_rate() {
    let mut v = funded();
    let mut c = config();
    c.allowed_pools[0].min_rate_b_to_a = rate(0, 0);
    testing_env!(ctx1("owner.testnet").build());
    v.update_config(c);
}

// ---- (3) balance-based reconciliation

/// Starts swap id 1 (400 wrap in) and leaves it at the deposit callback.
fn swap_at_deposit_cb() -> YieldVault {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.on_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "failed deposit must query Ref");
    assert!(v.get_state().swap_in_flight, "lock held until reconciled");
    v
}
/// Swap id 1 that Ref swapped for 390 rft, awaiting the withdraw callbacks.
fn swap_at_withdraw_cb() -> YieldVault {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.on_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.on_swap(1, Ok(U128(390)));
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_withdraw_done(1);
    assert!(matches!(r, PromiseOrValue::Promise(_)), "must query Ref before crediting");
    assert_eq!(bal(&v, &rft()), 0);
    v
}

#[test]
fn deposit_failed_but_tokens_landed_on_ref_is_stranded_not_rolled_back() {
    let mut v = swap_at_deposit_cb();
    cb_ctx(ok_result(&U128(400)), T0);
    assert_eq!(v.on_deposit_reconciled(1, Ok(U128(400))).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(spent_view(&v, &wrap()), 400, "spend stays counted");
    assert!(get_logs().join("\n").contains("deposit_landed_on_ref"));
}

#[test]
fn deposit_failed_and_ref_deposit_below_baseline_is_rolled_back() {
    let mut v = swap_at_deposit_cb();
    cb_ctx(ok_result(&U128(0)), T0);
    v.on_deposit_reconciled(1, Ok(U128(399)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert!(v.stranded.is_empty());
}

#[test]
fn deposit_reconcile_baseline_includes_already_stranded() {
    // 100 wrap already stranded on Ref: a Ref deposit of 499 (< 100 + 400)
    // proves the 400 did not land; 500 proves it did.
    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 100);
    v.on_deposit_reconciled(1, Ok(U128(499)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(stranded(&v, &wrap()), 100);

    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 100);
    v.on_deposit_reconciled(1, Ok(U128(500)));
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(stranded(&v, &wrap()), 500);
}

#[test]
fn deposit_failed_and_get_deposit_errors_is_stranded_unverified() {
    let mut v = swap_at_deposit_cb();
    cb_ctx(PromiseResult::Failed, T0);
    v.on_deposit_reconciled(1, Err(PromiseError::Failed));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert!(get_logs().join("\n").contains("deposit_unverified"));
}

#[test]
fn withdraw_ok_but_ref_deposit_unchanged_is_stranded_not_credited() {
    let mut v = swap_at_withdraw_cb();
    cb_ctx(ok_result(&U128(390)), T0);
    assert_eq!(v.on_withdraw_reconciled(1, Ok(U128(390))).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 390);
    assert_eq!(v.get_state().swaps_executed, 0);
    assert!(get_logs().join("\n").contains("withdraw_not_reconciled"));
}

#[test]
fn withdraw_ok_and_ref_deposit_dropped_is_credited() {
    let mut v = swap_at_withdraw_cb();
    cb_ctx(ok_result(&U128(0)), T0);
    assert_eq!(v.on_withdraw_reconciled(1, Ok(U128(389))).0, 390);
    assert_eq!(bal(&v, &rft()), 390);
    assert!(v.stranded.is_empty());
    assert_eq!(v.get_state().swaps_executed, 1);
    assert!(!v.get_state().swap_in_flight);
}

#[test]
fn withdraw_reconcile_baseline_includes_already_stranded() {
    let mut v = swap_at_withdraw_cb();
    v.stranded.insert(rft(), 50);
    // baseline 50 + 390 = 440: a deposit of 440 means nothing left Ref.
    assert_eq!(v.on_withdraw_reconciled(1, Ok(U128(440))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 440);
}

#[test]
fn withdraw_ok_and_get_deposit_errors_is_stranded_unverified() {
    let mut v = swap_at_withdraw_cb();
    cb_ctx(PromiseResult::Failed, T0);
    assert_eq!(v.on_withdraw_reconciled(1, Err(PromiseError::Failed)).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded_view(&v, &rft()), 390);
    assert!(get_logs().join("\n").contains("withdraw_unverified"));
}

#[test]
fn late_reconcile_of_force_released_swap_is_a_noop() {
    let mut v = swap_at_withdraw_cb();
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(c.build());
    v.force_release_lock();
    let stranded_before = stranded(&v, &rft());
    cb_ctx(PromiseResult::Failed, T0 + STALE_LOCK_NS);
    assert_eq!(v.on_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), stranded_before);
}

#[test]
#[should_panic(expected = "Method is private")]
fn reconcile_callbacks_reject_non_self() {
    let mut v = swap_at_withdraw_cb();
    at("mallory.testnet", T0);
    v.on_withdraw_reconciled(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn deposit_reconcile_rejects_non_self() {
    let mut v = swap_at_deposit_cb();
    at("mallory.testnet", T0);
    v.on_deposit_reconciled(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn recover_reconcile_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    v.on_recover_reconciled(rft(), U128(1), Ok(U128(0)));
}

fn recovering() -> YieldVault {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_recover(rft(), U128(300));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    v
}

#[test]
fn recover_ok_but_ref_deposit_unchanged_is_restranded_not_credited() {
    let mut v = recovering();
    // 200 still stranded + 300 in flight = 500 baseline; Ref still shows 500.
    cb_ctx(ok_result(&U128(500)), T0);
    assert_eq!(v.on_recover_reconciled(rft(), U128(300), Ok(U128(500))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 500);
}

#[test]
fn recover_ok_and_ref_deposit_dropped_is_credited() {
    let mut v = recovering();
    cb_ctx(ok_result(&U128(200)), T0);
    assert_eq!(v.on_recover_reconciled(rft(), U128(300), Ok(U128(200))).0, 300);
    assert_eq!(bal(&v, &rft()), 300);
    assert_eq!(stranded(&v, &rft()), 200);
    assert!(get_logs().join("\n").contains("\"event\":\"recovered\""));
}

#[test]
fn recover_ok_and_get_deposit_errors_is_restranded_unverified() {
    let mut v = recovering();
    cb_ctx(PromiseResult::Failed, T0);
    assert_eq!(v.on_recover_reconciled(rft(), U128(300), Err(PromiseError::Failed)).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded_view(&v, &rft()), 500);
    assert!(get_logs().join("\n").contains("withdraw_unverified"));
}

// ---- (4) private init, (5) recover lock

#[test]
#[should_panic(expected = "ERR_PRIVATE_INIT")]
fn new_rejects_foreign_predecessor() {
    at("mallory.testnet", T0);
    YieldVault::new(
        acct("mallory.testnet"),
        acct("nft.testnet"),
        "1".to_string(),
        acct("ref-finance-101.testnet"),
        config(),
    );
}

#[test]
#[should_panic(expected = "ERR_PRIVATE_INIT")]
fn new_rejects_the_owner_unless_it_is_the_contract_account() {
    at("owner.testnet", T0);
    YieldVault::new(
        acct("owner.testnet"),
        acct("nft.testnet"),
        "1".to_string(),
        acct("ref-finance-101.testnet"),
        config(),
    );
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn recover_from_ref_refused_while_swap_in_flight() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    run(&mut v, proposal(100));
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(10));
}

#[test]
fn recover_from_ref_allowed_again_after_lock_released() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    run(&mut v, proposal(100));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_deposit(1, Err(PromiseError::Failed));
    v.on_deposit_reconciled(1, Ok(U128(0)));
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(10));
    assert_eq!(stranded(&v, &rft()), 490);
}
