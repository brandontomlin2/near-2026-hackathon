// Deterministic SYNTHETIC attestation report for offline tests and mock mode.
// Nothing here came from a TEE. The quote is zero-filled bytes with our nonce
// and a made-up signing address placed where a TDX quote keeps REPORTDATA, so
// the offline binding check has something to read. It proves the code path,
// not the hardware.

import { requestHash, sha256Hex } from "./attestation.mjs";

export const MOCK_MODEL = "mock-tee-model";
export const MOCK_SIGNING_ADDRESS = "0x" + sha256Hex("mock-signing-key").slice(0, 40);

/**
 * @param {{ requestBody: string, model?: string, nonce?: string }} opts
 */
export function mockAttestation({ requestBody, model = MOCK_MODEL, nonce }) {
  const n = nonce ?? requestHash(requestBody);
  const quote = Buffer.alloc(632);
  Buffer.from(n, "hex").copy(quote, 568 + 32); // nonce in the second half
  Buffer.from(MOCK_SIGNING_ADDRESS.slice(2), "hex").copy(quote, 568); // address in the first
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
