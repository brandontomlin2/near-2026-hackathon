//! Refund and failure-fund-location claims, proven end to end in the local sandbox.
//! Every test runs the entry point at its documented minimum prepaid gas and with Ref's mock
//! default inner withdraw gas (no `set_ref_withdraw_gas`).
//! Run: `cargo test --test refunds -- --nocapture --test-threads=1`
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

fn has_event(logs: &[&str], name: &str) -> bool {
    logs.iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains(&format!("\"event\":\"{name}\"")))
}

fn has_event_with(logs: &[&str], name: &str, needle: &str) -> bool {
    logs.iter().any(|l| l.contains(&format!("\"event\":\"{name}\"")) && l.contains(needle))
}

async fn knob(sb: &Sb, who: &near_workspaces::Contract, method: &str, v: bool) -> anyhow::Result<()> {
    sb.admin.call(who.id(), method).args_json(json!({"v": v})).transact().await?.into_result()?;
    Ok(())
}

async fn ft_knob(sb: &Sb, t: &near_workspaces::Contract, method: &str, fail: bool) -> anyhow::Result<()> {
    sb.admin.call(t.id(), method).args_json(json!({"fail": fail})).transact().await?.into_result()?;
    Ok(())
}

async fn run_swap(sb: &Sb, title: &str, may_fail: &[&str]) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
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

/// Verifies README "Failure handling" table:
/// "| Deposit reported used amount 0 | still with the vault | roll back the debit and day spend; `deposit_failed` |"
/// Ref's ft_on_transfer returns the whole amount unused, the token refunds the vault via
/// ft_resolve_transfer, `on_deposit` sees used = 0.
#[tokio::test]
async fn receiver_refunds_all_rolls_back() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    knob(&sb, &sb.rf, "set_refund_all_deposits", true).await?;

    let r = run_swap(&sb, "execute_swap, Ref ft_on_transfer refunds everything", &[]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "swap_failed", "deposit_failed"), "swap_failed deposit_failed event: {logs:?}");
    assert!(!has_event(&logs, "swap_executed"));

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "debit rolled back");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), 0, "day spend rolled back");
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT, "real tokens back in the vault");
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);

    // The lock is really free: with the knob off the same swap now completes.
    knob(&sb, &sb.rf, "set_refund_all_deposits", false).await?;
    let _ = run_swap(&sb, "execute_swap after the refund, knob off", &[]).await?;
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    Ok(())
}

/// A failed `ref.swap` (swap-panic knob) no longer strands token_in: the vault withdraws it back
/// from Ref (`on_refund_pre` -> `ref.withdraw` -> `on_refund_reconciled`) and rolls the debit and
/// the day spend back. Same chain shape as the happy path, at MIN_EXECUTE_GAS.
#[tokio::test]
async fn ref_swap_panic_self_heals_via_refund() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    knob(&sb, &sb.rf, "set_swap_panic", true).await?;
    let ref_tin_before = sb.ft_balance(&sb.tin, sb.rf.id()).await?;

    // Only ref.swap may fail: every vault callback and the refund's ft_transfer succeed.
    let r = run_swap(&sb, "execute_swap, ref.swap panics (refund path)", &["ref.swap"]).await?;
    let logs = r.logs();
    assert!(has_event(&logs, "swap_refunded"), "swap_refunded event: {logs:?}");
    assert!(has_event_with(&logs, "swap_failed", "\"reason\":\"swap_failed\""), "swap_failed event: {logs:?}");
    assert!(!has_event(&logs, "stranded"), "no strand: {logs:?}");
    assert!(!has_event(&logs, "swap_executed"));

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(s["paused"], false);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "debit rolled back");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), 0, "day spend rolled back");
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0);
    // The tokens really came back: vault FT balance, Ref inner deposit, Ref FT balance.
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tin, sb.rf.id()).await?, ref_tin_before);
    Ok(())
}

/// Refund chain gas table row: same shape as the happy path, completes at MIN_EXECUTE_GAS.
#[tokio::test]
async fn refund_chain_hops_and_gas_at_min_execute_gas() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    knob(&sb, &sb.rf, "set_swap_panic", true).await?;
    let r = run_swap(&sb, "REFUND CHAIN: execute_swap @ MIN_EXECUTE_GAS, ref.swap panics", &["ref.swap"]).await?;
    let hash = r.outcome().transaction_hash.to_string();
    let (rows, total) = gas_table(&sb, &hash, sb.runner.id()).await?;
    for hop in ["vault.execute_swap", "tin.ft_transfer_call", "ref.ft_on_transfer", "vault.on_deposit",
        "ref.swap", "vault.on_swap", "ref.get_deposit", "vault.on_refund_pre", "ref.withdraw",
        "tin.ft_transfer", "ref.exchange_callback_post_withdraw", "vault.on_refund_reconciled"] {
        assert!(rows.iter().any(|x| x.label == hop), "missing hop {hop}: {:?}", rows.iter().map(|x| &x.label).collect::<Vec<_>>());
    }
    let failed: Vec<&str> = rows.iter().filter(|x| !x.ok).map(|x| x.label.as_str()).collect();
    assert_eq!(failed, ["ref.swap"], "only ref.swap may fail in the chain");
    let c = lib_gas_constants();
    assert!(total < c["MIN_EXECUTE_GAS"] * TGAS, "chain burnt {total} within MIN_EXECUTE_GAS");
    let ex = rows.iter().find(|x| x.label == "vault.execute_swap").unwrap();
    assert!(ex.subtree <= c["MIN_EXECUTE_GAS"] * TGAS);
    Ok(())
}

/// Verifies README: "| `ref.withdraw` failed, or ok but Ref deposit fell by less than `amount_out`
/// from the snapshot | token_out still on Ref | strand, reason `withdraw_not_reconciled`; no credit |"
/// and "This covers Ref's `withdraw`, which can re-credit its internal balance and still return
/// success when the token transfer fails."
#[tokio::test]
async fn token_out_transfer_fails_in_ref_withdraw_strands_then_recovers() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    ft_knob(&sb, &sb.tout, "set_fail_transfers", true).await?;
    let ref_tout_before = sb.ft_balance(&sb.tout, sb.rf.id()).await?;

    // tout.ft_transfer fails by design; Ref's post-withdraw callback then re-credits.
    let r = run_swap(&sb, "execute_swap, tout.ft_transfer fails inside ref.withdraw", &["tout.ft_transfer"]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "stranded", "withdraw_not_reconciled"), "stranded withdraw_not_reconciled: {logs:?}");
    assert!(has_event(&logs, "swap_failed"));
    assert!(!has_event(&logs, "swap_executed"));

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(pair_amount(&s["stranded_on_ref"], sb.tout.id().as_str()), AMOUNT_OUT);
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tout).await?, 0, "no phantom credit");
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - AMOUNT_IN);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, AMOUNT_OUT, "Ref re-credited the deposit");
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tout, sb.rf.id()).await?, ref_tout_before, "no tokens left Ref");

    // Unset the knob and recover.
    ft_knob(&sb, &sb.tout, "set_fail_transfers", false).await?;
    let c = lib_gas_constants();
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tout.id(), "amount": AMOUNT_OUT.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    let rows = report(&sb, "recover_from_ref @ MIN_RECOVER_GAS after the knob is off", &r, sb.owner.id()).await?;
    assert!(rows.iter().any(|x| x.label == "tout.ft_transfer" && x.ok));
    assert!(has_event(&r.logs(), "recovered"), "recovered event: {:?}", r.logs());
    let s = sb.state().await?;
    assert_idle(&s);
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.vault_balance(&sb.tout).await?, AMOUNT_OUT);
    assert_eq!(sb.ft_balance(&sb.tout, sb.vault.id()).await?, AMOUNT_OUT);
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tout).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tout, sb.rf.id()).await?, ref_tout_before - AMOUNT_OUT);
    Ok(())
}

/// Verifies README: "| `ft_transfer_call` failed, Ref deposit below `amount_in` | still with the vault |
/// roll back the debit and the day spend ...; `swap_failed: deposit_failed` |"
/// (token_in's ft_transfer_call itself panics, `on_deposit` gets Err, asks `get_deposit`,
/// `on_deposit_reconciled` rolls back).
#[tokio::test]
async fn token_in_ft_transfer_call_fails_rolls_back_via_reconcile() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    ft_knob(&sb, &sb.tin, "set_fail_transfer_calls", true).await?;

    let r = run_swap(&sb, "execute_swap, tin.ft_transfer_call fails outright", &["tin.ft_transfer_call"]).await?;
    let logs = r.logs();
    assert!(has_event_with(&logs, "swap_failed", "deposit_failed"), "swap_failed deposit_failed: {logs:?}");

    let s = sb.state().await?;
    assert_idle(&s);
    assert_eq!(s["swaps_executed"], 0);
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "debit rolled back");
    assert_eq!(pair_amount(&s["spent_today"], sb.tin.id().as_str()), 0, "day spend rolled back");
    assert!(s["stranded_on_ref"].as_array().unwrap().is_empty());
    assert!(s["unverified_on_ref"].as_array().unwrap().is_empty());
    assert_eq!(sb.ref_deposit(sb.vault.id(), &sb.tin).await?, 0);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);
    Ok(())
}

/// Verifies README `withdraw` row: "debits, `ft_transfer` to owner, callback restores on failure"
/// (event `withdraw_failed`).
#[tokio::test]
async fn owner_withdraw_ft_transfer_fails_recredits() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    let c = lib_gas_constants();
    let owner_before = sb.ft_balance(&sb.tin, sb.owner.id()).await?;
    ft_knob(&sb, &sb.tin, "set_fail_transfers", true).await?;

    let w: u128 = 3_000_000;
    let r = sb.owner.call(sb.vault.id(), "withdraw")
        .args_json(json!({"token_id": sb.tin.id(), "amount": w.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_WITHDRAW_GAS"])).transact().await?;
    report_expecting(&sb, "withdraw @ MIN_WITHDRAW_GAS, tin.ft_transfer fails", &r, sb.owner.id(), &["tin.ft_transfer"]).await?;
    let logs = r.logs();
    assert!(has_event(&logs, "withdraw"), "withdraw event: {logs:?}");
    assert!(has_event(&logs, "withdraw_failed"), "withdraw_failed event: {logs:?}");

    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT, "balance re-credited");
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);
    assert_eq!(sb.ft_balance(&sb.tin, sb.owner.id()).await?, owner_before);
    assert_idle(&sb.state().await?);

    // Control: knob off, the same withdraw pays out.
    ft_knob(&sb, &sb.tin, "set_fail_transfers", false).await?;
    let r = sb.owner.call(sb.vault.id(), "withdraw")
        .args_json(json!({"token_id": sb.tin.id(), "amount": w.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_WITHDRAW_GAS"])).transact().await?;
    report(&sb, "withdraw @ MIN_WITHDRAW_GAS, control", &r, sb.owner.id()).await?;
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT - w);
    assert_eq!(sb.ft_balance(&sb.tin, sb.owner.id()).await?, owner_before + w);
    Ok(())
}

/// Verifies README interface row: "`ft_on_transfer` ... owner deposits of pool tokens only, else
/// full refund" and Info risk: "Unknown-token deposits through `ft_on_transfer` are refunded in full."
#[tokio::test]
async fn non_owner_and_non_allowed_token_deposits_refunded_in_full() -> anyhow::Result<()> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;

    // (a) non-owner (the runner) deposits an allowed token.
    sb.mint(&sb.tin, sb.runner.id(), 4_000_000).await?;
    sb.admin.call(sb.tin.id(), "storage_deposit")
        .args_json(json!({"account_id": sb.runner.id(), "registration_only": true}))
        .deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    let r = sb.runner.call(sb.tin.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": sb.vault.id(), "amount": "4000000", "msg": ""}))
        .deposit(YOCTO).gas(tgas(100)).transact().await?;
    report(&sb, "non-owner tin.ft_transfer_call(vault) @ 100 TGas", &r, sb.runner.id()).await?;
    assert!(!has_event(&r.logs(), "deposit"), "no deposit event: {:?}", r.logs());
    assert_eq!(sb.ft_balance(&sb.tin, sb.runner.id()).await?, 4_000_000, "sender refunded in full");
    assert_eq!(sb.vault_balance(&sb.tin).await?, DEPOSIT);
    assert_eq!(sb.ft_balance(&sb.tin, sb.vault.id()).await?, DEPOSIT);

    // (b) owner deposits a token that is in no allowed pool.
    let (_, ft_w, _) = wasms();
    let root = sb.worker.root_account()?;
    let tx = root.create_subaccount("txx").initial_balance(near(10)).transact().await?.into_result()?
        .deploy(&ft_w).await?.into_result()?;
    tx.call("new").args_json(json!({"owner_id": sb.admin.id()})).transact().await?.into_result()?;
    for who in [sb.vault.id(), sb.owner.id()] {
        sb.admin.call(tx.id(), "storage_deposit")
            .args_json(json!({"account_id": who, "registration_only": true}))
            .deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    }
    sb.mint(&tx, sb.owner.id(), 9_000_000).await?;
    let r = sb.owner.call(tx.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": sb.vault.id(), "amount": "9000000", "msg": ""}))
        .deposit(YOCTO).gas(tgas(100)).transact().await?;
    // Role names for the unknown token fall back to its account id in the table.
    report(&sb, "owner deposits non-allowed token @ 100 TGas", &r, sb.owner.id()).await?;
    assert!(!has_event(&r.logs(), "deposit"));
    assert_eq!(sb.ft_balance(&tx, sb.owner.id()).await?, 9_000_000, "sender refunded in full");
    assert_eq!(sb.ft_balance(&tx, sb.vault.id()).await?, 0);
    assert_eq!(sb.vault_balance(&tx).await?, 0);
    Ok(())
}
