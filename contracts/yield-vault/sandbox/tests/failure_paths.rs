//! Failure paths: the Ref withdraw gas finding and malformed Ref replies (handled as failed
//! reads, so no sandbox flow can leave the lock stuck any more; `force_release_lock` is covered
//! by the unit tests only).
//! Run: `cargo test --test failure_paths -- --nocapture`
mod common;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const DEPOSIT: u128 = 20_000_000;
const AMOUNT_IN: u128 = 5_000_000;
const MIN_OUT: u128 = 7_000_000;
const AMOUNT_OUT: u128 = AMOUNT_IN * RATE_NUM / RATE_DEN;

fn pair_amount(list: &Value, id: &str) -> u128 {
    list.as_array().unwrap().iter().find(|p| p[0] == id)
        .map(|p| p[1].as_str().unwrap().parse().unwrap()).unwrap_or(0)
}

/// Regression for finding M-1. HISTORY: with GAS_REF_WITHDRAW = 40 TGas the sandbox showed
/// `ref.withdraw` failing with "Exceeded the prepaid gas", because Ref's own `withdraw`
/// attaches 20 TGas to ft_transfer and 20 TGas to its resolve callback (ref-exchange utils.rs
/// GAS_FOR_FT_TRANSFER / GAS_FOR_RESOLVE_TRANSFER; mirrored in mock-ref), leaving nothing for
/// Ref's body. The vault stayed consistent (token_out stranded on Ref) but no swap could ever
/// complete. Fixed in lib.rs by raising GAS_REF_WITHDRAW to 60 and rebudgeting the chain.
/// This test pins the fix: with Ref at its realistic default 20 + 20, swap at exactly
/// MIN_EXECUTE_GAS and recover_from_ref at exactly MIN_RECOVER_GAS both complete.
#[tokio::test]
async fn ref_withdraw_gas_covers_ref_20_20_at_documented_minimums() -> anyhow::Result<()> {
    let c = lib_gas_constants();
    // 20 (ft_transfer) + 20 (resolve) must fit with an allowance for Ref's withdraw body and
    // receipt fees (the headroom tests measure what Ref can add on top).
    const REF_BODY_ALLOWANCE: u64 = 10;
    assert!(c["GAS_REF_WITHDRAW"] >= 20 + 20 + REF_BODY_ALLOWANCE,
        "GAS_REF_WITHDRAW = {} too small for Ref's 20+20", c["GAS_REF_WITHDRAW"]);

    let sb = Sb::new().await?; // mock-ref default: inner gas 20 + 20
    sb.register_and_deposit(DEPOSIT).await?;
    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report(&sb, "execute_swap @ MIN_EXECUTE_GAS, Ref inner withdraw gas 20+20", &r, sb.runner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false);
    assert_eq!(s["swaps_executed"], 1);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);

    // recover_from_ref at MIN_RECOVER_GAS: strand token_out on Ref via a panicking get_deposit
    // would be indirect; instead strand token_in with a panicking swap, then recover.
    sb.admin.call(sb.rf.id(), "set_swap_panic").args_json(json!({"v": true})).transact().await?.into_result()?;
    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report_expecting(&sb, "execute_swap, ref.swap panics (strand)", &r, sb.runner.id(), &["ref.swap"]).await?;
    sb.admin.call(sb.rf.id(), "set_swap_panic").args_json(json!({"v": false})).transact().await?.into_result()?;
    assert_eq!(pair_amount(&sb.state().await?["stranded_on_ref"], sb.tin.id().as_str()), AMOUNT_IN);
    let tin_before = sb.vault_balance(&sb.tin).await?;
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tin.id(), "amount": AMOUNT_IN.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    report(&sb, "recover_from_ref @ MIN_RECOVER_GAS, Ref inner withdraw gas 20+20", &r, sb.owner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["recovery_in_flight"], false);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, tin_before + AMOUNT_IN);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    Ok(())
}

/// A garbage `get_deposit` reply (valid JSON, not a U128) to `on_withdraw_pre` used to panic
/// the callback inside near-sdk's typed decoding and leave the lock held until
/// `force_release_lock`. It is now a failed read: the chain ends cleanly, the lock is released,
/// token_out is stranded on Ref (recorded, never credited), and `recover_from_ref` pulls it back.
#[tokio::test]
async fn garbage_reply_before_withdraw_ends_chain_and_strands_then_recover() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 1})).transact().await?.into_result()?;

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    // No receipt may fail: the callback handles the bad reply instead of panicking.
    report(&sb, "execute_swap, 1st get_deposit garbage (clean end, strand)", &r, sb.runner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false, "lock released without force_release_lock");
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT);
    assert_eq!(pair_amount(&s["unverified_on_ref"], sb.tout.id().as_str()), 0);
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0, "never credited");
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, AMOUNT_OUT);
    assert!(r.logs().iter().any(|l| l.contains("withdraw_pre_unverified")));
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 0})).transact().await?.into_result()?;

    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tout.id(), "amount": AMOUNT_OUT.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    report(&sb, "recover_from_ref @ MIN_RECOVER_GAS (after garbage-reply strand)", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);
    assert!(sb.state().await?["stranded_on_ref"].as_array().unwrap().is_empty());
    Ok(())
}

/// A garbage reply to the post-withdraw read (`on_withdraw_reconciled`): the withdraw really
/// delivered the tokens to the vault, but the read that would prove it is unusable. The chain
/// ends cleanly with the amount recorded as unverified and NOT credited; the lock is free.
/// The tokens sit in the vault's FT balance, and the owner books them with `sync_balance`.
#[tokio::test]
async fn garbage_reply_after_withdraw_ends_chain_unverified_then_sync() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 2})).transact().await?.into_result()?;

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report(&sb, "execute_swap, 2nd get_deposit garbage (clean end, unverified)", &r, sb.runner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false, "lock released without force_release_lock");
    assert_eq!(s["swaps_executed"], 0, "a swap is never counted on an unverified read");
    assert_eq!(pair_amount(&s["unverified_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0, "not credited on a malformed read");
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT, "tokens did arrive");
    assert!(r.logs().iter().any(|l| l.contains("withdraw_unverified")));
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 0})).transact().await?.into_result()?;

    let r = sb.owner.call(sb.vault.id(), "sync_balance")
        .args_json(json!({"token_id": sb.tout.id()}))
        .deposit(YOCTO).gas(tgas(c["MIN_SYNC_GAS"])).transact().await?;
    report(&sb, "sync_balance @ MIN_SYNC_GAS (books the unverified-but-arrived tokens)", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    Ok(())
}
