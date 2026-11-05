// Malformed attestation fixtures and binding mismatches: mockAttestation output (and
// mutated copies of it) go through the real checker, and must be rejected for the right reason.
import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { checkAttestation, requestHash } from "./attestation.mjs";
import {
  MOCK_MODEL, MOCK_SIGNING_ADDRESS, TAMPERED_ADDRESS, TDX_V4_QUOTE_LENGTH, TDX_V4_REPORT_DATA_OFFSET,
  mockAttestation, tdxV4Header,
} from "./fixture.mjs";

const body = '{"model":"mock-tee-model","messages":[{"role":"user","content":"hi"}]}';
const NONCE_AT = TDX_V4_REPORT_DATA_OFFSET + 32;

function fresh(opts = {}) {
  const m = mockAttestation({ requestBody: body, ...opts });
  return { ...m, expected: { requestBody: body, model: opts.model ?? MOCK_MODEL, chatSignature: m.chatSignature } };
}
function node(report) { return report.model_attestations[0]; }
function quoteBytes(report) { return Buffer.from(node(report).intel_quote, "hex"); }
function setQuote(report, buf) { node(report).intel_quote = buf.toString("hex"); }
function check(report, expected) { return checkAttestation(report, expected); }
function failed(r) { return r.checks.filter((c) => c.status === "fail").map((c) => c.id); }
function byId(r, id) { return r.checks.find((c) => c.id === id); }

describe("baseline", () => {
  test("untouched fixture is consistent with every binding check passing and nothing unverifiable", () => {
    const { report, expected } = fresh();
    const r = check(report, expected);
    assert.equal(r.verdict, "consistent");
    assert.equal(r.verified, false);
    assert.deepEqual(failed(r), []);
    assert.deepEqual(r.unverifiable, []);
    assert.equal(byId(r, "node[0].quote-binding").status, "pass");
    assert.equal(byId(r, "nonce-echo").status, "pass");
    assert.equal(byId(r, "signature-text").status, "pass");
    assert.equal(byId(r, "signature-signer").status, "pass");
  });

  test("header bytes are exact: 04 00 02 00 81 00 00 00 then zeros, 48 long", () => {
    const h = tdxV4Header();
    assert.equal(h.length, 48);
    assert.equal(h.subarray(0, 8).toString("hex"), "0400020081000000");
    assert.ok(h.subarray(8).every((x) => x === 0));
    assert.equal(quoteBytes(fresh().report).subarray(0, 48).toString("hex"), h.toString("hex"));
  });

  test("tdxV4Header returns a fresh buffer each call, so mutating one does not corrupt later fixtures", () => {
    const h = tdxV4Header();
    h[0] = 0xff;
    assert.equal(tdxV4Header()[0], 4);
    assert.equal(quoteBytes(fresh().report)[0], 4);
  });
});

describe("quote byte mutations are rejected as quote-binding failures", () => {
  test("flipping any single bit of the nonce bytes in the quote rejects", () => {
    for (const offset of [NONCE_AT, NONCE_AT + 15, NONCE_AT + 31]) {
      const { report, expected } = fresh();
      const q = quoteBytes(report);
      q[offset] ^= 0x01;
      setQuote(report, q);
      const r = check(report, expected);
      assert.equal(r.verdict, "reject", `offset ${offset}`);
      assert.deepEqual(failed(r), ["node[0].quote-binding"], `offset ${offset}`);
      assert.match(byId(r, "node[0].quote-binding").detail, /do not hold the raw nonce\b(?! and)/);
    }
  });

  test("flipping a byte of the address in the quote rejects, naming the signing address only", () => {
    const { report, expected } = fresh();
    const q = quoteBytes(report);
    q[TDX_V4_REPORT_DATA_OFFSET + 5] ^= 0xff;
    setQuote(report, q);
    const r = check(report, expected);
    assert.deepEqual(failed(r), ["node[0].quote-binding"]);
    assert.match(byId(r, "node[0].quote-binding").detail, /do not hold the raw signing address/);
    assert.doesNotMatch(byId(r, "node[0].quote-binding").detail, /nonce/);
  });

  test("zeroing the whole report data names both nonce and signing address", () => {
    const { report, expected } = fresh();
    const q = quoteBytes(report);
    q.fill(0, TDX_V4_REPORT_DATA_OFFSET, TDX_V4_QUOTE_LENGTH);
    setQuote(report, q);
    const r = check(report, expected);
    assert.match(byId(r, "node[0].quote-binding").detail, /raw nonce and signing address/);
  });

  test("bytes flipped outside REPORTDATA (body zeros) do not change the binding verdict", () => {
    const { report, expected } = fresh();
    const q = quoteBytes(report);
    q[100] = 0xaa;
    q[567] = 0xbb;
    setQuote(report, q);
    assert.equal(check(report, expected).verdict, "consistent");
  });

  test("swapping the signing_address field to TAMPERED_ADDRESS rejects binding, signer and keeps nonce checks passing", () => {
    const { report, expected } = fresh();
    node(report).signing_address = TAMPERED_ADDRESS;
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.deepEqual(failed(r).sort(), ["node[0].quote-binding", "signature-signer"]);
    assert.match(byId(r, "node[0].quote-binding").detail, /do not hold the raw signing address/);
    assert.equal(byId(r, "nonce-echo").status, "pass");
  });

  test("rewriting the quote to carry TAMPERED_ADDRESS makes the binding agree with the swapped field (only the signer check is left to catch a chat signature from the old key)", () => {
    const { report, expected } = fresh();
    node(report).signing_address = TAMPERED_ADDRESS;
    const q = quoteBytes(report);
    Buffer.from(TAMPERED_ADDRESS.slice(2), "hex").copy(q, TDX_V4_REPORT_DATA_OFFSET);
    setQuote(report, q);
    const r = check(report, expected);
    assert.equal(byId(r, "node[0].quote-binding").status, "pass");
    assert.deepEqual(failed(r), ["signature-signer"]);
  });

  test("a signing address given in upper case still matches the lower-case bytes in the quote", () => {
    const { report, expected } = fresh();
    node(report).signing_address = "0x" + MOCK_SIGNING_ADDRESS.slice(2).toUpperCase();
    const r = check(report, expected);
    assert.equal(byId(r, "node[0].quote-binding").status, "pass");
    assert.equal(byId(r, "signature-signer").status, "pass");
  });

  test("a 0x prefix on intel_quote is tolerated by the checker", () => {
    const { report, expected } = fresh();
    node(report).intel_quote = "0x" + node(report).intel_quote;
    assert.equal(check(report, expected).verdict, "consistent");
  });
});

describe("malformed intel_quote", () => {
  test("wrong header version rejects with the version in the reason and report data unread", () => {
    for (const v of [0, 3, 6, 0xffff]) {
      const { report, expected } = fresh();
      const q = quoteBytes(report);
      q.writeUInt16LE(v, 0);
      setQuote(report, q);
      const r = check(report, expected);
      assert.equal(r.verdict, "reject", `version ${v}`);
      assert.match(byId(r, "node[0].quote-binding").detail, new RegExp(`header says version ${v}, tee_type 0x81`));
      assert.match(byId(r, "node[0].quote-binding").detail, /report data not read/);
    }
  });

  test("wrong TEE type (SGX 0x0, 0x80, 0x82) rejects with the type in the reason", () => {
    for (const t of [0x0, 0x80, 0x82]) {
      const { report, expected } = fresh();
      const q = quoteBytes(report);
      q.writeUInt32LE(t, 4);
      setQuote(report, q);
      const r = check(report, expected);
      assert.equal(r.verdict, "reject", `tee ${t}`);
      assert.match(byId(r, "node[0].quote-binding").detail, new RegExp(`tee_type 0x${t.toString(16)},`));
    }
  });

  test("a v5 header on a v4-shaped quote is judged by v5 rules (body type 0 here), not read at the v4 offset", () => {
    const { report, expected } = fresh();
    const q = quoteBytes(report);
    q.writeUInt16LE(5, 0);
    setQuote(report, q);
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.match(byId(r, "node[0].quote-binding").detail, /v5 quote with body type 0/);
  });

  test("truncated quotes are unverifiable, not rejected, and the summary says BINDING UNREAD", () => {
    for (const len of [0, 1, 47, 48, 600, 631]) {
      const { report, expected } = fresh();
      setQuote(report, quoteBytes(report).subarray(0, len));
      const r = check(report, expected);
      if (len === 0) {
        // empty string counts as a missing quote
        assert.equal(r.verdict, "reject", "len 0");
        assert.equal(byId(r, "node[0].intel-quote").status, "fail");
        continue;
      }
      assert.equal(r.verdict, "consistent", `len ${len}`);
      assert.deepEqual(r.unverifiable, ["node[0].quote-binding"], `len ${len}`);
      assert.match(r.summary, /BINDING UNREAD/);
      assert.match(byId(r, "node[0].quote-binding").detail, new RegExp(`${len} byte`));
    }
  });

  test("a truncated quote with a wrong nonce echo still rejects through nonce-echo (unread binding does not hide a stale report)", () => {
    const { report, expected } = fresh();
    setQuote(report, quoteBytes(report).subarray(0, 100));
    report.nonce = "cd".repeat(32);
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.deepEqual(failed(r), ["nonce-echo"]);
  });

  test("a truncated quote with no nonce echo is rejected by request-binding (nothing ties report to request)", () => {
    const { report, expected } = fresh();
    delete report.nonce;
    setQuote(report, quoteBytes(report).subarray(0, 100));
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.ok(failed(r).includes("request-binding"));
  });

  test("a full-length quote with no nonce echo passes on the quote binding alone", () => {
    const { report, expected } = fresh();
    delete report.nonce;
    const r = check(report, expected);
    assert.equal(r.verdict, "consistent");
    assert.equal(byId(r, "nonce-echo").status, "skip");
  });

  test("a quote longer than 632 bytes (signature section appended) is still read at the v4 offset", () => {
    const { report, expected } = fresh();
    setQuote(report, Buffer.concat([quoteBytes(report), Buffer.alloc(200, 0xee)]));
    assert.equal(check(report, expected).verdict, "consistent");
  });

  test("odd-length hex and non-hex quotes fail as 'not hex'", () => {
    for (const bad of [node(fresh().report).intel_quote.slice(1), "zz" + "00".repeat(700), "not a quote", "0x"]) {
      const { report, expected } = fresh();
      node(report).intel_quote = bad;
      const r = check(report, expected);
      if (bad === "0x") {
        // "0x" alone is a non-empty string that decodes to zero bytes: too short, unverifiable.
        assert.deepEqual(r.unverifiable, ["node[0].quote-binding"]);
        continue;
      }
      assert.equal(r.verdict, "reject", bad.slice(0, 10));
      assert.match(byId(r, "node[0].quote-binding").detail, /not hex/);
    }
  });

  test("missing or non-string intel_quote fails intel-quote and skips the binding check", () => {
    for (const v of [undefined, null, 123, ""]) {
      const { report, expected } = fresh();
      node(report).intel_quote = v;
      const r = check(report, expected);
      assert.equal(r.verdict, "reject");
      assert.equal(byId(r, "node[0].intel-quote").status, "fail");
      assert.equal(byId(r, "node[0].quote-binding"), undefined);
    }
  });
});

describe("malformed report structure", () => {
  test("missing, empty and non-array model_attestations are rejected as structure failures", () => {
    for (const mutate of [(r) => { delete r.model_attestations; }, (r) => { r.model_attestations = []; }, (r) => { r.model_attestations = {}; }, (r) => { r.model_attestations = "x"; }]) {
      const { report, expected } = fresh();
      mutate(report);
      const r = check(report, expected);
      assert.equal(r.verdict, "reject");
      assert.deepEqual(failed(r), ["structure"]);
    }
  });

  test("null and empty-object reports are rejected without throwing", () => {
    const { expected } = fresh();
    assert.equal(check(null, expected).verdict, "reject");
    assert.equal(check({}, expected).verdict, "reject");
  });

  test("a second, tampered node rejects the whole report and is named by index", () => {
    const { report, expected } = fresh();
    const second = structuredClone(node(report));
    second.signing_address = TAMPERED_ADDRESS;
    report.model_attestations.push(second);
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.deepEqual(failed(r), ["node[1].quote-binding"]);
    assert.equal(byId(r, "node[0].quote-binding").status, "pass");
  });

  test("a non-object node entry fails its checks without throwing", () => {
    const { report, expected } = fresh();
    report.model_attestations = [null];
    const r = check(report, expected);
    assert.equal(r.verdict, "reject");
    assert.ok(failed(r).includes("node[0].signing-key"));
    assert.ok(failed(r).includes("node[0].intel-quote"));
  });

  test("malformed signing_address values fail signing-key and skip the binding check", () => {
    for (const bad of [undefined, "0x1234", MOCK_SIGNING_ADDRESS.slice(2), MOCK_SIGNING_ADDRESS + "00", "0x" + "zz".repeat(20)]) {
      const { report, expected } = fresh();
      node(report).signing_address = bad;
      const r = check(report, expected);
      assert.equal(r.verdict, "reject");
      assert.ok(failed(r).includes("node[0].signing-key"));
      assert.equal(byId(r, "node[0].quote-binding"), undefined);
    }
  });

  test("unknown signing_algo fails; ed25519 and ecdsa pass", () => {
    for (const [algo, bad] of [["rsa", true], ["ed25519", false], ["ecdsa", false]]) {
      const { report, expected } = fresh();
      node(report).signing_algo = algo;
      assert.equal(check(report, expected).verdict, bad ? "reject" : "consistent", algo);
    }
  });

  test("a non-JSON nvidia_payload fails only the nvidia-payload check", () => {
    const { report, expected } = fresh();
    node(report).nvidia_payload = "{not json";
    assert.deepEqual(failed(check(report, expected)), ["node[0].nvidia-payload"]);
  });
});

describe("request and nonce binding", () => {
  test("a report made for one request body is rejected when checked against another body", () => {
    const { report } = fresh();
    const r = check(report, { requestBody: body + " ", model: MOCK_MODEL });
    assert.equal(r.verdict, "reject");
    assert.deepEqual(failed(r).sort(), ["node[0].quote-binding", "nonce-echo"]);
  });

  test("the chat signature of another request is rejected as signature-text", () => {
    const { report } = fresh();
    const other = mockAttestation({ requestBody: "other body" });
    const r = check(report, { requestBody: body, model: MOCK_MODEL, chatSignature: other.chatSignature });
    assert.deepEqual(failed(r), ["signature-text"]);
  });

  test("different requestBody gives a different nonce in report, quote bytes and a different quote hex", () => {
    const a = mockAttestation({ requestBody: "a" });
    const b = mockAttestation({ requestBody: "b" });
    assert.equal(a.report.nonce, requestHash("a"));
    assert.equal(b.report.nonce, requestHash("b"));
    assert.notEqual(a.report.nonce, b.report.nonce);
    assert.equal(quoteBytes(a.report).subarray(NONCE_AT).toString("hex"), a.report.nonce);
    assert.equal(quoteBytes(b.report).subarray(NONCE_AT).toString("hex"), b.report.nonce);
  });

  test("explicit nonce beats the derived requestHash: checks pass against that nonce and fail against the derived one", () => {
    const nonce = "ab".repeat(32);
    const { report, chatSignature } = mockAttestation({ requestBody: body, nonce });
    assert.equal(report.nonce, nonce);
    assert.equal(quoteBytes(report).subarray(NONCE_AT).toString("hex"), nonce);
    const withNonce = check(report, { requestBody: body, model: MOCK_MODEL, nonce, chatSignature });
    assert.equal(withNonce.verdict, "consistent");
    const derived = check(report, { requestBody: body, model: MOCK_MODEL, chatSignature });
    assert.equal(derived.verdict, "reject");
    assert.deepEqual(failed(derived).sort(), ["node[0].quote-binding", "nonce-echo"]);
  });

  test("an explicit nonce equal to the derived hash yields output deep-equal to the default", () => {
    assert.deepEqual(mockAttestation({ requestBody: body, nonce: requestHash(body) }), mockAttestation({ requestBody: body }));
  });

  test("an explicit nonce does not change the request hash inside the signature text", () => {
    const { chatSignature } = mockAttestation({ requestBody: body, nonce: "ab".repeat(32) });
    assert.equal(chatSignature.text.split(":")[1], requestHash(body));
  });

  test("checking with a different nonce than the one used to build rejects both echo and binding, with no unverifiable noise", () => {
    const { report } = mockAttestation({ requestBody: body, nonce: "11".repeat(32) });
    const r = check(report, { requestBody: body, model: MOCK_MODEL, nonce: "22".repeat(32) });
    assert.deepEqual(failed(r).sort(), ["node[0].quote-binding", "nonce-echo"]);
    assert.deepEqual(r.unverifiable, []);
  });
});

describe("model propagation", () => {
  test("a non-default model flows through and is accepted only when the checker expects it", () => {
    const { report, chatSignature } = mockAttestation({ requestBody: body, model: "other:model" });
    assert.equal(node(report).model_name, "other:model");
    assert.equal(check(report, { requestBody: body, model: "other:model", chatSignature }).verdict, "consistent");
    const wrong = check(report, { requestBody: body, model: MOCK_MODEL, chatSignature });
    assert.equal(wrong.verdict, "reject");
    assert.deepEqual(failed(wrong).sort(), ["node[0].model", "signature-text"]);
  });

  test("removing model_name leaves the model check skipped, and the signature text still binds the model", () => {
    const { report, expected } = fresh({ model: "other-model" });
    delete node(report).model_name;
    const r = check(report, expected);
    assert.equal(byId(r, "node[0].model").status, "skip");
    assert.equal(r.verdict, "consistent");
    const wrongModel = check(report, { ...expected, model: MOCK_MODEL });
    assert.deepEqual(failed(wrongModel), ["signature-text"]);
  });
});

describe("malformed nonce inputs to mockAttestation: the checker never accepts them", () => {
  const cases = {
    "non-hex": "zz".repeat(32),
    "odd length": "a".repeat(63),
    "too short (16 bytes)": "ab".repeat(16),
    "too long (40 bytes)": "ab".repeat(40),
    "0x prefixed": "0x" + "ab".repeat(32),
    "upper case": "AB".repeat(32),
    "empty": "",
  };
  for (const [name, nonce] of Object.entries(cases)) {
    test(`${name} nonce: fixture builds, quote stays 632 bytes, and checking with that nonce rejects on nonce-format`, () => {
      const { report, chatSignature } = mockAttestation({ requestBody: body, nonce });
      assert.equal(quoteBytes(report).length, TDX_V4_QUOTE_LENGTH);
      const r = check(report, { requestBody: body, model: MOCK_MODEL, nonce, chatSignature });
      assert.equal(r.verdict, "reject");
      assert.ok(failed(r).includes("nonce-format"));
    });

    test(`${name} nonce: checking with the derived requestHash instead rejects on nonce-echo and quote-binding`, () => {
      const { report, chatSignature } = mockAttestation({ requestBody: body, nonce });
      const r = check(report, { requestBody: body, model: MOCK_MODEL, chatSignature });
      assert.equal(r.verdict, "reject");
      assert.ok(failed(r).includes("nonce-echo"));
      assert.ok(failed(r).includes("node[0].quote-binding"));
    });
  }

  test("a well-formed 32-byte nonce is placed verbatim, so valid input is self-consistent", () => {
    const nonce = "0123456789abcdef".repeat(4);
    const { report } = mockAttestation({ requestBody: body, nonce });
    assert.equal(report.nonce, nonce);
    assert.equal(quoteBytes(report).subarray(NONCE_AT).toString("hex"), nonce);
    assert.equal(JSON.parse(node(report).nvidia_payload).nonce, nonce);
  });

  test("a too-long nonce does not overflow the quote or touch the address half", () => {
    const { report } = mockAttestation({ requestBody: body, nonce: "ab".repeat(40) });
    const q = quoteBytes(report);
    assert.equal(q.length, TDX_V4_QUOTE_LENGTH);
    assert.equal(q.subarray(TDX_V4_REPORT_DATA_OFFSET, TDX_V4_REPORT_DATA_OFFSET + 20).toString("hex"), MOCK_SIGNING_ADDRESS.slice(2));
  });
});

describe("determinism", () => {
  test("repeated calls with all options are deep-equal and share no mutable state", () => {
    const o = { requestBody: body, model: "m", nonce: "cd".repeat(32) };
    const a = mockAttestation(o);
    const b = mockAttestation(o);
    assert.deepEqual(a, b);
    a.report.model_attestations[0].signing_address = TAMPERED_ADDRESS;
    a.report.model_attestations.push({});
    assert.equal(mockAttestation(o).report.model_attestations.length, 1);
    assert.equal(mockAttestation(o).report.model_attestations[0].signing_address, MOCK_SIGNING_ADDRESS);
  });

  test("the fixture's quote hex is exactly 2 * 632 lowercase hex characters", () => {
    assert.match(node(fresh().report).intel_quote, /^[0-9a-f]{1264}$/);
  });
});
