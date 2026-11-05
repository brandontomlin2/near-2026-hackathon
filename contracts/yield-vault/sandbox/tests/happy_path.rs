//! Happy path end to end at the documented minimum prepaid gas for every entry point.
//! Run: `cargo test --test happy_path -- --nocapture`
mod common;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const DEPOSIT: u128 = 20_000_000;
const AMOUNT_IN: u128 = 5_000_000;
const MIN_OUT: u128 = 7_000_000;
// 3/2 rate: 5_000_000 in -> 7_500_000 out.
const AMOUNT_OUT: u128 = AMOUNT_IN * RATE_NUM / RATE_DEN;

fn n(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}
fn pair_amount(list: &Value, id: &str) -> u128 {
    list.as_array()
        .unwrap()
        .iter()
        .find(|p| p[0] == id)
        .map(|p| n(&p[1]))
        .unwrap_or(0)
}

#[tokio::test]
async fn happy_path_full_lifecycle() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    // mock-ref runs at its default: Ref's real inner withdraw gas (20 TGas ft_transfer + 20 TGas resolve).
    let c = lib_gas_constants();
    let g = |k: &str| tgas(c[k]);

    // 1. owner funds Ref storage for the vault's inner account (MIN_REGISTER_GAS).
    let r = sb.owner.call(sb.vault.id(), "register_on_ref")
        .deposit(near(1)).gas(g("MIN_REGISTER_GAS")).transact().await?;
    report(&sb, "register_on_ref @ MIN_REGISTER_GAS", &r, sb.owner.id()).await?;
    let st: Value = sb.rf.view("storage_balance_of").args_json(json!({"account_id": sb.vault.id()})).await?.json()?;
    assert_eq!(n(&st["total"]), 1_000_000_000_000_000_000_000_000);

    // 2. owner deposits token_in into the vault via ft_transfer_call -> vault.ft_on_transfer.
    let r = sb.owner.call(sb.tin.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": sb.vault.id(), "amount": DEPOSIT.to_string(), "msg": ""}))
        .deposit(YOCTO).gas(tgas(100)).transact().await?;
    report(&sb, "owner deposit: tin.ft_transfer_call(vault) @ 100 TGas", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);

    // 3. runner executes the swap with exactly MIN_EXECUTE_GAS.
    let ref_tin_before = sb.ft_balance(&sb.tin, sb.rf.id()).await?;
    let ref_tout_before = sb.ft_balance(&sb.tout, sb.rf.id()).await?;
    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(json!({"proposal": {
            "pool_id": POOL, "token_in": sb.tin.id(), "token_out": sb.tout.id(),
            "amount_in": AMOUNT_IN.to_string(), "min_amount_out": MIN_OUT.to_string()}}))
        .gas(g("MIN_EXECUTE_GAS")).transact().await?;
    let rows = report(&sb, "execute_swap @ MIN_EXECUTE_GAS (280 TGas)", &r, sb.runner.id()).await?;
    assert!(r.logs().iter().any(|l| l.contains("swap_executed") && l.contains(&AMOUNT_OUT.to_string())),
        "swap_executed event with amount_out: {:?}", r.logs());
    // every hop of the documented chain ran
    for hop in ["vault.execute_swap", "tin.ft_transfer_call", "ref.ft_on_transfer", "vault.on_deposit",
        "ref.swap", "vault.on_swap", "ref.get_deposit", "vault.on_withdraw_pre", "ref.withdraw",
        "tout.ft_transfer", "ref.exchange_callback_post_withdraw", "vault.on_withdraw_reconciled"] {
        assert!(rows.iter().any(|x| x.label == hop), "missing hop {hop}");
    }
    // vault accounting
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false);
    assert_eq!(s["recovery_in_flight"], false);
    assert_eq!(s["release_in_flight"], false);
    assert_eq!(s["swaps_executed"], 1);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), AMOUNT_IN);
    // Ref inner deposits fully drained
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);
    // real token balances
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tin, sb.rf.id()).await?, ref_tin_before + AMOUNT_IN);
    assert_eq!(sb.ft_balance(&sb.tout, sb.rf.id()).await?, ref_tout_before - AMOUNT_OUT);

    // 4. sync_balance credits a donation (MIN_SYNC_GAS).
    sb.mint(&sb.tout, sb.vault.id(), 1_000).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT, "donation not tracked yet");
    let r = sb.owner.call(sb.vault.id(), "sync_balance")
        .args_json(json!({"token_id": sb.tout.id()}))
        .deposit(YOCTO).gas(g("MIN_SYNC_GAS")).transact().await?;
    report(&sb, "sync_balance @ MIN_SYNC_GAS", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT + 1_000);

    // 5. owner withdraw (MIN_WITHDRAW_GAS).
    let w = 2_000_000u128;
    let r = sb.owner.call(sb.vault.id(), "withdraw")
        .args_json(json!({"token_id": sb.tout.id(), "amount": w.to_string()}))
        .deposit(YOCTO).gas(g("MIN_WITHDRAW_GAS")).transact().await?;
    report(&sb, "owner withdraw @ MIN_WITHDRAW_GAS", &r, sb.owner.id()).await?;
    assert_eq!(sb.ft_balance(&sb.tout, sb.owner.id()).await?, w);
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT + 1_000 - w);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT + 1_000 - w);
    Ok(())
}

/// Ref's swap panics: token_in is stranded on Ref, then recovered with recover_from_ref.
#[tokio::test]
async fn failed_swap_strands_then_recover_from_ref() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    let c = lib_gas_constants();
    let g = |k: &str| tgas(c[k]);
    sb.owner.call(sb.vault.id(), "register_on_ref").deposit(near(1)).gas(g("MIN_REGISTER_GAS")).transact().await?.into_result()?;
    sb.owner.call(sb.tin.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": sb.vault.id(), "amount": DEPOSIT.to_string(), "msg": ""}))
        .deposit(YOCTO).gas(tgas(100)).transact().await?.into_result()?;
    sb.admin.call(sb.rf.id(), "set_swap_panic").args_json(json!({"v": true})).transact().await?.into_result()?;

    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(json!({"proposal": {
            "pool_id": POOL, "token_in": sb.tin.id(), "token_out": sb.tout.id(),
            "amount_in": AMOUNT_IN.to_string(), "min_amount_out": MIN_OUT.to_string()}}))
        .gas(g("MIN_EXECUTE_GAS")).transact().await?;
    // ref.swap fails by design; the vault's own callbacks must all succeed.
    report_expecting(&sb, "execute_swap, ref.swap panics (strand path)", &r, sb.runner.id(), &["ref.swap"]).await?;
    let s = sb.state().await?;
    assert_eq!(s["swap_in_flight"], false);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tin.id().as_str()), AMOUNT_IN);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, AMOUNT_IN);

    sb.admin.call(sb.rf.id(), "set_swap_panic").args_json(json!({"v": false})).transact().await?.into_result()?;
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tin.id(), "amount": AMOUNT_IN.to_string()}))
        .deposit(YOCTO).gas(g("MIN_RECOVER_GAS")).transact().await?;
    report(&sb, "recover_from_ref @ MIN_RECOVER_GAS", &r, sb.owner.id()).await?;
    let s = sb.state().await?;
    assert_eq!(s["recovery_in_flight"], false);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    Ok(())
}
