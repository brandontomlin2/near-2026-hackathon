import test from "node:test";
import assert from "node:assert/strict";
import { checkAttestation, requestHash, VERDICT } from "./attestation.mjs";
import { mockAttestation, tdxV4Header, MOCK_MODEL, MOCK_SIGNING_ADDRESS } from "./fixture.mjs";

// Synthetic quotes only. v5 layout used: 48-byte header, u16 body type at 48,
// u32 body size at 50, body at 54, REPORTDATA 520 bytes into the body (574..638).
const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] });
const NONCE = Buffer.from(requestHash(requestBody), "hex");
const ADDR = Buffer.from(MOCK_SIGNING_ADDRESS.slice(2), "hex");

function quote({ version = 4, teeType = 0x81, bodyType = 2, bodySize, len, nonceAt, addrAt }) {
  const sizes = { 1: 384, 2: 584, 3: 648 };
  const v5 = version === 5;
  const size = bodySize ?? sizes[bodyType] ?? 584;
  const reportAt = v5 ? 574 : 568;
  const q = Buffer.alloc(len ?? (v5 ? 54 + size : 632));
  tdxV4Header().copy(q, 0);
  q.writeUInt16LE(version, 0);
  q.writeUInt32LE(teeType, 4);
  if (v5) { q.writeUInt16LE(bodyType, 48); q.writeUInt32LE(size, 50); }
  NONCE.copy(q, nonceAt ?? reportAt + 32);
  ADDR.copy(q, addrAt ?? reportAt);
  return q.toString("hex");
}
const binding = (hex) => {
  const { report } = mockAttestation({ requestBody });
  report.model_attestations[0].intel_quote = hex;
  const r = checkAttestation(report, { requestBody, model: MOCK_MODEL });
  return { r, c: r.checks.find((x) => x.id === "node[0].quote-binding") };
};

test("v4 TDX quote is accepted at 568..632", () => {
  const { c } = binding(quote({ version: 4 }));
  assert.equal(c.status, "pass");
  assert.match(c.detail, /^TDX v4 quote; bytes 568\.\.632/);
});

test("v5 TDX 1.0 and 1.5 quotes are accepted at 574..638", () => {
  for (const [bodyType, name] of [[2, "1.0"], [3, "1.5"]]) {
    const { c } = binding(quote({ version: 5, bodyType }));
    assert.equal(c.status, "pass", name);
    assert.match(c.detail, new RegExp(`^TDX v5 quote \\(TD report ${name.replace(".", "\\.")}\\); bytes 574\\.\\.638`));
  }
  assert.equal(binding(quote({ version: 5, bodyType: 3, len: 3000 })).c.status, "pass", "signature after the body");
});

test("v5 quote with values at the v4 offset (568) is not accepted", () => {
  // nonce/address placed 6 bytes early (v4 offsets), outside 574..638
  const { c, r } = binding(quote({ version: 5, nonceAt: 568 + 32, addrAt: 568 }));
  assert.equal(c.status, "fail");
  assert.equal(r.verdict, VERDICT.REJECT);
});

test("v5 quote with an SGX body or an unknown body type is rejected, report data unread", () => {
  for (const bodyType of [1, 0, 4]) {
    const { c, r } = binding(quote({ version: 5, bodyType, len: 700 }));
    assert.equal(c.status, "fail", `type ${bodyType}`);
    assert.match(c.detail, new RegExp(`body type ${bodyType}, not a TDX 1\\.0 or 1\\.5 TD report`));
    assert.match(c.detail, /report data not read/);
    assert.equal(r.verdict, VERDICT.REJECT);
  }
});

test("v5 quote whose declared body size contradicts its body type is rejected", () => {
  const { c } = binding(quote({ version: 5, bodyType: 2, bodySize: 648, len: 700 }));
  assert.equal(c.status, "fail");
  assert.match(c.detail, /declares 648 bytes, expected 584/);
});

test("v5 quote with a non-TDX tee_type is rejected", () => {
  const { c } = binding(quote({ version: 5, teeType: 0, len: 700 }));
  assert.equal(c.status, "fail");
  assert.match(c.detail, /version 5, tee_type 0x0/);
});

test("versions 3 and 6 are rejected with the version named, report data unread", () => {
  for (const version of [3, 6]) {
    const { c, r } = binding(quote({ version, len: 700, nonceAt: 600, addrAt: 568 }));
    assert.equal(c.status, "fail", `v${version}`);
    assert.match(c.detail, new RegExp(`header says version ${version}, tee_type 0x81, not a TDX v4 or v5 quote`));
    assert.match(c.detail, /report data not read/);
    assert.equal(r.verdict, VERDICT.REJECT);
  }
});

test("truncated quotes are unverifiable, not accepted", () => {
  const cases = {
    "v4 631 bytes": quote({ version: 4 }).slice(0, 631 * 2),
    "v5 1.0 one byte short of the body": quote({ version: 5, bodyType: 2 }).slice(0, (54 + 584 - 1) * 2),
    "v5 1.5 cut after REPORTDATA": quote({ version: 5, bodyType: 3 }).slice(0, 640 * 2),
    "tiny": "abcd",
  };
  for (const [label, hex] of Object.entries(cases)) {
    const { c, r } = binding(hex);
    assert.equal(c.status, "unverifiable", label);
    assert.deepEqual(r.unverifiable, ["node[0].quote-binding"], label);
  }
});
