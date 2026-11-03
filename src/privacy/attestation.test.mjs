import test from "node:test";
import assert from "node:assert/strict";
import { checkAttestation, requestHash, VERDICT } from "./attestation.mjs";
import { mockAttestation, MOCK_MODEL } from "./fixture.mjs";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] });
const run = (report, extra = {}) => checkAttestation(report, { requestBody, model: MOCK_MODEL, ...extra });
const status = (r, id) => r.checks.find((c) => c.id === id)?.status;

test("fixture is deterministic", () => {
  assert.deepEqual(mockAttestation({ requestBody }), mockAttestation({ requestBody }));
});

test("good report is consistent but never verified", () => {
  const { report, chatSignature } = mockAttestation({ requestBody });
  const r = run(report, { chatSignature });
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.equal(r.verified, false);
  assert.ok(r.notVerified.length >= 4);
  assert.match(r.summary, /NOT VERIFIED/);
});

test("rejects empty or malformed reports", () => {
  assert.equal(run({}).verdict, VERDICT.REJECT);
  assert.equal(run(null).verdict, VERDICT.REJECT);
  assert.equal(run({ model_attestations: [] }).verdict, VERDICT.REJECT);
});

test("rejects a report bound to a different request", () => {
  const { report } = mockAttestation({ requestBody: requestBody + " " });
  const r = run(report);
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.equal(status(r, "nonce-echo"), "fail");
  assert.equal(status(r, "node[0].quote-binding"), "fail");
});

test("rejects wrong model, missing key, bad address", () => {
  const { report } = mockAttestation({ requestBody });
  assert.equal(status(run({ ...report, model_attestations: [{ ...report.model_attestations[0], model_name: "other" }] }), "node[0].model"), "fail");
  const noKey = structuredClone(report); delete noKey.model_attestations[0].signing_address;
  assert.equal(status(run(noKey), "node[0].signing-key"), "fail");
  const bad = structuredClone(report); bad.model_attestations[0].signing_address = "0x12";
  assert.equal(run(bad).verdict, VERDICT.REJECT);
});

test("rejects missing quote or GPU payload", () => {
  const { report } = mockAttestation({ requestBody });
  const a = structuredClone(report); delete a.model_attestations[0].intel_quote;
  assert.equal(status(run(a), "node[0].intel-quote"), "fail");
  const b = structuredClone(report); b.model_attestations[0].nvidia_payload = "not json";
  assert.equal(status(run(b), "node[0].nvidia-payload"), "fail");
});

test("short quote is unverifiable, not a pass", () => {
  const { report } = mockAttestation({ requestBody });
  report.model_attestations[0].intel_quote = "abcd";
  const r = run(report);
  assert.equal(status(r, "node[0].quote-binding"), "unverifiable");
});

test("chat signature text must name our model and request hash", () => {
  const { report, chatSignature } = mockAttestation({ requestBody });
  const wrong = { ...chatSignature, text: `${MOCK_MODEL}:${requestHash("other")}:x` };
  assert.equal(status(run(report, { chatSignature: wrong }), "signature-text"), "fail");
  const stranger = { ...chatSignature, signing_address: "0x" + "ab".repeat(20) };
  assert.equal(status(run(report, { chatSignature: stranger }), "signature-signer"), "fail");
});

test("report with no model name skips the model check rather than passing it", () => {
  const { report } = mockAttestation({ requestBody });
  delete report.model_attestations[0].model_name;
  const r = run(report);
  assert.equal(status(r, "node[0].model"), "skip");
});
