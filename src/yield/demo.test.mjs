// Unit tests for src/yield/demo.mjs helpers (the end-to-end demo is tested in scripts/yield-demo.test.mjs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { offReferenceMeasure } from "./demo.mjs";

describe("offReferenceMeasure", () => {
  const params = { max_ref_deviation_bps: 1000, max_edge_bps: 100 };
  it("names the spot deviation when it is over its limit", () => {
    assert.equal(offReferenceMeasure({ ref_deviation_bps: 18703867.4, edge_bps: 17910000 }, params), "spot +18703867 bps");
    assert.equal(offReferenceMeasure({ ref_deviation_bps: -2500, edge_bps: -2600 }, params), "spot -2500 bps");
  });
  it("names the quote edge when only the quote limit tripped (spot inside its limit)", () => {
    assert.equal(offReferenceMeasure({ ref_deviation_bps: 194.2, edge_bps: 122.6 }, params), "quote +123 bps above the reference");
  });
});
