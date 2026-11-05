//! Failed Ref swap -> token_in refund (commit 1b29ae3): a REAL slippage failure (Ref's E68, not
//! the swap-panic knob) self-heals, ambiguous refunds still strand, and only real strands count
//! towards the MAX_CONSECUTIVE_STRANDS auto-pause.
//! Run: `cargo test --test failed_swap_refund -- --nocapture --test-threads=1`
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use serde_json::{json, Value};

const DEPOSIT: u128 = 20_000_000;
const AMOUNT_IN: u128 = 5_000_000;
/// Meets the vault's static floor (min_rate_a_to_b 1/1 => >= 5_000_000) and the pool's 3/2 rate
/// (7_500_000 out) until `slip()` drops the rate to 1/1 (5_000_000 out < 7_000_000 => E68).
const MIN_OUT: u128 = 7_000_000;
const AMOUNT_OUT: u128 = AMOUNT_IN * RATE_NUM / RATE_DEN;

fn pair_amount(list: &Value, id: &str) -> u128 {
    list.as_array().unwrap().iter().find(|p| p[0] == id)
        .map(|p| p[1].as_str().unwrap().parse().unwrap()).unwrap_or(0)
}

fn has_event(logs: &[&str], name: &str) -> bool {
    logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!("\"event\":\"{name}\"")))
}

fn has_event_with(logs: &[&str], name: &str, needle: &str) -> bool {
    logs.iter().any(|l| l.contains(&format!("\"event\":\"{name}\"")) && l.contains(needle))
}

async fn set_rate(sb: &Sb, num: u128, den: u128) -> anyhow::Result<()> {
    sb.admin.call(sb.rf.id(), "set_rate")
        .args_json(json!({"pool_id": POOL, "rate_num": num.to_string(), "rate_den": den.to_string()}))
        .transact().await?.into_result()?;
    Ok(())
}

/// Ref's rate drops to 1/1 so `min_amount_out` (7_000_000) is unreachable: real E68.
async fn slip(sb: &Sb) -> anyhow::Result<()> {
    set_rate(sb, 1, 1).await
}

async fn unslip(sb: &Sb) -> anyhow::Result<()> {
    set_rate(sb, RATE_NUM, RATE_DEN).await
}

async fn swap(sb: &Sb, title: &str, may_fail: &[&str]) -> anyhow::Result<ExecutionFinalResult> {
    let c = lib_gas_constants();
    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report_expecting(sb, title, &r, sb.runner.id(), may_fail).await?;
    Ok(r)
}

fn assert_idle(s: &Value) {
    assert_eq!(s["swap_in_flight"], false, "lock released");
    assert_eq!(s["recovery_in_flight"], false);
    assert_eq!(s["release_in_flight"], false);
}

/// Everything a clean refund must leave behind.
async fn assert_refunded(sb: &Sb, r: &ExecutionFinalResult, ref_tin_before: u128) -> anyhow::Result<()> {
    let logs = r.logs();
    assert!(has_event(&logs, "swap_refunded"), "swap_refunded: {logs:?}");
    assert!(has_event_with(&logs, "swap_failed", "\"reason\":\"swap_failed\""), "swap_failed: {logs:?}");
    assert!(!has_event(&logs, "stranded"), "no strand: {logs:?}");
    assert!(!has_event(&logs, "auto_paused"));
    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(s["paused"], false);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "balance restored");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), 0, "spent_today restored");
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT, "real tokens back in the vault");
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tin, sb.rf.id()).await?, ref_tin_before, "Ref holds no extra token_in");
    Ok(())
}

/// (a) A real Ref slippage failure recovers token_in without a strand.
#[tokio::test]
async fn slippage_e68_refunds_token_in_without_strand() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let ref_tin_before = sb.ft_balance(&sb.tin, sb.rf.id()).await?;
    slip(&sb).await?;

    let r = swap(&sb, "execute_swap, real E68 slippage (refund path)", &["ref.swap"]).await?;
    let fails = format!("{:?}", r.receipt_failures());
    assert!(fails.contains("E68"), "ref.swap failed with the slippage error: {fails}");
    assert_refunded(&sb, &r, ref_tin_before).await?;

    // The lock is free and the funds are usable: at a reachable rate the same swap completes.
    unslip(&sb).await?;
    let _ = swap(&sb, "execute_swap after the refund, rate restored", &[]).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    Ok(())
}

/// (b1) Slippage fails AND Ref's refund `ft_transfer` fails: Ref re-credits, the reconcile sees no
/// drop => verified strand `refund_not_reconciled`, nothing credited, spend still counted.
#[tokio::test]
async fn refund_transfer_fails_strands_refund_not_reconciled() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    slip(&sb).await?;
    sb.ft_knob(&sb.tin, "set_fail_transfers", true).await?;

    let r = swap(&sb, "execute_swap, E68 + refund ft_transfer fails", &["ref.swap", "tin.ft_transfer"]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "stranded", "refund_not_reconciled"), "stranded: {logs:?}");
    assert!(!logs.iter().any(|l| l.contains("\"verified\":false")), "verified strand: {logs:?}");
    assert!(has_event(&logs, "swap_failed"));
    assert!(!has_event(&logs, "swap_refunded"));

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tin.id().as_str()), AMOUNT_IN);
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN, "no credit");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), AMOUNT_IN, "spend stays booked");
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, AMOUNT_IN, "Ref re-credited");
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(s["paused"], false, "a single strand does not pause");
    Ok(())
}

/// (b2) The post-withdraw read is garbage: the withdraw did deliver the tokens, but nothing proves
/// it => unverified strand `refund_unverified`, not credited, spend counted; sync_balance books it.
#[tokio::test]
async fn garbage_post_read_strands_refund_unverified() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    slip(&sb).await?;
    // get_deposit call 1 = on_refund_pre read, call 2 = on_refund_reconciled read.
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 2})).transact().await?.into_result()?;

    let r = swap(&sb, "execute_swap, E68 + 2nd get_deposit garbage", &["ref.swap"]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "stranded", "refund_unverified"), "stranded: {logs:?}");
    assert!(has_event_with(&logs, "stranded", "\"verified\":false"));
    assert!(!has_event(&logs, "swap_refunded"));

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(pair_amount(&s["unverified_on_ref"], sb.tin.id().as_str()), AMOUNT_IN);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN, "not credited on an unverified read");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), AMOUNT_IN);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT, "tokens did arrive");
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);

    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 0})).transact().await?.into_result()?;
    let c = lib_gas_constants();
    sb.owner.call(sb.vault.id(), "sync_balance").args_json(json!({"token_id": sb.tin.id()}))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .gas(tgas(c["MIN_SYNC_GAS"])).transact().await?.into_result()?;
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "owner books the arrived tokens");
    Ok(())
}

/// (b3) The pre-withdraw read fails (get_deposit panics): no withdraw is attempted, token_in is a
/// verified strand `refund_pre_unverified` still sitting in Ref's account.
#[tokio::test]
async fn failed_pre_read_strands_refund_pre_unverified() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    slip(&sb).await?;
    sb.ref_knob("set_get_deposit_panic", true).await?;

    let r = swap(&sb, "execute_swap, E68 + get_deposit panics", &["ref.swap", "ref.get_deposit"]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "stranded", "refund_pre_unverified"), "stranded: {logs:?}");
    assert!(!has_event(&logs, "swap_refunded"));
    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tin.id().as_str()), AMOUNT_IN);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), AMOUNT_IN);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, AMOUNT_IN, "never withdrawn");
    Ok(())
}

/// (c1) Three consecutive unrecoverable failures auto-pause the vault.
#[tokio::test]
async fn three_unrecoverable_failures_auto_pause() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    for i in 1..=3 {
        let r = sb.strand_token_in(AMOUNT_IN, MIN_OUT).await?;
        report_expecting(&sb, &format!("unrecoverable failure #{i}"), &r, sb.runner.id(), &["ref.swap", "tin.ft_transfer"]).await?;
        let logs = r.logs();
        assert!(has_event_with(&logs, "stranded", "refund_not_reconciled"), "#{i}: {logs:?}");
        let paused = sb.state().await?["paused"].as_bool().unwrap();
        assert_eq!(paused, i == 3, "paused after failure #{i}");
        assert_eq!(has_event_with(&logs, "auto_paused", "consecutive_strands"), i == 3, "#{i}: {logs:?}");
    }
    let s = sb.state().await?;
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tin.id().as_str()), 3 * AMOUNT_IN);
    // A paused vault rejects the next proposal.
    let c = lib_gas_constants();
    let r = sb.runner.call(sb.vault.id(), "execute_swap").args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    assert!(r.is_failure(), "paused vault must reject execute_swap");
    assert!(format!("{:?}", r.failures()).contains("ERR_PAUSED"), "{:?}", r.failures());
    Ok(())
}

/// (c2) Repeated slippage failures all refund: never paused, and the next execute_swap is accepted.
#[tokio::test]
async fn repeated_slippage_refunds_never_pause() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let ref_tin_before = sb.ft_balance(&sb.tin, sb.rf.id()).await?;
    slip(&sb).await?;
    for i in 1..=4 {
        let r = swap(&sb, &format!("slippage refund #{i}"), &["ref.swap"]).await?;
        assert_refunded(&sb, &r, ref_tin_before).await?;
    }
    // 5th proposal at a reachable rate is accepted and completes.
    unslip(&sb).await?;
    let r = swap(&sb, "execute_swap after 4 refunded slippage failures", &[]).await?;
    assert!(has_event(&r.logs(), "swap_executed"));
    let s = sb.state().await?;
    assert_eq!(s["paused"], false);
    assert_eq!(s["swaps_executed"], 1);
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    Ok(())
}

/// (c3) A verified refund neither increments nor resets the strand count: strand, strand, refund,
/// strand => paused on the third real strand.
#[tokio::test]
async fn refund_neither_counts_nor_resets_strand_count() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    for _ in 0..2 {
        sb.strand_token_in(AMOUNT_IN, MIN_OUT).await?;
    }
    assert_eq!(sb.state().await?["paused"], false);
    // A clean refund in between (plain swap panic, transfers healthy).
    sb.ref_knob("set_swap_panic", true).await?;
    let r = swap(&sb, "refund between strands", &["ref.swap"]).await?;
    assert!(has_event(&r.logs(), "swap_refunded"), "{:?}", r.logs());
    sb.ref_knob("set_swap_panic", false).await?;
    assert_eq!(sb.state().await?["paused"], false, "refund does not count");
    let r = sb.strand_token_in(AMOUNT_IN, MIN_OUT).await?;
    assert!(has_event(&r.logs(), "auto_paused"), "refund did not reset the count: {:?}", r.logs());
    assert_eq!(sb.state().await?["paused"], true);
    Ok(())
}
