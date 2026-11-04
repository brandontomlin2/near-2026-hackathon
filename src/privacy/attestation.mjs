// Offline checks on a NEAR AI Cloud private-inference attestation report.
//
// HONESTY NOTE. This module checks structure and consistency only. It does
// NOT verify any signature or certificate chain: not the Intel TDX quote, not
// the NVIDIA NRAS token, not the ECDSA chat signature. Those need Intel's
// collateral, NVIDIA's service, or secp256k1/keccak code we do not ship. So
// the verdict is never "verified". The best result is "consistent": the
// report is well formed and its self-declared fields agree with our request.
// An attacker who can forge JSON can pass every check here. Read
// docs/privacy.md before claiming anything to a judge.

import { sha256Hex } from "../anchor/hash.mjs";
import { plural } from "../util/plural.mjs";

export const VERDICT = Object.freeze({
  CONSISTENT: "consistent", // structure and bindings agree; nothing cryptographic checked
  REJECT: "reject", // at least one offline check failed
});

// Checks that need the network, hardware vendors or crypto we do not carry.
export const NOT_VERIFIED = Object.freeze([
  "Intel TDX quote signature and certificate chain (needs dcap-qvl + Intel collateral)",
  "NVIDIA NRAS GPU attestation (needs a call to nras.attestation.nvidia.com)",
  "Compose manifest hash against mr_config of a verified quote",
  "ECDSA chat signature recovery against signing_address (needs keccak256 + secp256k1)",
  "Whether the report came from a real TEE rather than being hand written",
]);

// Layout assumption for the TDX quote (Intel DCAP quote format v4, TDX TD
// report 1.0): a 48-byte header whose first u16 LE is the version (4) and
// whose u32 LE at byte 4 is the TEE type (0x81 = TDX), then the 584-byte TD
// report body. REPORTDATA is the last 64 bytes of the body, so it sits at
// bytes 568..632. We read it without authenticating it.
//
// What NEAR AI puts in those 64 bytes is NOT documented. The vendored docs
// (.agents/skills/near-ai-cloud) only say the signing address and the nonce
// are "bound" in the report data, not how. We look for the raw nonce and the
// raw 20-byte address.
//
// Outcomes, never weaker than origin/main:
//  - not hex                      -> FAIL (as on main; never "unverifiable")
//  - hex, >= 632 bytes            -> header must say version 4 and TDX tee_type
//                                    0x81, else FAIL before report data is read.
//                                    Then FAIL if the nonce or address is
//                                    missing at offset 568, PASS if both found.
//  - hex, < 632 bytes             -> "unverifiable" (as on main, where it was
//                                    silently counted as OK). This is the ONLY
//                                    input that reaches BINDING UNREAD / exit 2:
//                                    a well-formed hex quote too short to hold
//                                    a v4 report body, e.g. a truncated quote.
//                                    A caller only gets CONSISTENT then if the
//                                    report also echoes our nonce
//                                    (see request-binding in checkAttestation).
// (A genuine report that hashes the binding would fail too; we accept that
// rather than let a replayed quote through.)
const TDX_QUOTE_VERSION = 4;
const TDX_TEE_TYPE = 0x81;
const TDX_REPORT_DATA_OFFSET = 568;
const TDX_REPORT_DATA_LENGTH = 64;
const TDX_V4_QUOTE_MIN_LENGTH = TDX_REPORT_DATA_OFFSET + TDX_REPORT_DATA_LENGTH;

// Intel DCAP quote format v5 (sgx_quote5_t / tdx_quote5 in Intel's
// SGX/TDX DCAP QuoteGeneration headers). Offsets used, all little-endian:
//   0..48   header: u16 version (5), u16 att_key_type, u32 tee_type (0x81 TDX),
//           then reserved, QE vendor id and user data (same 48 bytes as v4)
//   48..50  u16 quote body type: 1 = SGX enclave report (384 bytes, rejected),
//           2 = TDX 1.0 TD report (584 bytes), 3 = TDX 1.5 TD report (648 bytes)
//   50..54  u32 body size in bytes (must equal 584 for type 2, 648 for type 3)
//   54..    the body. The TD 1.5 report is the 1.0 report plus 64 trailing
//           bytes (tee_tcb_svn2, mr_servicetd), so REPORTDATA stays 520 bytes
//           into the body for both: 54 + 520 = 574, i.e. bytes 574..638.
// (v4 has no body-type/size fields: body at 48, REPORTDATA at 568..632.)
// Written from Intel's published layout, not checked against a real v5 quote
// from this repo; the tests use synthetic quotes built from the same offsets.
const TDX_V5_BODY_OFFSET = 54;
const TDX_V5_BODIES = new Map([
  [2, { size: 584, name: "TD report 1.0" }],
  [3, { size: 648, name: "TD report 1.5" }],
]);
const TDX_V5_REPORT_DATA_OFFSET = TDX_V5_BODY_OFFSET + 520;

const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The attestation nonce we send, derived from the exact request body.
 * Choosing nonce = sha256(request body) is intended to tie the fetched attestation
 * to this one request, once the quote is actually verified (this module does not
 * verify the quote signature, so the tie is nominal today). It is our own convention; the server only needs 32 random-looking
 * bytes. The chat signature text also carries this same request hash.
 */
export function requestHash(requestBody) {
  return sha256Hex(requestBody);
}

function add(checks, id, status, detail) {
  checks.push({ id, status, detail });
}

function toBytes(hex) {
  if (typeof hex !== "string") return null;
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return null;
  return Buffer.from(clean, "hex");
}

// Returns ["pass" | "fail" | "unverifiable", detail]: see the layout note.
function checkQuoteReportData(quote, nonce, signingAddress) {
  const bytes = toBytes(quote);
  if (!bytes) return ["fail", "intel_quote is not hex"];
  if (bytes.length < TDX_V4_QUOTE_MIN_LENGTH) {
    return ["unverifiable", `intel_quote is ${plural(bytes.length, "byte")}, too short to hold TDX report data`];
  }
  const version = bytes.readUInt16LE(0);
  const teeType = bytes.readUInt32LE(4);
  const hex = (n) => `0x${n.toString(16)}`;
  let kind, offset;
  if (version === TDX_QUOTE_VERSION && teeType === TDX_TEE_TYPE) {
    kind = "TDX v4 quote";
    offset = TDX_REPORT_DATA_OFFSET;
  } else if (version === 5 && teeType === TDX_TEE_TYPE) {
    const bodyType = bytes.readUInt16LE(48);
    const bodySize = bytes.readUInt32LE(50);
    const body = TDX_V5_BODIES.get(bodyType);
    if (!body) {
      return ["fail", `intel_quote is a v5 quote with body type ${bodyType}, not a TDX 1.0 or 1.5 TD report (type 2 or 3); report data not read`];
    }
    if (bodySize !== body.size) {
      return ["fail", `intel_quote is a v5 quote whose ${body.name} body declares ${bodySize} bytes, expected ${body.size}; report data not read`];
    }
    if (bytes.length < TDX_V5_BODY_OFFSET + body.size) {
      return ["unverifiable", `intel_quote is ${bytes.length} bytes, too short to hold a v5 ${body.name} body (${TDX_V5_BODY_OFFSET + body.size})`];
    }
    kind = `TDX v5 quote (${body.name})`;
    offset = TDX_V5_REPORT_DATA_OFFSET;
  } else {
    return ["fail", `intel_quote header says version ${version}, tee_type ${hex(teeType)}, not a TDX v4 or v5 quote (version 4 or 5, tee_type ${hex(TDX_TEE_TYPE)}); report data not read`];
  }
  const range = `${offset}..${offset + TDX_REPORT_DATA_LENGTH}`;
  const reportData = bytes.subarray(offset, offset + TDX_REPORT_DATA_LENGTH);
  const hasNonce = reportData.includes(Buffer.from(nonce, "hex"));
  const addr = toBytes(signingAddress);
  const hasAddress = addr !== null && reportData.includes(addr);
  if (hasNonce && hasAddress) {
    return ["pass", `${kind}; bytes ${range} hold our nonce and the signing address as raw bytes (quote itself unauthenticated)`];
  }
  const missing = [!hasNonce && "nonce", !hasAddress && "signing address"].filter(Boolean).join(" and ");
  return ["fail", `${kind}; bytes ${range} do not hold the raw ${missing} (stale, replayed or another node's quote)`];
}

/**
 * @param {object} report Parsed JSON from GET /v1/attestation/report, shape
 *   { model_attestations: [{ signing_address, signing_algo?, nvidia_payload,
 *     intel_quote, model_name? }], model?: string }.
 * @param {{ requestBody: string, model: string, nonce?: string,
 *   chatSignature?: { text: string, signature: string, signing_address: string } }} expected
 *   requestBody is the exact request string we send. nonce defaults to
 *   requestHash(requestBody). model is the model id we asked for.
 * @returns {{ verdict: string, verified: false, checks: object[], unverifiable: string[], notVerified: string[], summary: string }}
 *   Each check has status "pass", "fail", "skip" or "unverifiable". Only
 *   "fail" rejects; "unverifiable" means the input could not be read under
 *   our assumptions. Its ids are in `unverifiable` so callers can tell
 *   "binding confirmed" from "binding unread".
 */
export function checkAttestation(report, expected) {
  const checks = [];
  const nonce = expected.nonce ?? requestHash(expected.requestBody);

  const entries = Array.isArray(report?.model_attestations) ? report.model_attestations : null;
  if (!entries || entries.length === 0) {
    add(checks, "structure", "fail", "model_attestations missing or empty");
    return finish(checks);
  }
  add(checks, "structure", "pass", `${entries.length} node attestation(s) present`);

  add(
    checks,
    "nonce-format",
    HEX64.test(nonce) ? "pass" : "fail",
    HEX64.test(nonce) ? "nonce is 64 lowercase hex chars" : "nonce must be 64 lowercase hex chars",
  );

  if (typeof report.nonce === "string") {
    add(checks, "nonce-echo", report.nonce === nonce ? "pass" : "fail",
      report.nonce === nonce ? "report echoes our nonce" : "report nonce differs from ours (stale or replayed)");
  } else {
    add(checks, "nonce-echo", "skip", "report carries no top-level nonce field");
  }

  // Check every node and list every problem. Any failing check on any node
  // rejects the whole report (see finish): a report that attests a bad node
  // is not one we trust, even if we only talk to one node.
  entries.forEach((e, i) => {
    const tag = `node[${i}]`;
    const addrOk = typeof e?.signing_address === "string" && ADDRESS.test(e.signing_address);
    add(checks, `${tag}.signing-key`, addrOk ? "pass" : "fail",
      addrOk ? "signing_address is a well-formed 20-byte address" : "signing_address missing or malformed");
    const algo = e?.signing_algo;
    if (algo !== undefined) {
      add(checks, `${tag}.signing-algo`, algo === "ecdsa" || algo === "ed25519" ? "pass" : "fail", `signing_algo=${algo}`);
    }
    const nv = e?.nvidia_payload;
    let nvOk = false;
    if (typeof nv === "string") {
      try {
        const parsed = JSON.parse(nv);
        nvOk = parsed !== null && typeof parsed === "object";
      } catch { nvOk = false; }
    } else nvOk = nv !== null && typeof nv === "object";
    add(checks, `${tag}.nvidia-payload`, nvOk ? "pass" : "fail",
      nvOk ? "present and parses as an object (not sent to NRAS)" : "nvidia_payload missing or not JSON");
    const quoteOk = typeof e?.intel_quote === "string" && e.intel_quote.length > 0;
    add(checks, `${tag}.intel-quote`, quoteOk ? "pass" : "fail",
      quoteOk ? "present (signature not checked)" : "intel_quote missing");
    if (quoteOk && addrOk && HEX64.test(nonce)) {
      const [status, detail] = checkQuoteReportData(e.intel_quote, nonce, e.signing_address);
      add(checks, `${tag}.quote-binding`, status, detail);
    }
    const name = e?.model_name ?? report.model;
    if (name === undefined) {
      add(checks, `${tag}.model`, "skip", "report names no model; only the signature text can bind it");
    } else {
      add(checks, `${tag}.model`, name === expected.model ? "pass" : "fail",
        name === expected.model ? `model is ${name}` : `report model ${name} != requested ${expected.model}`);
    }
  });

  // With no echoed nonce, only a confirmed quote binding ties the report to
  // this request. Without either, nothing does, so it cannot be consistent.
  if (typeof report.nonce !== "string" && !checks.some((c) => c.id.endsWith(".quote-binding") && c.status === "pass")) {
    add(checks, "request-binding", "fail", "no nonce echo and no confirmed quote binding: nothing ties this report to our request");
  }

  const sig = expected.chatSignature;
  if (sig) {
    // Match the known "model:requestHash:" prefix instead of splitting on ":",
    // so a model id that contains ":" still works. The response hash is the
    // one remaining segment and must not contain ":".
    const prefix = `${expected.model}:${requestHash(expected.requestBody)}:`;
    const text = String(sig.text ?? "");
    const tail = text.startsWith(prefix) ? text.slice(prefix.length) : "";
    const ok = tail.length > 0 && !tail.includes(":");
    add(checks, "signature-text", ok ? "pass" : "fail",
      ok ? "signed text names our model and request hash" : "signed text does not match our model and request hash");
    const known = entries.some((e) => e?.signing_address?.toLowerCase() === String(sig.signing_address).toLowerCase());
    add(checks, "signature-signer", known ? "pass" : "fail",
      known ? "signature's signing_address matches an attested node (signature itself not recovered)" : "signing_address not among attested nodes");
  }

  return finish(checks);
}

// Only "fail" rejects. "unverifiable" checks do not reject, but a consistent
// summary names them so "fields agree" is never read as "every field agreed".
function finish(checks) {
  const ids = (list) => list.map((c) => c.id).join(", ");
  const failed = checks.filter((c) => c.status === "fail");
  const unverifiable = checks.filter((c) => c.status === "unverifiable");
  const verdict = failed.length === 0 ? VERDICT.CONSISTENT : VERDICT.REJECT;
  let summary;
  if (failed.length > 0) {
    summary = `REJECT: ${ids(failed)}.`;
  } else {
    summary = `CONSISTENT, NOT VERIFIED${unverifiable.length > 0 ? ", BINDING UNREAD" : ""}: offline fields agree, but no TEE signature or certificate was checked.`;
    if (unverifiable.length > 0) summary += ` Unverifiable, not counted either way: ${ids(unverifiable)}.`;
  }
  return { verdict, verified: false, checks, unverifiable: unverifiable.map((c) => c.id), notVerified: [...NOT_VERIFIED], summary };
}
