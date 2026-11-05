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
fn unverified(v: &YieldVault, t: &AccountId) -> u128 {
    v.unverified.get(t).copied().unwrap_or(0)
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
    let _ = v.handle_deposit(1, Ok(U128(400)));
    assert!(v.get_state().swap_in_flight);
    assert_eq!(v.in_flight.as_ref().unwrap().amount_in, 400);
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    assert_eq!(v.in_flight.as_ref().unwrap().amount_out, 390);
    cb_ctx(ok_result(&U128(390)), T0);
    let r = v.handle_withdraw_pre(1, Ok(U128(390)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(v.in_flight.as_ref().unwrap().ref_pre_out, 390);
    assert!(v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 0, "not credited before reconciliation");
    cb_ctx(ok_result(&U128(0)), T0);
    let out = v.handle_withdraw_reconciled(1, Ok(U128(0)));
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
    let r = v.handle_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    // Ref's deposit shows the tokens did not land: roll back.
    v.handle_deposit_reconciled(1, Ok(U128(0)));
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
    let _ = v.handle_deposit(1, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
}

#[test]
fn deposit_partial_use_refunds_remainder_and_swaps_used() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(300)), T0);
    let r = v.handle_deposit(1, Ok(U128(300)));
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
    let _ = v.handle_deposit(1, Ok(U128(999)));
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
    let _ = v.handle_deposit(1, Err(PromiseError::Failed));
    cb_ctx(PromiseResult::Failed, T0 + DAY);
    v.handle_deposit_reconciled(1, Ok(U128(0)));
    assert_eq!(v.spent_today.get(&wrap()).copied(), Some(50));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn swap_failed_starts_refund_keeps_lock_and_strands_nothing() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.handle_swap(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "must withdraw token_in back");
    drop(r); // promises are scheduled on drop
    let calls = created_calls();
    assert_eq!(calls[0].1, "get_deposit");
    assert_eq!(calls[0].0, v.ref_exchange_id.to_string());
    assert_eq!(calls[0].2["token_id"], wrap().to_string(), "snapshots token_in, not token_out");
    assert_eq!(calls[1].1, "on_refund_pre");
    assert!(v.get_state().swap_in_flight, "lock held across the refund hops");
    assert_eq!(v.in_flight.as_ref().unwrap().amount_out, 0, "held() keeps reporting token_in");
    assert_eq!(v.in_flight.as_ref().unwrap().held(), (wrap(), 400));
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
    assert_eq!(v.consecutive_strands, 0);
    assert_eq!(bal(&v, &wrap()), 9_600, "not credited before the refund is verified");
    let logs = get_logs().join("\n");
    assert!(!logs.contains("\"event\":\"stranded\"") && !logs.contains("\"event\":\"swap_failed\""), "{logs}");
}

#[test]
fn amount_out_below_min_strands_token_out() {
    let mut v = funded();
    let mut p = proposal(400);
    p.min_amount_out = U128(390);
    run(&mut v, p);
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(389)), T0);
    let r = v.handle_swap(1, Ok(U128(389)));
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
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(0)), T0);
    let _ = v.handle_swap(1, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert!(v.stranded.is_empty());
}

#[test]
fn withdraw_failed_strands_token_out() {
    // A failed Ref `withdraw` leaves the deposit at the pre-withdraw 390.
    let mut v = swap_at_withdraw_cb();
    cb_ctx(ok_result(&U128(390)), T0);
    let out = v.handle_withdraw_reconciled(1, Ok(U128(390)));
    assert_eq!(out.0, 0);
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
    let _ = v.handle_deposit(1, Err(PromiseError::Failed));
    v.handle_deposit_reconciled(1, Ok(U128(0)));
    run(&mut v, proposal(100));
    assert!(v.get_state().swap_in_flight);
}

#[test]
fn callbacks_without_in_flight_are_noops() {
    let mut v = funded();
    cb_ctx(PromiseResult::Failed, T0);
    assert!(matches!(
        v.handle_deposit(1, Err(PromiseError::Failed)),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        v.handle_swap(1, Err(PromiseError::Failed)),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        v.handle_withdraw_pre(1, Ok(U128(0))),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(matches!(
        v.handle_refund_pre(1, Ok(U128(1_000))),
        PromiseOrValue::Value(U128(0))
    ));
    assert_eq!(v.handle_deposit_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(v.handle_refund_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &wrap()), 10_000);
}

// ------------------------------------------------- callbacks reject outsiders

#[test]
#[should_panic(expected = "Method is private")]
fn on_deposit_rejects_non_self() {
    let mut v = funded();
    testing_env_with_promise_results(ctx("mallory.testnet", T0).build(), PromiseResult::Failed);
    let _ = v.handle_deposit(1, Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_swap_rejects_non_self() {
    let mut v = funded();
    at("mallory.testnet", T0);
    let _ = v.handle_swap(1, Ok(U128(1)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_withdraw_pre_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.handle_withdraw_pre(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_refund_pre_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.handle_refund_pre(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_refund_reconciled_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    let _ = v.handle_refund_reconciled(1, Ok(U128(0)));
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
    let _ = v.on_recover(1);
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
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn withdraw_rejects_low_gas_before_debiting() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(Gas::from_tgas(79));
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(1_500));
}

#[test]
fn withdraw_accepts_exactly_min_gas() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(1_500));
    assert_eq!(bal(&v, &wrap()), 8_500);
}

/// The unit-test VM charges receipt fees, so these catch a minimum that cannot
/// even pay for the promises it creates. They are not a real-chain measurement.
#[test]
fn execute_swap_fits_in_exactly_min_gas_in_unit_vm() {
    let mut v = funded();
    let mut c = ctx("runner.testnet", T0);
    c.prepaid_gas(MIN_EXECUTE_GAS);
    testing_env!(c.build());
    let _ = v.execute_swap(proposal(100));
    assert!(v.get_state().swap_in_flight);
}

#[test]
fn force_release_fits_in_exactly_min_gas_in_unit_vm() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    c.prepaid_gas(MIN_FORCE_RELEASE_GAS);
    testing_env!(c.build());
    let _ = v.force_release_lock();
    assert!(v.get_state().release_in_flight);
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
    let _ = v.force_release_lock();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pause_requires_one_yocto() {
    let mut v = funded();
    at("owner.testnet", T0);
    v.pause();
}

/// Function calls created so far: (receiver, method, args, deposit).
fn created_calls() -> Vec<(String, String, Value, u128)> {
    use near_sdk::mock::MockAction;
    let mut out = Vec::new();
    for r in near_sdk::test_utils::get_created_receipts() {
        for a in r.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } = a
            {
                out.push((
                    r.receiver_id.to_string(),
                    String::from_utf8(method_name).unwrap(),
                    serde_json::from_slice(&args).unwrap_or(Value::Null),
                    attached_deposit.as_yoctonear(),
                ));
            }
        }
    }
    out
}

#[test]
fn register_on_ref_requires_deposit_and_forwards_it() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.attached_deposit(NearToken::from_millinear(10));
    testing_env!(c.build());
    let _ = v.register_on_ref();
    let calls = created_calls();
    let sd = calls
        .iter()
        .find(|c| c.1 == "storage_deposit")
        .expect("storage_deposit call");
    assert_eq!(sd.0, "ref-finance-101.testnet");
    assert_eq!(sd.3, NearToken::from_millinear(10).as_yoctonear());
    // Full deposit stays on Ref (covers per-token storage); no refund to the vault.
    assert_eq!(sd.2["registration_only"], Value::Bool(false));
    assert_eq!(sd.2["account_id"], "vault.testnet");
    assert!(calls.iter().any(|c| c.1 == "on_register"), "callback attached");
}

#[test]
fn on_register_failure_forwards_deposit_to_owner() {
    let mut v = funded();
    cb_ctx(PromiseResult::Failed, T0);
    v.on_register(U128(10));
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"event\":\"register_failed\""));
    let transfers: Vec<_> = near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .filter(|r| {
            r.actions
                .iter()
                .any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == 10))
        })
        .collect();
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].receiver_id, acct("owner.testnet"));
}

#[test]
fn on_register_success_keeps_deposit_on_ref_and_sends_nothing() {
    let mut v = funded();
    cb_ctx(ok_result(&serde_json::json!({ "total": "10", "available": "0" })), T0);
    v.on_register(U128(10));
    assert!(get_logs().join("\n").contains("\"event\":\"registered_on_ref\""));
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_register_rejects_non_self() {
    let mut v = funded();
    testing_env_with_promise_results(ctx("mallory.testnet", T0).build(), PromiseResult::Failed);
    v.on_register(U128(10));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn register_on_ref_rejects_low_gas() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.attached_deposit(NearToken::from_millinear(10));
    c.prepaid_gas(Gas::from_tgas(59));
    testing_env!(c.build());
    let _ = v.register_on_ref();
}

#[test]
fn register_on_ref_fits_in_exactly_min_gas_in_unit_vm() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.attached_deposit(NearToken::from_millinear(10));
    c.prepaid_gas(MIN_REGISTER_GAS);
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
    pre_read(&mut v, 500);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_recover(1);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(bal(&v, &rft()), 0, "not credited before reconciliation");
    cb_ctx(PromiseResult::Failed, T0);
    v.handle_recover_reconciled(1,Ok(U128(200)));
    assert_eq!(bal(&v, &rft()), 300);
}

/// Recovery hop 1 for recovery id 1: Ref reports `pre` before the withdraw.
fn pre_read(v: &mut YieldVault, pre: u128) {
    cb_ctx(ok_result(&U128(pre)), T0);
    let r = v.handle_recover_pre(1, Ok(U128(pre)));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "withdraw issued");
    assert_eq!(v.recovery.as_ref().unwrap().pre, pre);
}

#[test]
fn recover_from_ref_reads_ref_before_withdrawing() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    let calls = created_calls();
    assert_eq!(calls.len(), 2, "get_deposit then on_recover_pre, no withdraw yet");
    assert_eq!(calls[0].1, "get_deposit");
    assert_eq!(calls[1].1, "on_recover_pre");
}

#[test]
fn recover_refused_when_ref_holds_less_than_amount() {
    // The stranded record (500) is larger than what is really on Ref (200).
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    cb_ctx(ok_result(&U128(200)), T0);
    let r = v.handle_recover_pre(1, Ok(U128(200)));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))), "no withdraw");
    assert!(!v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
    assert_eq!(bal(&v, &rft()), 0);
    assert!(get_logs().join("\n").contains("recover_refused"));
}

#[test]
fn recover_refused_when_pre_read_fails() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_recover_pre(1, Err(PromiseError::Failed));
    assert!(!v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
}

#[test]
fn phantom_stranded_record_cannot_make_failed_withdraw_look_successful() {
    // Record says 500, Ref really holds 300. Recovering 300: Ref's withdraw
    // returns normally but its ft_transfer failed and Ref re-credited, so the
    // deposit is still 300. The old baseline (200 + 300 = 500 > 300) would
    // have credited; the before/after delta (300 - 300 = 0) does not.
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    pre_read(&mut v, 300);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let _ = v.on_recover(1);
    cb_ctx(ok_result(&U128(300)), T0);
    assert_eq!(v.handle_recover_reconciled(1, Ok(U128(300))).0, 0);
    assert_eq!(bal(&v, &rft()), 0, "nothing credited");
    assert_eq!(stranded(&v, &rft()), 500, "record restored");
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn recover_from_ref_rejects_low_gas() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(Gas::from_tgas(MIN_RECOVER_GAS.as_tgas() - 1));
    testing_env!(c.build());
    let _ = v.recover_from_ref(rft(), U128(300));
}

#[test]
fn recover_from_ref_fits_in_exactly_min_gas_in_unit_vm() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_RECOVER_GAS);
    testing_env!(c.build());
    let _ = v.recover_from_ref(rft(), U128(300));
    assert!(v.get_state().recovery_in_flight);
}

#[test]
#[should_panic(expected = "Method is private")]
fn on_recover_pre_rejects_non_self() {
    let mut v = funded();
    at("mallory.testnet", T0);
    let _ = v.handle_recover_pre(1, Ok(U128(0)));
}

#[test]
fn recover_failure_restores_stranded() {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(500));
    assert_eq!(stranded(&v, &rft()), 0);
    pre_read(&mut v, 500);
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_recover(1);
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
    let _ = v.force_release_lock();
}

#[test]
#[should_panic(expected = "ERR_NO_SWAP_IN_FLIGHT")]
fn force_release_without_lock_rejected() {
    let mut v = funded();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.force_release_lock();
}

/// Owner calls `force_release_lock` once the lock is stale; returns the release id.
fn force_release(v: &mut YieldVault) -> u64 {
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(c.build());
    let _ = v.force_release_lock();
    let id = v.release.expect("release pending");
    assert!(v.get_state().release_in_flight);
    assert!(
        v.get_state().swap_in_flight || v.get_state().recovery_in_flight,
        "lock held until the reconcile runs"
    );
    id
}
fn release_cb() {
    cb_ctx(PromiseResult::Successful(vec![]), T0 + STALE_LOCK_NS);
}

#[test]
fn force_release_tokens_never_left_vault_rolls_back_not_strands() {
    // Stuck before ft_transfer_call moved anything: the vault still holds all
    // 10_000 wrap (9_900 tracked + 100 debited), Ref holds none.
    let mut v = funded();
    run(&mut v, proposal(100));
    assert_eq!(bal(&v, &wrap()), 9_900);
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight && !v.get_state().release_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000, "re-credited, not orphaned");
    assert_eq!(stranded(&v, &wrap()), 0, "not double counted as stranded");
    assert_eq!(spent_view(&v, &wrap()), 0, "spend rolled back");
    assert!(get_logs().join("\n").contains("lock_force_released_in_vault"));
}

#[test]
fn force_release_tokens_on_ref_strands_not_credits() {
    // Deposit reached Ref, on_deposit never ran: the vault holds only 9_900.
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_900)), Ok(U128(100)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 9_900, "not credited");
    assert_eq!(stranded(&v, &wrap()), 100, "recoverable from Ref");
    assert_eq!(spent_view(&v, &wrap()), 100);
}

#[test]
fn force_release_both_places_show_it_prefers_ref_record_only_once() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(100)), Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert_eq!(stranded(&v, &wrap()), 100);
    assert!(get_logs().join("\n").contains("lock_force_released_ambiguous"));
}

#[test]
fn force_release_after_swap_ran_on_ref_strands_untracked_token_out() {
    // ft_transfer_call and ref.swap both ran but on_swap never did: token_in
    // is gone, Ref holds 95 rft the vault does not track (10 already stranded).
    let mut v = funded();
    v.stranded.insert(rft(), 10);
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_900)), Ok(U128(0)), Ok(U128(105)));
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert_eq!(stranded(&v, &wrap()), 0, "no phantom token_in record");
    assert_eq!(stranded(&v, &rft()), 105, "10 + the 95 untracked rft");
    assert!(get_logs().join("\n").contains("lock_force_released_swapped"));
}

#[test]
fn force_release_with_failed_reads_strands_unverified() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(
        id,
        Err(PromiseError::Failed),
        Err(PromiseError::Failed),
        Err(PromiseError::Failed),
    );
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert_eq!(unverified(&v, &wrap()), 100);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert!(get_logs().join("\n").contains("lock_force_released_unverified"));
}

#[test]
fn force_release_vault_read_ok_but_ref_read_failed_does_not_roll_back() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Err(PromiseError::Failed), Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_900, "no rollback on a partial picture");
    assert_eq!(unverified(&v, &wrap()), 100);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert!(get_logs().join("\n").contains("lock_force_released_unverified"));
}

#[test]
fn force_release_token_out_read_failed_does_not_roll_back() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(0)), Err(PromiseError::Failed));
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert_eq!(unverified(&v, &wrap()), 100);
    assert_eq!(stranded(&v, &wrap()), 0);
}

#[test]
fn force_release_recovery_ref_read_failed_does_not_credit() {
    let mut v = recovering();
    let rid = force_release(&mut v);
    release_cb();
    v.resolve_release_recovery(rid, Ok(U128(300)), Err(PromiseError::Failed));
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
}

#[test]
fn force_release_token_out_already_in_vault_completes_swap() {
    // on_withdraw_pre never ran but Ref's withdraw delivered 390 rft.
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(390)), Ok(U128(0)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 390);
    assert_eq!(stranded(&v, &rft()), 0);
    assert_eq!(v.get_state().swaps_executed, 1);
}

#[test]
fn force_release_token_out_still_on_ref_strands_it() {
    let mut v = swap_at_withdraw_cb();
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(0)), Ok(U128(390)), Ok(U128(390)));
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 390);
}

#[test]
fn pending_release_blocks_withdraw_refunds_deposits_and_mutes_stuck_callbacks() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    // A deposit now would skew the FT balance read: refunded.
    testing_env!(ctx(wrap().as_str(), T0).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(5), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(5))));
    // A late callback of the stuck swap must not resolve it behind the release.
    cb_ctx(ok_result(&U128(0)), T0 + STALE_LOCK_NS);
    let _ = v.handle_deposit(1, Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert!(v.get_state().swap_in_flight);
    // A stale release callback (superseded id) is ignored.
    release_cb();
    v.resolve_release_swap(id + 100, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(v.get_state().release_in_flight);
}

#[test]
#[should_panic(expected = "ERR_RELEASE_PENDING")]
fn withdraw_refused_while_release_pending() {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    let mut c = ctx1("owner.testnet");
    c.block_timestamp(T0 + STALE_LOCK_NS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(1));
}

#[test]
fn force_release_can_be_retried_and_older_release_is_superseded() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let first = force_release(&mut v);
    let second = force_release(&mut v);
    assert!(second > first);
    release_cb();
    v.resolve_release_swap(first, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(v.get_state().swap_in_flight, "superseded release is a no-op");
    v.resolve_release_swap(second, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn force_release_rejects_low_gas() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let mut c = ctx("owner.testnet", T0 + STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    c.prepaid_gas(Gas::from_tgas(50));
    testing_env!(c.build());
    let _ = v.force_release_lock();
}

#[test]
#[should_panic(expected = "Method is private")]
fn force_release_callbacks_reject_non_self() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    at("mallory.testnet", T0);
    v.on_force_release_swap(id);
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
    let rid = force_release(&mut v); // id 2
    release_cb();
    v.resolve_release_swap(rid, Ok(U128(9_900)), Ok(U128(100)), Ok(U128(0)));
    run_at(&mut v, proposal(200), T0 + STALE_LOCK_NS); // id 3
    cb_ctx(PromiseResult::Failed, T0 + STALE_LOCK_NS);
    let r = v.handle_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(v.handle_deposit_reconciled(1, Ok(U128(0))).0, 0);
    assert!(v.get_state().swap_in_flight);
    assert_eq!(v.in_flight.as_ref().unwrap().id, 3);
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
    let _ = v.handle_deposit(2, Err(PromiseError::Failed));
    v.handle_deposit_reconciled(2, Ok(U128(0)));
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
    let r = v.handle_deposit(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "failed deposit must query Ref");
    assert!(v.get_state().swap_in_flight, "lock held until reconciled");
    v
}
/// Swap id 1 that Ref swapped for 390 rft, awaiting the withdraw callbacks.
fn swap_at_withdraw_cb() -> YieldVault {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let r = v.handle_swap(1, Ok(U128(390)));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "must snapshot Ref before withdrawing");
    // Pre-withdraw snapshot: Ref holds exactly the 390 swapped in.
    cb_ctx(ok_result(&U128(390)), T0);
    let r = v.handle_withdraw_pre(1, Ok(U128(390)));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "must withdraw then re-read Ref");
    assert_eq!(bal(&v, &rft()), 0);
    v
}

#[test]
fn deposit_failed_but_tokens_landed_on_ref_is_stranded_not_rolled_back() {
    let mut v = swap_at_deposit_cb();
    cb_ctx(ok_result(&U128(400)), T0);
    assert_eq!(v.handle_deposit_reconciled(1, Ok(U128(400))).0, 0);
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
    v.handle_deposit_reconciled(1, Ok(U128(399)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert!(v.stranded.is_empty());
}

#[test]
fn deposit_reconcile_uses_amount_in_as_proof_and_stranded_only_to_verify() {
    // 100 wrap already stranded on Ref. 399 (< amount_in 400) proves the 400
    // did not land: rolled back. 499 is ambiguous (the 100 record may
    // overstate Ref), so it is stranded unverified, never credited. 500
    // covers the record plus the 400: stranded as verified.
    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 100);
    v.handle_deposit_reconciled(1, Ok(U128(399)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(stranded(&v, &wrap()), 100);

    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 100);
    v.handle_deposit_reconciled(1, Ok(U128(499)));
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(stranded(&v, &wrap()), 100);
    assert_eq!(unverified(&v, &wrap()), 400);

    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 100);
    v.handle_deposit_reconciled(1, Ok(U128(500)));
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(stranded(&v, &wrap()), 500);
}

#[test]
fn deposit_failed_and_get_deposit_errors_is_stranded_unverified() {
    let mut v = swap_at_deposit_cb();
    cb_ctx(PromiseResult::Failed, T0);
    v.handle_deposit_reconciled(1, Err(PromiseError::Failed));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 400);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert!(get_logs().join("\n").contains("deposit_unverified"));
}

#[test]
fn withdraw_ok_but_ref_deposit_unchanged_is_stranded_not_credited() {
    let mut v = swap_at_withdraw_cb();
    cb_ctx(ok_result(&U128(390)), T0);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(390))).0, 0);
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
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(0))).0, 390);
    assert_eq!(bal(&v, &rft()), 390);
    assert!(v.stranded.is_empty());
    assert_eq!(v.get_state().swaps_executed, 1);
    assert!(!v.get_state().swap_in_flight);
}

#[test]
fn withdraw_partial_drop_from_snapshot_is_stranded_not_credited() {
    // Pre 390, post 1: the deposit fell by 389, less than amount_out 390.
    let mut v = swap_at_withdraw_cb();
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(1))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 390);
}

#[test]
fn withdraw_pre_read_failed_strands_without_withdrawing() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.handle_withdraw_pre(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &rft()), 390);
    assert_eq!(bal(&v, &rft()), 0);
    assert!(get_logs().join("\n").contains("withdraw_pre_unverified"));
}

#[test]
fn withdraw_pre_below_amount_out_is_stranded_unverified() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    cb_ctx(ok_result(&U128(100)), T0);
    let r = v.handle_withdraw_pre(1, Ok(U128(100)));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &rft()), 390);
    assert_eq!(bal(&v, &rft()), 0);
}

#[test]
fn withdraw_reconcile_ignores_stranded_records() {
    // A real 50 rft already stranded: Ref's pre snapshot is 440, a post of 50
    // is a drop of exactly 390 and is credited; the record is untouched.
    let mut v = funded();
    v.stranded.insert(rft(), 50);
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    cb_ctx(ok_result(&U128(440)), T0);
    let _ = v.handle_withdraw_pre(1, Ok(U128(440)));
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(50))).0, 390);
    assert_eq!(bal(&v, &rft()), 390);
    assert_eq!(stranded(&v, &rft()), 50);
}

#[test]
fn withdraw_reconcile_baseline_includes_already_stranded() {
    let mut v = swap_at_withdraw_cb();
    v.stranded.insert(rft(), 50);
    // baseline 50 + 390 = 440: a deposit of 440 means nothing left Ref.
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(440))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 440);
}

// M2: a stranded record that overstates what Ref holds (for example 1_000 rft
// recorded by a `swap_failed` strand whose swap really ran) must not turn a
// silently re-credited withdraw into a credit. The reconcile must compare
// Ref's deposit against this operation's own before-snapshot, not against
// the absolute `stranded` record.
#[test]
fn m2_phantom_stranded_does_not_fake_withdraw_credit() {
    let mut v = swap_at_withdraw_cb();
    v.stranded.insert(rft(), 1_000);
    // Ref re-credited the withdraw: its rft deposit is still the 390 swapped in.
    cb_ctx(ok_result(&U128(390)), T0);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(390))).0, 0);
    assert_eq!(bal(&v, &rft()), 0, "no credit while the tokens sit on Ref");
    assert_eq!(v.get_state().swaps_executed, 0);
    assert!(!v.get_state().swap_in_flight);
}

#[test]
fn m2_phantom_stranded_does_not_fake_deposit_rollback() {
    let mut v = swap_at_deposit_cb();
    v.stranded.insert(wrap(), 1_000);
    // The 400 wrap did land on Ref (deposit 400), but 400 < 1_000 + 400.
    cb_ctx(ok_result(&U128(400)), T0);
    v.handle_deposit_reconciled(1, Ok(U128(400)));
    assert_eq!(bal(&v, &wrap()), 9_600, "no rollback credit while the tokens sit on Ref");
    assert!(!v.get_state().swap_in_flight);
}

#[test]
fn withdraw_ok_and_get_deposit_errors_is_stranded_unverified() {
    let mut v = swap_at_withdraw_cb();
    cb_ctx(PromiseResult::Failed, T0);
    assert_eq!(v.handle_withdraw_reconciled(1, Err(PromiseError::Failed)).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(unverified(&v, &rft()), 390);
    assert_eq!(stranded_view(&v, &rft()), 0);
    assert!(get_logs().join("\n").contains("withdraw_unverified"));
}

#[test]
fn late_reconcile_of_force_released_swap_is_a_noop() {
    let mut v = swap_at_withdraw_cb();
    let rid = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(rid, Ok(U128(0)), Ok(U128(390)), Ok(U128(390)));
    let stranded_before = stranded(&v, &rft());
    cb_ctx(PromiseResult::Failed, T0 + STALE_LOCK_NS);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), stranded_before);
}

#[test]
#[should_panic(expected = "Method is private")]
fn reconcile_callbacks_reject_non_self() {
    let mut v = swap_at_withdraw_cb();
    at("mallory.testnet", T0);
    v.handle_withdraw_reconciled(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn deposit_reconcile_rejects_non_self() {
    let mut v = swap_at_deposit_cb();
    at("mallory.testnet", T0);
    v.handle_deposit_reconciled(1, Ok(U128(0)));
}

#[test]
#[should_panic(expected = "Method is private")]
fn recover_reconcile_rejects_non_self() {
    let mut v = funded();
    at("owner.testnet", T0);
    v.handle_recover_reconciled(1, Ok(U128(0)));
}

fn recovering() -> YieldVault {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    pre_read(&mut v, 500);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let r = v.on_recover(1);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    v
}

#[test]
fn recover_ok_but_ref_deposit_unchanged_is_restranded_not_credited() {
    let mut v = recovering();
    // Ref showed 500 before the withdraw and still shows 500: nothing left Ref.
    cb_ctx(ok_result(&U128(500)), T0);
    assert_eq!(v.handle_recover_reconciled(1,Ok(U128(500))).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 500);
}

#[test]
fn recover_ok_and_ref_deposit_dropped_is_credited() {
    let mut v = recovering();
    cb_ctx(ok_result(&U128(200)), T0);
    assert_eq!(v.handle_recover_reconciled(1,Ok(U128(200))).0, 300);
    assert_eq!(bal(&v, &rft()), 300);
    assert_eq!(stranded(&v, &rft()), 200);
    assert!(get_logs().join("\n").contains("\"event\":\"recovered\""));
}

#[test]
fn recover_ok_and_get_deposit_errors_is_restranded_unverified() {
    let mut v = recovering();
    cb_ctx(PromiseResult::Failed, T0);
    assert_eq!(v.handle_recover_reconciled(1,Err(PromiseError::Failed)).0, 0);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded_view(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
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
    let _ = v.handle_deposit(1, Err(PromiseError::Failed));
    v.handle_deposit_reconciled(1, Ok(U128(0)));
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(10));
    assert_eq!(stranded(&v, &rft()), 490);
}

// ---- recovery lock: a pending recover_from_ref blocks swaps, config and other recoveries

fn recovery_started() -> YieldVault {
    let mut v = funded();
    v.stranded.insert(rft(), 500);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(300));
    assert!(v.get_state().recovery_in_flight);
    v
}

#[test]
fn swap_refused_while_recovery_in_flight() {
    let v = recovery_started();
    let r = v.check_proposal(proposal(100), acct("runner.testnet"));
    assert!(!r.ok && r.reason.starts_with("ERR_SWAP_IN_FLIGHT"), "{}", r.reason);
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn execute_swap_panics_while_recovery_in_flight() {
    let mut v = recovery_started();
    run(&mut v, proposal(100));
}

#[test]
fn recovery_lock_held_until_reconcile_reads_ref() {
    // on_recover succeeded but the get_deposit reconcile has not run yet.
    let v = recovering();
    assert!(v.get_state().recovery_in_flight);
    let r = v.check_proposal(proposal(100), acct("runner.testnet"));
    assert!(!r.ok && r.reason.starts_with("ERR_SWAP_IN_FLIGHT"));
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn second_recovery_refused_while_one_in_flight() {
    let mut v = recovery_started();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(100));
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn update_config_refused_while_recovery_in_flight() {
    let mut v = recovery_started();
    testing_env!(ctx1("owner.testnet").build());
    v.update_config(config());
}

#[test]
fn recovery_lock_released_after_failed_withdraw() {
    let mut v = recovery_started();
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_recover(1);
    assert!(!v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 500);
    assert!(v.check_proposal(proposal(100), acct("runner.testnet")).ok);
}

#[test]
fn recovery_lock_released_after_reconcile() {
    let mut v = recovering();
    cb_ctx(ok_result(&U128(200)), T0);
    assert_eq!(v.handle_recover_reconciled(1, Ok(U128(200))).0, 300);
    assert!(!v.get_state().recovery_in_flight);
    assert!(v.check_proposal(proposal(100), acct("runner.testnet")).ok);
}

#[test]
#[should_panic(expected = "ERR_LOCK_NOT_STALE")]
fn force_release_recovery_too_early_rejected() {
    let mut v = recovery_started();
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.force_release_lock();
}

#[test]
fn force_release_recovery_whose_withdraw_landed_credits_once() {
    // Ref's withdraw delivered the 300 rft to the vault; Ref still holds the
    // other 200 stranded. Credited, not restored to stranded.
    let mut v = recovering();
    let rid = force_release(&mut v);
    release_cb();
    v.resolve_release_recovery(rid, Ok(U128(300)), Ok(U128(200)));
    assert!(!v.get_state().recovery_in_flight);
    assert_eq!(bal(&v, &rft()), 300);
    assert_eq!(stranded(&v, &rft()), 200);
}

#[test]
fn force_release_recovery_with_failed_reads_restores_stranded() {
    let mut v = recovering();
    let rid = force_release(&mut v);
    release_cb();
    v.resolve_release_recovery(rid, Err(PromiseError::Failed), Err(PromiseError::Failed));
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
    assert!(get_logs().join("\n").contains("recovery_force_released_unverified"));
}

#[test]
fn force_release_stale_recovery_restores_stranded_and_late_callbacks_are_noops() {
    let mut v = recovering();
    let rid = force_release(&mut v);
    release_cb();
    v.resolve_release_recovery(rid, Ok(U128(0)), Ok(U128(500)));
    assert!(!v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 500);
    // The late reconcile of the released recovery must not credit or re-strand.
    cb_ctx(ok_result(&U128(200)), T0 + STALE_LOCK_NS);
    assert_eq!(v.handle_recover_reconciled(1, Ok(U128(200))).0, 0);
    let _ = v.on_recover(1);
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()), 500);
}

#[test]
fn recovery_ids_share_the_swap_counter() {
    let mut v = recovery_started();
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_recover(1);
    run(&mut v, proposal(100));
    assert_eq!(v.in_flight.as_ref().map(|f| f.id), Some(2));
}

// ------------------------------------------------------- abort_release / lenient reads

/// Callback context with several raw promise results (a joined `.and` batch).
fn cb_ctx_many(results: Vec<PromiseResult>, ts: u64) {
    testing_env!(
        ctx("vault.testnet", ts).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

#[test]
fn malformed_read_payloads_do_not_panic_and_strand_unverified() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    // Successful but not U128 (empty, wrong shape, not JSON): must not panic.
    cb_ctx_many(
        vec![
            PromiseResult::Successful(vec![]),
            PromiseResult::Successful(b"{\"a\":1}".to_vec()),
            PromiseResult::Successful(b"not json".to_vec()),
        ],
        T0 + STALE_LOCK_NS,
    );
    v.on_force_release_swap(id);
    assert!(!v.get_state().release_in_flight && !v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 100);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert!(get_logs().join("\n").contains("lock_force_released_unverified"));
}

#[test]
fn malformed_read_payloads_do_not_panic_for_recovery() {
    let mut v = recovery_started();
    let id = force_release(&mut v);
    cb_ctx_many(
        vec![
            PromiseResult::Successful(b"\"x\"".to_vec()),
            PromiseResult::Successful(vec![]),
        ],
        T0 + STALE_LOCK_NS,
    );
    v.on_force_release_recovery(id);
    assert!(!v.get_state().release_in_flight && !v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
}

#[test]
fn well_formed_payloads_still_resolve_through_the_callback() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    cb_ctx_many(
        vec![ok_result(&U128(10_000)), ok_result(&U128(0)), ok_result(&U128(0))],
        T0 + STALE_LOCK_NS,
    );
    v.on_force_release_swap(id);
    assert_eq!(bal(&v, &wrap()), 10_000, "rolled back from raw results");
}

fn abort_ctx(pred: &str, ts: u64) {
    let mut c = ctx1(pred);
    c.block_timestamp(ts);
    testing_env!(c.build());
}

#[test]
#[should_panic(expected = "ERR_RELEASE_NOT_STALE")]
fn abort_release_refused_before_window() {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS - 1);
    v.abort_release();
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn abort_release_refused_for_non_owner() {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    abort_ctx("mallory.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
}

#[test]
#[should_panic(expected = "ERR_NO_RELEASE")]
fn abort_release_refused_without_pending_release() {
    let mut v = funded();
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
}

#[test]
fn abort_release_unfreezes_vault_and_owner_can_withdraw() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
    let s = v.get_state();
    assert!(!s.release_in_flight && !s.swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 100, "held amount recorded as unverified");
    assert_eq!(stranded(&v, &wrap()), 0);
    assert_eq!(bal(&v, &wrap()), 9_900);
    let logs = get_logs().join("\n");
    assert!(logs.contains("force_release_aborted") && logs.contains("lock_force_released_unverified"));
    // A late callback of the aborted release is a no-op.
    cb_ctx_many(
        vec![ok_result(&U128(10_000)), ok_result(&U128(0)), ok_result(&U128(0))],
        T0 + STALE_LOCK_NS + RELEASE_ABORT_NS,
    );
    v.on_force_release_swap(id);
    assert_eq!(bal(&v, &wrap()), 9_900);
    assert_eq!(unverified(&v, &wrap()), 100);
    // Owner can withdraw again.
    let mut c = ctx1("owner.testnet");
    c.block_timestamp(T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(9_900));
    assert_eq!(bal(&v, &wrap()), 0);
}

#[test]
fn abort_release_on_recovery_strands_restores_and_unlocks() {
    let mut v = recovery_started();
    force_release(&mut v);
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
    assert!(!v.get_state().release_in_flight && !v.get_state().recovery_in_flight);
    assert_eq!(stranded(&v, &rft()), 200);
    assert_eq!(unverified(&v, &rft()), 300);
}

// ------------------------------------------------- sync_balance (M1)

fn sync_ctx(pred: &str) {
    let mut c = ctx1(pred);
    c.prepaid_gas(MIN_SYNC_GAS);
    testing_env!(c.build());
}
/// Owner starts `sync_balance(token)`; returns the sync id.
fn start_sync(v: &mut YieldVault, token: AccountId) -> u64 {
    sync_ctx("owner.testnet");
    let _ = v.sync_balance(token);
    assert_ne!(v.sync_id, 0);
    v.sync_id
}
fn sync_cb(v: &mut YieldVault, id: u64, token: AccountId, ft: Result<U128, PromiseError>) {
    match &ft {
        Ok(b) => cb_ctx(ok_result(b), T0),
        Err(_) => cb_ctx(PromiseResult::Failed, T0),
    }
    v.handle_sync_balance(id, token, ft);
}
/// `run(proposal(100))`, force release, then abort: 100 wrap is recorded as unverified.
fn aborted_release() -> YieldVault {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
    v
}

#[test]
fn sync_balance_recovers_funds_stranded_by_abort_release() {
    // The vault really holds all 10_000 wrap; abort_release could not tell.
    let mut v = aborted_release();
    assert_eq!((bal(&v, &wrap()), unverified(&v, &wrap())), (9_900, 100));
    let id = start_sync(&mut v, wrap());
    let calls = created_calls();
    assert_eq!(calls[0].1, "ft_balance_of");
    assert_eq!(calls[0].0, "wrap.testnet");
    assert_eq!(calls[1].1, "on_sync_balance");
    sync_cb(&mut v, id, wrap(), Ok(U128(10_000)));
    assert_eq!(bal(&v, &wrap()), 10_000, "vault copy is credited");
    assert_eq!(v.sync_id, 0);
    let logs = get_logs().join("\n");
    assert!(logs.contains("balance_synced") && logs.contains("\"credited\":\"100\""), "{logs}");
}

#[test]
fn sync_balance_credits_ft_transfer_donation() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(10_250)));
    assert_eq!(bal(&v, &wrap()), 10_250);
    // Owner can now withdraw the donation.
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(10_250));
    assert_eq!(bal(&v, &wrap()), 0);
}

#[test]
fn sync_balance_debits_a_phantom_when_ft_balance_is_lower() {
    // Idle vault: tracked must equal the FT balance, so a phantom is healed.
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(3_000)));
    assert_eq!(bal(&v, &wrap()), 3_000);
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"debited\":\"7000\"") && logs.contains("\"credited\":\"0\""), "{logs}");
    // A failed read changes nothing.
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Err(PromiseError::Failed));
    assert_eq!(bal(&v, &wrap()), 3_000);
    assert!(get_logs().join("\n").contains("sync_failed"));
}

#[test]
fn sync_balance_debit_to_zero_removes_the_entry() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 0);
    assert!(v.get_state().balances.iter().all(|(t, _)| t != &wrap()));
}

#[test]
fn stale_sync_callback_after_a_swap_started_is_a_noop() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    run(&mut v, proposal(100)); // debits 100 and clears the pending sync
    sync_cb(&mut v, id, wrap(), Ok(U128(10_000)));
    assert_eq!(bal(&v, &wrap()), 9_900, "stale read must not re-credit the in-flight 100");
    assert!(v.get_state().swap_in_flight);
}

#[test]
fn deposit_is_refunded_while_a_sync_read_is_pending() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    testing_env!(ctx(wrap().as_str(), T0).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(500), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(500))), "refunded in full");
    assert_eq!(bal(&v, &wrap()), 10_000);
    sync_cb(&mut v, id, wrap(), Ok(U128(10_000)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    deposit(&mut v, wrap(), 500); // accepted again once the sync resolved
    assert_eq!(bal(&v, &wrap()), 10_500);
}

#[test]
fn stale_sync_callback_after_a_withdraw_started_is_a_noop() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(500));
    sync_cb(&mut v, id, wrap(), Ok(U128(10_000)));
    assert_eq!(bal(&v, &wrap()), 9_500, "the 500 leaving must not be credited back");
}

#[test]
fn superseded_sync_callback_is_a_noop() {
    let mut v = funded();
    let old = start_sync(&mut v, wrap());
    let new = start_sync(&mut v, wrap());
    assert_ne!(old, new);
    sync_cb(&mut v, old, wrap(), Ok(U128(12_000)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    sync_cb(&mut v, new, wrap(), Ok(U128(12_000)));
    assert_eq!(bal(&v, &wrap()), 12_000);
}

#[test]
fn sync_callback_is_a_noop_while_a_lock_is_held() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    v.recovery = Some(Recovery { id: 99, token_id: rft(), amount: 1, started_at: T0, pre: 0, unv: 0 });
    v.sync_id = id; // as if nothing had cleared it
    sync_cb(&mut v, id, wrap(), Ok(U128(12_000)));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
#[should_panic(expected = "ERR_SYNC_BUSY")]
fn sync_refused_while_swap_in_flight() {
    let mut v = funded();
    run(&mut v, proposal(100));
    sync_ctx("owner.testnet");
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "ERR_SYNC_BUSY")]
fn sync_refused_while_recovery_in_flight() {
    let mut v = recovery_started();
    sync_ctx("owner.testnet");
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "ERR_SYNC_BUSY")]
fn sync_refused_while_release_pending() {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    sync_ctx("owner.testnet");
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "ERR_SYNC_BUSY")]
fn sync_refused_while_owner_withdraw_pending() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(10));
    sync_ctx("owner.testnet");
    let _ = v.sync_balance(wrap());
}

#[test]
fn sync_allowed_again_after_owner_withdraw_callback() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(10));
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    v.on_owner_withdraw(wrap(), U128(10));
    start_sync(&mut v, wrap());
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn sync_refused_for_non_owner() {
    let mut v = funded();
    sync_ctx("mallory.testnet");
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn sync_requires_one_yocto() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.prepaid_gas(MIN_SYNC_GAS);
    testing_env!(c.build());
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn sync_requires_min_gas() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(Gas::from_tgas(20));
    testing_env!(c.build());
    let _ = v.sync_balance(wrap());
}

#[test]
#[should_panic(expected = "Method is private")]
fn sync_callback_rejects_non_self() {
    let mut v = funded();
    at("mallory.testnet", T0);
    v.handle_sync_balance(1, wrap(), Ok(U128(5)));
}

#[test]
fn sync_balance_fits_in_exactly_min_gas_in_unit_vm() {
    let mut v = funded();
    start_sync(&mut v, wrap());
}

// ------------------------------------- unverified strands (M2)

#[test]
fn phantom_unverified_record_does_not_cause_a_false_credit() {
    // 1. A swap's reconcile read fails: 390 rft is recorded as unverified. Say
    //    it never existed on Ref (phantom).
    let mut v = swap_at_withdraw_cb();
    cb_ctx(PromiseResult::Failed, T0);
    v.handle_withdraw_reconciled(1, Err(PromiseError::Failed));
    assert_eq!((unverified(&v, &rft()), stranded(&v, &rft())), (390, 0));
    // 2. A second swap yields 390 rft, but Ref's withdraw was silently
    //    re-credited, so Ref's deposit is still 390 (no phantom on top).
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(2, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(2, Ok(U128(390)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_withdraw_pre(2, Ok(U128(390)));
    // Old baseline (stranded 390 + 390 = 780) made deposit 390 look like a success.
    assert_eq!(v.handle_withdraw_reconciled(2, Ok(U128(390))).0, 0);
    assert_eq!(bal(&v, &rft()), 0, "no false credit");
    assert_eq!(stranded(&v, &rft()), 390, "the real 390 is stranded, recoverable");
    assert_eq!(unverified(&v, &rft()), 390);
    assert_eq!(v.get_state().swaps_executed, 0);
}

#[test]
fn unverified_record_does_not_raise_the_deposit_reconcile_baseline() {
    // Unverified wrap must not raise the baseline of a later deposit reconcile.
    let mut v = funded();
    v.unverified.insert(wrap(), 1_000);
    run(&mut v, proposal(400));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_deposit(1, Err(PromiseError::Failed));
    cb_ctx(ok_result(&U128(1_000)), T0);
    v.handle_deposit_reconciled(1, Ok(U128(1_000)));
    // Ref's 1_000 is the unverified record, not this deposit: baseline is 400,
    // 1_000 >= 400 reads as landed, so it is stranded (fail-safe), not rolled back.
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(stranded(&v, &wrap()), 400);
}

#[test]
fn recover_from_ref_takes_verified_strand_first_then_unverified() {
    let mut v = funded();
    v.stranded.insert(rft(), 100);
    v.unverified.insert(rft(), 300);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(250));
    assert_eq!((stranded(&v, &rft()), unverified(&v, &rft())), (0, 150));
    assert_eq!(v.recovery.as_ref().unwrap().unv, 150);
    pre_read(&mut v, 250);
    cb_ctx(PromiseResult::Successful(vec![]), T0);
    let _ = v.on_recover(1);
    cb_ctx(ok_result(&U128(0)), T0);
    assert_eq!(v.handle_recover_reconciled(1, Ok(U128(0))).0, 250);
    assert_eq!(bal(&v, &rft()), 250);
    assert_eq!((stranded(&v, &rft()), unverified(&v, &rft())), (0, 150));
}

#[test]
fn failed_recovery_returns_each_part_to_its_own_map() {
    let mut v = funded();
    v.stranded.insert(rft(), 100);
    v.unverified.insert(rft(), 300);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(250));
    pre_read(&mut v, 250);
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.on_recover(1);
    assert_eq!((stranded(&v, &rft()), unverified(&v, &rft())), (100, 300));
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_STRANDED")]
fn recover_from_ref_cannot_exceed_stranded_plus_unverified() {
    let mut v = funded();
    v.stranded.insert(rft(), 100);
    v.unverified.insert(rft(), 300);
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(401));
}

#[test]
fn state_view_lists_unverified_separately() {
    let v = aborted_release();
    let s = v.get_state();
    assert_eq!(s.unverified_on_ref, vec![(wrap(), U128(100))]);
    assert!(s.stranded_on_ref.is_empty());
}

// ------------------------------- abort_release then a new swap (P3)

#[test]
fn abort_release_then_new_swap_then_late_old_callbacks_are_noops() {
    let mut v = funded();
    run(&mut v, proposal(100)); // swap id 1
    let release_id = force_release(&mut v); // id 2
    abort_ctx("owner.testnet", T0 + STALE_LOCK_NS + RELEASE_ABORT_NS);
    v.abort_release();
    let t = T0 + STALE_LOCK_NS + RELEASE_ABORT_NS;
    run_at(&mut v, proposal(50), t); // new swap, id 3
    assert_eq!(v.in_flight.as_ref().unwrap().id, 3);
    let snapshot = (v.balances.clone(), v.stranded.clone(), v.unverified.clone());
    // Late callbacks of the old release and the old swap.
    cb_ctx_many(
        vec![ok_result(&U128(10_000)), ok_result(&U128(0)), ok_result(&U128(0))],
        t,
    );
    v.on_force_release_swap(release_id);
    cb_ctx(ok_result(&U128(100)), t);
    let _ = v.handle_deposit(1, Ok(U128(100)));
    cb_ctx(ok_result(&U128(90)), t);
    let _ = v.handle_swap(1, Ok(U128(90)));
    cb_ctx(ok_result(&U128(90)), t);
    let _ = v.handle_withdraw_pre(1, Ok(U128(90)));
    cb_ctx(ok_result(&U128(0)), t);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    cb_ctx(PromiseResult::Failed, t);
    assert_eq!(v.handle_deposit_reconciled(1, Err(PromiseError::Failed)).0, 0);
    assert_eq!(snapshot, (v.balances.clone(), v.stranded.clone(), v.unverified.clone()));
    let fl = v.in_flight.as_ref().expect("new swap untouched");
    assert_eq!((fl.id, fl.amount_in, fl.amount_out), (3, 50, 0));
    assert_eq!(v.get_state().swaps_executed, 0);
}

// ------------------------------------------- owner force release, end to end

/// A swap stuck after `on_swap` recorded 390 rft (its `on_withdraw_pre` never
/// ran). The owner forces the lock release; the real `on_force_release_swap`
/// callback parses the three raw reads; the lock clears; late callbacks of
/// the stuck swap are no-ops; the vault works again.
#[test]
fn owner_force_release_lock_end_to_end_swap() {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(1, Ok(U128(390)));
    assert_eq!(v.in_flight.as_ref().unwrap().amount_out, 390);

    // Owner, 1 yocto, after STALE_LOCK_NS: the release starts and holds the lock.
    let t = T0 + STALE_LOCK_NS;
    let release_id = force_release(&mut v);
    assert!(get_logs().join("\n").contains("\"event\":\"force_release_started\""));
    assert!(v.get_state().swap_in_flight);

    // While the release is pending, owner deposits are refunded.
    testing_env!(ctx(wrap().as_str(), t).build());
    let r = v.ft_on_transfer(acct("owner.testnet"), U128(5), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(5))), "deposit refunded during release");
    assert_eq!(bal(&v, &wrap()), 9_600);

    // Reads: vault ft_balance_of(rft) = 0, Ref get_deposit(rft) = 390 (held),
    // Ref get_deposit(token_out = rft) = 390.
    cb_ctx_many(
        vec![ok_result(&U128(0)), ok_result(&U128(390)), ok_result(&U128(390))],
        t,
    );
    v.on_force_release_swap(release_id);
    let s = v.get_state();
    assert!(!s.swap_in_flight && !s.release_in_flight, "lock and release cleared");
    assert_eq!(stranded(&v, &rft()), 390, "token_out recorded on Ref, recoverable");
    assert_eq!(bal(&v, &rft()), 0, "not credited while on Ref");
    assert_eq!(bal(&v, &wrap()), 9_600, "token_in not rolled back: it was swapped");
    assert!(get_logs().join("\n").contains("lock_force_released"));

    // Late callbacks of the stuck swap change nothing.
    let snapshot = (v.balances.clone(), v.stranded.clone(), v.unverified.clone());
    cb_ctx(ok_result(&U128(390)), t);
    assert!(matches!(v.handle_withdraw_pre(1, Ok(U128(390))), PromiseOrValue::Value(U128(0))));
    cb_ctx(ok_result(&U128(0)), t);
    assert_eq!(v.handle_withdraw_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(snapshot, (v.balances.clone(), v.stranded.clone(), v.unverified.clone()));

    // The vault accepts a new swap.
    run_at(&mut v, proposal(100), t);
    assert!(v.get_state().swap_in_flight);
    assert_eq!(v.in_flight.as_ref().unwrap().id, release_id + 1);
}

#[test]
#[should_panic(expected = "ERR_RELEASE_PENDING")]
fn owner_withdraw_refused_while_force_release_pending() {
    let mut v = funded();
    run(&mut v, proposal(400));
    let _ = force_release(&mut v);
    let mut c = ctx1("owner.testnet");
    c.block_timestamp(T0 + STALE_LOCK_NS).prepaid_gas(MIN_WITHDRAW_GAS);
    testing_env!(c.build());
    let _ = v.withdraw(wrap(), U128(1));
}

#[test]
#[should_panic(expected = "ERR_NO_SWAP_IN_FLIGHT")]
fn owner_force_release_after_completed_release_has_nothing_to_release() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    cb_ctx_many(
        vec![ok_result(&U128(10_000)), ok_result(&U128(0)), ok_result(&U128(0))],
        T0 + STALE_LOCK_NS,
    );
    v.on_force_release_swap(id);
    assert_eq!(bal(&v, &wrap()), 10_000, "never left the vault: rolled back");
    let _ = force_release(&mut v);
}

// ------------------------------------------------- NEAR and Ref storage out

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn near_ctx(pred: &str, balance: u128) {
    let mut c = ctx1(pred);
    c.account_balance(NearToken::from_yoctonear(balance))
        .prepaid_gas(MIN_STORAGE_WITHDRAW_GAS);
    testing_env!(c.build());
}

#[test]
fn withdraw_near_sends_free_balance_to_owner() {
    let mut v = funded();
    near_ctx("owner.testnet", 5 * ONE_NEAR);
    let free = v.get_withdrawable_near().0;
    let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
    // The unit VM counts the attached 1 yocto in the account balance.
    assert_eq!(free, 5 * ONE_NEAR + 1 - storage - NEAR_STORAGE_RESERVE);
    let _ = v.withdraw_near(U128(free));
    assert!(get_logs().join("\n").contains("\"event\":\"near_withdrawn\""));
    assert_eq!(bal(&v, &wrap()), 10_000, "token accounting untouched");
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_NEAR")]
fn withdraw_near_cannot_dip_into_storage_or_reserve() {
    let mut v = funded();
    near_ctx("owner.testnet", 5 * ONE_NEAR);
    let free = v.get_withdrawable_near().0;
    let _ = v.withdraw_near(U128(free + 1));
}

#[test]
fn withdrawable_near_is_zero_when_balance_below_storage() {
    let v = funded();
    near_ctx("owner.testnet", 1);
    assert_eq!(v.get_withdrawable_near().0, 0);
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn withdraw_near_rejects_non_owner() {
    let mut v = funded();
    near_ctx("mallory.testnet", 5 * ONE_NEAR);
    let _ = v.withdraw_near(U128(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_near_requires_one_yocto() {
    let mut v = funded();
    let mut c = ctx("owner.testnet", T0);
    c.account_balance(NearToken::from_yoctonear(5 * ONE_NEAR));
    testing_env!(c.build());
    let _ = v.withdraw_near(U128(1));
}

#[test]
#[should_panic(expected = "ERR_ZERO_AMOUNT")]
fn withdraw_near_rejects_zero() {
    let mut v = funded();
    near_ctx("owner.testnet", 5 * ONE_NEAR);
    let _ = v.withdraw_near(U128(0));
}

#[test]
fn withdraw_ref_storage_calls_ref_storage_withdraw() {
    let mut v = funded();
    near_ctx("owner.testnet", 5 * ONE_NEAR);
    let _ = v.withdraw_ref_storage(None);
    assert!(get_logs().join("\n").contains("\"event\":\"ref_storage_withdraw\""));
}

#[test]
#[should_panic(expected = "ERR_NOT_OWNER")]
fn withdraw_ref_storage_rejects_non_owner() {
    let mut v = funded();
    near_ctx("mallory.testnet", 5 * ONE_NEAR);
    let _ = v.withdraw_ref_storage(None);
}

#[test]
#[should_panic(expected = "ERR_INSUFFICIENT_GAS")]
fn withdraw_ref_storage_rejects_low_gas() {
    let mut v = funded();
    let mut c = ctx1("owner.testnet");
    c.prepaid_gas(Gas::from_tgas(39));
    testing_env!(c.build());
    let _ = v.withdraw_ref_storage(Some(U128(1)));
}

// ------------------------------------------- malformed callback payloads
//
// A reply that is not a valid U128 (wrong type, not JSON, empty, negative) is
// handled exactly like a failed promise in every chain callback: no panic, the
// lock is released (or the chain continues to its reconcile read), and nothing
// is ever credited. These drive the exported callbacks, which read the raw
// bytes, so they would panic inside near-sdk's typed decoding if it were used.

fn malformed_payloads() -> Vec<Vec<u8>> {
    vec![
        b"\"not-a-number\"".to_vec(),
        b"<html>502 bad gateway</html>".to_vec(),
        b"{}".to_vec(),
        b"-5".to_vec(),
        b"\"-5\"".to_vec(),
        b"null".to_vec(),
        vec![],
    ]
}
fn malformed(bytes: &[u8]) -> PromiseResult {
    PromiseResult::Successful(bytes.to_vec())
}

#[test]
fn malformed_deposit_reply_queries_ref_like_a_failed_one() {
    for bytes in malformed_payloads() {
        let mut v = funded();
        run(&mut v, proposal(400));
        cb_ctx(malformed(&bytes), T0);
        let r = v.on_deposit(1);
        assert!(matches!(r, PromiseOrValue::Promise(_)), "{bytes:?}");
        drop(r); // promises are scheduled on drop
        let calls = created_calls();
        assert_eq!(calls[0].1, "get_deposit", "{bytes:?}");
        assert_eq!(calls[1].1, "on_deposit_reconciled", "{bytes:?}");
        assert!(v.get_state().swap_in_flight, "lock held until reconciled");
        assert_eq!(bal(&v, &wrap()), 9_600, "still debited, not credited");
        assert!(v.stranded.is_empty() && v.unverified.is_empty());
    }
}

#[test]
fn malformed_deposit_reconcile_reply_is_stranded_unverified() {
    for bytes in malformed_payloads() {
        let mut v = swap_at_deposit_cb();
        cb_ctx(malformed(&bytes), T0);
        assert_eq!(v.on_deposit_reconciled(1).0, 0);
        assert!(!v.get_state().swap_in_flight, "{bytes:?}");
        assert_eq!(unverified(&v, &wrap()), 400);
        assert_eq!(stranded(&v, &wrap()), 0);
        assert_eq!(bal(&v, &wrap()), 9_600);
        assert!(get_logs().join("\n").contains("deposit_unverified"));
    }
}

#[test]
fn malformed_swap_reply_starts_the_token_in_refund() {
    for bytes in malformed_payloads() {
        let mut v = funded();
        run(&mut v, proposal(400));
        cb_ctx(ok_result(&U128(400)), T0);
        let _ = v.handle_deposit(1, Ok(U128(400)));
        cb_ctx(malformed(&bytes), T0);
        let r = v.on_swap(1);
        assert!(matches!(r, PromiseOrValue::Promise(_)), "{bytes:?}");
        drop(r);
        assert_eq!(created_calls().last().unwrap().1, "on_refund_pre", "{bytes:?}");
        assert!(v.get_state().swap_in_flight, "{bytes:?}");
        assert!(v.stranded.is_empty() && v.unverified.is_empty(), "{bytes:?}");
        assert_eq!(bal(&v, &wrap()), 9_600);
        assert_eq!(bal(&v, &rft()), 0);
    }
}

#[test]
fn malformed_withdraw_pre_reply_strands_token_out_without_withdrawing() {
    for bytes in malformed_payloads() {
        let mut v = funded();
        run(&mut v, proposal(400));
        cb_ctx(ok_result(&U128(400)), T0);
        let _ = v.handle_deposit(1, Ok(U128(400)));
        cb_ctx(ok_result(&U128(390)), T0);
        let _ = v.handle_swap(1, Ok(U128(390)));
        cb_ctx(malformed(&bytes), T0);
        let r = v.on_withdraw_pre(1);
        assert!(matches!(r, PromiseOrValue::Value(U128(0))), "{bytes:?}");
        assert!(!v.get_state().swap_in_flight);
        assert_eq!(stranded(&v, &rft()), 390);
        assert_eq!(unverified(&v, &rft()), 0);
        assert_eq!(bal(&v, &rft()), 0);
        assert!(get_logs().join("\n").contains("withdraw_pre_unverified"));
    }
}

#[test]
fn malformed_withdraw_reconcile_reply_is_unverified_and_never_credited() {
    for bytes in malformed_payloads() {
        let mut v = swap_at_withdraw_cb();
        cb_ctx(malformed(&bytes), T0);
        assert_eq!(v.on_withdraw_reconciled(1).0, 0);
        assert!(!v.get_state().swap_in_flight, "{bytes:?}");
        assert_eq!(unverified(&v, &rft()), 390);
        assert_eq!(stranded(&v, &rft()), 0);
        assert_eq!(bal(&v, &rft()), 0, "never credited on a malformed read");
        assert_eq!(v.get_state().swaps_executed, 0);
        let logs = get_logs().join("\n");
        assert!(logs.contains("withdraw_unverified"));
        assert!(!logs.contains("swap_executed"));
    }
}

#[test]
fn malformed_recover_pre_reply_refuses_and_marks_unverified() {
    for bytes in malformed_payloads() {
        let mut v = recovery_started();
        cb_ctx(malformed(&bytes), T0);
        let r = v.on_recover_pre(1);
        assert!(matches!(r, PromiseOrValue::Value(U128(0))), "no withdraw {bytes:?}");
        assert!(!v.get_state().recovery_in_flight);
        assert_eq!(stranded(&v, &rft()), 200);
        assert_eq!(unverified(&v, &rft()), 300);
        assert_eq!(bal(&v, &rft()), 0);
        let logs = get_logs().join("\n");
        assert!(logs.contains("recover_refused") && !logs.contains("\"event\":\"recovered\""));
    }
}

#[test]
fn malformed_recover_reconcile_reply_restores_record_as_unverified() {
    for bytes in malformed_payloads() {
        let mut v = recovery_started();
        pre_read(&mut v, 500);
        cb_ctx(PromiseResult::Successful(vec![]), T0);
        let _ = v.on_recover(1);
        cb_ctx(malformed(&bytes), T0);
        assert_eq!(v.on_recover_reconciled(1).0, 0);
        assert!(!v.get_state().recovery_in_flight, "{bytes:?}");
        assert_eq!(stranded(&v, &rft()), 200);
        assert_eq!(unverified(&v, &rft()), 300);
        assert_eq!(bal(&v, &rft()), 0, "never credited");
        assert!(get_logs().join("\n").contains("withdraw_unverified"));
    }
}

#[test]
fn malformed_sync_balance_reply_is_a_failed_sync() {
    for bytes in malformed_payloads() {
        let mut v = funded();
        let id = start_sync(&mut v, wrap());
        cb_ctx(malformed(&bytes), T0);
        v.on_sync_balance(id, wrap());
        assert_eq!(bal(&v, &wrap()), 10_000, "{bytes:?}");
        assert_eq!(v.sync_id, 0);
        assert!(get_logs().join("\n").contains("sync_failed"));
    }
}

#[test]
fn well_formed_replies_still_drive_the_exported_callbacks() {
    // Happy path through the raw-reading callbacks (not the typed test seam).
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    assert!(matches!(v.on_deposit(1), PromiseOrValue::Promise(_)));
    cb_ctx(ok_result(&U128(390)), T0);
    assert!(matches!(v.on_swap(1), PromiseOrValue::Promise(_)));
    cb_ctx(ok_result(&U128(390)), T0);
    assert!(matches!(v.on_withdraw_pre(1), PromiseOrValue::Promise(_)));
    cb_ctx(ok_result(&U128(0)), T0);
    assert_eq!(v.on_withdraw_reconciled(1).0, 390);
    assert_eq!(bal(&v, &rft()), 390);
    assert_eq!(v.get_state().swaps_executed, 1);
}

// --------------------------------- transient refundable transfers (Codex, L-1)

/// A third party's `ft_transfer_call` reaches `ft_on_transfer` while a sync
/// read is pending; returns the refund.
fn foreign_transfer(v: &mut YieldVault, token: AccountId, sender: &str, amount: u128) -> u128 {
    testing_env!(ctx(token.as_str(), T0).build());
    match v.ft_on_transfer(acct(sender), U128(amount), String::new()) {
        PromiseOrValue::Value(r) => r.0,
        _ => panic!("ft_on_transfer returns a value"),
    }
}

#[test]
fn transient_refundable_transfer_during_sync_is_not_credited() {
    // Codex example: tracked 10_000, a refundable 500 is visible to the read.
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    assert_eq!(foreign_transfer(&mut v, wrap(), "mallory.testnet", 500), 500, "refunded");
    assert_eq!(v.sync_id, 0, "the pending sync is invalidated");
    assert!(get_logs().join("\n").contains("sync_invalidated"));
    sync_cb(&mut v, id, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_000, "the transient 500 must not be credited");
    assert!(!get_logs().join("\n").contains("balance_synced"), "callback is a no-op");
}

#[test]
fn any_token_transfer_during_sync_invalidates_it() {
    // The read is of `wrap`, the transient is of an unknown token: still a
    // conservative invalidation (the sync may be of any token).
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    let unknown = acct("junk.testnet");
    assert_eq!(foreign_transfer(&mut v, unknown, "mallory.testnet", 7), 7);
    assert_eq!(v.sync_id, 0);
    sync_cb(&mut v, id, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn owner_deposit_during_sync_is_refunded_and_invalidates_it() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    assert_eq!(foreign_transfer(&mut v, wrap(), "owner.testnet", 500), 500);
    sync_cb(&mut v, id, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_000, "refunded deposit is not also credited by the sync");
}

#[test]
fn undisturbed_sync_still_credits_a_real_donation() {
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_500);
    assert!(get_logs().join("\n").contains("\"credited\":\"500\""));
}

#[test]
fn transfer_without_a_pending_sync_emits_no_invalidation() {
    let mut v = funded();
    assert_eq!(foreign_transfer(&mut v, wrap(), "mallory.testnet", 500), 500);
    assert!(!get_logs().join("\n").contains("sync_invalidated"));
    deposit(&mut v, wrap(), 500);
    assert_eq!(bal(&v, &wrap()), 10_500);
    assert!(!get_logs().join("\n").contains("sync_invalidated"));
}

#[test]
fn fresh_sync_after_an_invalidated_one_works() {
    let mut v = funded();
    let old = start_sync(&mut v, wrap());
    foreign_transfer(&mut v, wrap(), "mallory.testnet", 500);
    sync_cb(&mut v, old, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    // The refund has settled; a real donation of 250 is now the only excess.
    let new = start_sync(&mut v, wrap());
    assert_ne!(old, new);
    sync_cb(&mut v, new, wrap(), Ok(U128(10_250)));
    assert_eq!(bal(&v, &wrap()), 10_250);
}

#[test]
fn residual_phantom_from_a_starved_receiver_is_healed_by_the_next_sync() {
    // If ft_on_transfer is starved of gas its invalidation is reverted and the
    // sync credits the transient 500. The token then refunds it; the next
    // quiet sync debits the phantom.
    let mut v = funded();
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(10_500)));
    assert_eq!(bal(&v, &wrap()), 10_500, "phantom (residual, documented)");
    let id = start_sync(&mut v, wrap());
    sync_cb(&mut v, id, wrap(), Ok(U128(10_000)));
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn transient_transfer_during_release_taints_swap_rollback() {
    // Without the taint, ft = 10_000 (9_900 tracked + 100) would roll back.
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    assert_eq!(foreign_transfer(&mut v, wrap(), "mallory.testnet", 100), 100, "refunded");
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight && !v.get_state().release_in_flight);
    assert_eq!(bal(&v, &wrap()), 9_900, "no rollback on a tainted read");
    assert_eq!(unverified(&v, &wrap()), 100, "booked once, as unverified");
    assert_eq!(stranded(&v, &wrap()), 0);
    assert!(get_logs().join("\n").contains("lock_force_released_unverified"));
}

#[test]
fn transient_transfer_during_release_taints_token_out_credit() {
    // Held token_out: an untainted ft read would credit the swap.
    let mut v = funded();
    run(&mut v, proposal(100));
    v.in_flight.as_mut().unwrap().amount_out = 390;
    let id = force_release(&mut v);
    foreign_transfer(&mut v, rft(), "mallory.testnet", 390);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(390)), Ok(U128(0)), Ok(U128(0)));
    assert_eq!(bal(&v, &rft()), 0, "no credit on a tainted read");
    assert_eq!(unverified(&v, &rft()), 390);
    assert_eq!(v.get_state().swaps_executed, 0);
}

#[test]
fn transient_transfer_during_release_taints_recovery_credit() {
    let mut v = recovering();
    let rid = force_release(&mut v);
    foreign_transfer(&mut v, rft(), "mallory.testnet", 300);
    release_cb();
    v.resolve_release_recovery(rid, Ok(U128(300)), Ok(U128(0)));
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(stranded(&v, &rft()) + unverified(&v, &rft()), 500, "record restored, nothing lost");
    assert_eq!(unverified(&v, &rft()), 300);
}

#[test]
fn taint_does_not_leak_into_the_next_release() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    foreign_transfer(&mut v, wrap(), "mallory.testnet", 100);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_900);
    // A new swap, released cleanly, rolls back normally.
    run_at(&mut v, proposal(100), T0 + 2 * STALE_LOCK_NS);
    let mut c = ctx("owner.testnet", T0 + 4 * STALE_LOCK_NS);
    c.attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(c.build());
    let _ = v.force_release_lock();
    let id = v.release.unwrap();
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_900)), Ok(U128(0)), Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_900, "clean read rolls back the second 100");
}

#[test]
fn superseded_release_callback_does_not_clear_the_taint() {
    let mut v = funded();
    run(&mut v, proposal(100));
    let first = force_release(&mut v);
    foreign_transfer(&mut v, wrap(), "mallory.testnet", 100);
    release_cb();
    v.resolve_release_swap(first + 100, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0))); // stale id
    assert!(v.release_tainted, "a stale callback must not consume the taint");
}

// ------------------------------------------- withdraw_ref_storage locks (L-6)

fn ref_storage_call(v: &mut YieldVault) {
    near_ctx("owner.testnet", 5 * ONE_NEAR);
    let _ = v.withdraw_ref_storage(None);
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn withdraw_ref_storage_refused_during_swap() {
    let mut v = funded();
    run(&mut v, proposal(100));
    ref_storage_call(&mut v);
}

#[test]
#[should_panic(expected = "ERR_SWAP_IN_FLIGHT")]
fn withdraw_ref_storage_refused_during_recovery() {
    let mut v = recovery_started();
    ref_storage_call(&mut v);
}

#[test]
#[should_panic(expected = "ERR_RELEASE_PENDING")]
fn withdraw_ref_storage_refused_during_release() {
    let mut v = funded();
    run(&mut v, proposal(100));
    force_release(&mut v);
    ref_storage_call(&mut v);
}

#[test]
fn withdraw_ref_storage_allowed_again_after_the_lock_clears() {
    let mut v = funded();
    run(&mut v, proposal(100));
    v.in_flight = None;
    ref_storage_call(&mut v);
    assert_eq!(created_calls()[0].1, "storage_withdraw");
}

// --------------------------------- L-3: untracked token_out behind a phantom record

#[test]
fn release_swap_ran_behind_phantom_stranded_names_the_untracked_ref_balance() {
    // Phantom stranded[rft] = 150 >= Ref's real 100 rft from the swap that ran.
    // No new record is possible (extra == 0), so the owner is told explicitly.
    let mut v = funded();
    v.stranded.insert(rft(), 150);
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_900)), Ok(U128(0)), Ok(U128(100)));
    assert!(!v.get_state().swap_in_flight && !v.get_state().release_in_flight);
    assert_eq!(unverified(&v, &wrap()), 100, "token_in was consumed, stays unverified");
    assert_eq!(stranded(&v, &rft()), 150, "record unchanged, not double counted");
    let logs = get_logs().join("\n");
    assert!(
        logs.contains("\"event\":\"ref_balance_untracked\"")
            && logs.contains("\"token_id\":\"rft.tokenfactory.testnet\"")
            && logs.contains("\"ref_deposit\":\"100\"")
            && logs.contains("\"stranded\":\"150\""),
        "{logs}"
    );
    // The phantom record still lets the owner pull the real 100 rft.
    testing_env!(ctx1("owner.testnet").build());
    let _ = v.recover_from_ref(rft(), U128(100));
    assert!(v.get_state().recovery_in_flight);
    let rid = v.recovery.as_ref().unwrap().id;
    cb_ctx(ok_result(&U128(100)), T0 + STALE_LOCK_NS);
    let _ = v.handle_recover_pre(rid, Ok(U128(100)));
    cb_ctx(PromiseResult::Successful(vec![]), T0 + STALE_LOCK_NS);
    let _ = v.on_recover(rid);
    cb_ctx(ok_result(&U128(0)), T0 + STALE_LOCK_NS);
    assert_eq!(v.handle_recover_reconciled(rid, Ok(U128(0))).0, 100);
    assert_eq!(bal(&v, &rft()), 100, "the real tokens are recovered");
    assert_eq!(stranded(&v, &rft()), 50);
}

#[test]
fn release_swap_that_never_ran_emits_no_untracked_event() {
    let mut v = funded();
    v.stranded.insert(rft(), 150);
    run(&mut v, proposal(100));
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_900)), Ok(U128(0)), Ok(U128(0)));
    assert!(!get_logs().join("\n").contains("ref_balance_untracked"));
    assert_eq!(unverified(&v, &wrap()), 100);
}

// ------------------------------------------------- L-5: spend vs strand/rollback

#[test]
fn strand_keeps_spend_counted_and_rollback_restores_it() {
    // Pins current behavior: a stranded swap keeps its amount in today's spend
    // (the funds sit on Ref, recoverable only by the owner); a rolled-back swap
    // gives the spend back (the tokens never left).
    let mut v = funded();
    run(&mut v, proposal(400));
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(id, Ok(U128(400)));
    fail_swap_then_refund_not_reconciled(&mut v, id, 400);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(spent_view(&v, &wrap()), 400, "strand keeps the spend");

    run(&mut v, proposal(300));
    assert_eq!(spent_view(&v, &wrap()), 700);
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(0)), T0);
    let _ = v.handle_deposit(id, Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(spent_view(&v, &wrap()), 400, "rollback restores only its own, same-day spend");
}

// -------------------------------------------- L-4: auto-pause after repeated strands

/// `ref.swap` failed (deposit already accepted), the refund withdraw ran, but
/// Ref's deposit did not drop: token_in is stranded (verified) on Ref.
fn fail_swap_then_refund_not_reconciled(v: &mut YieldVault, id: u64, amount: u128) {
    // Ref holds earlier strands plus this deposit.
    let pre = v.stranded_of(&v.in_flight.as_ref().unwrap().token_in) + amount;
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.handle_swap(id, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    cb_ctx(ok_result(&U128(pre)), T0);
    let r = v.handle_refund_pre(id, Ok(U128(pre)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    cb_ctx(ok_result(&U128(pre)), T0);
    v.handle_refund_reconciled(id, Ok(U128(pre)));
    assert!(!v.get_state().swap_in_flight);
}
/// `ref.swap` failed and the refund verifiably landed back in the vault.
fn fail_swap_then_refund_verified(v: &mut YieldVault, id: u64, amount: u128) {
    let held = v.stranded_of(&v.in_flight.as_ref().unwrap().token_in);
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_swap(id, Err(PromiseError::Failed));
    cb_ctx(ok_result(&U128(held + amount)), T0);
    let _ = v.handle_refund_pre(id, Ok(U128(held + amount)));
    cb_ctx(ok_result(&U128(held)), T0);
    v.handle_refund_reconciled(id, Ok(U128(held)));
    assert!(!v.get_state().swap_in_flight);
}
/// One swap that ends in a strand (`ref.swap` failed, refund not reconciled).
fn strand_swap(v: &mut YieldVault) {
    run(v, proposal(100));
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(100)), T0);
    let _ = v.handle_deposit(id, Ok(U128(100)));
    fail_swap_then_refund_not_reconciled(v, id, 100);
}
/// One swap whose `ref.swap` failed and whose token_in came back (verified).
fn refund_swap(v: &mut YieldVault) {
    run(v, proposal(100));
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(100)), T0);
    let _ = v.handle_deposit(id, Ok(U128(100)));
    fail_swap_then_refund_verified(v, id, 100);
}
/// One swap that completes (390 rft credited).
fn good_swap(v: &mut YieldVault) {
    run(v, proposal(100));
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(100)), T0);
    let _ = v.handle_deposit(id, Ok(U128(100)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(id, Ok(U128(390)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_withdraw_pre(id, Ok(U128(390)));
    cb_ctx(ok_result(&U128(0)), T0);
    v.handle_withdraw_reconciled(id, Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
}
fn unpause(v: &mut YieldVault) {
    testing_env!(ctx1("owner.testnet").build());
    v.unpause();
}

#[test]
fn three_consecutive_strands_pause_the_vault() {
    let mut v = funded();
    strand_swap(&mut v);
    strand_swap(&mut v);
    assert!(!v.get_state().paused, "two strands do not pause");
    strand_swap(&mut v);
    assert!(v.get_state().paused, "the third consecutive strand pauses");
    let logs = get_logs().join("\n");
    assert!(logs.contains("\"event\":\"auto_paused\"") && logs.contains("consecutive_strands"), "{logs}");
    let r = v.check_proposal(proposal(100), acct("runner.testnet"));
    assert!(!r.ok && r.reason.starts_with("ERR_PAUSED"), "{}", r.reason);
}

#[test]
fn a_successful_swap_resets_the_strand_streak() {
    let mut v = funded();
    strand_swap(&mut v);
    strand_swap(&mut v);
    good_swap(&mut v);
    strand_swap(&mut v);
    strand_swap(&mut v);
    assert!(!v.get_state().paused, "streak restarted after the success");
    strand_swap(&mut v);
    assert!(v.get_state().paused);
}

#[test]
fn owner_unpause_resets_the_strand_streak() {
    let mut v = funded();
    strand_swap(&mut v);
    strand_swap(&mut v);
    unpause(&mut v);
    strand_swap(&mut v);
    strand_swap(&mut v);
    assert!(!v.get_state().paused, "2 + 2 strands around an unpause do not pause");
    strand_swap(&mut v);
    assert!(v.get_state().paused);
    unpause(&mut v);
    assert!(!v.get_state().paused);
    strand_swap(&mut v);
    assert!(!v.get_state().paused, "a fresh streak after the auto-pause");
}

#[test]
fn rolled_back_failures_do_not_count_as_strands() {
    let mut v = funded();
    for _ in 0..5 {
        run(&mut v, proposal(100));
        let id = v.next_swap_id;
        cb_ctx(ok_result(&U128(0)), T0);
        let _ = v.handle_deposit(id, Ok(U128(0))); // nothing left the vault
    }
    assert!(!v.get_state().paused);
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn other_strand_outcomes_count_too() {
    // amount_out below the runner's own min_amount_out (the L-4 attack), then
    // an unverified deposit, then a withdraw that did not reconcile.
    let mut v = funded();
    let mut p = proposal(100);
    p.min_amount_out = U128(1_000_000);
    run(&mut v, p);
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(100)), T0);
    let _ = v.handle_deposit(id, Ok(U128(100)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(id, Ok(U128(390)));
    assert_eq!(stranded(&v, &rft()), 390);

    run(&mut v, proposal(100));
    let id = v.next_swap_id;
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_deposit(id, Err(PromiseError::Failed));
    cb_ctx(PromiseResult::Failed, T0);
    v.handle_deposit_reconciled(id, Err(PromiseError::Failed));
    assert!(!v.get_state().paused);

    run(&mut v, proposal(100));
    let id = v.next_swap_id;
    cb_ctx(ok_result(&U128(100)), T0);
    let _ = v.handle_deposit(id, Ok(U128(100)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_swap(id, Ok(U128(390)));
    cb_ctx(ok_result(&U128(390)), T0);
    let _ = v.handle_withdraw_pre(id, Ok(U128(390)));
    cb_ctx(ok_result(&U128(390)), T0);
    v.handle_withdraw_reconciled(id, Ok(U128(390))); // deposit did not drop
    assert!(v.get_state().paused);
}

// ------------------------------------------- M1: failed swap is refunded, not stranded

/// Swap id 1 (400 wrap) whose `ref.swap` failed, awaiting the refund callbacks.
fn swap_at_refund_pre() -> YieldVault {
    let mut v = funded();
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.handle_swap(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    v
}
/// Same, one hop later: Ref showed 400 and the refund withdraw is out.
fn swap_at_refund_reconcile_cb() -> YieldVault {
    let mut v = swap_at_refund_pre();
    cb_ctx(ok_result(&U128(400)), T0);
    let r = v.handle_refund_pre(1, Ok(U128(400)));
    assert!(matches!(r, PromiseOrValue::Promise(_)), "must withdraw then re-read Ref");
    v
}

#[test]
fn refund_pre_snapshots_withdraws_token_in_and_rereads() {
    let mut v = swap_at_refund_pre();
    cb_ctx(ok_result(&U128(450)), T0);
    let r = v.handle_refund_pre(1, Ok(U128(450)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    drop(r);
    assert_eq!(v.in_flight.as_ref().unwrap().ref_pre_out, 450);
    assert_eq!(v.in_flight.as_ref().unwrap().amount_out, 0);
    let calls = created_calls();
    let w = calls.iter().find(|c| c.1 == "withdraw").expect("withdraw scheduled");
    assert_eq!(w.0, v.ref_exchange_id.to_string());
    assert_eq!(w.2["token_id"], wrap().to_string());
    assert_eq!(w.2["amount"], "400");
    assert_eq!(w.3, 1, "one yocto");
    assert!(calls.iter().filter(|c| c.1 == "get_deposit").count() >= 1);
    assert_eq!(calls.last().unwrap().1, "on_refund_reconciled");
    assert!(v.get_state().swap_in_flight);
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
}

#[test]
fn verified_refund_restores_balance_spend_and_releases_lock() {
    let mut v = swap_at_refund_reconcile_cb();
    cb_ctx(ok_result(&U128(0)), T0);
    assert_eq!(v.handle_refund_reconciled(1, Ok(U128(0))).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000, "token_in restored");
    assert_eq!(bal(&v, &rft()), 0);
    assert_eq!(spent_view(&v, &wrap()), 0, "the refunded spend does not burn the daily cap");
    assert!(v.spent_today.is_empty());
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
    assert!(v.get_state().stranded_on_ref.is_empty());
    assert_eq!(v.get_state().swaps_executed, 0);
    assert_eq!(v.consecutive_strands, 0);
    let logs = get_logs().join("\n");
    let refunded = logs.find("\"event\":\"swap_refunded\"").expect("swap_refunded");
    let failed = logs.find("\"event\":\"swap_failed\"").expect("swap_failed");
    assert!(refunded < failed, "swap_refunded is emitted first");
    assert!(logs.contains("\"reason\":\"swap_failed\""));
    assert!(logs.contains("\"amount\":\"400\""));
    assert!(!logs.contains("\"event\":\"stranded\""), "{logs}");
}

#[test]
fn verified_refund_lets_a_full_cap_swap_through_again() {
    let mut v = funded();
    for id in 1..=3u64 {
        // Each swap wants the whole 500-wrap max_trade; the daily cap is 2_500.
        run(&mut v, proposal(500));
        cb_ctx(ok_result(&U128(500)), T0);
        let _ = v.handle_deposit(id, Ok(U128(500)));
        fail_swap_then_refund_verified(&mut v, id, 500);
    }
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    // Five full-cap swaps still fit afterwards (a burnt cap would refuse them).
    for _ in 0..5 {
        let r = v.check_proposal(proposal(500), acct("runner.testnet"));
        assert!(r.ok, "{}", r.reason);
        run(&mut v, proposal(500));
        v.in_flight = None;
    }
    assert_eq!(spent_view(&v, &wrap()), 2_500);
}

#[test]
fn many_verified_refunds_never_auto_pause() {
    let mut v = funded();
    for _ in 0..5 {
        refund_swap(&mut v);
    }
    assert!(!v.get_state().paused, "an unfillable min_amount_out cannot pause the vault");
    assert_eq!(v.consecutive_strands, 0);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert!(!get_logs().join("\n").contains("auto_paused"));
}

#[test]
fn verified_refund_across_day_roll_restores_balance_not_new_day_spend() {
    let mut v = swap_at_refund_reconcile_cb();
    v.day = 11;
    v.spent_today.clear();
    v.spent_today.insert(wrap(), 50);
    cb_ctx(ok_result(&U128(0)), T0 + DAY);
    v.handle_refund_reconciled(1, Ok(U128(0)));
    assert_eq!(bal(&v, &wrap()), 10_000, "balance restored");
    assert_eq!(v.spent_today.get(&wrap()).copied(), Some(50), "new day's spend untouched");
    assert!(!v.get_state().swap_in_flight);
    assert!(v.stranded.is_empty());
}

#[test]
fn verified_refund_neither_increments_nor_resets_the_strand_count() {
    let mut v = funded();
    strand_swap(&mut v);
    strand_swap(&mut v);
    assert_eq!(v.consecutive_strands, 2);
    refund_swap(&mut v);
    assert_eq!(v.consecutive_strands, 2, "a refund is neither a strand nor a completed swap");
    assert!(!v.get_state().paused);
    strand_swap(&mut v);
    assert!(v.get_state().paused, "strand, strand, refund, strand pauses");
}

#[test]
fn refund_pre_below_amount_in_is_stranded_unverified_and_counts() {
    let mut v = swap_at_refund_pre();
    cb_ctx(ok_result(&U128(399)), T0);
    let r = v.handle_refund_pre(1, Ok(U128(399)));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))), "no withdraw attempted");
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 400);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert_eq!(bal(&v, &wrap()), 9_600, "never credited");
    assert_eq!(spent_view(&v, &wrap()), 400, "spend stays counted");
    assert_eq!(v.consecutive_strands, 1);
    let logs = get_logs().join("\n");
    assert!(logs.contains("refund_pre_mismatch") && !logs.contains("swap_refunded"), "{logs}");
}

#[test]
fn refund_pre_read_failed_is_stranded_verified_and_counts() {
    let mut v = swap_at_refund_pre();
    cb_ctx(PromiseResult::Failed, T0);
    let r = v.handle_refund_pre(1, Err(PromiseError::Failed));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))), "no blind withdraw");
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(unverified(&v, &wrap()), 0);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(v.consecutive_strands, 1);
    assert!(get_logs().join("\n").contains("refund_pre_unverified"));
}

#[test]
fn refund_withdraw_not_reconciled_strands_without_credit_or_rollback() {
    let mut v = swap_at_refund_reconcile_cb();
    cb_ctx(ok_result(&U128(400)), T0);
    assert_eq!(v.handle_refund_reconciled(1, Ok(U128(400))).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(bal(&v, &wrap()), 9_600, "no credit");
    assert_eq!(spent_view(&v, &wrap()), 400, "spend NOT rolled back");
    assert_eq!(v.consecutive_strands, 1);
    let logs = get_logs().join("\n");
    assert!(logs.contains("refund_not_reconciled") && !logs.contains("swap_refunded"), "{logs}");
}

#[test]
fn refund_partial_drop_is_not_reconciled() {
    let mut v = swap_at_refund_reconcile_cb();
    cb_ctx(ok_result(&U128(1)), T0);
    v.handle_refund_reconciled(1, Ok(U128(1))); // dropped by 399 only
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(bal(&v, &wrap()), 9_600);
}

#[test]
fn refund_reconcile_read_failed_is_stranded_unverified() {
    let mut v = swap_at_refund_reconcile_cb();
    cb_ctx(PromiseResult::Failed, T0);
    assert_eq!(v.handle_refund_reconciled(1, Err(PromiseError::Failed)).0, 0);
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 400);
    assert_eq!(stranded(&v, &wrap()), 0);
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert_eq!(spent_view(&v, &wrap()), 400);
    assert_eq!(v.consecutive_strands, 1);
    assert!(get_logs().join("\n").contains("refund_unverified"));
}

#[test]
fn refund_baseline_ignores_stranded_records() {
    // 50 wrap already stranded on Ref: pre snapshot 450, post 50 is a real drop
    // of 400; post 450 is not, whatever the record says.
    let mut v = funded();
    v.stranded.insert(wrap(), 50);
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_swap(1, Err(PromiseError::Failed));
    cb_ctx(ok_result(&U128(450)), T0);
    let _ = v.handle_refund_pre(1, Ok(U128(450)));
    cb_ctx(ok_result(&U128(50)), T0);
    v.handle_refund_reconciled(1, Ok(U128(50)));
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(stranded(&v, &wrap()), 50, "old record untouched");
}

#[test]
fn refund_pre_not_covering_stranded_plus_amount_in_is_not_withdrawn() {
    // 50 wrap stranded; Ref shows 420 >= amount_in 400 but < 50 + 400. The
    // refund must not withdraw (part of it could be the stranded 50).
    let mut v = funded();
    v.stranded.insert(wrap(), 50);
    run(&mut v, proposal(400));
    cb_ctx(ok_result(&U128(400)), T0);
    let _ = v.handle_deposit(1, Ok(U128(400)));
    cb_ctx(PromiseResult::Failed, T0);
    let _ = v.handle_swap(1, Err(PromiseError::Failed));
    cb_ctx(ok_result(&U128(420)), T0);
    let r = v.handle_refund_pre(1, Ok(U128(420)));
    assert!(matches!(r, PromiseOrValue::Value(_)), "no withdraw scheduled");
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(unverified(&v, &wrap()), 400);
    assert_eq!(stranded(&v, &wrap()), 50);
    assert_eq!(bal(&v, &wrap()), 9_600, "nothing credited");
    assert_eq!(v.consecutive_strands, 1);
    assert!(get_logs().join("\n").contains("refund_pre_mismatch"));
}

#[test]
fn stale_refund_callbacks_with_wrong_id_are_noops() {
    let mut v = swap_at_refund_pre();
    cb_ctx(ok_result(&U128(400)), T0);
    assert!(matches!(
        v.handle_refund_pre(99, Ok(U128(400))),
        PromiseOrValue::Value(U128(0))
    ));
    assert_eq!(v.in_flight.as_ref().unwrap().ref_pre_out, 0);
    cb_ctx(ok_result(&U128(0)), T0);
    assert_eq!(v.handle_refund_reconciled(99, Ok(U128(0))).0, 0);
    assert!(v.get_state().swap_in_flight, "lock untouched by a stale id");
    assert_eq!(bal(&v, &wrap()), 9_600);
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
}

#[test]
fn refund_callbacks_are_noops_while_a_force_release_is_pending() {
    let mut v = swap_at_refund_reconcile_cb();
    let _ = force_release(&mut v);
    // The released swap's own late callbacks: current() refuses while release is set.
    cb_ctx(ok_result(&U128(0)), T0 + STALE_LOCK_NS);
    assert_eq!(v.handle_refund_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &wrap()), 9_600, "not credited behind the release's back");
    assert!(v.get_state().swap_in_flight && v.get_state().release_in_flight);
    assert!(matches!(
        v.handle_refund_pre(1, Ok(U128(400))),
        PromiseOrValue::Value(U128(0))
    ));
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
}

#[test]
fn force_release_during_refund_with_token_in_back_in_vault_rolls_back() {
    // Refund withdraw landed in the vault (10_000 on the token contract), Ref empty.
    let mut v = swap_at_refund_reconcile_cb();
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(10_000)), Ok(U128(0)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight && !v.get_state().release_in_flight);
    assert_eq!(bal(&v, &wrap()), 10_000);
    assert_eq!(spent_view(&v, &wrap()), 0);
    assert!(v.stranded.is_empty() && v.unverified.is_empty());
    assert!(get_logs().join("\n").contains("lock_force_released_in_vault"));
    // The refund's own late reconcile is now a no-op (no double credit).
    cb_ctx(ok_result(&U128(0)), T0 + STALE_LOCK_NS);
    assert_eq!(v.handle_refund_reconciled(1, Ok(U128(0))).0, 0);
    assert_eq!(bal(&v, &wrap()), 10_000);
}

#[test]
fn force_release_during_refund_with_token_in_still_on_ref_strands() {
    let mut v = swap_at_refund_reconcile_cb();
    let id = force_release(&mut v);
    release_cb();
    v.resolve_release_swap(id, Ok(U128(9_600)), Ok(U128(400)), Ok(U128(0)));
    assert!(!v.get_state().swap_in_flight);
    assert_eq!(bal(&v, &wrap()), 9_600, "not credited");
    assert_eq!(stranded(&v, &wrap()), 400);
    assert_eq!(spent_view(&v, &wrap()), 400);
    assert!(get_logs().join("\n").contains("lock_force_released"));
}

// ---------------------------------------------------------------- shared rule vectors

/// Runs tests/rule-vectors.json, the same file src/yield/rules.parity.test.mjs runs through the
/// JavaScript rules, against the `check_proposal` view. Expected strings live only in that file.
#[test]
fn rule_vectors_match_check_proposal() {
    let doc: Value = serde_json::from_str(include_str!("../tests/rule-vectors.json")).unwrap();
    let config: VaultConfig = serde_json::from_value(doc["config"].clone()).unwrap();
    let base = &doc["base_state"];
    let cases = doc["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        // A state override replaces the same key of base_state.
        let field = |k: &str| c["state"].get(k).unwrap_or(&base[k]);
        let amounts = |v: &Value| -> BTreeMap<AccountId, u128> {
            v.as_object()
                .unwrap()
                .iter()
                .map(|(t, a)| (acct(t), a.as_str().unwrap().parse().unwrap()))
                .collect()
        };
        let mut v = new_vault_with(config.clone());
        v.paused = field("paused").as_bool().unwrap();
        v.day = field("day").as_u64().unwrap();
        v.spent_today = amounts(field("spent_today"));
        v.balances = amounts(field("balances"));
        if field("in_flight").as_bool().unwrap() {
            v.in_flight = Some(InFlight {
                id: 1,
                pool_id: 0,
                token_in: wrap(),
                token_out: rft(),
                amount_in: 1,
                min_amount_out: 1,
                day: v.day,
                amount_out: 0,
                started_at: T0,
                ref_pre_out: 0,
            });
        }
        if field("recovery").as_bool().unwrap() {
            v.recovery = Some(Recovery {
                id: 2,
                token_id: wrap(),
                amount: 1,
                started_at: T0,
                pre: 0,
                unv: 0,
            });
        }
        let now_ns = c.get("now_ns").unwrap_or(&base["now_ns"]).as_u64().unwrap();
        at("anyone.testnet", now_ns);
        let proposal: SwapProposal = serde_json::from_value(c["proposal"].clone()).unwrap();
        let got = v.check_proposal(proposal, acct(c["runner"].as_str().unwrap()));
        let expect = c["expect"].as_str().unwrap();
        assert_eq!(got.reason, expect, "vector: {name}");
        assert_eq!(got.ok, expect.is_empty(), "vector: {name}");
    }
}
