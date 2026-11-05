//! Failure and escape-hatch paths: the Ref withdraw gas finding, and force_release_lock.
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

/// FINDING (M-1): Ref's own `withdraw` attaches 20 TGas to ft_transfer and 20 TGas to its
/// resolve callback (ref-exchange utils.rs GAS_FOR_FT_TRANSFER / GAS_FOR_RESOLVE_TRANSFER;
/// mirrored in mock-ref). The vault attaches GAS_REF_WITHDRAW = 40 TGas in total, which leaves
/// nothing for Ref's own body and receipt fees, so `ref.withdraw` fails with "Exceeded the
/// prepaid gas". The vault stays consistent (token_out is stranded on Ref) but no swap can
/// ever complete. Ref's own UI attaches 100 TGas to `withdraw`.
#[tokio::test]
async fn ref_withdraw_gas_40_is_too_little_with_ref_20_20() -> anyhow::Result<()> {
    let sb = Sb::new().await?; // mock-ref default: inner gas 20 + 20
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    assert_eq!(c["GAS_REF_WITHDRAW"], 40, "lib.rs constant changed; revisit this finding");

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    let rows = report_expecting(&sb, "execute_swap @ 280, Ref inner withdraw gas 20+20 (FINDING)", &r, sb.runner.id(), &["ref.withdraw"]).await?;
    assert!(rows.iter().any(|x| x.label == "ref.withdraw" && !x.ok), "ref.withdraw must fail");
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false, "vault must not be left locked");
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT);
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, AMOUNT_OUT);

    // Recovery at MIN_RECOVER_GAS hits the same 40 TGas withdraw and fails the same way.
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tout.id(), "amount": AMOUNT_OUT.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    report_expecting(&sb, "recover_from_ref @ 150, Ref inner withdraw gas 20+20 (FINDING)", &r, sb.owner.id(), &["ref.withdraw"]).await?;
    let s = sb.state().await?;
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT, "stranded record restored");
    assert_eq!(s["recovery_in_flight"], false);
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);

    // With Ref's inner gas lowered (10 + 10) the same recovery works.
    sb.set_ref_withdraw_gas(10, 10).await?;
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tout.id(), "amount": AMOUNT_OUT.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    report(&sb, "recover_from_ref @ 150, Ref inner withdraw gas 10+10", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);
    Ok(())
}

async fn stale(sb: &Sb) -> anyhow::Result<()> {
    // 10 minutes of sandbox time (each block is ~0.3 s of timestamp, so 2500 blocks > 600 s). fast_forward advances the block height and the block
    // timestamps; the vault's own ERR_LOCK_NOT_STALE check is the real arbiter below.
    sb.worker.fast_forward(2_500).await?;
    Ok(())
}

/// The swap completed on Ref and the tokens reached the vault, but the last callback
/// (`on_withdraw_reconciled`) panicked decoding a garbage `get_deposit` reply, so the lock
/// is held. `force_release_lock` finds the tokens in the vault and credits them.
#[tokio::test]
async fn force_release_credits_swap_whose_last_callback_died() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.set_ref_withdraw_gas(10, 10).await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 2})).transact().await?.into_result()?;

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report_expecting(&sb, "execute_swap, 2nd get_deposit garbage (lock stuck)", &r, sb.runner.id(), &["vault.on_withdraw_reconciled"]).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], true, "lock must be stuck");
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0, "not credited yet");
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT, "tokens did arrive");
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 0})).transact().await?.into_result()?;

    // Too early: refused.
    let early = sb.owner.call(sb.vault.id(), "force_release_lock")
        .deposit(YOCTO).gas(tgas(c["MIN_FORCE_RELEASE_GAS"])).transact().await?;
    assert!(early.is_failure());
    assert!(format!("{:?}", early.failures()).contains("ERR_LOCK_NOT_STALE"), "{:?}", early.failures());

    stale(&sb).await?;
    let r = sb.owner.call(sb.vault.id(), "force_release_lock")
        .deposit(YOCTO).gas(tgas(c["MIN_FORCE_RELEASE_GAS"])).transact().await?;
    report(&sb, "force_release_lock @ MIN_FORCE_RELEASE_GAS (credit branch)", &r, sb.owner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false);
    assert_eq!(s["release_in_flight"], false);
    assert_eq!(s["swaps_executed"], 1);
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(r.logs().iter().any(|l| l.contains("swap_executed") && l.contains("force_release")));
    Ok(())
}

/// The swap ran on Ref but `on_withdraw_pre` died on a garbage reply before the withdraw:
/// token_out sits on Ref. `force_release_lock` strands it, `recover_from_ref` pulls it back.
#[tokio::test]
async fn force_release_strands_swap_stuck_before_withdraw_then_recover() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.set_ref_withdraw_gas(10, 10).await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 1})).transact().await?.into_result()?;

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    report_expecting(&sb, "execute_swap, 1st get_deposit garbage (lock stuck)", &r, sb.runner.id(), &["vault.on_withdraw_pre"]).await?;
    assert_eq!(sb.state().await?["swap_in_flight"], true);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, AMOUNT_OUT);
    sb.admin.call(sb.rf.id(), "set_garbage_get_deposit_call").args_json(json!({"n": 0})).transact().await?.into_result()?;

    stale(&sb).await?;
    let r = sb.owner.call(sb.vault.id(), "force_release_lock")
        .deposit(YOCTO).gas(tgas(c["MIN_FORCE_RELEASE_GAS"])).transact().await?;
    report(&sb, "force_release_lock @ MIN_FORCE_RELEASE_GAS (strand branch)", &r, sb.owner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT);
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);

    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tout.id(), "amount": AMOUNT_OUT.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    report(&sb, "recover_from_ref @ MIN_RECOVER_GAS (after force release)", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);
    assert!(sb.state().await?["stranded_on_ref"].as_array().unwrap().is_empty());
    Ok(())
}
