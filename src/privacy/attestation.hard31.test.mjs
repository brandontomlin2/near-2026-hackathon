// A malformed report is a REJECT, never a crash: the caller prints the verdict.
import assert from "node:assert/strict";
import test from "node:test";

import { checkAttestation } from "./attestation.mjs";
import { MOCK_MODEL, mockAttestation } from "./fixture.mjs";

const requestBody = JSON.stringify({ model: MOCK_MODEL, messages: [{ role: "user", content: "hi" }] });
const status = (r, id) => r.checks.find((c) => c.id === id)?.status;

test("a node whose signing_address is not a string rejects, with or without a chat signature", () => {
  for (const bad of [123, {}, [], true, null]) {
    const { report, chatSignature } = mockAttestation({ requestBody });
    report.model_attestations[0].signing_address = bad;
    for (const sig of [undefined, chatSignature]) {
      const r = checkAttestation(report, { requestBody, model: MOCK_MODEL, chatSignature: sig });
      assert.equal(r.verdict, "reject", `signing_address ${JSON.stringify(bad)}`);
      assert.equal(status(r, "node[0].signing-key"), "fail");
    }
  }
});

test("a non-string chat signature signing_address or text rejects instead of throwing", () => {
  const { report, chatSignature } = mockAttestation({ requestBody });
  for (const patch of [{ signing_address: 123 }, { signing_address: undefined }, { text: 42 }, { text: {} }]) {
    const r = checkAttestation(report, { requestBody, model: MOCK_MODEL, chatSignature: { ...chatSignature, ...patch } });
    assert.equal(r.verdict, "reject", JSON.stringify(patch));
  }
});

test("model_attestations holding null, numbers or strings rejects every entry and does not throw", () => {
  const r = checkAttestation({ model_attestations: [null, 5, "x"] }, { requestBody, model: MOCK_MODEL });
  assert.equal(r.verdict, "reject");
  for (let i = 0; i < 3; i++) assert.equal(status(r, `node[${i}].signing-key`), "fail");
});
