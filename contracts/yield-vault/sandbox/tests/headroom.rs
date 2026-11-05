//! Headroom of the Ref hops: how much heavier than the mock can each Ref method be before
//! the callback chain (at exactly MIN_EXECUTE_GAS / MIN_RECOVER_GAS, Ref inner withdraw gas
//! 20+20) stops completing? mock-ref `set_burn_tgas(method, tgas)` makes one method spin until
//! `env::used_gas()` has grown by `tgas` before its normal work (deterministic). One hop at a
//! time, step 5 TGas, stop at the first failing step. Every trial runs on one sandbox per hop;
//! the first failing trial ends the hop and its end state is checked for consistency.
//!
//! Run: `cargo test --test headroom -- --nocapture --test-threads=1`
//!
//! MEASURED max extra TGas per Ref hop that still lets the chain complete (the knob adds to
//! the mock's own ~1.6 TGas body; `get_deposit` is searched in 1 TGas steps, the rest in 5;
//! `get_deposit` knob hits both get_deposit calls in the chain):
//!
//! | hop                              | attached | swap @ 280 | recover @ 170 | floor asserted |
//! |----------------------------------|----------|-----------|---------------|----------------|
//! | ft_on_transfer                   | 40       | 35        | n/a           | 30             |
//! | swap                             | 50       | 45        | n/a           | 40             |
//! | get_deposit (each of 2 calls)    | 10       | 9         | 9             | 8              |
//! | withdraw                         | 80       | 35        | 35            | 30             |
//! | exchange_callback_post_withdraw  | 20 (+rest)| 55       | 55            | 50             |
//!
//! History: with GAS_REF_WITHDRAW = 60 (commit 7a1d70e) `withdraw` tolerated only +15 and the
//! post-withdraw callback +35; lib.rs now attaches 80, leaving about 40 TGas for Ref's own
//! withdraw body and fees on top of its inner 20+20. At the limit the failing hop runs out of gas and the vault stays
//! consistent (asserted): lock released, value explained by credited + stranded + unverified.
mod common;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const DEPOSIT: u128 = 50_000_000;
// 1_000_000 tin -> 1_500_000 tout exactly (3/2), so value 3*tin + 2*tout is conserved.
const AMOUNT_IN: u128 = 1_000_000;
const MIN_OUT: u128 = 1_400_000;
const MAX_TRIAL_TGAS: u64 = 300;

fn pair_amount(list: &Value, id: &str) -> u128 {
    list.as_array().unwrap().iter().find(|p| p[0] == id)
        .map(|p| p[1].as_str().unwrap().parse().unwrap()).unwrap_or(0)
}

/// Outcome of one trial.
struct Trial {
    complete: bool,
    failed: Vec<String>,
}

struct Snapshot {
    lock_held: bool,
    /// per token: (vault_balance, stranded_on_ref + unverified_on_ref, ft_balance(vault), ref_deposit(vault))
    tin: (u128, u128, u128, u128),
    tout: (u128, u128, u128, u128),
}

async fn snapshot(sb: &Sb) -> anyhow::Result<Snapshot> {
    let s = sb.state().await?;
    let one = |t: &near_workspaces::Contract| (t.id().to_string(), t.clone());
    let (tin_id, tin) = one(&sb.tin);
    let (tout_id, tout) = one(&sb.tout);
    let mut out = Vec::new();
    for (id, t) in [(tin_id, tin), (tout_id, tout)] {
        out.push((
            sb.vault_balance(&t).await?,
            pair_amount(&s["stranded_on_ref"], &id) + pair_amount(&s["unverified_on_ref"], &id),
            sb.ft_balance(&t, sb.vault.id()).await?,
            sb.ref_deposit(sb.vault.id(), &t).await?,
        ));
    }
    Ok(Snapshot {
        lock_held: s["swap_in_flight"] == true || s["recovery_in_flight"] == true || s["release_in_flight"] == true,
        tin: out[0],
        tout: out[1],
    })
}

impl Snapshot {
    /// Value the vault owns across wallet + Ref inner deposits, 3*tin + 2*tout (3/2 rate).
    fn owned_value(&self) -> u128 {
        3 * (self.tin.2 + self.tin.3) + 2 * (self.tout.2 + self.tout.3)
    }
    /// Value the vault's books explain: credited balances plus stranded-on-Ref records.
    fn booked_value(&self) -> u128 {
        3 * (self.tin.0 + self.tin.1) + 2 * (self.tout.0 + self.tout.1)
    }
}

async fn swap_trial(sb: &Sb, c: &std::collections::BTreeMap<String, u64>) -> anyhow::Result<Trial> {
    let before = sb.state().await?["swaps_executed"].as_u64().unwrap();
    let r = sb.runner.call(sb.vault.id(), "execute_swap")
        .args_json(sb.swap_args(AMOUNT_IN, MIN_OUT))
        .gas(tgas(c["MIN_EXECUTE_GAS"])).transact().await?;
    let hash = r.outcome().transaction_hash.to_string();
    let (rows, _) = gas_table(sb, &hash, sb.runner.id()).await?;
    let failed: Vec<String> = rows.iter().filter(|x| !x.ok).map(|x| x.label.clone()).collect();
    let after = sb.state().await?["swaps_executed"].as_u64().unwrap();
    Ok(Trial { complete: failed.is_empty() && after == before + 1, failed })
}

/// Strands AMOUNT_IN of token_in on Ref (swap panics and the refund withdraw's ft_transfer fails), then recovers it with MIN_RECOVER_GAS.
async fn recover_trial(sb: &Sb, c: &std::collections::BTreeMap<String, u64>, method: &str, extra: u64) -> anyhow::Result<Trial> {
    sb.set_ref_burn(method, 0).await?;
    let _strand = sb.strand_token_in(AMOUNT_IN, MIN_OUT).await?;
    let st = sb.state().await?;
    assert_eq!(pair_amount(&st["stranded_on_ref"], sb.tin.id().as_str()) % AMOUNT_IN, 0);
    let stranded_before = pair_amount(&st["stranded_on_ref"], sb.tin.id().as_str());
    assert!(stranded_before >= AMOUNT_IN, "setup: nothing stranded");
    sb.set_ref_burn(method, extra).await?;
    let r = sb.owner.call(sb.vault.id(), "recover_from_ref")
        .args_json(json!({"token_id": sb.tin.id(), "amount": AMOUNT_IN.to_string()}))
        .deposit(YOCTO).gas(tgas(c["MIN_RECOVER_GAS"])).transact().await?;
    let hash = r.outcome().transaction_hash.to_string();
    let (rows, _) = gas_table(sb, &hash, sb.owner.id()).await?;
    let failed: Vec<String> = rows.iter().filter(|x| !x.ok).map(|x| x.label.clone()).collect();
    let stranded_after = pair_amount(&sb.state().await?["stranded_on_ref"], sb.tin.id().as_str());
    Ok(Trial { complete: failed.is_empty() && stranded_after == stranded_before - AMOUNT_IN, failed })
}

async fn fresh() -> anyhow::Result<Sb> {
    let sb = Sb::new().await?;
    sb.register_and_deposit(DEPOSIT).await?;
    Ok(sb)
}

/// (hop, floor): the chain must complete with this hop burning at least `floor` extra TGas.
/// Floor = measured maximum minus one step (see the MEASURED block in the header).
const SWAP_HOPS: [(&str, u64); 5] = [
    ("ft_on_transfer", 30), ("swap", 40), ("get_deposit", GET_DEPOSIT_SWAP_FLOOR), ("withdraw", 30),
    ("exchange_callback_post_withdraw", 50),
];
const RECOVER_HOPS: [(&str, u64); 3] = [
    ("get_deposit", GET_DEPOSIT_RECOVER_FLOOR), ("withdraw", 30), ("exchange_callback_post_withdraw", 50),
];
const GET_DEPOSIT_SWAP_FLOOR: u64 = 8;
const GET_DEPOSIT_RECOVER_FLOOR: u64 = 8;

/// Search step: 5 TGas, except `get_deposit` which only has a 10 TGas budget (GAS_REF_VIEW)
/// and needs 1 TGas resolution.
fn step(method: &str) -> u64 {
    if method == "get_deposit" { 1 } else { 5 }
}

/// Max extra TGas tolerated per hop, plus the end-state snapshot of the first failing trial.
struct HopResult {
    max_ok: u64,
    step: u64,
    first_fail: Option<Trial>,
    end: Snapshot,
}

async fn measure_swap_hop(method: &str) -> anyhow::Result<HopResult> {
    let c = lib_gas_constants();
    let sb = fresh().await?;
    let mut max_ok = 0;
    let mut extra = 0;
    loop {
        sb.set_ref_burn(method, extra).await?;
        let t = swap_trial(&sb, &c).await?;
        if !t.complete {
            let end = snapshot(&sb).await?;
            return Ok(HopResult { max_ok, step: step(method), first_fail: Some(t), end });
        }
        max_ok = extra;
        extra += step(method);
        if extra > MAX_TRIAL_TGAS {
            return Ok(HopResult { max_ok, step: step(method), first_fail: None, end: snapshot(&sb).await? });
        }
    }
}

async fn measure_recover_hop(method: &str) -> anyhow::Result<HopResult> {
    let c = lib_gas_constants();
    let sb = fresh().await?;
    let mut max_ok = 0;
    let mut extra = 0;
    loop {
        let t = recover_trial(&sb, &c, method, extra).await?;
        if !t.complete {
            let end = snapshot(&sb).await?;
            return Ok(HopResult { max_ok, step: step(method), first_fail: Some(t), end });
        }
        max_ok = extra;
        extra += step(method);
        if extra > MAX_TRIAL_TGAS {
            return Ok(HopResult { max_ok, step: step(method), first_fail: None, end: snapshot(&sb).await? });
        }
    }
}

/// At the limit the vault must stay consistent: lock released, every token the vault owns
/// (wallet + Ref inner deposit) is explained by a credited balance, a stranded record or an
/// unverified record (never lost, never double counted), and credits never exceed the wallet.
fn assert_consistent_at_limit(what: &str, h: &HopResult) {
    let e = &h.end;
    assert!(!e.lock_held, "{what}: lock still held after the chain ran out of gas");
    assert_eq!(e.owned_value(), e.booked_value(), "{what}: owned value not explained by books");
    assert!(e.tin.0 <= e.tin.2 && e.tout.0 <= e.tout.2, "{what}: credited more than the wallet holds");
    assert_eq!(e.owned_value(), 150_000_000, "{what}: value created or lost vs the 50M tin deposit");
}

fn report_hop(kind: &str, hop: &str, h: &HopResult) {
    println!("HEADROOM {kind} {hop}: max_ok={} TGas (step {}), first failure at +{} failed={:?} lock_held={} tin(bal,stranded+unverified,ft,ref)={:?} tout={:?} owned={} booked={}",
        h.max_ok, h.step, h.max_ok + h.step, h.first_fail.as_ref().map(|t| t.failed.clone()),
        h.end.lock_held, h.end.tin, h.end.tout, h.end.owned_value(), h.end.booked_value());
}

/// Swap chain at exactly MIN_EXECUTE_GAS (280), Ref inner withdraw gas 20+20.
#[tokio::test]
async fn swap_chain_headroom_at_min_execute_gas() -> anyhow::Result<()> {
    for (hop, floor) in SWAP_HOPS {
        let h = measure_swap_hop(hop).await?;
        report_hop("swap", hop, &h);
        assert!(h.first_fail.is_some(), "{hop}: never failed up to +{MAX_TRIAL_TGAS} TGas; burn knob broken?");
        assert!(h.max_ok >= floor, "{hop}: headroom {} < floor {floor}", h.max_ok);
        assert_consistent_at_limit(&format!("swap/{hop}"), &h);
    }
    Ok(())
}

/// recover_from_ref at exactly MIN_RECOVER_GAS (170), Ref inner withdraw gas 20+20.
#[tokio::test]
async fn recover_headroom_at_min_recover_gas() -> anyhow::Result<()> {
    for (hop, floor) in RECOVER_HOPS {
        let h = measure_recover_hop(hop).await?;
        report_hop("recover", hop, &h);
        assert!(h.first_fail.is_some(), "{hop}: never failed up to +{MAX_TRIAL_TGAS} TGas; burn knob broken?");
        assert!(h.max_ok >= floor, "{hop}: headroom {} < floor {floor}", h.max_ok);
        assert_consistent_at_limit(&format!("recover/{hop}"), &h);
    }
    Ok(())
}
