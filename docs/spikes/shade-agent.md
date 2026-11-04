# Spike: Shade Agents + chain signatures for the Yield Optimizer

Status: Spike complete (dry-run only; nothing was signed, sent or deployed). Go/no-go decision: 2026-11-06. Feature freeze: 2026-11-11.

## Verdict

**Conditional GO, scoped down.** Take the decentralized path only as a *testnet, thin-slice* demo, and keep the existing centralized executor as the default path that the judge walkthrough relies on.

- The risky cryptographic half is de-risked. The ed25519 key that the MPC network will derive for our agent contract is computed offline and matched the live testnet contract byte-for-byte (13 passing tests, `spikes/shade/chainsig.test.mjs`). The sign request and the NEAR transaction it signs are built and printed by `node spikes/shade/dry-run.mjs`.
- The unproven half is the live loop: deploying the agent contract, registering a TEE (or whitelisted local) agent, and getting one real signature back. That needs spending testnet NEAR and, for the real attestation story, a paid Phala deployment. Neither was done here.
- Rule for 2026-11-06: **GO** if Brandon approves the three items in "What Brandon must approve" by end of day 2026-11-06. **NO-GO** (fall back to centralized executor plus this document and the dry-run as "designed, derivation verified") if not approved by then, because approving later leaves under 5 days to the 2026-11-11 freeze for a live loop plus a Phala deploy that nobody has run yet. The NO-GO fallback still ships real, tested value.

## Q1. Shade Agents: local dev mode, what needs Phala, attestation

Source: `/tmp/shade-research/tpl/r` (shade-agent-template) and `/tmp/shade-research/fw/r` (framework). Framework README warns it has **not been formally audited**.

- **Local mode works without Phala.** `deployment.yaml` has `environment: local | TEE`. In `local`, the agent runs on our machine (`npm run dev`), the CLI deploys the agent contract to testnet, and the agent account is added by hand with `shade whitelist` (contract method `whitelist_agent_for_local`, owner-only). The contract is initialised with `requires_tee = false`, and `shade-agent-js` submits a fake zero-filled attestation that the contract accepts only when `requires_tee` is false (`shade-agent-js/src/utils/tee.ts:69`, `agent-contract/src/lib.rs`).
- **What needs Phala (or any Dstack TEE host).** Only `environment: TEE`: the CLI builds and pushes a Docker image (needs Docker Hub login), deploys to Phala Cloud (needs a Phala API key; instance type in the template is `tdx.small`) and prints the URL. A real Intel TDX quote is produced only here.
- **Attestation.** In TEE mode the agent calls `register_agent(attestation)` on the agent contract. The contract verifies the Dstack/TDX attestation and checks it against owner-approved **measurements** (`approve_measurements`) and approved **PPIDs** (`approve_ppids`), which pin the code image and the physical CPU. An attestation expires (`update_attestation_expiration_time`), so the agent must re-register periodically. Only registered agents may call `request_signature`. `requires_tee = false` therefore means anyone the owner whitelists can sign, so local mode proves plumbing, not trust.
- **Repo overlap.** This repo already parses TDX v5 quotes (`feat(attest): parse TDX v5 quotes`, #139), so a quote from Phala can be inspected with existing code. Not tested against a real Phala quote in this spike.
- **Reproducibility.** The framework documents reproducible builds (`docs/concepts/reproducability.md`), which is what makes a measurement meaningful to a judge. The template has `reproducible_build: false` by default; turning it on adds build time and risk.

## Q2. Chain signatures on testnet: an ed25519 key controlling a NEAR account

Evidence: `spikes/shade/evidence/testnet-mpc-views.txt` (view calls only, captured 2026-11-04T05:26Z against `v1.signer-prod.testnet`).

- **Ed25519 is supported on testnet.** `public_key` with `domain_id=1` returns `ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2` (domain 0 is secp256k1). The template's `internal_request_signature` already maps `"Eddsa"` to domain 1.
- **Derivation verified.** `derived_public_key` for `(yield-agent.testnet, "yield-vault-1")` is `ed25519:4FLkw3i5QV11843yboCvBJ4jdSg3ijyLUxzhN47RRdDM` on chain, and `chainsig.mjs` computes the same key offline from the root key (sha3-256 tweak, root + G·tweak mod L, ported from `/tmp/mpcsrc/src/crates/.../kdf.rs`). Two further predecessor/path pairs also match (see tests). The predecessor is the **agent contract**, not the agent's own account, so the derived key is stable across agent restarts and redeploys of the TEE.
- **How the key controls a NEAR account.** A NEAR account accepts any ed25519 public key as an access key, and the MPC network can sign for it. One-time setup (printed by the dry run): `AddKey` on the executor account with the derived key as a **function-call key limited to the vault contract and `execute_swap`**. After that the agent contract can request a signature over the sha256 of a borsh transaction, and the signed transaction is broadcast by anyone. No private key ever exists.
- **Sign request.** `v1.signer-prod.testnet.sign`, deposit 1 yoctoNEAR, at least 15 Tgas attached (`sign_call_gas_attachment_requirement_tera_gas: 15` in the captured config), args `{ path, payload_v2: { Eddsa: <hex sha256> }, domain_id: 1 }`. Built by `buildSignRequest`.
- **Not verified live.** Nothing was signed, so these remain untested: the end-to-end signature, that the broadcast transaction is accepted with a real nonce and block hash (the dry run uses placeholders), signing latency, and the exact signature output encoding we must feed to `attachSignature`. These are the live-loop risks.
- Limitation to design around: the function-call key can only call the vault, so the signed path cannot move funds out except through whatever `execute_swap` allows. That is a feature, and the vault must enforce slippage and token allowlists itself.

## Q3. Minimal decentralized design

```
vault.testnet (our contract, holds funds, enforces limits)
   ^ execute_swap(...)   signed by derived ed25519 key (function-call key)
executor.testnet (NEAR account, AddKey = MPC-derived key)
   ^ signature from v1.signer-prod.testnet.sign
agent-contract.testnet (shade-contract-template; request_signature only for registered agents)
   ^ request_signature(path, payload, "Eddsa")
Shade Agent (local mode, later Phala TEE): fetches quotes, decides, builds tx, asks for signature, broadcasts
```

- **Vault** keeps the policy: allowed tokens, max amount per swap, min output, only `executor` may call `execute_swap`. The agent is untrusted by construction; the TEE adds "it ran the published code", the vault adds "even a compromised agent can only do bounded swaps".
- **Reuse.** The agent contract is the unmodified template (it already has `request_signature` with Eddsa). New code is just the agent (quote, tx build, sign, broadcast) and a vault method; `chainsig.mjs` already provides key derivation, borsh tx and sign request.
- **Slice, in priority order** (cut from the bottom): (1) dry-run plan printed by `dry-run.mjs` and unit tests, already done; (2) agent contract deployed on testnet, local-mode agent whitelisted, one real signature obtained, one tx broadcast; (3) the same with a Phala TEE and approved measurements; (4) reproducible build.
- **What is demonstrable on testnet without sending anything now:** the live `public_key` and `derived_public_key` view calls, the offline derivation matching them, and the full printed plan (AddKey, execute_swap tx hash, MPC sign args). A judge can run `node spikes/shade/dry-run.mjs` and `node --test spikes/shade/*.test.mjs` and compare against the evidence file. Anything beyond this requires signing.

## Cost

| Item | Estimate | Note |
| --- | --- | --- |
| Agent contract funding | 8 NEAR testnet (template default `funding_amount: 8`) | testnet, free from faucet; mainnet not needed |
| Sign call | 1 yocto + 15 Tgas per signature | negligible on testnet |
| Dev accounts (executor, vault, agent contract) | small testnet balances | |
| Phala Cloud (`tdx.small`) | not measured; not stated in the cloned docs | check the Phala dashboard price before approving; delete the deployment afterwards (README warns about ongoing cost) |
| Docker Hub account/image | free tier | needs `docker login` |
| Engineering | live loop about 1 to 1.5 days, Phala TEE about 1 more day, plus unknowns | estimate, not measured |

All of this is testnet; no mainnet action is needed. NEAR Intents is the only mainnet-only integration and is out of scope here.

## What Brandon must approve

By 2026-11-06 (needed for GO):

1. Creating testnet accounts and spending testnet NEAR (about 8 for the agent contract plus small amounts), including `AddKey` on the executor account and deploying the agent contract and vault. These are signed transactions, so they need an explicit yes.
2. Phala Cloud account, API key and a paid `tdx.small` deployment (check price first), plus a Docker Hub login. Optional: without it the demo stays in local mode with `requires_tee = false` and must be described honestly as plumbing only, not trust.
3. Feature-freeze rule: if the live signature is not obtained by end of 2026-11-09, stop and ship the NO-GO fallback (dry-run plus tests plus this document), so the freeze on 2026-11-11 is not at risk.

Also decide: whether the README presents this as a working feature or as a verified design (recommended: say exactly what was and was not run).
