//! Shared harness: wasm builds, deployment, and the gas table.
//!
//! WASM BUILD CHOICE: `RUSTFLAGS="--cfg near" cargo build --locked --release --target wasm32-unknown-unknown`
//! (rust 1.95 via rust-toolchain.toml), run once per test process into `target/` dirs inside
//! this crate (git-ignored). The sandbox nearcore accepted that output without `cargo near`.
//! The vault is built from `../Cargo.toml` with `--locked` so its Cargo.lock is never touched.
#![allow(dead_code)]

use anyhow::{anyhow, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Once;

pub const TGAS: u64 = 1_000_000_000_000;

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

static BUILD: Once = Once::new();

/// Builds the three wasm files once; returns (vault, mock_ft, mock_ref) bytes.
pub fn wasms() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    BUILD.call_once(|| {
        let root = crate_dir();
        let run = |manifest: PathBuf, target_dir: PathBuf| {
            let st = Command::new("cargo")
                .args(["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"])
                .arg("--manifest-path")
                .arg(&manifest)
                .arg("--target-dir")
                .arg(&target_dir)
                // near-sdk-env only calls the host (panic messages, etc.) under `cfg(near)`,
                // which cargo-near sets; a plain build loses every panic message.
                .env("RUSTFLAGS", "--cfg near")
                .status()
                .expect("spawn cargo");
            assert!(st.success(), "wasm build failed for {manifest:?}");
        };
        run(root.join("../Cargo.toml"), root.join("target/vault-wasm"));
        run(root.join("mocks/Cargo.toml"), root.join("target/mocks-wasm"));
    });
    let root = crate_dir();
    let rd = |p: &str| std::fs::read(root.join(p)).unwrap_or_else(|e| panic!("{p}: {e}"));
    (
        rd("target/vault-wasm/wasm32-unknown-unknown/release/yield_vault.wasm"),
        rd("target/mocks-wasm/wasm32-unknown-unknown/release/mock_ft.wasm"),
        rd("target/mocks-wasm/wasm32-unknown-unknown/release/mock_ref.wasm"),
    )
}

pub fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}

pub fn tgas(n: u64) -> Gas {
    Gas::from_gas(n * TGAS)
}

/// Gas constants parsed from `../src/lib.rs` (`pub const X: Gas = Gas::from_tgas(N);`).
pub fn lib_gas_constants() -> BTreeMap<String, u64> {
    let src = std::fs::read_to_string(crate_dir().join("../src/lib.rs")).expect("read lib.rs");
    let mut m = BTreeMap::new();
    for line in src.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("pub const ") {
            if let Some((name, tail)) = rest.split_once(": Gas = Gas::from_tgas(") {
                if let Some(n) = tail.split(')').next().and_then(|n| n.parse().ok()) {
                    m.insert(name.to_string(), n);
                }
            }
        }
    }
    m
}

pub struct Sb {
    pub worker: Worker<Sandbox>,
    pub admin: Account,
    pub owner: Account,
    pub runner: Account,
    pub vault: Contract,
    pub tin: Contract,
    pub tout: Contract,
    pub rf: Contract,
}

pub const POOL: u64 = 7;
/// tin -> tout: 3/2 token_out per token_in.
pub const RATE_NUM: u128 = 3;
pub const RATE_DEN: u128 = 2;

async fn sub(root: &Account, name: &str, bal: u128) -> Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(near(bal))
        .transact()
        .await?
        .into_result()?)
}

impl Sb {
    /// Deploys everything, inits the vault, registers accounts, mints, funds the pool.
    /// Does NOT register the vault on Ref and does NOT deposit into the vault.
    pub async fn new() -> Result<Sb> {
        let (vault_w, ft_w, ref_w) = wasms();
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let admin = sub(&root, "admin", 10).await?;
        let owner = sub(&root, "owner", 50).await?;
        let runner = sub(&root, "runner", 20).await?;
        let vault = sub(&root, "vault", 30).await?.deploy(&vault_w).await?.into_result()?;
        let tin = sub(&root, "tin", 10).await?.deploy(&ft_w).await?.into_result()?;
        let tout = sub(&root, "tout", 10).await?.deploy(&ft_w).await?.into_result()?;
        let rf = sub(&root, "rf", 30).await?.deploy(&ref_w).await?.into_result()?;

        for t in [&tin, &tout] {
            t.call("new").args_json(json!({ "owner_id": admin.id() })).transact().await?.into_result()?;
        }
        rf.call("new").args_json(json!({ "owner_id": admin.id() })).transact().await?.into_result()?;

        let config = json!({
            "strategy": "aloof",
            "allowed_pools": [{
                "pool_id": POOL,
                "token_a": tin.id(), "token_b": tout.id(),
                "min_rate_a_to_b": { "num": "1", "den": "1" },
                "min_rate_b_to_a": { "num": "1", "den": "4" },
            }],
            "limits": [
                { "token_id": tin.id(), "max_trade": "10000000", "daily_cap": "50000000" },
                { "token_id": tout.id(), "max_trade": "10000000", "daily_cap": "50000000" },
            ],
            "runners": [runner.id()],
        });
        vault
            .call("new")
            .args_json(json!({
                "owner_id": owner.id(),
                "nft_contract_id": "nft.test.near",
                "token_id": "1",
                "ref_exchange_id": rf.id(),
                "config": config,
            }))
            .transact()
            .await?
            .into_result()?;

        let sb = Sb { worker, admin, owner, runner, vault, tin, tout, rf };
        // NEP-145 registrations on both tokens.
        for t in [&sb.tin, &sb.tout] {
            for who in [sb.vault.id(), sb.owner.id(), sb.rf.id()] {
                sb.admin
                    .call(t.id(), "storage_deposit")
                    .args_json(json!({ "account_id": who, "registration_only": true }))
                    .deposit(NearToken::from_millinear(10))
                    .transact()
                    .await?
                    .into_result()?;
            }
        }
        // Pool + liquidity (book-keeping on Ref, real tokens minted to Ref).
        let liq = "1000000000";
        sb.admin
            .call(sb.rf.id(), "add_pool")
            .args_json(json!({
                "pool_id": POOL, "token_a": sb.tin.id(), "token_b": sb.tout.id(),
                "rate_num": RATE_NUM.to_string(), "rate_den": RATE_DEN.to_string(),
            }))
            .transact().await?.into_result()?;
        sb.admin
            .call(sb.rf.id(), "fund_pool")
            .args_json(json!({ "pool_id": POOL, "amount_a": liq, "amount_b": liq }))
            .transact().await?.into_result()?;
        for t in [&sb.tin, &sb.tout] {
            sb.mint(t, sb.rf.id(), 1_000_000_000).await?;
        }
        sb.mint(&sb.tin, sb.owner.id(), 100_000_000).await?;
        Ok(sb)
    }

    /// Sets the gas Ref's `withdraw` attaches to its inner ft_transfer / resolve callback.
    pub async fn set_ref_withdraw_gas(&self, transfer: u64, resolve: u64) -> Result<()> {
        self.admin.call(self.rf.id(), "set_withdraw_gas")
            .args_json(json!({"transfer_tgas": transfer, "resolve_tgas": resolve}))
            .transact().await?.into_result()?;
        Ok(())
    }

    /// Makes the named Ref method burn `tgas` extra TGas before its normal work (0 clears).
    pub async fn set_ref_burn(&self, method: &str, tgas: u64) -> Result<()> {
        self.admin.call(self.rf.id(), "set_burn_tgas")
            .args_json(json!({"method": method, "tgas": tgas}))
            .transact().await?.into_result()?;
        Ok(())
    }

    /// Owner funds Ref storage for the vault and deposits `amount` of token_in into it.
    pub async fn register_and_deposit(&self, amount: u128) -> Result<()> {
        let c = lib_gas_constants();
        self.owner.call(self.vault.id(), "register_on_ref")
            .deposit(near(1)).gas(tgas(c["MIN_REGISTER_GAS"])).transact().await?.into_result()?;
        self.owner.call(self.tin.id(), "ft_transfer_call")
            .args_json(json!({"receiver_id": self.vault.id(), "amount": amount.to_string(), "msg": ""}))
            .deposit(NearToken::from_yoctonear(1)).gas(tgas(100)).transact().await?.into_result()?;
        Ok(())
    }

    pub fn swap_args(&self, amount_in: u128, min_out: u128) -> Value {
        json!({"proposal": {
            "pool_id": POOL, "token_in": self.tin.id(), "token_out": self.tout.id(),
            "amount_in": amount_in.to_string(), "min_amount_out": min_out.to_string()}})
    }

    pub async fn mint(&self, t: &Contract, to: &AccountId, amount: u128) -> Result<()> {
        self.admin
            .call(t.id(), "mint")
            .args_json(json!({ "account_id": to, "amount": amount.to_string() }))
            .transact().await?.into_result()?;
        Ok(())
    }

    pub async fn ft_balance(&self, t: &Contract, who: &AccountId) -> Result<u128> {
        let s: String = t.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
        Ok(s.parse()?)
    }

    pub async fn ref_deposit(&self, who: &AccountId, t: &Contract) -> Result<u128> {
        let s: String = self.rf
            .view("get_deposit_view")
            .args_json(json!({ "account_id": who, "token_id": t.id() }))
            .await?.json()?;
        Ok(s.parse()?)
    }

    pub async fn vault_balance(&self, t: &Contract) -> Result<u128> {
        let s: String = self.vault.view("get_balance").args_json(json!({ "token_id": t.id() })).await?.json()?;
        Ok(s.parse()?)
    }

    pub async fn state(&self) -> Result<Value> {
        Ok(self.vault.view("get_state").await?.json()?)
    }
}

// ------------------------------------------------------------------ gas table

pub struct Row {
    pub depth: usize,
    pub label: String,
    pub attached: u64,
    pub burnt: u64,
    pub subtree: u64,
    pub constant: Option<(String, u64)>,
    pub ok: bool,
}

fn role(sb: &Sb, id: &str) -> String {
    let m = [
        (sb.vault.id().as_str(), "vault"),
        (sb.rf.id().as_str(), "ref"),
        (sb.tin.id().as_str(), "tin"),
        (sb.tout.id().as_str(), "tout"),
        (sb.owner.id().as_str(), "owner"),
        (sb.runner.id().as_str(), "runner"),
    ];
    m.iter().find(|(a, _)| *a == id).map(|(_, r)| r.to_string()).unwrap_or_else(|| id.to_string())
}

/// Which `lib.rs` constant funds this receipt (None where lib.rs has no constant).
fn constant_for(role_exec: &str, method: &str, role_pred: &str) -> Option<&'static str> {
    let tok = role_exec == "tin" || role_exec == "tout";
    Some(match (role_exec, method) {
        ("vault", "execute_swap") => "MIN_EXECUTE_GAS",
        ("vault", "on_deposit") => "GAS_CB_DEPOSIT",
        ("vault", "on_swap") => "GAS_CB_SWAP",
        ("vault", "on_withdraw_pre") => "GAS_CB_WITHDRAW_PRE",
        ("vault", "on_withdraw_reconciled") | ("vault", "on_deposit_reconciled") => "GAS_CB_RECONCILE",
        ("vault", "withdraw") => "MIN_WITHDRAW_GAS",
        ("vault", "on_owner_withdraw") => "GAS_CB_FINAL",
        ("vault", "recover_from_ref") => "MIN_RECOVER_GAS",
        ("vault", "on_recover_pre") => "GAS_CB_RECOVER_PRE",
        ("vault", "on_recover") => "GAS_CB_WITHDRAW_DONE",
        ("vault", "on_recover_reconciled") => "GAS_CB_RECONCILE",
        ("vault", "sync_balance") => "MIN_SYNC_GAS",
        ("vault", "on_sync_balance") => "GAS_CB_SYNC",
        ("vault", "register_on_ref") => "MIN_REGISTER_GAS",
        ("vault", "on_register") => "GAS_CB_REGISTER",
        ("vault", "force_release_lock") => "MIN_FORCE_RELEASE_GAS",
        ("vault", "on_force_release_swap") | ("vault", "on_force_release_recovery") => "GAS_CB_RELEASE",
        ("vault", "withdraw_ref_storage") => "MIN_STORAGE_WITHDRAW_GAS",
        ("ref", "swap") => "GAS_REF_SWAP",
        ("ref", "withdraw") => "GAS_REF_WITHDRAW",
        ("ref", "get_deposit") => "GAS_REF_VIEW",
        ("ref", "storage_deposit") => "GAS_STORAGE_DEPOSIT",
        ("ref", "storage_withdraw") => "GAS_STORAGE_DEPOSIT",
        (_, "ft_transfer_call") if tok && role_pred == "vault" => "GAS_FT_TRANSFER_CALL",
        (_, "ft_transfer") if tok && role_pred == "vault" => "GAS_FT_TRANSFER",
        (_, "ft_balance_of") if tok && role_pred == "vault" => "GAS_FT_VIEW",
        _ => return None,
    })
}

/// Fetches the full tx tree from the sandbox RPC and builds the per-receipt table.
pub async fn gas_table(sb: &Sb, tx_hash: &str, signer: &AccountId) -> Result<(Vec<Row>, u64)> {
    let consts = lib_gas_constants();
    let resp: Value = reqwest::Client::new()
        .post(sb.worker.rpc_addr())
        .json(&json!({
            "jsonrpc": "2.0", "id": "g", "method": "EXPERIMENTAL_tx_status",
            "params": { "tx_hash": tx_hash, "sender_account_id": signer, "wait_until": "FINAL" }
        }))
        .send().await?.json().await?;
    let r = resp.get("result").ok_or_else(|| anyhow!("rpc: {resp}"))?;
    let g = |v: &Value| -> u64 { v["gas_burnt"].as_u64().unwrap_or(0) };
    // receipt id -> (outcome, receipt)
    let mut outs: BTreeMap<String, &Value> = BTreeMap::new();
    for o in r["receipts_outcome"].as_array().unwrap() {
        outs.insert(o["id"].as_str().unwrap().to_string(), o);
    }
    let mut recs: BTreeMap<String, &Value> = BTreeMap::new();
    for rc in r["receipts"].as_array().unwrap() {
        recs.insert(rc["receipt_id"].as_str().unwrap().to_string(), rc);
    }
    let txo = &r["transaction_outcome"]["outcome"];
    let mut total = g(txo);

    fn subtree(id: &str, outs: &BTreeMap<String, &Value>) -> u64 {
        let Some(o) = outs.get(id) else { return 0 };
        let own = o["outcome"]["gas_burnt"].as_u64().unwrap_or(0);
        own + o["outcome"]["receipt_ids"].as_array().unwrap().iter()
            .map(|c| subtree(c.as_str().unwrap(), outs)).sum::<u64>()
    }

    let mut rows = Vec::new();
    // Walk breadth-first from the tx outcome's receipts, in receipt-id order of creation.
    let mut queue: Vec<(String, usize)> = txo["receipt_ids"].as_array().unwrap().iter()
        .map(|c| (c.as_str().unwrap().to_string(), 0)).collect();
    let mut i = 0;
    while i < queue.len() {
        let (id, depth) = queue[i].clone();
        i += 1;
        let Some(o) = outs.get(&id) else { continue };
        let oc = &o["outcome"];
        total += g(oc);
        for c in oc["receipt_ids"].as_array().unwrap() {
            queue.push((c.as_str().unwrap().to_string(), depth + 1));
        }
        let Some(rc) = recs.get(&id) else { continue };
        let fc = rc["receipt"]["Action"]["actions"]
            .as_array()
            .and_then(|a| a.iter().find_map(|x| x.get("FunctionCall")));
        let Some(fc) = fc else { continue }; // refunds / data receipts
        let method = fc["method_name"].as_str().unwrap().to_string();
        let exec = role(sb, oc["executor_id"].as_str().unwrap());
        let pred = role(sb, rc["predecessor_id"].as_str().unwrap());
        let ok = oc["status"].get("SuccessValue").is_some() || oc["status"].get("SuccessReceiptId").is_some();
        if !ok {
            println!("   [failed receipt {exec}.{method}] {}", oc["status"]);
        }
        let constant = constant_for(&exec, &method, &pred)
            .and_then(|n| consts.get(n).map(|v| (n.to_string(), *v)));
        rows.push(Row {
            depth,
            label: format!("{exec}.{method}"),
            attached: fc["gas"].as_u64().unwrap(),
            burnt: g(oc),
            subtree: subtree(&id, &outs),
            constant,
            ok,
        });
    }
    Ok((rows, total))
}

pub fn print_table(title: &str, rows: &[Row], total: u64) {
    let t = |g: u64| format!("{:.2}", g as f64 / TGAS as f64);
    println!("\n=== GAS: {title} ===");
    println!(
        "{:<3} {:<34} {:>9} {:>9} {:>9} {:>11} {:>9}  {}",
        "#", "receipt (role.method)", "constant", "attached", "burnt", "subtree", "const-sub", "lib.rs constant"
    );
    for (n, r) in rows.iter().enumerate() {
        let c = r.constant.as_ref().map(|(k, v)| format!("{k} = {v}")).unwrap_or_else(|| "-".into());
        let (cv, head) = match &r.constant {
            Some((_, v)) => (t(*v * TGAS), format!("{:.2}", (*v * TGAS) as f64 / TGAS as f64 - r.subtree as f64 / TGAS as f64)),
            None => ("-".to_string(), "-".to_string()),
        };
        println!(
            "{:<3} {:<34} {:>9} {:>9} {:>9} {:>11} {:>9}  {}{}",
            n,
            format!("{}{}", "  ".repeat(r.depth.min(8)), r.label),
            cv, t(r.attached), t(r.burnt), t(r.subtree),
            head,
            c,
            if r.ok { "" } else { "  FAILED" }
        );
    }
    println!("total gas burnt for tx (tx + all receipts): {} TGas", t(total));
    println!("(TGas. attached = what the receipt actually got, which can exceed the constant because near-sdk hands unused gas to callbacks;\n subtree = own burnt + all descendant receipts; const-sub = constant - subtree, negative means the constant is too small)");
}

/// Prints the table and asserts every function-call receipt succeeded.
pub async fn report(sb: &Sb, title: &str, res: &near_workspaces::result::ExecutionFinalResult, signer: &AccountId) -> Result<Vec<Row>> {
    report_expecting(sb, title, res, signer, &[]).await
}

/// Like `report`, but the receipts named in `may_fail` (role.method) are expected to
/// fail; the final result may then fail too. Everything else must succeed.
pub async fn report_expecting(sb: &Sb, title: &str, res: &near_workspaces::result::ExecutionFinalResult, signer: &AccountId, may_fail: &[&str]) -> Result<Vec<Row>> {
    let hash = res.outcome().transaction_hash.to_string();
    let (rows, total) = gas_table(sb, &hash, signer).await?;
    print_table(title, &rows, total);
    for r in &rows {
        assert!(r.ok || may_fail.contains(&r.label.as_str()), "{title}: unexpected failed receipt {}", r.label);
    }
    if may_fail.is_empty() {
        assert!(res.is_success(), "{title}: final result failed: {:?}", res.failures());
    }
    Ok(rows)
}
