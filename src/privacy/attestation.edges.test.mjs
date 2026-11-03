// Honesty and edge behaviour of the offline attestation check. The module can
// say "consistent" or "reject"; it must never say "verified", must not be
// talked into it by the report, and must tell a synthetic report apart from
// an unknown real one only by what the caller already knows.
import assert from "node:assert/strict";
import test from "node:test";

import { NOT_VERIFIED, VERDICT, checkAttestation, requestHash } from "./attestation.mjs";
import { sha256Hex } from "../anchor/hash.mjs";
import { MOCK_MODEL, MOCK_SIGNING_ADDRESS, mockAttestation, tdxV4Header } from "./fixture.mjs";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] });
const run = (report, extra = {}) => checkAttestation(report, { requestBody, model: MOCK_MODEL, ...extra });
const status = (r, id) => r.checks.find((c) => c.id === id)?.status;
const good = () => mockAttestation({ requestBody });
const REPORT_DATA_OFFSET = 568;

test("the vocabulary has no 'verified' outcome and the not-verified list is frozen and complete", () => {
  assert.deepEqual(Object.values(VERDICT).sort(), ["consistent", "reject"]);
  assert.ok(Object.isFrozen(VERDICT));
  assert.ok(Object.isFrozen(NOT_VERIFIED));
  assert.equal(NOT_VERIFIED.length, 5);
  for (const needle of [/TDX quote signature/, /NVIDIA NRAS/, /mr_config/, /ECDSA chat signature/, /real TEE/]) {
    assert.ok(NOT_VERIFIED.some((s) => needle.test(s)), String(needle));
  }
});

test("a perfect synthetic report passes every check yet is still verified: false and says NOT VERIFIED", () => {
  const { report, chatSignature } = good();
  const r = run(report, { chatSignature });
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.equal(r.verified, false);
  assert.ok(r.checks.length >= 9);
  assert.ok(r.checks.every((c) => c.status === "pass"), JSON.stringify(r.checks.filter((c) => c.status !== "pass")));
  assert.ok(new Set(r.checks.map((c) => c.id)).size === r.checks.length, "check ids are unique");
  assert.ok(r.checks.every((c) => ["pass", "fail", "skip", "unverifiable"].includes(c.status)));
  assert.match(r.summary, /^CONSISTENT, NOT VERIFIED:/);
  assert.match(r.summary, /no TEE signature or certificate was checked/);
  assert.deepEqual(r.notVerified, [...NOT_VERIFIED]);
  assert.match(r.checks.find((c) => c.id === "node[0].quote-binding").detail, /quote itself unauthenticated/);
  assert.match(r.checks.find((c) => c.id === "node[0].intel-quote").detail, /signature not checked/);
  assert.match(r.checks.find((c) => c.id === "node[0].nvidia-payload").detail, /not sent to NRAS/);
  assert.match(r.checks.find((c) => c.id === "signature-signer").detail, /signature itself not recovered/);
});

test("the report cannot talk the checker into a verified result", () => {
  const { report, chatSignature } = good();
  const tampered = { ...report, verified: true, verdict: "verified", synthetic: false, notVerified: [] };
  const r = run(tampered, { chatSignature });
  assert.equal(r.verified, false);
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.deepEqual(r.notVerified, [...NOT_VERIFIED]);
  // The result's list is a copy: a caller editing it cannot shorten the shared one.
  r.notVerified.length = 0;
  assert.equal(NOT_VERIFIED.length, 5);
  assert.equal(run(report).notVerified.length, 5);
});

test("a hand-written report built without the fixture passes: the check is offline consistency only", () => {
  const nonce = requestHash(requestBody);
  const address = "0x" + "ab".repeat(20);
  const quote = Buffer.alloc(632);
  tdxV4Header().copy(quote, 0);
  Buffer.from(address.slice(2), "hex").copy(quote, REPORT_DATA_OFFSET + 44);
  Buffer.from(nonce, "hex").copy(quote, REPORT_DATA_OFFSET);
  const forged = { model_attestations: [{ signing_address: address, nvidia_payload: {}, intel_quote: quote.toString("hex") }], model: MOCK_MODEL };
  const r = run(forged);
  assert.equal(r.verdict, VERDICT.CONSISTENT, JSON.stringify(r.checks.filter((c) => c.status === "fail")));
  assert.equal(r.verified, false);
  assert.equal(status(r, "nonce-echo"), "skip");
  assert.equal(status(r, "node[0].model"), "pass", "top-level model is used when the node has no model_name");
});

test("checkAttestation does not mutate the report or the expected object", () => {
  const { report, chatSignature } = good();
  const before = structuredClone(report);
  const expected = { requestBody, model: MOCK_MODEL, chatSignature };
  const expectedBefore = structuredClone(expected);
  checkAttestation(report, expected);
  assert.deepEqual(report, before);
  assert.deepEqual(expected, expectedBefore);
});

test("structure: model_attestations must be a non-empty array; nothing else is checked when it is not", () => {
  for (const report of [undefined, null, 7, "x", [], { model_attestations: "one" }, { model_attestations: {} }, { model_attestations: null }]) {
    const r = checkAttestation(report, { requestBody, model: MOCK_MODEL });
    assert.equal(r.verdict, VERDICT.REJECT, JSON.stringify(report));
    assert.deepEqual(r.checks.map((c) => c.id), ["structure"], JSON.stringify(report));
    assert.equal(r.summary, "REJECT: structure.");
  }
  assert.equal(run({ model_attestations: [{}] }).checks[0].detail, "1 node attestation(s) present");
});

test("every node is checked under its own index and one bad node rejects the whole report", () => {
  const { report } = good();
  const bad = { ...report.model_attestations[0], signing_address: "nope", intel_quote: "" };
  const r = run({ ...report, model_attestations: [report.model_attestations[0], bad] });
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.equal(status(r, "node[0].signing-key"), "pass");
  assert.equal(status(r, "node[1].signing-key"), "fail");
  assert.equal(status(r, "node[1].intel-quote"), "fail");
  assert.equal(status(r, "node[1].quote-binding"), undefined, "no binding check without a quote and a key");
  assert.equal(r.checks[0].detail, "2 node attestation(s) present");
  assert.match(r.summary, /^REJECT: node\[1\]\.signing-key, node\[1\]\.intel-quote\.$/);
});

test("quote binding reads only REPORTDATA at bytes 568..632 of a v4 quote; a readable quote without them fails, an unreadable one is unverifiable", () => {
  const nonce = requestHash(requestBody);
  const withQuote = (quote) => {
    const { report } = good();
    report.model_attestations[0].intel_quote = quote;
    return run(report).checks.find((c) => c.id === "node[0].quote-binding");
  };
  const place = (nonceAt, addrAt, size = 632) => {
    const q = Buffer.alloc(size);
    tdxV4Header().copy(q, 0);
    Buffer.from(nonce, "hex").copy(q, nonceAt);
    Buffer.from(MOCK_SIGNING_ADDRESS.slice(2), "hex").copy(q, addrAt);
    return q;
  };
  assert.equal(withQuote(place(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32).toString("hex")).status, "pass", "nonce first");
  assert.equal(withQuote(place(REPORT_DATA_OFFSET + 32, REPORT_DATA_OFFSET).toString("hex")).status, "pass", "address first");
  assert.equal(withQuote(place(REPORT_DATA_OFFSET + 32, REPORT_DATA_OFFSET, 2000).toString("hex")).status, "pass", "longer quotes are fine");
  assert.equal(withQuote("0x" + place(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32).toString("hex").toUpperCase()).status, "pass", "0x and upper case hex");
  const outside = withQuote(place(100, 200).toString("hex"));
  assert.equal(outside.status, "fail", "nonce and address outside REPORTDATA do not count");
  assert.equal(outside.detail, "TDX v4 report data does not hold the raw nonce and signing address (stale, replayed or another node's quote)");
  const nonceOnly = withQuote(place(REPORT_DATA_OFFSET, 100).toString("hex"));
  assert.equal(nonceOnly.status, "fail");
  assert.match(nonceOnly.detail, /^TDX v4 report data does not hold the raw signing address \(/);
  const addrOnly = withQuote(place(100, REPORT_DATA_OFFSET).toString("hex"));
  assert.equal(addrOnly.status, "fail");
  assert.match(addrOnly.detail, /^TDX v4 report data does not hold the raw nonce \(/);
  const straddle = withQuote(place(REPORT_DATA_OFFSET + 40, REPORT_DATA_OFFSET).toString("hex"));
  assert.equal(straddle.status, "fail", "a nonce that runs past byte 632 is not inside REPORTDATA");
  const noHeader = place(REPORT_DATA_OFFSET, REPORT_DATA_OFFSET + 32); noHeader.fill(0, 0, 48);
  assert.equal(withQuote(noHeader.toString("hex")).status, "unverifiable", "raw bytes in place but no v4 header: offsets unknown");
  assert.match(withQuote(noHeader.toString("hex")).detail, /not the assumed TDX v4/);
  assert.equal(withQuote("abc").status, "unverifiable", "odd length");
  assert.match(withQuote("abc").detail, /^intel_quote is not hex; /);
  assert.equal(withQuote("0x" + "00".repeat(631)).status, "unverifiable");
  assert.equal(withQuote("00".repeat(631)).detail, "intel_quote is 631 bytes, too short to hold TDX report data");
});

test("an explicit nonce replaces the request-hash nonce for echo and binding, not for the signature text", () => {
  const nonce = sha256Hex("some other 32 random-looking bytes");
  const { report, chatSignature } = mockAttestation({ requestBody, nonce });
  assert.equal(report.nonce, nonce);
  const r = run(report, { nonce, chatSignature });
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.equal(status(r, "nonce-echo"), "pass");
  assert.equal(status(r, "node[0].quote-binding"), "pass");
  assert.equal(status(r, "signature-text"), "pass", "signature text is bound to the request hash, whatever the nonce");
  const without = run(report, { chatSignature });
  assert.equal(status(without, "nonce-echo"), "fail", "the default nonce is sha256(requestBody)");
  assert.equal(status(without, "node[0].quote-binding"), "fail", "the quote holds another nonce");
  assert.equal(without.verdict, VERDICT.REJECT, "the echo check alone rejects it");
  const nonceOnly = run(report, { nonce });
  assert.equal(nonceOnly.checks.filter((c) => c.id.startsWith("signature-")).length, 0, "no signature checks without a signature");
});

test("nonce-format: a non-string nonce fails and never reaches the quote; null means the default", () => {
  const { report } = good();
  for (const nonce of [7, {}, ["a"], true]) {
    const r = run(report, { nonce });
    assert.equal(status(r, "nonce-format"), "fail", String(nonce));
    assert.equal(status(r, "node[0].quote-binding"), undefined, String(nonce));
    assert.equal(r.verdict, VERDICT.REJECT);
  }
  const r = run(report, { nonce: null });
  assert.equal(status(r, "nonce-format"), "pass");
  assert.equal(status(r, "nonce-echo"), "pass");
  assert.equal(r.verdict, VERDICT.CONSISTENT);
});

test("model binding: the node's model_name beats the report's model, and either can fail", () => {
  const { report } = good();
  const withModels = (nodeName, topLevel) => {
    const node = { ...report.model_attestations[0] };
    if (nodeName === undefined) delete node.model_name; else node.model_name = nodeName;
    const rep = { ...report, model_attestations: [node] };
    if (topLevel === undefined) delete rep.model; else rep.model = topLevel;
    return run(rep).checks.find((c) => c.id === "node[0].model");
  };
  assert.equal(withModels(MOCK_MODEL, "other").status, "pass");
  assert.equal(withModels("other", MOCK_MODEL).status, "fail");
  assert.equal(withModels("other", MOCK_MODEL).detail, `report model other != requested ${MOCK_MODEL}`);
  assert.equal(withModels(undefined, MOCK_MODEL).detail, `model is ${MOCK_MODEL}`);
  assert.equal(withModels(undefined, "other").status, "fail");
  assert.equal(withModels(undefined, undefined).status, "skip");
  assert.equal(withModels(null, undefined).status, "skip", "a null model_name counts as absent");
  assert.equal(withModels(null, MOCK_MODEL).status, "pass", "and falls through to the report's model");
  assert.equal(withModels("", undefined).status, "fail", "an empty name is a value, not an absence");
});

test("chat signature: right hash but wrong model, missing text or missing signer all fail", () => {
  const { report, chatSignature } = good();
  const hash = requestHash(requestBody);
  const check = (sig, id) => status(run(report, { chatSignature: sig }), id);
  assert.equal(check({ ...chatSignature, text: `other-model:${hash}:resp` }, "signature-text"), "fail");
  assert.equal(check({ ...chatSignature, text: `${MOCK_MODEL}:${hash}:anything-goes` }, "signature-text"), "pass", "the response hash is not checked offline");
  assert.equal(check({ ...chatSignature, text: `${MOCK_MODEL}:${hash}` }, "signature-text"), "fail", "exactly three parts");
  assert.equal(check({ ...chatSignature, text: `${MOCK_MODEL}:${hash}:a:b` }, "signature-text"), "fail");
  assert.equal(check({ ...chatSignature, text: undefined }, "signature-text"), "fail");
  assert.equal(check({ ...chatSignature, signing_address: undefined }, "signature-signer"), "fail");
  assert.equal(check({ ...chatSignature, signing_address: 12 }, "signature-signer"), "fail");
  const r = run(report, { chatSignature: { signature: "0x00" } });
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.match(r.summary, /signature-text, signature-signer/);
});

test("requestHash is sha256 over the exact bytes, so any whitespace change rebinds the request", () => {
  assert.equal(requestHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(requestHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(requestHash(requestBody), sha256Hex(requestBody));
  assert.notEqual(requestHash(requestBody), requestHash(`${requestBody} `));
  assert.notEqual(requestHash(requestBody), requestHash(JSON.stringify(JSON.parse(requestBody), null, 2)));
});

test("fixture: labelled synthetic, zero signature, and model/nonce options flow into every field", () => {
  const { report, chatSignature } = good();
  assert.equal(report.synthetic, true);
  assert.equal(chatSignature.signature, "0x" + "00".repeat(65));
  assert.equal(chatSignature.signing_algo, "ecdsa");
  assert.equal(report.model_attestations[0].signing_algo, "ecdsa");
  assert.equal(JSON.parse(report.model_attestations[0].nvidia_payload).synthetic, true);
  assert.equal(JSON.parse(report.model_attestations[0].nvidia_payload).nonce, requestHash(requestBody));
  assert.equal(report.model_attestations[0].intel_quote.length, 632 * 2);
  assert.match(MOCK_SIGNING_ADDRESS, /^0x[0-9a-f]{40}$/);

  const custom = mockAttestation({ requestBody, model: "other/model", nonce: sha256Hex("n") });
  assert.equal(custom.report.model_attestations[0].model_name, "other/model");
  assert.equal(custom.report.nonce, sha256Hex("n"));
  assert.equal(custom.chatSignature.text.split(":")[0], "other/model");
  assert.equal(custom.chatSignature.text.split(":")[1], requestHash(requestBody));
  assert.equal(checkAttestation(custom.report, { requestBody, model: "other/model", nonce: sha256Hex("n"), chatSignature: custom.chatSignature }).verdict, VERDICT.CONSISTENT);
  assert.equal(checkAttestation(custom.report, { requestBody, model: MOCK_MODEL, nonce: sha256Hex("n") }).verdict, VERDICT.REJECT);
});
