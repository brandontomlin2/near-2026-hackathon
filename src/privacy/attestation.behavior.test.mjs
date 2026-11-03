import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../anchor/hash.mjs";
import { checkAttestation, requestHash, VERDICT, NOT_VERIFIED } from "./attestation.mjs";
import { mockAttestation, tdxV4Header, TAMPERED_ADDRESS, MOCK_MODEL, MOCK_SIGNING_ADDRESS } from "./fixture.mjs";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] });
const run = (report, extra = {}) => checkAttestation(report, { requestBody, model: MOCK_MODEL, ...extra });
const find = (r, id) => r.checks.find((c) => c.id === id);
const status = (r, id) => find(r, id)?.status;
const good = () => mockAttestation({ requestBody });
const node0 = (report) => report.model_attestations[0];
const NONCE = requestHash(requestBody);
const ADDR = Buffer.from(MOCK_SIGNING_ADDRESS.slice(2), "hex");

// Build a quote of `len` bytes with the nonce / address at chosen offsets.
// By default it carries a TDX v4 header (version 4, tee_type 0x81).
function quoteWith({ len = 632, nonceAt, addrAt, header = true }) {
  const q = Buffer.alloc(len);
  if (header) tdxV4Header().copy(q, 0);
  if (nonceAt !== undefined) Buffer.from(NONCE, "hex").copy(q, nonceAt);
  if (addrAt !== undefined) ADDR.copy(q, addrAt);
  return q.toString("hex");
}
const withQuote = (hex) => { const { report } = good(); node0(report).intel_quote = hex; return run(report); };

// 1. Honesty invariants across junk and good inputs.
test("honesty invariants hold for every input shape", () => {
  const g = good();
  const tampered = mockAttestation({ requestBody: requestBody + " " }).report;
  const matrix = [
    ["good", g.report], ["tampered", tampered], ["{}", {}], ["null", null], ["undefined", undefined],
    ["string", "string"], ["42", 42], ["[]", []],
    ["empty object entries", { model_attestations: {} }],
    ["[null]", { model_attestations: [null] }],
    ["[{}]", { model_attestations: [{}] }],
  ];
  const statuses = new Set(["pass", "fail", "skip", "unverifiable"]);
  const verdicts = new Set(Object.values(VERDICT));
  for (const [label, input] of matrix) {
    const r = run(input, { chatSignature: g.chatSignature });
    assert.equal(r.verified, false, label);
    assert.ok(verdicts.has(r.verdict), label);
    assert.deepEqual(r.notVerified, NOT_VERIFIED, label);
    const consistent = r.verdict === VERDICT.CONSISTENT;
    if (consistent) assert.match(r.summary, /NOT VERIFIED/, label);
    else {
      assert.ok(r.summary.startsWith("REJECT:"), label);
      assert.doesNotMatch(r.summary, /verified/i, label);
    }
    for (const c of r.checks) {
      assert.equal(typeof c.id, "string", label);
      assert.equal(typeof c.detail, "string", label);
      assert.ok(statuses.has(c.status), `${label}: ${c.status}`);
    }
    const idList = r.checks.map((c) => c.id);
    assert.equal(new Set(idList).size, idList.length, `${label}: duplicate check ids`);
  }
});

test("notVerified is a fresh copy; the shared list stays frozen and unchanged", () => {
  const before = [...NOT_VERIFIED];
  const r = run(good().report);
  assert.notEqual(r.notVerified, NOT_VERIFIED);
  r.notVerified.push("tampered");
  r.notVerified[0] = "tampered";
  assert.deepEqual(NOT_VERIFIED, before);
  assert.equal(Object.isFrozen(NOT_VERIFIED), true);
  assert.deepEqual(run(good().report).notVerified, before);
});

// 2. TEE path unavailable.
test("no report at all is a REJECT on structure alone, never consistent", () => {
  for (const missing of [undefined, null, { error: "ECONNREFUSED" }, { model_attestations: [] }]) {
    const r = run(missing);
    assert.equal(r.verdict, VERDICT.REJECT);
    assert.equal(r.checks.length, 1);
    assert.equal(r.checks[0].id, "structure");
    assert.equal(r.checks[0].status, "fail");
    assert.match(r.checks[0].detail, /model_attestations/);
    assert.equal(r.summary, "REJECT: structure.");
  }
});

// 3. Constants.
test("VERDICT has only consistent and reject, frozen, never 'verified'", () => {
  assert.deepEqual(Object.keys(VERDICT).sort(), ["CONSISTENT", "REJECT"]);
  assert.equal(VERDICT.CONSISTENT, "consistent");
  assert.equal(VERDICT.REJECT, "reject");
  assert.equal(Object.isFrozen(VERDICT), true);
  assert.ok(!Object.values(VERDICT).includes("verified"));
});

test("NOT_VERIFIED lists what is skipped, by name", () => {
  assert.ok(NOT_VERIFIED.length >= 5);
  for (const s of NOT_VERIFIED) assert.ok(typeof s === "string" && s.length > 0);
  const all = NOT_VERIFIED.join("\n");
  for (const needle of ["Intel TDX", "NVIDIA NRAS", "ECDSA", "real TEE"]) assert.ok(all.includes(needle), needle);
});

// nvidia_payload string-null regression.
test("nvidia_payload: string 'null' fails like null; '[]', '{}' and a real array pass", () => {
  const set = (v) => { const { report } = good(); node0(report).nvidia_payload = v; return status(run(report), "node[0].nvidia-payload"); };
  assert.equal(set("null"), "fail");
  assert.equal(set(null), "fail");
  // Arrays are objects to both branches, so they are accepted (documented leniency).
  assert.equal(set("[]"), "pass");
  assert.equal(set("{}"), "pass");
  assert.equal(set([]), "pass");
});

// 4. Multi-node.
test("a failing second node rejects the report; ids are per node", () => {
  const { report } = good();
  report.model_attestations.push({ ...structuredClone(node0(report)), signing_address: "0x12" });
  const r = run(report);
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.equal(status(r, "node[0].signing-key"), "pass");
  assert.equal(status(r, "node[1].signing-key"), "fail");
  assert.equal(r.summary, "REJECT: node[1].signing-key.");
  assert.equal(r.checks.filter((c) => c.id.startsWith("node[1].")).length, 5);
  assert.equal(r.checks.filter((c) => c.id.startsWith("node[0].")).length, 6);
});

test("two good nodes are consistent and both are checked", () => {
  const { report } = good();
  report.model_attestations.push(structuredClone(node0(report)));
  const r = run(report);
  assert.equal(r.verdict, VERDICT.CONSISTENT);
  assert.equal(status(r, "node[1].quote-binding"), "pass");
  assert.equal(r.checks.filter((c) => c.id.startsWith("node[1].")).length, 6);
  assert.match(find(r, "structure").detail, /^2 node/);
});

// 5. Nonce handling.
test("non-string report.nonce skips nonce-echo", () => {
  const { report } = good();
  report.nonce = 42;
  assert.equal(status(run(report), "nonce-echo"), "skip");
});

test("explicit expected.nonce is honoured; signature text still binds the real request", () => {
  const other = requestBody + " ";
  const { report } = mockAttestation({ requestBody: other });
  const forReal = mockAttestation({ requestBody }).chatSignature;
  const forOther = mockAttestation({ requestBody: other }).chatSignature;
  const ok = run(report, { nonce: requestHash(other), chatSignature: forReal });
  assert.equal(status(ok, "nonce-echo"), "pass");
  assert.equal(status(ok, "node[0].quote-binding"), "pass");
  assert.equal(status(ok, "signature-text"), "pass");
  assert.equal(ok.verdict, VERDICT.CONSISTENT);
  const bad = run(report, { nonce: requestHash(other), chatSignature: forOther });
  assert.equal(status(bad, "signature-text"), "fail");
});

test("nonce-format rejects 63 hex chars and a 0x prefix", () => {
  const { report } = good();
  for (const nonce of [NONCE.slice(1), "0x" + NONCE]) {
    const r = run(report, { nonce });
    assert.equal(status(r, "nonce-format"), "fail");
    assert.equal(r.verdict, VERDICT.REJECT);
  }
});

// 6. Quote binding. The layout (v4 header, REPORTDATA at 568..632, raw nonce
// and raw address inside it) is OUR assumption; the docs only say the two are
// "bound". So the check passes when the assumption is confirmed byte for byte
// and is "unverifiable" ONLY when the quote is hex but too short to hold a v4
// report body. A non-hex quote, or a 632+ byte quote without our values (any
// header), fails, exactly as on origin/main.
const binding = (hex) => find(withQuote(hex), "node[0].quote-binding");

test("quote binding, truncated hex quote: unverifiable, not rejected, and the summary says the binding is unread", () => {
  const shapes = {
    "too short": quoteWith({ len: 631, nonceAt: 568, addrAt: 600 }).slice(0, 631 * 2),
    "tiny": "abcd",
  };
  for (const [label, hex] of Object.entries(shapes)) {
    const r = withQuote(hex);
    const c = find(r, "node[0].quote-binding");
    assert.equal(c.status, "unverifiable", label);
    assert.ok(c.detail.length > 20, `${label}: has a reason`);
    assert.notEqual(r.verdict, VERDICT.REJECT, `${label}: not rejected on an unconfirmed layout`);
    assert.equal(r.summary,
      "CONSISTENT, NOT VERIFIED, BINDING UNREAD: offline fields agree, but no TEE signature or certificate was checked. Unverifiable, not counted either way: node[0].quote-binding.",
      label);
    assert.deepEqual(r.unverifiable, ["node[0].quote-binding"], label);
    assert.equal(r.verdict, VERDICT.CONSISTENT,
      label);
  }
  assert.equal(withQuote(quoteWith({ nonceAt: 600, addrAt: 568 })).summary,
    "CONSISTENT, NOT VERIFIED: offline fields agree, but no TEE signature or certificate was checked.");
});

test("quote binding, v4 with raw bytes: passes, says so, and says the quote is unauthenticated", () => {
  const c = binding(quoteWith({ nonceAt: 600, addrAt: 568 }));
  assert.equal(c.status, "pass");
  assert.match(c.detail, /^TDX v4 quote; bytes 568\.\.632 hold our nonce and the signing address as raw bytes/);
  assert.match(c.detail, /quote itself unauthenticated/);
  // 0x prefix and upper case hex are the same bytes.
  const hex = quoteWith({ nonceAt: 600, addrAt: 568 });
  assert.equal(binding("0x" + hex).status, "pass");
  assert.equal(binding(hex.toUpperCase()).status, "pass");
  // Either order within REPORTDATA, and longer quotes (a real one carries a signature after byte 632).
  assert.equal(binding(quoteWith({ nonceAt: 568, addrAt: 568 + 32 })).status, "pass");
  assert.equal(binding(quoteWith({ len: 2000, nonceAt: 568 + 32, addrAt: 568 })).status, "pass");
});

test("quote binding, readable v4 quote with the wrong values: fails and rejects, names what is missing", () => {
  const both = binding(quoteWith({}));
  assert.equal(both.status, "fail");
  assert.equal(both.detail,
    "TDX v4 quote; bytes 568..632 do not hold the raw nonce and signing address (stale, replayed or another node's quote)");
  assert.equal(withQuote(quoteWith({})).verdict, VERDICT.REJECT);
  const noAddr = binding(quoteWith({ nonceAt: 568, addrAt: 568 + 60 })); // address runs past byte 632
  assert.equal(noAddr.status, "fail");
  assert.match(noAddr.detail, /raw signing address \(/);
  assert.doesNotMatch(noAddr.detail, /nonce and/);
  const noNonce = binding(quoteWith({ len: 700, nonceAt: 601, addrAt: 568 })); // nonce runs past byte 632
  assert.equal(noNonce.status, "fail");
  assert.match(noNonce.detail, /raw nonce \(/);
  assert.match(binding(quoteWith({ nonceAt: 600, addrAt: 567 })).detail, /raw signing address \(/); // one byte before REPORTDATA
  assert.equal(withQuote(quoteWith({ nonceAt: 600 })).verdict, VERDICT.REJECT);
  assert.equal(withQuote(quoteWith({ addrAt: 568 })).verdict, VERDICT.REJECT);
});

test("no top-level nonce: a v4 quote bound to a different nonce or address REJECTs, not CONSISTENT", () => {
  const noEcho = (hex) => { const { report } = good(); delete report.nonce; node0(report).intel_quote = hex; return run(report); };
  assert.equal(status(noEcho(quoteWith({ nonceAt: 600, addrAt: 568 })), "nonce-echo"), "skip");
  assert.equal(noEcho(quoteWith({ nonceAt: 600, addrAt: 568 })).verdict, VERDICT.CONSISTENT, "a confirmed quote binding is enough");
  const other = Buffer.from(sha256Hex("another request"), "hex").toString("hex");
  const wrongNonce = Buffer.from(quoteWith({ addrAt: 568 }), "hex");
  Buffer.from(other, "hex").copy(wrongNonce, 600);
  const a = noEcho(wrongNonce.toString("hex"));
  assert.equal(status(a, "node[0].quote-binding"), "fail");
  assert.equal(a.verdict, VERDICT.REJECT);
  const wrongAddr = Buffer.from(quoteWith({ nonceAt: 600 }), "hex");
  Buffer.alloc(20, 0x11).copy(wrongAddr, 568);
  const b = noEcho(wrongAddr.toString("hex"));
  assert.equal(status(b, "node[0].quote-binding"), "fail");
  assert.equal(b.verdict, VERDICT.REJECT);
});

test("no top-level nonce and a truncated quote: zero request binding, so REJECT", () => {
  const { report } = good();
  delete report.nonce;
  node0(report).intel_quote = "abcd";
  const r = run(report);
  assert.equal(status(r, "nonce-echo"), "skip");
  assert.equal(status(r, "node[0].quote-binding"), "unverifiable");
  assert.equal(status(r, "request-binding"), "fail");
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.equal(r.summary, "REJECT: request-binding.");
});

test("quote binding, short hex quote: unverifiable with the reason (the only input that reaches BINDING UNREAD)", () => {
  const short = binding(quoteWith({ nonceAt: 568, addrAt: 600 }).slice(0, 631 * 2));
  assert.equal(short.status, "unverifiable");
  assert.equal(short.detail, "intel_quote is 631 bytes, too short to hold TDX report data");
  assert.equal(binding("abcd").detail, "intel_quote is 2 bytes, too short to hold TDX report data");
});

test("quote binding, 632+ bytes with a non-v4 header: judged at offset 568 exactly as on main", () => {
  // Raw values in place under a v5 header: main passed this (it never read the header); so do we, and say what header it was.
  const v5 = Buffer.from(quoteWith({ nonceAt: 600, addrAt: 568 }), "hex");
  v5.writeUInt16LE(5, 0);
  const c5 = binding(v5.toString("hex"));
  assert.equal(c5.status, "pass");
  assert.match(c5.detail, /^quote header version 5, tee_type 0x81 \(not TDX v4\); bytes 568\.\.632 hold our nonce/);
  // The same header without our values fails; it is never "unverifiable".
  const stale = Buffer.from(quoteWith({}), "hex");
  stale.writeUInt16LE(5, 0);
  const s5 = binding(stale.toString("hex"));
  assert.equal(s5.status, "fail");
  assert.match(s5.detail, /^quote header version 5, tee_type 0x81 \(not TDX v4\); bytes 568\.\.632 do not hold the raw nonce and signing address/);
  // SGX tee type and no header at all behave the same way.
  const sgx = Buffer.from(quoteWith({}), "hex");
  sgx.writeUInt32LE(0, 4);
  assert.equal(binding(sgx.toString("hex")).status, "fail");
  assert.equal(binding(quoteWith({ header: false })).status, "fail");
  assert.equal(binding(quoteWith({ header: false, nonceAt: 600, addrAt: 568 })).status, "pass", "as on main");
});

test("quote binding, non-hex quote: FAIL (as on main), never unverifiable", () => {
  for (const q of ["zz", "abc", "0xzz", "not a quote at all", "00".repeat(700) + "g"]) {
    const c = binding(q);
    assert.equal(c.status, "fail", q.slice(0, 20));
    assert.equal(c.detail, "intel_quote is not hex");
  }
});

// Replay cases: the report echoes the CORRECT top-level nonce (so nonce-echo
// passes) but the quote is garbage or stale. These must REJECT, never CONSISTENT.
test("replay (a): correct nonce echoed, garbage quote -> REJECT, exit-1 verdict, no unverifiable", () => {
  for (const q of ["zz", "this is not hex", "abc", "0x" + "zz".repeat(400)]) {
    const r = withQuote(q);
    assert.equal(status(r, "nonce-echo"), "pass");
    assert.equal(status(r, "node[0].quote-binding"), "fail", q);
    assert.equal(r.verdict, VERDICT.REJECT, q);
    assert.deepEqual(r.unverifiable, [], q);
    assert.match(r.summary, /^REJECT: node\[0\]\.quote-binding\.$/, q);
  }
});

test("replay (b): correct nonce echoed, stale non-v4 quote of 632+ bytes -> REJECT", () => {
  const other = Buffer.from(sha256Hex("an earlier request"), "hex");
  for (const [version, teeType] of [[5, 0x81], [3, 0x81], [4, 0], [0, 0], [0xffff, 0xffffffff]]) {
    for (const len of [632, 700, 5000]) {
      const q = Buffer.alloc(len);
      q.writeUInt16LE(version, 0);
      q.writeUInt32LE(teeType, 4);
      other.copy(q, 568 + 32); // someone else's nonce
      ADDR.copy(q, 568);
      const r = withQuote(q.toString("hex"));
      assert.equal(status(r, "nonce-echo"), "pass");
      assert.equal(status(r, "node[0].quote-binding"), "fail", `v${version} t${teeType} len ${len}`);
      assert.equal(r.verdict, VERDICT.REJECT, `v${version} t${teeType} len ${len}`);
      assert.deepEqual(r.unverifiable, []);
    }
  }
});

test("tampered fixture (attest:check --tamper, a well-formed wrong address): REJECTed through the quote binding", () => {
  const { report, chatSignature } = good();
  node0(report).signing_address = TAMPERED_ADDRESS;
  const r = run(report, { chatSignature });
  assert.equal(r.verdict, VERDICT.REJECT);
  assert.equal(status(r, "node[0].signing-key"), "pass");
  assert.equal(status(r, "node[0].quote-binding"), "fail");
  assert.equal(r.summary, "REJECT: node[0].quote-binding, signature-signer.");
  // A malformed address still rejects, with no binding check.
  node0(report).signing_address = "0x00";
  assert.equal(status(run(report), "node[0].signing-key"), "fail");
  // A report built for another request is rejected by the nonce echo and by the quote binding.
  const other = mockAttestation({ requestBody: requestBody + " " }).report;
  const o = run(other);
  assert.equal(o.verdict, VERDICT.REJECT);
  assert.equal(status(o, "nonce-echo"), "fail");
  assert.equal(status(o, "node[0].quote-binding"), "fail");
  assert.equal(o.summary, "REJECT: nonce-echo, node[0].quote-binding.");
});

test("fixture quote carries a TDX v4 header so the pass path is the one a v4 report would take", () => {
  const q = Buffer.from(node0(good().report).intel_quote, "hex");
  assert.equal(q.length, 632);
  assert.equal(q.readUInt16LE(0), 4);
  assert.equal(q.readUInt16LE(2), 2);
  assert.equal(q.readUInt32LE(4), 0x81);
  assert.deepEqual(q.subarray(0, 48), tdxV4Header());
});

// 7. Model binding.
test("model: node model_name wins over report.model; absent falls back to report.model", () => {
  const setup = (name, top) => {
    const { report } = good();
    if (name === undefined) delete node0(report).model_name; else node0(report).model_name = name;
    if (top !== undefined) report.model = top;
    return run(report);
  };
  assert.equal(status(setup("other", MOCK_MODEL), "node[0].model"), "fail");
  assert.equal(status(setup(MOCK_MODEL, "other"), "node[0].model"), "pass");
  assert.equal(status(setup(undefined, MOCK_MODEL), "node[0].model"), "pass");
  const bad = find(setup(undefined, "X"), "node[0].model");
  assert.equal(bad.status, "fail");
  assert.equal(bad.detail, `report model X != requested ${MOCK_MODEL}`);
});

test("model: null model_name falls through to report.model; empty string does not", () => {
  const setup = (name, top) => {
    const { report } = good();
    node0(report).model_name = name;
    if (top !== undefined) report.model = top;
    return run(report);
  };
  assert.equal(status(setup(null, MOCK_MODEL), "node[0].model"), "pass");
  assert.equal(status(setup(null, "X"), "node[0].model"), "fail");
  assert.equal(status(setup(null), "node[0].model"), "skip");
  // Nullish, not falsy: "" is a real (wrong) name and is not replaced by report.model.
  assert.equal(status(setup("", MOCK_MODEL), "node[0].model"), "fail");
});

// 8. signing_algo.
test("signing_algo is case sensitive; null is checked and fails", () => {
  const algo = (v) => { const { report } = good(); node0(report).signing_algo = v; return run(report); };
  assert.equal(status(algo("ecdsa"), "node[0].signing-algo"), "pass");
  assert.equal(status(algo("ECDSA"), "node[0].signing-algo"), "fail");
  assert.equal(status(algo(null), "node[0].signing-algo"), "fail");
});

// 9. chatSignature edges.
test("chatSignature with missing text or signing_address fails without throwing", () => {
  const { report, chatSignature } = good();
  const noText = run(report, { chatSignature: { ...chatSignature, text: undefined } });
  assert.equal(status(noText, "signature-text"), "fail");
  const noSigner = run(report, { chatSignature: { ...chatSignature, signing_address: undefined } });
  assert.equal(status(noSigner, "signature-signer"), "fail");
  assert.equal(noSigner.verdict, VERDICT.REJECT);
});

test("chatSignature text must be exactly three parts with our model and hash", () => {
  const { report } = good();
  const sig = (text) => ({ text, signature: "0x", signing_address: MOCK_SIGNING_ADDRESS });
  const st = (text) => status(run(report, { chatSignature: sig(text) }), "signature-text");
  assert.equal(st(`${MOCK_MODEL}:${NONCE}:resp`), "pass");
  assert.equal(st(`${MOCK_MODEL}:${NONCE}:a:b`), "fail");
  assert.equal(st(`other-model:${NONCE}:resp`), "fail");
  assert.equal(st(`${MOCK_MODEL}:${requestHash("other")}:resp`), "fail");
});

test("chatSignature signer match ignores letter case in either direction", () => {
  const { report, chatSignature } = good();
  const lower = { ...chatSignature, signing_address: MOCK_SIGNING_ADDRESS.toLowerCase() };
  const upperNode = structuredClone(report);
  node0(upperNode).signing_address = "0x" + MOCK_SIGNING_ADDRESS.slice(2).toUpperCase();
  assert.equal(status(run(upperNode, { chatSignature: lower }), "signature-signer"), "pass");
  const upperSig = { ...chatSignature, signing_address: "0x" + MOCK_SIGNING_ADDRESS.slice(2).toUpperCase() };
  assert.equal(status(run(report, { chatSignature: upperSig }), "signature-signer"), "pass");
});

test("chatSignature null adds no signature checks", () => {
  const r = run(good().report, { chatSignature: null });
  assert.equal(r.checks.filter((c) => c.id.startsWith("signature-")).length, 0);
});

// 10. Summary.
test("summary lists every failed id in check order, comma separated, ending with a period", () => {
  const { report } = good();
  report.nonce = "x";
  node0(report).signing_address = "0x12";
  node0(report).nvidia_payload = "not json";
  node0(report).model_name = "other";
  const r = run(report);
  assert.equal(r.summary, "REJECT: nonce-echo, node[0].signing-key, node[0].nvidia-payload, node[0].model.");
});

test("consistent summary is the exact NOT VERIFIED sentence", () => {
  const { report, chatSignature } = good();
  assert.equal(run(report, { chatSignature }).summary,
    "CONSISTENT, NOT VERIFIED: offline fields agree, but no TEE signature or certificate was checked.");
});

// 11. Hash helpers and fixture binding.
test("requestHash and sha256Hex are plain sha256 of the body", () => {
  assert.equal(requestHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(""), requestHash(""));
  assert.notEqual(requestHash("a"), requestHash("b"));
});

test("fixture nonce and signed text are tied to the request hash", () => {
  const { report, chatSignature } = good();
  assert.equal(report.nonce, requestHash(requestBody));
  assert.ok(chatSignature.text.startsWith(`${MOCK_MODEL}:${requestHash(requestBody)}:`));
});

// 12. Fixture honesty.
test("fixture is flagged synthetic with an all-zero 65-byte signature", () => {
  const { report, chatSignature } = good();
  assert.equal(report.synthetic, true);
  assert.equal(chatSignature.signature, "0x" + "00".repeat(65));
});

test("fixture with a custom nonce uses it in report.nonce and in the quote", () => {
  const nonce = "ab".repeat(32);
  const { report } = mockAttestation({ requestBody, nonce });
  assert.equal(report.nonce, nonce);
  const quote = Buffer.from(node0(report).intel_quote, "hex");
  assert.ok(quote.subarray(568, 632).includes(Buffer.from(nonce, "hex")));
  assert.equal(status(run(report, { nonce }), "node[0].quote-binding"), "pass");
});
