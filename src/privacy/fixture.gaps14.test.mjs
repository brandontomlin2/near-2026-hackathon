// The synthetic attestation fixture's own contract: it is honest about being
// synthetic, deterministic, and lays the quote out where the offline binding
// check reads it.
import test from "node:test";
import assert from "node:assert/strict";
import { requestHash } from "./attestation.mjs";
import { MOCK_MODEL, MOCK_SIGNING_ADDRESS, mockAttestation } from "./fixture.mjs";

const body = '{"model":"mock-tee-model","messages":[]}';

test("the report and its payload say synthetic, and the signature is 65 zero bytes", () => {
  const { report, chatSignature } = mockAttestation({ requestBody: body });
  assert.equal(report.synthetic, true);
  assert.equal(JSON.parse(report.model_attestations[0].nvidia_payload).synthetic, true);
  assert.equal(chatSignature.signature, "0x" + "00".repeat(65));
});

test("same input gives deep-equal output; a different body changes the nonce, quote and signature text", () => {
  const a = mockAttestation({ requestBody: body });
  assert.deepEqual(mockAttestation({ requestBody: body }), a);
  const b = mockAttestation({ requestBody: `${body} ` });
  assert.notEqual(b.report.nonce, a.report.nonce);
  assert.notEqual(b.report.model_attestations[0].intel_quote, a.report.model_attestations[0].intel_quote);
  assert.notEqual(b.chatSignature.text, a.chatSignature.text);
});

test("the nonce defaults to requestHash(body); an explicit nonce replaces it in the report and the quote but not in the signature text", () => {
  const dflt = mockAttestation({ requestBody: body });
  assert.equal(dflt.report.nonce, requestHash(body));
  const nonce = "ab".repeat(32);
  const custom = mockAttestation({ requestBody: body, nonce });
  assert.equal(custom.report.nonce, nonce);
  const quote = Buffer.from(custom.report.model_attestations[0].intel_quote, "hex");
  assert.equal(quote.subarray(600, 632).toString("hex"), nonce);
  assert.equal(custom.chatSignature.text, dflt.chatSignature.text, "the signature text is bound to the request, not the nonce");
});

test("the quote is 632 bytes with the address at 568..588 and the nonce at 600..632, zeros elsewhere", () => {
  const { report } = mockAttestation({ requestBody: body });
  const quote = Buffer.from(report.model_attestations[0].intel_quote, "hex");
  assert.equal(quote.length, 632);
  assert.equal(quote.subarray(568, 588).toString("hex"), MOCK_SIGNING_ADDRESS.slice(2));
  assert.equal(quote.subarray(600, 632).toString("hex"), requestHash(body));
  assert.ok(quote.subarray(0, 568).every((x) => x === 0));
  assert.ok(quote.subarray(588, 600).every((x) => x === 0));
});

test("the model argument flows into the node entry and the signature text; the default is MOCK_MODEL", () => {
  assert.equal(mockAttestation({ requestBody: body }).report.model_attestations[0].model_name, MOCK_MODEL);
  const other = mockAttestation({ requestBody: body, model: "other-model" });
  assert.equal(other.report.model_attestations[0].model_name, "other-model");
  const [model, reqHash, respHash] = other.chatSignature.text.split(":");
  assert.equal(model, "other-model");
  assert.equal(reqHash, requestHash(body));
  assert.match(respHash, /^[0-9a-f]{64}$/);
});

test("the signing address is a 20-byte 0x address, the same in the report and the chat signature", () => {
  assert.match(MOCK_SIGNING_ADDRESS, /^0x[0-9a-f]{40}$/);
  const { report, chatSignature } = mockAttestation({ requestBody: body });
  assert.equal(report.model_attestations[0].signing_address, MOCK_SIGNING_ADDRESS);
  assert.equal(chatSignature.signing_address, MOCK_SIGNING_ADDRESS);
});
