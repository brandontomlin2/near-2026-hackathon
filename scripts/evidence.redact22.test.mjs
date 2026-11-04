import assert from "node:assert/strict";
import test from "node:test";

import { scrubErrorMessage, viewCall } from "./evidence.mjs";

const KEY = "test-fake-key/abc+123=";
const ENCODED = encodeURIComponent(KEY);
const RPC_URL = `https://rpc.testnet.example.com/v2/${ENCODED}?apikey=${ENCODED}`;

async function failingView(message, env) {
  const saved = process.env.NEAR_AI_API_KEY;
  process.env.NEAR_AI_API_KEY = env;
  try {
    return await viewCall({
      fetchImpl: async () => { throw new Error(message); },
      rpcUrl: RPC_URL,
      contract: "c.testnet",
      method: "nft_tokens",
      args: {},
    });
  } finally {
    if (saved === undefined) delete process.env.NEAR_AI_API_KEY;
    else process.env.NEAR_AI_API_KEY = saved;
  }
}

test("viewCall error with the full RPC URL records only the origin", async () => {
  const record = await failingView(`request to ${RPC_URL} failed: ECONNRESET`, KEY);
  const text = JSON.stringify(record);
  assert.ok(!text.includes(ENCODED));
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes("apikey"));
  assert.equal(record.error, "request to https://rpc.testnet.example.com failed: ECONNRESET");
});

test("viewCall error with the raw or encoded API key records neither", async () => {
  const record = await failingView(`bad credential ${KEY} / ${ENCODED}`, KEY);
  const text = JSON.stringify(record);
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes(ENCODED));
  assert.equal(record.error, "bad credential [REDACTED] / [REDACTED]");
});

test("scrubErrorMessage leaves clean messages and unparsable URLs alone", () => {
  assert.equal(scrubErrorMessage("HTTP 500", { rpcUrl: "not a url", env: {} }), "HTTP 500");
  assert.equal(scrubErrorMessage("HTTP 500", { rpcUrl: undefined, env: { NEAR_AI_API_KEY: KEY } }), "HTTP 500");
});
