// transferSection must name a missing explorer/teeInference instead of crashing with a raw TypeError.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTransfer } from "./transfer-verify.mjs";
import { transferSection } from "./transfer-section.mjs";

const valid = () => ({ transfer: buildTransfer([], { calls: [] }, { contractId: "c.testnet", mode: "mock" }) });

describe("transferSection missing manifest fields", () => {
  it("renders a valid manifest with explorer and TEE lines", () => {
    const m = valid();
    const html = transferSection(m);
    assert.match(html, /Explorer page for the contract: <strong>mock placeholder<\/strong>/);
    assert.ok(html.includes(m.transfer.teeInference.label));
  });

  for (const field of ["explorer", "teeInference"]) {
    for (const how of ["deleted", "null"]) {
      it(`names manifest.transfer.${field} when it is ${how}`, () => {
        const m = valid();
        if (how === "deleted") delete m.transfer[field];
        else m.transfer[field] = null;
        assert.throws(
          () => transferSection(m),
          (e) => e instanceof TypeError && e.message === `transferSection: manifest.transfer.${field} is missing`,
        );
      });
    }
  }

  it("still returns an empty string when there is no transfer at all", () => {
    assert.equal(transferSection({}), "");
  });
});
