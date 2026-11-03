# Privacy track: TEE attestation feasibility

Verdict: **conditional go**. Submit `privacy` only if the demo shows the
attestation check below running against a live NEAR AI Cloud report, with
the limits stated plainly. If we only ship the mock fixture, **no-go**:
`PRODUCT.md` already says to leave `privacy` off until a real check ships.

## What NEAR AI Cloud offers

Inference runs in Intel TDX confidential VMs with NVIDIA TEE GPUs. For a
model, `GET /v1/attestation/report?model=...&signing_algo=ecdsa&nonce=<64 hex>`
(API key required, free) returns per node a `signing_address`,
`nvidia_payload` and `intel_quote`. Each chat reply is signed by that key;
`GET /v1/signature/{chat_id}` returns `text = model:request_hash:response_hash`
and a signature. Source: the `near-ai-cloud` skill references and
docs.near.ai/cloud. No network was used to write this.

## What `src/privacy/attestation.mjs` checks offline

Run `node scripts/attest-check.mjs` (add `--tamper` to see a reject).

- Report structure: `model_attestations` present, each node has a
  well-formed signing address, a parseable `nvidia_payload`, an `intel_quote`.
- Nonce binding: we use `nonce = sha256(request body)`, so the report is tied
  to one request. We check the report echoes it and that the quote's
  REPORTDATA bytes (offset 568, per the TDX v4 layout as we understand it)
  contain the nonce and the signing address.
- Model id: matches what we asked for, when the report names one.
- If a chat signature is supplied: its signed text names our model and
  request hash, and its signer is one of the attested nodes.

Result is `consistent` or `reject`, never `verified`.

## What is NOT verified (and we do not pretend to)

- The TDX quote's signature and Intel certificate chain. Needs `dcap-qvl` and
  Intel collateral. Without it, the REPORTDATA check above reads
  unauthenticated bytes: anyone can write a JSON file that passes it.
- NVIDIA NRAS. Needs a POST to `nras.attestation.nvidia.com`; then JWT
  claims (`x-nvidia-overall-att-result`, `eat_nonce`, `secboot`, `dbgstat`).
- Compose manifest hash against `mr_config`.
- The chat ECDSA signature. Recovery needs keccak256 and secp256k1; Node's
  built-in crypto has neither (SHA3-256 is not keccak). Adding `ethers` or
  `@noble/curves` + `@noble/hashes` would close this; it is a small dependency.
- The synthetic fixture (`src/privacy/fixture.mjs`) is hand made. Passing it
  proves our code path only. The REPORTDATA layout and the position of the
  nonce within it are assumptions to confirm against a real report.

## Does it qualify for the privacy track?

Honestly, only weakly today. The track is about private/verifiable AI. Our
use of NEAR AI Cloud is private inference by construction, but a judge will
ask "how do I know?". Offline consistency checks do not answer that. A
credible entry needs the three online steps: NRAS, `dcap-qvl`, and signature
recovery, run once against a live report and shown in the demo.

## Recommendation

1. **Go, scoped small**, if there is a day and an API key: add a `--live`
   path that fetches one report, posts the payload to NRAS, checks the JWT
   nonce and flags, verifies the quote with `dcap-qvl` (or links the result
   from proof.t16z.com), and recovers the chat signature. About 1 to 2 days.
   Keep the offline module as the first gate and the mock mode for judges
   without keys.
2. **No-go** if that does not fit before the Nov 11 freeze. Drop `privacy`
   from the submission; keep `nfts`, `swarms`, `agents`. Do not describe the
   mock check as attestation anywhere in the README.
3. Either way, README wording: "offline consistency check; hardware
   verification is X or not done", never "verified private".

Open question for the human: is a live API key available, and is the extra
day worth a fourth track.

## Needs wiring by the integrator

Suggested `package.json` line: `"attest:check": "node scripts/attest-check.mjs"`.
