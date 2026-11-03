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

import { createHash } from "node:crypto";

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

// Layout assumption for the TDX quote: a v4 quote is a 48-byte header, then
// the TD report body. REPORTDATA is the last 64 bytes of the 584-byte body,
// so it sits at bytes 568..632. We read it without authenticating it.
const TDX_REPORT_DATA_OFFSET = 568;
const TDX_REPORT_DATA_LENGTH = 64;

const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The attestation nonce we send, derived from the exact request body.
 * Choosing nonce = sha256(request body) ties the fetched attestation to this
 * one request. It is our own convention; the server only needs 32 random-looking
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

function checkQuoteReportData(quote, nonce, signingAddress) {
  const bytes = toBytes(quote);
  if (!bytes) return ["fail", "intel_quote is not hex"];
  if (bytes.length < TDX_REPORT_DATA_OFFSET + TDX_REPORT_DATA_LENGTH) {
    return ["unverifiable", `intel_quote is ${bytes.length} bytes, too short to hold TDX report data`];
  }
  const reportData = bytes.subarray(
    TDX_REPORT_DATA_OFFSET,
    TDX_REPORT_DATA_OFFSET + TDX_REPORT_DATA_LENGTH,
  );
  const hasNonce = reportData.includes(Buffer.from(nonce, "hex"));
  const addr = toBytes(signingAddress);
  const hasAddress = addr !== null && reportData.includes(addr);
  if (hasNonce && hasAddress) {
    return ["pass", "quote report data contains our nonce and the signing address (quote itself unauthenticated)"];
  }
  return ["fail", `quote report data missing ${[!hasNonce && "nonce", !hasAddress && "signing address"].filter(Boolean).join(" and ")}`];
}

/**
 * @param {object} report Parsed JSON from GET /v1/attestation/report, shape
 *   { model_attestations: [{ signing_address, signing_algo?, nvidia_payload,
 *     intel_quote, model_name? }], model?: string }.
 * @param {{ requestBody: string, model: string, nonce?: string,
 *   chatSignature?: { text: string, signature: string, signing_address: string } }} expected
 *   requestBody is the exact request string we send. nonce defaults to
 *   requestHash(requestBody). model is the model id we asked for.
 * @returns {{ verdict: string, verified: false, checks: object[], notVerified: string[], summary: string }}
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

  // Judge the report by its best node: every node's problems are listed, but
  // one fully consistent node is enough, since we only talk to one node.
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
      try { nvOk = typeof JSON.parse(nv) === "object"; } catch { nvOk = false; }
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

  const sig = expected.chatSignature;
  if (sig) {
    const parts = String(sig.text ?? "").split(":");
    const want = `${expected.model}:${requestHash(expected.requestBody)}`;
    const got = parts.length === 3 ? `${parts[0]}:${parts[1]}` : null;
    add(checks, "signature-text", got === want ? "pass" : "fail",
      got === want ? "signed text names our model and request hash" : "signed text does not match our model and request hash");
    const known = entries.some((e) => e?.signing_address?.toLowerCase() === String(sig.signing_address).toLowerCase());
    add(checks, "signature-signer", known ? "pass" : "fail",
      known ? "signature's signing_address matches an attested node (signature itself not recovered)" : "signing_address not among attested nodes");
  }

  return finish(checks);
}

function finish(checks) {
  const failed = checks.filter((c) => c.status === "fail");
  const verdict = failed.length === 0 ? VERDICT.CONSISTENT : VERDICT.REJECT;
  const summary = failed.length === 0
    ? "CONSISTENT, NOT VERIFIED: offline fields agree, but no TEE signature or certificate was checked."
    : `REJECT: ${failed.map((c) => c.id).join(", ")}.`;
  return { verdict, verified: false, checks, notVerified: [...NOT_VERIFIED], summary };
}
