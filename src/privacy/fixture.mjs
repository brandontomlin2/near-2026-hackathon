// Deterministic SYNTHETIC attestation report for offline tests and mock mode.
// Nothing here came from a TEE. The quote is zero-filled bytes behind a TDX v4
// quote header, with our nonce and a made-up signing address placed where a
// v4 TDX quote keeps REPORTDATA, so the offline binding check has something to
// read. It proves the code path, not the hardware, and it encodes OUR guess at
// how NEAR AI binds the two values (raw bytes); a real report may differ.

import { sha256Hex } from "../anchor/hash.mjs";
import { requestHash } from "./attestation.mjs";

export const MOCK_MODEL = "mock-tee-model";
export const MOCK_SIGNING_ADDRESS = "0x" + sha256Hex("mock-signing-key").slice(0, 40);

export const TDX_V4_HEADER_LENGTH = 48;
export const TDX_V4_REPORT_DATA_OFFSET = 568;
export const TDX_V4_QUOTE_LENGTH = 632; // header + 584-byte TD report body, no signature

/**
 * A 48-byte Intel DCAP quote header that the checker reads as TDX v4:
 * version 4, attestation key type 2 (ECDSA-256 with P-256), TEE type 0x81
 * (TDX). Everything else is zero. Synthetic; nothing is signed.
 */
export function tdxV4Header() {
  const h = Buffer.alloc(TDX_V4_HEADER_LENGTH);
  h.writeUInt16LE(4, 0);
  h.writeUInt16LE(2, 2);
  h.writeUInt32LE(0x81, 4);
  return h;
}

/**
 * @param {{ requestBody: string, model?: string, nonce?: string }} opts
 */
export function mockAttestation({ requestBody, model = MOCK_MODEL, nonce }) {
  const n = nonce ?? requestHash(requestBody);
  const quote = Buffer.alloc(TDX_V4_QUOTE_LENGTH);
  tdxV4Header().copy(quote, 0);
  Buffer.from(n, "hex").copy(quote, TDX_V4_REPORT_DATA_OFFSET + 32); // nonce in the second half
  Buffer.from(MOCK_SIGNING_ADDRESS.slice(2), "hex").copy(quote, TDX_V4_REPORT_DATA_OFFSET); // address in the first
  const report = {
    synthetic: true,
    nonce: n,
    model_attestations: [{
      model_name: model,
      signing_address: MOCK_SIGNING_ADDRESS,
      signing_algo: "ecdsa",
      nvidia_payload: JSON.stringify({ synthetic: true, nonce: n }),
      intel_quote: quote.toString("hex"),
    }],
  };
  const chatSignature = {
    text: `${model}:${requestHash(requestBody)}:${sha256Hex("mock-response")}`,
    signature: "0x" + "00".repeat(65), // not a real signature
    signing_address: MOCK_SIGNING_ADDRESS,
    signing_algo: "ecdsa",
  };
  return { report, chatSignature };
}
