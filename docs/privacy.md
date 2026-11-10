# Privacy track: TEE attestation feasibility

Verdict: **conditional go**. Submit `privacy` only if the demo shows the
attestation check below running against a live NEAR AI Cloud report, with
the limits stated plainly. If we only ship the mock fixture, **no-go**:
`PRODUCT.md` already says to leave `privacy` off until a real check ships.

## What NEAR AI Cloud offers

Per NEAR AI's documentation (not verified here), inference runs in Intel TDX confidential VMs with NVIDIA TEE GPUs. For a
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
`CONSISTENT, NOT VERIFIED` and exits 0, `REJECT` and exits 1, or
`CONSISTENT, NOT VERIFIED, BINDING UNREAD` and exits 2 (a quote was
truncated hex; `-- --unreadable-quote` shows it with a 2-byte quote). It always lists what was not
verified, so "offline fields agree" never hides a field that could not be read.

Exit 2 is shared: `attest-check` also exits 2 on a usage error (an unknown flag,
or `--tamper` with `--unreadable-quote`), as every CLI in this repo does. A
script cannot tell the two apart by exit code alone. Usage errors print one
`attest-check: ...` line to stderr and no verdict, while `BINDING UNREAD` prints
the verdict on stdout.

## What leaves the machine in live mode, and what stays on disk

With `MOCK_INFERENCE=0`, prompts, the agent's character sheet and the owner's
`ask` question are sent to `cloud-api.near.ai` (or `NEAR_AI_BASE_URL`). Whether
that stays inside a TEE depends on the model:

- NEAR AI's "Private" models run in a TEE. The "Anonymised" models (Anthropic,
  OpenAI, Google, routed through NEAR AI with identifying information removed)
  do **not** run in a TEE.
- `NEAR_AI_MODEL` is free text. Nothing in this repo checks which class a model
  is. The live client prints a one-line warning to stderr when the value is not
  one of the "Private" text models listed in the vendored skill docs
  (`TEE_MODELS` in `src/inference/client.mjs`). It is a warning only: the call
  still goes ahead, and the list can go stale. Mock mode prints nothing.
- The TEE is not verified anywhere in this repo, whichever model you pick.

On disk, `out/` is gitignored but unencrypted. `out/memory/<id>/log.jsonl` keeps
the owner's `ask` questions and the agent's answers in plaintext, and `out/`
also holds the sheets and transcripts. Delete `out/` to remove them.

### The quote layout assumption behind `quote-binding`

The NEAR AI docs vendored under `.agents/skills/near-ai-cloud` say only that
the signing address and the nonce are "bound in the TDX report data". They do
not say how (raw bytes, a hash of the two, some other encoding), nor which
quote format version is returned, nor how `intel_quote` is encoded. Nothing in
this repository has been run against a real report, so the code works from an
assumption, and it says so in its output.

The assumption: `intel_quote` is hex; it is an Intel DCAP quote format v4 or v5
with a TDX TD report body. v4: the header's first `u16` little-endian is `4`, the
`u32` at byte 4 is `0x81` (TDX), and the 64-byte `report_data` field sits at
bytes 568..632. v5: version `5`, tee type `0x81`, then a `u16` body type at
byte 48 (2 = TDX 1.0 TD report, 3 = TDX 1.5 TD report; 1 = SGX enclave report
is rejected) and a `u32` body size at byte 50 (584 or 648, must match the type),
the body at byte 54, and `report_data` 520 bytes into it, at bytes 574..638.
The v5 offsets come from Intel's published DCAP v5 layout and are not checked
against a real v5 quote from NEAR AI; the tests use synthetic quotes.
The check passes when the raw 32-byte nonce and the raw 20-byte address both
appear somewhere inside those 64 bytes.

How `quote-binding` reports, given that:

- `pass` when `intel_quote` is hex, at least 632 bytes, and both raw values
  are found in `report_data` (v4: bytes 568..632; v5 with a TDX 1.0/1.5 body:
  bytes 574..638), and the 48-byte header says version 4 or 5 with TEE type
  `0x81` (TDX). The detail always says the quote is unauthenticated.
- `fail` when `intel_quote` is not hex (the report claims a quote we cannot even
  read as bytes); when it is 632+ bytes and the header does not say version 4
  or 5 and TDX (checked first, with the version and TEE type it did say, and
  the report data is not read, so correct bytes at 568..632 do not save it);
  when it is v5 with a body type other than 2 or 3 (for example an SGX body), or
  a body size that contradicts the body type; or when the header is v4/v5 TDX
  and `report_data` lacks our nonce or the signing address
  (stale, replayed, another node's quote). A genuine report that
  hashes the binding would also fail here; we accept that rather than let a
  replayed quote through.
- `unverifiable`, with the reason, only when `intel_quote` is valid hex but
  shorter than 632 bytes, or a v5 quote shorter than its declared body
  (54 + 584 or 54 + 648 bytes) (a truncated quote). That is the one input that
  reaches `BINDING UNREAD` / exit 2. The result is still `consistent` only if
  the report echoes our nonce; the summary says `BINDING UNREAD` and the result
  lists the ids in `unverifiable`.
- Request binding needs one of two things: the report echoes our nonce
  (`nonce-echo`), or `quote-binding` passes. A report with a top-level nonce
  absent and no passing quote binding fails `request-binding`. Nothing else in
  the offline checker ties a report to our request.
- Other rejects: a malformed signing address, a report that echoes a different
  nonce, a wrong model, or a chat signature signed by an address the report
  does not attest. `npm run attest:check -- --tamper` swaps in a well-formed
  but wrong address, which the quote binding catches.

The bundled fixture carries a v4/TDX header and the raw bytes, so it takes the
`pass` path. That is the code path a real v4 report with a raw-byte binding
would take; it is not evidence that NEAR AI binds the values that way.

## What is NOT verified (and we do not pretend to)

- The TDX quote's signature and Intel certificate chain. Needs `dcap-qvl` and
  Intel collateral. Without it, the REPORTDATA check above reads
  unauthenticated bytes: anyone can write a JSON file that passes it. What the
  check does verify about a quote is only: it is hex, long enough for its body, its
  header says version 4 or 5 and TEE type TDX (v5: a TDX 1.0 or 1.5 body type),
  and `report_data` (568..632 for v4, 574..638 for v5) holds our nonce and
  the signing address. It does not verify the quote signature, the certificate
  chain, the measurements (MRTD, RTMRs, `mr_config`) or the TCB status.
- NVIDIA NRAS. Needs a POST to `nras.attestation.nvidia.com`; then JWT
  claims (`x-nvidia-overall-att-result`, `eat_nonce`, `secboot`, `dbgstat`).
- Compose manifest hash against `mr_config`.
- The chat ECDSA signature. Recovery needs keccak256 and secp256k1; Node's
  built-in crypto has neither (SHA3-256 is not keccak). Adding `ethers` or
  `@noble/curves` + `@noble/hashes` would close this; it is a small dependency.
- The synthetic fixture (`src/privacy/fixture.mjs`) is hand made. Passing it
  proves our code path only. The quote layout and the raw-byte binding it
  encodes are our assumptions (see above), to confirm against a real report;
  until then a real report may well come back `quote-binding: fail` and `REJECT`.

## Does it qualify for the privacy track?

Honestly, only weakly today. The track is about private/verifiable AI. NEAR
AI Cloud documents that inference runs inside TEEs; this repository does not
verify that, and an operator who overrides `NEAR_AI_BASE_URL` leaves that
guarantee (the client now refuses plain `http://` except to loopback). A judge
will ask "how do I know?". Offline consistency checks do not answer that. A
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
   from the submission; keep `security`, `defi`, `nfts`. Do not describe the
   mock check as attestation anywhere in the README.
3. Either way, README wording: "offline consistency check; hardware
   verification is X or not done", never "verified private".

Open question for the human: is a live API key available, and is the extra
day worth a fourth track.

## Hostile model text on the hosted page

In live mode, posts and character sheets are model output and are treated as hostile. `escapeHtml` (`src/viewer/render.mjs`) is the single escaping helper for `out/index.html`, `out/site/index.html` and the viewer. It escapes `& < > " '` once, and replaces control characters and bidi overrides/isolates with U+FFFD so text cannot reorder or hide its neighbours. The raw sheet and its hash are unchanged in `memory/<token>/sheet.json`. The file list on the demo page only links plain relative file names. `src/demo/escaping.test.mjs` pushes hostile text through `runDemo` and checks the page, the viewer and every written SVG (no new tags or attributes, no handlers, no script URLs, no external fetches).
