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

Run `npm run attest:check` (add `-- --tamper` to see a reject). It checks the
hand-made fixture report from `src/privacy/fixture.mjs`, not a live TEE: no
report is fetched, no network call is made, and the first line of output says
so. The same code path would run on a real report, but nothing in this
repository has been run against one.

- Report structure: `model_attestations` present, each node has a
  well-formed signing address, a parseable `nvidia_payload`, an `intel_quote`.
- Nonce binding: we use `nonce = sha256(request body)`, so the report is tied
  to one request. We check the report echoes it (`nonce-echo`), and we look
  for the nonce and the signing address in the quote's report data
  (`quote-binding`) under the layout assumption described next.
- Model id: matches what we asked for, when the report names one.
- If a chat signature is supplied: its signed text names our model and
  request hash, and its signer is one of the attested nodes.

Each check is `pass`, `fail`, `skip` or `unverifiable`. Only `fail` rejects.
Result is `consistent` or `reject`, never `verified`. The CLI prints
`CONSISTENT, NOT VERIFIED` and exits 0, or `REJECT` and exits 1, and in both
cases lists what was not verified. When a check is `unverifiable` the
consistent summary names it, so "offline fields agree" never hides a field
that could not be read.

### The quote layout assumption behind `quote-binding`

The NEAR AI docs vendored under `.agents/skills/near-ai-cloud` say only that
the signing address and the nonce are "bound in the TDX report data". They do
not say how (raw bytes, a hash of the two, some other encoding), nor which
quote format version is returned, nor how `intel_quote` is encoded. Nothing in
this repository has been run against a real report, so the code works from an
assumption, and it says so in its output.

The assumption: `intel_quote` is hex; it is an Intel DCAP quote format v4 with
a TDX TD report 1.0 body, so the header's first `u16` little-endian is `4`, the
`u32` at byte 4 is `0x81` (TDX), and the 64-byte `report_data` field sits at
bytes 568..632; and the raw 32-byte nonce and the raw 20-byte address both
appear somewhere inside those 64 bytes.

How `quote-binding` reports, given that:

- `pass` only when every part of the assumption is confirmed byte for byte:
  hex, at least 632 bytes, a v4/TDX header, and both raw values found in
  `report_data`. The detail still says the quote itself is unauthenticated.
- `unverifiable`, with the reason, in every other case: not hex, too short, a
  header that is not version 4 / TDX (a v5 quote, say), or a v4 quote whose
  `report_data` does not hold the raw bytes (a hashed binding would look like
  this). A genuine report with a different binding would land here, and the
  check must not call it forged on an assumption we have not confirmed.
- never `fail`. The binding check cannot prove an inconsistency, so it does
  not claim one. A report is still rejected by what the code can prove: a
  malformed signing address (`npm run attest:check -- --tamper`), a report
  that echoes a different nonce, a wrong model, or a chat signature signed by
  an address the report does not attest.

The bundled fixture carries a v4/TDX header and the raw bytes, so it takes the
`pass` path. That is the code path a real v4 report with a raw-byte binding
would take; it is not evidence that NEAR AI binds the values that way.

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
  proves our code path only. The quote layout and the raw-byte binding it
  encodes are our assumptions (see above), to confirm against a real report;
  until then a real report may well come back `quote-binding: unverifiable`.

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

## Hostile model text on the hosted page

In live mode, posts and character sheets are model output and are treated as hostile. `escapeHtml` (`src/viewer/render.mjs`) is the single escaping helper for `out/index.html`, `out/site/index.html` and the viewer. It escapes `& < > " '` once, and replaces control characters and bidi overrides/isolates with U+FFFD so text cannot reorder or hide its neighbours. The raw sheet and its hash are unchanged in `memory/<token>/sheet.json`. The file list on the demo page only links plain relative file names. `src/demo/escaping.test.mjs` pushes hostile text through `runDemo` and checks the page, the viewer and every written SVG (no new tags or attributes, no handlers, no script URLs, no external fetches).
