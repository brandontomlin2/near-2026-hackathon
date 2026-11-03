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

test("rejects a report bound to a different request, on the nonce echo and the quote binding", () => {
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

const good = () => mockAttestation({ requestBody });
const ids = (r, suffix) => r.checks.filter((c) => c.id.endsWith(suffix));

test("report without a top-level nonce skips nonce-echo and can still be consistent", () => {
  const { report } = good();
  delete report.nonce;
  const r = run(report);
  assert.equal(status(r, "nonce-echo"), "skip");
  assert.equal(r.verdict, VERDICT.CONSISTENT);
});

test("signing_algo: unsupported fails, absent adds no check, ed25519 passes", () => {
  const rsa = good().report; rsa.model_attestations[0].signing_algo = "rsa";
  const r = run(rsa);
  assert.equal(status(r, "node[0].signing-algo"), "fail");
  assert.equal(r.verdict, VERDICT.REJECT);
  const none = good().report; delete none.model_attestations[0].signing_algo;
  assert.equal(ids(run(none), "signing-algo").length, 0);
  const ed = good().report; ed.model_attestations[0].signing_algo = "ed25519";
  assert.equal(status(run(ed), "node[0].signing-algo"), "pass");
});

test("nvidia_payload: parsed object passes; null or number fails", () => {
  const set = (v) => { const { report } = good(); report.model_attestations[0].nvidia_payload = v; return run(report); };
  assert.equal(status(set({ a: 1 }), "node[0].nvidia-payload"), "pass");
  assert.equal(status(set(null), "node[0].nvidia-payload"), "fail");
  assert.equal(status(set(7), "node[0].nvidia-payload"), "fail");
});

test("non-hex intel_quote FAILS and rejects, as on main (never unverifiable)", () => {
  const { report } = good();
  report.model_attestations[0].intel_quote = "zz";
  const r = run(report);
  const c = r.checks.find((x) => x.id === "node[0].quote-binding");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /not hex/);
  assert.equal(r.verdict, VERDICT.REJECT);
});

test("quote with the nonce but not the signing address names only the address, as a fail", () => {
  const { report } = good();
  const quote = Buffer.from(report.model_attestations[0].intel_quote, "hex");
  quote.fill(0, 568, 588);
  report.model_attestations[0].intel_quote = quote.toString("hex");
  const c = run(report).checks.find((x) => x.id === "node[0].quote-binding");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /do not hold the raw signing address \(/);
  assert.doesNotMatch(c.detail, /raw nonce/);
});

test("explicit malformed nonce fails nonce-format and emits no quote-binding", () => {
  const { report } = good();
  for (const nonce of [requestHash(requestBody).toUpperCase(), "abcd"]) {
    const r = run(report, { nonce });
    assert.equal(status(r, "nonce-format"), "fail");
    assert.equal(ids(r, "quote-binding").length, 0);
  }
});

test("chat signature: wrong part count fails text; signer match ignores letter case", () => {
  const { report, chatSignature } = good();
  assert.equal(status(run(report, { chatSignature: { ...chatSignature, text: "abc" } }), "signature-text"), "fail");
  const upper = { ...chatSignature, signing_address: "0x" + chatSignature.signing_address.slice(2).toUpperCase() };
  assert.equal(status(run(report, { chatSignature: upper }), "signature-signer"), "pass");
});

test("summary of a rejected report lists the failed check ids", () => {
  const { report } = mockAttestation({ requestBody: requestBody + " " });
  const r = run(report);
  assert.match(r.summary, /^REJECT:/);
  assert.match(r.summary, /nonce-echo/);
});
