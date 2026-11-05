# Yield vault runner as a Shade Agent: plan and go/no-go

## 1. Status

PLAN ONLY, DRY RUN. Nothing is deployed, signed, sent, built or pushed. This is not part of the demo. Written 2026-11-05 for the 2026-11-06 go/no-go call by Brandon. It builds on `docs/spikes/shade-agent.md` (earlier spike) and the dry-run code in `spikes/shade/` and `src/yield/shade/`.

Research method: WebFetch of official docs and the NearDeFi/near repos on 2026-11-05. Every claim carries a URL. "Unconfirmed" means I could not read it in a primary source.

## 0. Read this first: facts that change the picture

- **The Shade Agent Framework is deprecated.** https://docs.near.org/ai/shade-agents/introduction says that after 2026-04-19 the framework is no longer maintained as standalone tooling; it stays open source, docs moved to the monorepo https://github.com/NearDeFi/shade-agent-framework/tree/main/docs. Teams using it handle their own fixes. The repo README still says it is not formally audited. https://docs.near.org/llms.txt (fetched 2026-11-05) lists no Shade Agent pages at all, only chain signatures, off-chain compute and OutLayer pages. We would build on an unmaintained, unaudited framework.
- The vault code was read, not assumed (`contracts/yield-vault/src/lib.rs`): `add_runner(runner_id)` (line 867), `revoke_runner(runner_id)` (878), `revoke_all_runners()` (891, also pauses), all `#[payable]` and calling `owner_one_yocto()` (owner only, exactly 1 yocto). There is no `set_runner`. `execute_swap(proposal: SwapProposal)` (line 555) has no `#[payable]` (0 deposit), requires `env::prepaid_gas() >= MIN_EXECUTE_GAS` = 280 Tgas (lines 59, 561), and `check_rules(&proposal, &runner)` gates on the predecessor being in `config.runners`.
- `spikes/shade/dry-run.mjs` builds `execute_swap` args without `pool_id`, without the `{ proposal: ... }` wrapper, and with 50 Tgas (line 34). That would fail on the real vault (missing field; insufficient gas). The new `src/yield/shade/` code fixes this (it uses `EXECUTE_SWAP_GAS` and a sample proposal with `pool_id`). Treat the spike script's swap payload as illustrative only.
- MPC `sign` gas: the contract README says "requires at least 10 Tgas" (https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md) but the live testnet config view says 15 (`spikes/shade/evidence/testnet-mpc-views.txt`). Use the live value, attach more.

## 2. Architecture

```
 Phala Cloud CVM (Intel TDX, dstack OS)         NEAR testnet
 +-----------------------------------+
 | yield-shade-agent (our container) |   1. register_agent(attestation)
 |  - agent NEAR account (implicit,  |----------------------------+
 |    ephemeral keys, lost on reboot)|                            v
 |  - plans a swap (src/yield)       |        +--------------------------------+
 |  - builds borsh tx, hashes it     |   2.   | AGENT CONTRACT (shade-contract |
 |                                   |------->|  -template, our deployment)    |
 +-----------------------------------+ request| owner approves measurements +  |
          ^   ^                         _sign  | PPIDs; only a valid, unexpired |
          |   | 5. signed tx           (path,  | agent may request_signature    |
          |   |    broadcast by agent  payload,+---------------+----------------+
          |   |                        key_type)               | 3. sign({request:
          |   |                                                |   path, payload_v2:
          |   |                                                v   {Eddsa: hex},
          |   |                                +--------------------------------+
          |   +--------------------------------|  v1.signer-prod.testnet (MPC)  |
          |        4. signature (64 bytes)     |  domain 1 = ed25519            |
          |                                    +--------------------------------+
          v
 executor account (NEAR, e.g. executor.<x>.testnet)
   access key = MPC-derived ed25519 key (function-call key:
   receiver = vault, methods = [execute_swap])
          |  6. signed tx: execute_swap, 300 Tgas, 0 deposit
          v
 VAULT (contracts/yield-vault): predecessor = executor must be in config.runners;
 enforces allowlists, caps, min_out itself.
```

- **Predecessor for derivation is the agent contract.** The MPC contract derives the key from (predecessor, path, domain). The agent never calls MPC directly; the agent contract does, so the predecessor is the agent contract id. Source: chain signature tutorial "the contract is the predecessor" (https://docs.near.org/chain-abstraction/chain-signatures/tutorials/controlling-near-accounts/1-setup.md). Consequence: the derived key is stable across TEE restarts. Verified offline vs live: `derived_public_key` for predecessor `yield-agent.testnet`, path `yield-vault-1`, domain 1 = `ed25519:4FLkw3i5QV11843yboCvBJ4jdSg3ijyLUxzhN47RRdDM` (`spikes/shade/evidence/testnet-mpc-views.txt`, `chainsig.mjs`).
- **Two different keys, do not confuse them.** (a) The agent's own ephemeral implicit NEAR account keys, held inside the TEE, which pay for `register_agent` and `request_signature` calls (https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/reference/api.md). (b) The MPC-derived key, which has no private key anywhere and is the executor account's access key.
- The framework's own examples use the agent contract to sign for other chains; using the derived ed25519 key as a NEAR account access key is our design (documented for NEAR accounts in the chain signatures tutorial above, which uses a secp256k1 FullAccess key; our ed25519 function-call variant is UNCONFIRMED live).
- Signing does not guarantee delivery: a signature may be produced but the tx not sent or fail; retries must not create extra valid signatures for one action (https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/concepts/security.md). The tx nonce plus vault `in_flight` handling bound this on our side.

## 3. Authorizing the runner on the vault, kill switches

1. Owner calls `vault.add_runner({"runner_id": "<executor>"})` with exactly 1 yocto, owner key signing (lib.rs 867). Runner list lives in `config.runners`.
2. Separately, the executor account owner submits `AddKey` for the MPC-derived ed25519 public key as a function-call key: `receiver_id = vault`, `method_names = ["execute_swap"]`, allowance set to cover gas (see below). The function-call key cannot attach a deposit, which matches `execute_swap` being non-payable.
3. Kill switch A (vault side): `revoke_runner({runner_id})` (panics `ERR_RUNNER_NOT_FOUND` if absent) or `revoke_all_runners()`, which clears every runner AND pauses the vault (lib.rs 891-897). Each needs the owner and 1 yocto.
4. Kill switch B (account side): `DeleteKey` of the derived key on the executor account. Independent of the vault; works even if the vault were mis-configured. Also `remove_agent` / measurement removal on the agent contract stops new signatures (https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/reference/agent-contract.md), but signatures already produced stay valid until used, so A and B are the real revocations.
5. Gas: `execute_swap` needs >= 280 Tgas prepaid; the tx limit is 300 Tgas, so attach 300. Allowance must cover the fee for 300 Tgas per swap; the exact NEAR burnt depends on the gas price (assume the 0.0001 NEAR/Tgas order of magnitude, UNCONFIRMED here) times the number of swaps; set allowance generously (e.g. 1 NEAR on testnet) and cap swap count in the vault. Unused gas is refunded to the signer, only the burnt part is charged.
6. The executor account needs a NEAR balance for gas; the allowance is only an upper bound on the key's spending.

## 4. What Phala hosting needs

| Need | Detail | Source |
| --- | --- | --- |
| Phala Cloud account + API key | Free account, key from dashboard, stored with `shade auth` | https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/getting-started/quickstart-deploying.md |
| Docker + registry login | `docker login`; CLI builds and pushes the image (`build_docker_image.tag` = `user/name`) | same page; https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/reference/cli.md |
| Instance type | `tdx.small` through `tdx.8xlarge`; template uses `tdx.small` | cli.md; https://raw.githubusercontent.com/NearDeFi/shade-agent-template/main/deployment.yaml |
| dstack version | `0.5.7` or `0.5.8` (template 0.5.8) | cli.md |
| Compose file | `docker_compose_path`; mounts `/var/run/dstack.sock:/var/run/dstack.sock`, `platform: linux/amd64`, port 3000 | https://raw.githubusercontent.com/NearDeFi/shade-agent-template/main/docker-compose.yaml |
| Env vars the template passes | `AGENT_CONTRACT_ID`, `SPONSOR_ACCOUNT_ID`, `SPONSOR_PRIVATE_KEY` (sponsor funds the agent account) | template README, quickstart-deploying.md |
| Measurement approval | `approve_measurements` / `approve_ppids` in `deployment.yaml`; the CLI computes values from the compose file and Phala settings. Pin images by digest, env values are NOT measured. | deployment.yaml; security.md |
| Attestation expiry | `attestation_expiration_time_ms`, template sets 7 days; agent is invalid after expiry and removed; agent must re-`register_agent` (about 0.005 NEAR deposit for first registration) | agent-contract.md; api.md |
| Public logs/sysinfo | booleans in the config, template `true`; turn logs off for anything sensitive | deployment.yaml; security.md |

Caveat: the CLI reference describes a `tee_config.phala.enabled` schema, while the template's `deployment.yaml` uses `deploy_to_phala`. The two differ; which one the current `@neardefi/shade-agent-cli` release accepts is UNCONFIRMED. `shade plan` is the CLI's own dry check.

## 5. Contract ids and methods

| Item | Args | Deposit | Gas | Status |
| --- | --- | --- | --- | --- |
| `v1.signer-prod.testnet` exists, ed25519 domain | `public_key {domain_id:1}` view = `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2` | none | view | CONFIRMED by testnet view call in spikes/shade/evidence/testnet-mpc-views.txt (captured 2026-11-04) |
| MPC `derived_public_key` | `{path, predecessor, domain_id}` | none | view | CONFIRMED by testnet view call in spikes/shade/evidence/testnet-mpc-views.txt; signature per https://raw.githubusercontent.com/near/mpc/main/crates/contract/README.md |
| MPC domain ids | 0 = secp256k1, 1 = ed25519 on testnet | n/a | n/a | CONFIRMED by testnet view calls in evidence (README examples conflict on ids, so the live view wins) |
| MPC `sign` | `{request:{path, payload_v2:{Eddsa:<hex 32..1232 bytes>}, domain_id:1}}` | >= 1 yocto, excess refunded | >= 15 Tgas live config (README says 10; request costs about 7) | args shape CONFIRMED by https://github.com/near/mpc (README) and `.agents/skills/near-smart-contracts/rules/chain-signatures.md` ("request" wrapper); gas 15 CONFIRMED by testnet config view in evidence. Never executed: UNCONFIRMED live |
| MPC `sign` response encoding for ed25519 | skill file shows `{"Ed25519":{"signature":[64 bytes]}}` | n/a | n/a | UNCONFIRMED: only a skill file says this, not a primary source; the README did not specify it. Verify on first live call |
| Agent contract `new` | `requires_tee, attestation_expiration_time_ms, owner_id, mpc_contract_id` | none | n/a | CONFIRMED https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/reference/agent-contract.md |
| Agent contract `approve_measurements`, `approve_ppids`, `remove_agent` | `measurements`, `ppids`, `account_id` | none | n/a | CONFIRMED (same page) |
| Agent contract `whitelist_agent_for_local` | `account_id`, owner only, local mode only | none | n/a | CONFIRMED (same page) |
| Agent contract `register_agent` | `attestation` | >= about 0.00486 NEAR (storage; lib sets 486 bytes) | n/a | CONFIRMED (agent-contract.md; shade-contract-template lib.rs https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/shade-contract-template/src/lib.rs) |
| Agent contract `request_signature` | `{path, payload, key_type}` strings, valid agent only | none mentioned | UNCONFIRMED: caller gas and the internal MPC gas/deposit are in `internal_request_signature`, which I could not read | args CONFIRMED (agent-contract.md); `key_type: "Eddsa"` mapping to domain 1 is UNCONFIRMED (earlier spike claimed it from a local clone; source not readable via fetch) |
| Agent contract mpc id | `v1.signer-prod.testnet` for testnet | n/a | n/a | CONFIRMED (shade-contract-template lib.rs comment) |
| Agent account type | must be an implicit account | n/a | n/a | CONFIRMED (agent-contract.md) |
| Vault `add_runner` | `{runner_id}` | exactly 1 yocto | default | CONFIRMED by reading contracts/yield-vault/src/lib.rs:867 |
| Vault `revoke_runner` | `{runner_id}` | exactly 1 yocto | default | CONFIRMED lib.rs:878 |
| Vault `revoke_all_runners` | `{}` (also pauses) | exactly 1 yocto | default | CONFIRMED lib.rs:891 |
| Vault `execute_swap` | `{proposal:{pool_id, token_in, token_out, amount_in, min_amount_out}}` | 0 (not payable) | >= 280 Tgas, attach 300 | CONFIRMED lib.rs:555-563 |
| Executor `AddKey` (ed25519 function-call key, receiver vault, method execute_swap) | public key, allowance | none | n/a | UNCONFIRMED live: NEAR access-key semantics are standard, but never run with the MPC-derived key; the tutorial used secp256k1 FullAccess. Earlier spike also flagged AddKey nonce 0 as unverified |
| Shade CLI deploy/plan/whitelist/reproduce | see cli.md | n/a | n/a | CONFIRMED command names (cli.md); behavior against our contract UNCONFIRMED |
| Ref/swap pools used by vault | not part of this plan | n/a | n/a | out of scope |

## 6. Costs

| Item | Amount | Status |
| --- | --- | --- |
| Agent contract funding | 8 NEAR testnet (`funding_amount: 8`) | CONFIRMED in template deployment.yaml; testnet faucet, no real value |
| `register_agent` | about 0.005 NEAR, once, again if re-registered after removal | CONFIRMED api.md / agent-contract.md |
| MPC `sign` | 1 yocto + gas per signature | CONFIRMED README |
| Executor account + function-call key allowance | e.g. 1 NEAR testnet | estimate |
| Phala Cloud | no price found in the docs fetched; docs say monitor and delete unused deployments | UNCONFIRMED. Check https://cloud.phala.network pricing for `tdx.small` before approving |
| Docker registry | free tier should suffice | estimate |
| Sponsor account for the agent | few NEAR testnet | estimate |

Mainnet is out of scope. Total testnet funding is about 15 NEAR plus an unknown Phala bill.

## 7. Minimal steps to go live on testnet

Steps marked YES-NEEDED need Brandon's explicit yes (signing, deploy, spend).

1. Review `deploy/shade/` drafts and this plan. No action. (no yes)
2. Run the offline checks in section 10. (no yes)
3. Decide framework risk: deprecated, unaudited (section 0). (decision)
4. Create/fund testnet accounts: sponsor, agent-contract, executor, vault owner via faucet and `shade auth set all testnet create-new`. YES-NEEDED (key creation, funding).
5. Deploy the vault (if not already) and `add_runner(executor)` with 1 yocto. YES-NEEDED (signing).
6. Write the agent runtime and Dockerfile (code only; the payload builders in `src/yield/shade/` already exist). (no yes, no deploy)
7. Local mode first: `environment: local`, `shade deploy` deploys the agent contract (`requires_tee=false`), run the agent, `shade whitelist`. YES-NEEDED (deploy, signing, 8 NEAR).
8. First real signature: agent calls `request_signature` with an ed25519 payload; record the response encoding; verify signature vs `derived_public_key`. YES-NEEDED.
9. `AddKey` of the derived key on the executor as a function-call key. YES-NEEDED (signing).
10. Broadcast one `execute_swap` (300 Tgas, tiny amount) signed with the MPC signature; confirm the vault accepts it. YES-NEEDED.
11. Exercise both kill switches (`revoke_runner`, `DeleteKey`). YES-NEEDED.
12. TEE: `shade plan`, then `environment: TEE`, `docker login`, `build_docker_image` push, Phala deploy, approve measurements/PPIDs, register. YES-NEEDED (docker push, Phala spend, deploy).
13. Remove local-mode, remove agent contract access keys, set a multisig owner (security.md recommendations). YES-NEEDED; optional for a hackathon.

## 8. Risks and open questions

- Framework deprecated since 2026-04-19, unaudited; Phala/dstack schema drift between template and CLI reference (section 4). Pin versions or fall back to hand-written calls.
- Signature encoding from the MPC for ed25519 unconfirmed; transaction nonce/block hash handling and AddKey nonce 0 unverified.
- Latency: the skill file says about 2-3 s per signature (not primary-source). Block hash expiry (about 24 h on NEAR) is not a problem; nonce races between concurrent signed txs are.
- Agent keys are ephemeral; losing them on reboot means re-registering and a new agent account, but the executor/derived key is unaffected.
- TDX physical-host attacks (TEE.fail) can extract secrets (security.md); our guard is the vault's own limits, which is why the vault must stay the enforcer.
- Env vars are not measured: `SPONSOR_PRIVATE_KEY` and any API keys are not covered by attestation. The sponsor key should hold only small funds.
- The vault's `in_flight` and 300 Tgas cap mean one swap at a time; the agent must not double-sign.
- Open: exact `internal_request_signature` gas and deposit; real Phala price; whether judges credit a deprecated framework.
- Hackathon rules: docs/HACKATHON.md lists TEE and function call keys under the track themes (security track mentions "FUNCTION CALL KEYS, TEE ATTESTATION"); no rule requires Shade specifically.

## 9. Go/no-go for Brandon

| Option | What it is | Effort | Risks | If skipped we lose |
| --- | --- | --- | --- | --- |
| Go: full Shade + TEE | Phala CVM, approved measurements, derived-key executor | 20-30 h estimate | deprecated unaudited framework, unknown Phala cost, schema drift, many signing steps, little time to debug | n/a (this is the max) |
| Partial: local-mode agent + real MPC signature | Agent contract with `requires_tee=false`, whitelisted local agent, real `sign`, derived key as executor function-call key, one real `execute_swap` | 8-12 h estimate | proves plumbing not trust; encoding and AddKey unknowns; still deprecated framework (can drop it and call the agent contract / MPC directly) | the TEE attestation story |
| No-go: centralized runner + dry-run evidence | Keep runner key, ship dry-run plan, verified derivation | 0-2 h | judges see a design, not a live primitive | the live real-NEAR-primitive demonstration (chain signatures) |

Recommendation: Partial. Reasoning: judging values real NEAR primitives, and a real MPC signature controlling the executor is the primitive that matters and is reachable by 2026-11-14 23:59 UTC. The TEE leg adds an unaudited, deprecated framework, an unknown Phala bill and several signing steps without enough slack. Timebox Partial to 12 hours; if step 8 (first real signature) fails by 2026-11-09, fall back to No-go with the dry-run evidence. Decide on the TEE leg after step 10 works. Because both Partial and Go share steps 4-11, nothing is wasted. Keep the kill switches (`revoke_runner`, `DeleteKey`) in the demo either way.

## 10. How to check this offline

- `npm run yield:shade:dry-run`: prints this plan's payloads with `dry_run: true`, `signed: false`, `sent: false`; `-- --json` prints the JSON only.
- `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs`
- Compare derivation against `spikes/shade/evidence/testnet-mpc-views.txt`.
- Drafts in `deploy/shade/` are not built or deployed; every file starts with that banner.

## Contradictions with `docs/spikes/shade-agent.md`

- The spike says the framework is a live option; the official docs now say it is deprecated (since 2026-04-19) and unmaintained.
- Spike: `minGasTgas` 15 vs the MPC README's 10; the on-chain config (15) wins. Both are minimums, not attach amounts.
- Spike: `request_signature` `Eddsa` to domain 1 mapping "already" in the template: not readable from fetched sources, listed UNCONFIRMED here.
- Spike's `dry-run.mjs` swap payload is wrong for the real vault (section 0).
- Spike mentions `environment: local | TEE` and `shade whitelist` only; the CLI reference also lists `tee_config.phala.enabled` and a self-hosted dstack server target, so the manifest shape may differ by CLI version.
