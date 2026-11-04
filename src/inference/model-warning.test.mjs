// Live mode warns (stderr, one line) when NEAR_AI_MODEL is not a documented TEE model.
// It never refuses, and mock mode prints nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { TEE_MODELS, createInferenceClient } from "./client.mjs";

const live = (model, warn) =>
  createInferenceClient({
    env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "fake-test-key-0123456789", NEAR_AI_MODEL: model },
    warn,
  });

test("a documented TEE model gives no warning", () => {
  for (const m of TEE_MODELS) {
    const lines = [];
    live(m, (l) => lines.push(l));
    assert.deepEqual(lines, [], m);
  }
});

test("an Anonymised or unknown model warns with one line but is still accepted", () => {
  const lines = [];
  const client = live("anthropic/claude-sonnet-4-5", (l) => lines.push(l));
  assert.ok(client);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^warning: NEAR_AI_MODEL "anthropic\/claude-sonnet-4-5" is not one of the TEE/);
  assert.ok(!lines[0].includes("\n"));
});

test("mock mode prints nothing, whatever NEAR_AI_MODEL says", () => {
  const lines = [];
  createInferenceClient({ env: { NEAR_AI_MODEL: "anthropic/claude-sonnet-4-5" }, warn: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
});
