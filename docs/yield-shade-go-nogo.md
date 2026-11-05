# Shade Agent go/no-go: owner checklist

This document performs nothing. Nothing in it has been done: no account is created, no contract is deployed, nothing is signed, sent, funded or hosted. Every item below is unchecked and marked "NOT DONE". An item may only be ticked after the owner (Brandon) gave an explicit yes for that item and it was carried out. Everything is testnet; mainnet is out of scope.

Background and sources: [`yield-shade-agent-plan.md`](yield-shade-agent-plan.md). Option table and time boxes: [plan section 9](yield-shade-agent-plan.md#9-gono-go-for-brandon). Step numbers below (plan step N) refer to [plan section 7](yield-shade-agent-plan.md#7-minimal-steps-to-go-live-on-testnet). Risks: plan section 8. Costs: plan section 6. All times UTC.

## Status at a glance

| | |
| --- | --- |
| Decision | not decided (Brandon decides by 2026-11-06) |
| Recommendation | Partial (not a decision) |
| Yes-gated steps done | 0 of 10. All 10 are NOT DONE and unchecked, see [Steps that need an explicit yes](#steps-that-need-an-explicit-yes) |
| Live Shade evidence | none: no transaction id, no signature, no deployed account or contract |
| What exists today | offline dry-run evidence only, runnable without anyone's yes, see [What runs today without a yes](#what-runs-today-without-a-yes-offline) |

## Decision

| | |
| --- | --- |
| Options | **Go** (full Shade plus TEE on Phala), **Partial** (local-mode agent contract, real MPC signature, derived key as executor, one real `execute_swap`), **No-go** (keep dry-run evidence only) |
| Recommendation | **Partial** |
| Decide by | 2026-11-06 |
| Partial time box | 12 h total. Checkpoint 1 by 2026-11-09: first real signature (plan step 8). Checkpoint 2 by 2026-11-11: first real `execute_swap` (plan step 10). TEE leg (plan step 12) only decided after step 10 and not after 2026-11-11. |
| Hard fallback to No-go | 2026-11-11 23:59 at the latest (earlier if checkpoint 1 is missed) |
| My decision | [ ] Go   [ ] Partial   [ ] No-go   (not decided) |

## What runs today without a yes (offline)

A judge or anyone with a fresh clone can run these now. They sign, send and deploy nothing, need no keys or accounts, and make no network call. Each command is run from the repository root after `npm install`; the quoted lines are what it really prints (a test, `scripts/yield-shade.readme.test.mjs`, fails if they drift).

1. Run `npm run yield:shade:dry-run`. See `SHADE AGENT RUNNER PLAN - DRY RUN - offline, nothing signed, nothing sent` and `dry_run: true, signed: false, sent: false`. Exit 0.
2. Run `npm run yield:shade:dry-run -- --json`. See `"dry_run": true,`, `"signed": false,` and `"sent": false,`. Exit 0.
3. Run `npm run yield:shade:dry-run -- --sign`. See `yield:shade:dry-run: refused: --sign is not allowed. Dry run only; nothing is signed, sent or sent to mainnet.` Exit 1.
4. Run `npm run yield:shade:check`. See `yield shade: dry_run true, signed false, sent false, network testnet; no near CLI, network or subprocess call; 5 refused flags and NEAR_NETWORK=mainnet exit 1`. Exit 0.

Also offline:

- Tests (plan section 10): `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs`, and `gtimeout 900 node --test scripts/yield-shade.readme.test.mjs` for the README and checklist quotes.
- `bash scripts/verify.sh` runs `npm run yield:shade:check` as its `yield shade` stage.
- The derivation code reproduces the keys returned by live read-only testnet view calls on `v1.signer-prod.testnet`, captured 2026-11-04 in `spikes/shade/evidence/testnet-mpc-views.txt` (for example `yield-agent.testnet` with path `yield-vault-1`). The dry run's own derived key belongs to the invented placeholder `shade-agent.yield-demo.testnet`; it is computed by the same code and was not queried on chain.

## Steps that need an explicit yes

Each item needs its own yes. Costs come from the plan; "unknown, see plan section 6" means no number exists.

- [ ] **1. Create and fund testnet accounts** (plan step 4). Sponsor, agent contract, executor and vault owner accounts, created through the testnet faucet and `shade auth set all testnet create-new` (creates keys). Cost: testnet faucet NEAR, no real value; plan section 6 totals about 15 NEAR testnet plus an unknown Phala bill. Kill switch: stop; unused testnet accounts hold nothing of value. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **2. Deploy the yield vault and call `add_runner(executor)`** (plan step 5). Owner account signs a deploy of `contracts/yield-vault` and then `add_runner({"runner_id": "<executor>"})` with exactly 1 yocto. Cost: deploy storage and initial funding amounts unknown, see plan section 6; `add_runner` 1 yocto plus gas. Rollback: `revoke_runner` (1 yocto) removes the runner; `revoke_all_runners` removes all runners and pauses the vault. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **3. Deploy the agent contract in local mode** (plan step 7). `environment: local`, `shade deploy` deploys the Shade agent contract (`requires_tee=false`), our deployment of the shade-contract-template, linked to `v1.signer-prod.testnet`. Cost: 8 NEAR testnet funding (`funding_amount: 8`, plan section 6). Rollback: `remove_agent` / measurement removal stops new signature requests, but signatures already produced stay valid until used, so see items 2 and 6 for the real revocations. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **4. Run the agent and whitelist it** (plan step 7). `shade whitelist` calls `whitelist_agent_for_local` (owner only, local mode only) for the agent's implicit account, whose own ephemeral keys pay gas. Cost: gas plus sponsor funding, a few NEAR testnet (estimate, plan section 6). Rollback: `remove_agent` on the agent contract. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **5. First real MPC signature** (plan step 8). The agent calls `request_signature` on the agent contract, which calls `sign` on `v1.signer-prod.testnet` (domain 1, ed25519) with the tx hash as payload; record the response encoding and verify against the derived key. Cost: 1 yocto for `sign` plus gas (MPC live config 15 Tgas minimum); the agent contract's internal gas and deposit are unknown, see plan sections 5 and 6. Kill switch: stop calling; a signature alone moves nothing until it is attached to a transaction and the derived key is an access key (item 6). Checkpoint 1: by 2026-11-09, else fall back to No-go. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **6. `AddKey` of the derived ed25519 key on the executor account** (plan step 9). The executor account owner signs `AddKey` for the MPC-derived public key as a function-call key: receiver the vault, methods `["execute_swap"]`, allowance 1 NEAR (1000000000000000000000000 yocto, a choice and not measured). Cost: the allowance is a spending cap for gas, not a transfer; the executor needs a NEAR balance for gas, amount unknown, see plan section 6. Rollback: `DeleteKey` of that key on the executor (independent of the vault). An exhausted key cannot be refilled; rotate with `DeleteKey` plus `AddKey`, each needing its own yes. Status: NOT DONE - needs YES

- [ ] **7. First real `execute_swap`** (plan step 10). One signed transaction, 280 Tgas, 0 deposit, tiny amount, signed with the MPC signature and broadcast by the agent. Cost: up to about 0.028 NEAR gas prepaid at the assumed minimum gas price (unconfirmed, plan section 3), plus the tiny swap amount. Kill switch: `revoke_runner` or `revoke_all_runners` (vault side, 1 yocto), or `DeleteKey` (account side). Checkpoint 2: by 2026-11-11, else fall back to No-go. Needed for Go and Partial. Status: NOT DONE - needs YES

- [ ] **8. Exercise both kill switches** (plan step 11). Owner signs `revoke_runner` (1 yocto) and the executor signs `DeleteKey`, proving both revocations work. Cost: 1 yocto plus gas; the key and runner must be re-added afterwards if the demo continues. Status: NOT DONE - needs YES

- [ ] **9. Phala TEE leg** (plan step 12; Go only, optional for Partial). `shade plan`, then `environment: TEE`, `docker login` and image push, Phala Cloud CVM deploy (`tdx.small`), `approve_measurements` / `approve_ppids`, `register_agent` (about 0.005 NEAR deposit). Cost: Phala bill unknown, see plan section 6 (check cloud.phala.network pricing before approving); docker registry free tier (estimate). Rollback: delete the CVM deployment in Phala Cloud, `remove_agent` and remove the approved measurements on the agent contract. Decide only after item 7 (plan step 10) works and not after 2026-11-11. Status: NOT DONE - needs YES

- [ ] **10. Hardening and cleanup** (plan step 13; optional). Remove local mode, remove agent contract access keys, move ownership to a multisig. Cost: gas, amount unknown, see plan section 6. Rollback: none needed beyond the keys held by the owner. Status: NOT DONE - needs YES

Not yes-gated but a decision: plan step 3 (accept the deprecated, unaudited Shade Agent Framework, plan section 0). If that is not acceptable, Partial can call the agent contract and MPC contract directly.

## If Brandon says yes

Nothing in this section has been done. It describes what the owner would run by hand after a yes; it decides nothing and ticks nothing. Each signing or sending step still needs its own explicit yes from Brandon (checklist items 1 to 8 above, by number; the vault steps need the yes of items 1 and 2, the Shade steps items 3 to 8). Testnet only. Placeholders: `<OWNER>.testnet`, `vault.<OWNER>.testnet`, `runner.<OWNER>.testnet`; for Partial also `<sponsor>`, `<agent-contract>` and `<executor>` as in plan section 7. The `near` commands in the runbook are copied from the tool output, and near-cli-rs syntax is UNCONFIRMED against upstream (runbook row N1): run `near --version` and `near contract call-function as-transaction --help` first. The owner needs at least 10 NEAR testnet (outflow 8.525 NEAR + 7 yocto, most of it returned by rollback).

1. Copy the config out of git's way and fill it: `mkdir -p out && cp config/yield-vault.live.example.json out/yield-vault.live.json`. Replace every `<FILL_ME>`, `owner_id`, `vault_id`, `runner_id`, `nft_contract_id`, `token_id`, set `"placeholders": false`. Public keys only. Stop if the tool refuses a field.
2. Run `npm run yield:live:preflight -- --config out/yield-vault.live.json`. It must end with `READY FOR LIVE: yes`. MANUAL items (owner funds, keychain keys, the NFT) are for the owner to confirm. Stop on any FAIL or `READY FOR LIVE: no`.
3. In the shell, `export NEAR_NETWORK=testnet`, `export YIELD_VAULT_ACCOUNT_ID=vault.<OWNER>.testnet`, `export YIELD_RUNNER_ACCOUNT_ID=runner.<OWNER>.testnet`. Then run `npm run yield:live:dry-run -- --config out/yield-vault.live.json --require-ready`. Exit 0 means ready; the PREFLIGHT table shows placeholders filled, the three env names set (values never printed), snapshot fresh (limit 72 h, else `npm run yield:snapshot`). Exit 3 lists what is missing: stop and fix it.
4. Runbook steps 1 to 18 in [`yield-vault-live-runbook.md`](yield-vault-live-runbook.md), one at a time, using the command from your own `dry-run --config` output (the runbook shows the example ids). They create the vault and runner accounts, deploy and `new` the vault, register on both tokens, wrap 0.02 NEAR, pay Ref storage, deposit 0.02 wNEAR, and end with step 18, the swap rules run without side effects. Stop at the first result that differs from the step's "Expected result".
5. Step 19, the one `execute_swap`: runner `runner.<OWNER>.testnet` to `vault.<OWNER>.testnet`, swap 0.01 wNEAR, 280 TGas, deposit 0, shown as step 19 in the dry-run output. Do not send it before step 18 is clean. After it, wait for `swap_in_flight` to read false in the step 20 view.
6. Steps 20 to 26: read the state and balances, then `withdraw` the token_out and unswapped token_in balances to the owner (1 yocto each). Fill the amounts from the view steps; skip a withdraw whose value is 0.

Only if the decision was Partial, after step 6 or in its own window: follow checklist items 1 to 8 in order, with plan section 7 steps 4, 5, 7, 8, 9, 10 and 11. Item 7 replaces the keychain-signed runner of step 19 with the MPC-signed `execute_swap`. Costs and checkpoints (2026-11-09, 2026-11-11) are in the Decision table; unknown figures stay unknown, see plan section 6.

### How to stop or roll back

- Fastest safe stop: runbook "Fastest safe stop", which is steps 27 and 28: `pause`, then `revoke_all_runners`, owner, 1 yocto each, 30 TGas each. It blocks new swaps only; owner deposits and withdrawals still work.
- Shade executor key: `DeleteKey` of the derived key on `<executor>` (checklist item 8). It is independent of the vault.
- Full teardown: runbook "Full teardown order" (steps 27 to 36); never delete the vault (step 35) while any token balance, `stranded_on_ref`, `unverified_on_ref` or Ref deposit is non-zero. For Partial, also item 3's `remove_agent`.
- A swap already in flight cannot be stopped. If it is stuck, wait 10 minutes, then the owner runs `force_release_lock` (1 yocto, at least 100 TGas).
- If any check prints something unexpected, stop and fall back to No-go.

## No-go fallback

If the decision is No-go, or a checkpoint is missed, what ships is the dry-run evidence and nothing live:

- `npm run yield:shade:dry-run` (and `-- --json`) shows the derived executor key, `add_runner`, `AddKey`, the unsigned `execute_swap` transaction, the MPC `sign` request and the revocation calls, with `dry_run: true, signed: false, sent: false`.
- `npm run yield:shade:check` and `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs` prove it is offline.
- The derivation code is checked against live read-only testnet view calls (`spikes/shade/evidence/testnet-mpc-views.txt`); the dry run's own derived key is for an invented placeholder account and was not queried on chain.
- Nothing else: no account, deployment, signature, `AddKey`, `execute_swap` or transaction id exists for the Shade Agent part. All 10 yes-gated steps stay NOT DONE.

README wording change needed for No-go (describe only, not applied): none for the claims, since the README already states the Shade Agent part is a dry run and a plan that signs and sends nothing. Optionally add one sentence to the "Work in progress: Yield Optimizer" paragraph and the "Shade Agent dry run" subsection saying the go/no-go outcome was No-go on the decision date, that no live signature, `AddKey` or `execute_swap` was made, and that the only Shade evidence is the dry run and the read-only derivation check. The README must not describe the executor key as live.

For Partial or Go, after steps are done the README must be changed instead: add numbered "do X, see Y" steps with real transaction ids and explorer links for each completed step, state which steps ran on testnet, state that the TEE leg was or was not done, and update the "not deployed" statements in "Mock caveats and status" and "Yield Optimizer" to match. Not before the transactions exist.
