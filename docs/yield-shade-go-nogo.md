# Shade Agent go/no-go: owner checklist

This document performs nothing. Nothing in it has been done: no account is created, no contract is deployed, nothing is signed, sent, funded or hosted. Every item below is unchecked and marked "NOT DONE". An item may only be ticked after the owner (Brandon) gave an explicit yes for that item and it was carried out. Everything is testnet; mainnet is out of scope.

Background and sources: [`yield-shade-agent-plan.md`](yield-shade-agent-plan.md). Option table and time boxes: [plan section 9](yield-shade-agent-plan.md#9-gono-go-for-brandon). Step numbers below (plan step N) refer to [plan section 7](yield-shade-agent-plan.md#7-minimal-steps-to-go-live-on-testnet). Risks: plan section 8. Costs: plan section 6. All times UTC.

## Decision

| | |
| --- | --- |
| Options | **Go** (full Shade plus TEE on Phala), **Partial** (local-mode agent contract, real MPC signature, derived key as executor, one real `execute_swap`), **No-go** (keep dry-run evidence only) |
| Recommendation | **Partial** |
| Decide by | 2026-11-06 |
| Partial time box | 12 h total. Checkpoint 1 by 2026-11-09: first real signature (plan step 8). Checkpoint 2 by 2026-11-11: first real `execute_swap` (plan step 10). TEE leg (plan step 12) only decided after step 10 and not after 2026-11-11. |
| Hard fallback to No-go | 2026-11-11 23:59 at the latest (earlier if checkpoint 1 is missed) |
| My decision | [ ] Go   [ ] Partial   [ ] No-go   (not decided) |

## Already done offline (no yes needed)

These sign, send and deploy nothing and make no network call.

- `npm run yield:shade:dry-run` prints the payloads and ends with `dry_run: true, signed: false, sent: false`. `-- --json` prints the same as JSON; `-- --sign` is refused with exit 1.
- `npm run yield:shade:check` asserts `dry_run` is true, `signed` is false, `sent` is false, and that the dry run makes no `near` CLI, network or subprocess call.
- Offline tests (plan section 10): `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs`, and `node --test scripts/yield-shade.readme.test.mjs` for the README quotes.
- The derived key matches the live testnet view calls in `spikes/shade/evidence/testnet-mpc-views.txt` (captured 2026-11-04, read-only).

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

## No-go fallback

If the decision is No-go, or a checkpoint is missed, what ships is the dry-run evidence and nothing live:

- `npm run yield:shade:dry-run` (and `-- --json`) shows the derived executor key, `add_runner`, `AddKey`, the unsigned `execute_swap` transaction, the MPC `sign` request and the revocation calls, with `dry_run: true, signed: false, sent: false`.
- `npm run yield:shade:check` and `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs` prove it is offline.
- The derived key is checked against live read-only testnet views (`spikes/shade/evidence/testnet-mpc-views.txt`).

README wording change needed for No-go (describe only, not applied): none for the claims, since the README already states the Shade Agent part is a dry run and a plan that signs and sends nothing. Optionally add one sentence to the "Work in progress: Yield Optimizer" paragraph and the "Shade Agent dry run" subsection saying the go/no-go outcome was No-go on the decision date, that no live signature, `AddKey` or `execute_swap` was made, and that the only Shade evidence is the dry run and the read-only derivation check. The README must not describe the executor key as live.

For Partial or Go, after steps are done the README must be changed instead: add numbered "do X, see Y" steps with real transaction ids and explorer links for each completed step, state which steps ran on testnet, state that the TEE leg was or was not done, and update the "not deployed" statements in "Mock caveats and status" and "Yield Optimizer" to match. Not before the transactions exist.
