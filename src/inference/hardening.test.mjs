// Edge-case tests for the inference client. Uses injected fetch stubs, so no
// sockets and no real keys. The key below is a throwaway string.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { InferenceError, createInferenceClient, createLiveClient, createMockClient } from "./client.mjs";

const KEY = "sk-hardening-secret-0123456789";
const REQ = { messages: [{ role: "user", content: "hello there" }] };
const noSleep = () => Promise.resolve();

function json(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
const ok = (content = "hi") => json(200, { id: "c1", choices: [{ message: { content } }] });

function live(fetchImpl, extra = {}) {
  return createLiveClient({ apiKey: KEY, model: "m", fetch: fetchImpl, sleep: noSleep, ...extra });
}

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected rejection");
}

test("missing or blank key in live mode: clear error, nothing echoed", () => {
  for (const apiKey of [undefined, "", "   "]) {
    const env = { MOCK_INFERENCE: "0", NEAR_AI_MODEL: "m", NEAR_AI_API_KEY: apiKey };
    let err;
    try { createInferenceClient({ env }); } catch (e) { err = e; }
    assert.ok(err instanceof InferenceError, `apiKey=${JSON.stringify(apiKey)}`);
    assert.equal(err.code, "missing_api_key");
    assert.match(err.message, /NEAR_AI_API_KEY/);
  }
});

test("a key that is set never appears in config errors", () => {
  const env = { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "" };
  const err = (() => { try { createInferenceClient({ env }); } catch (e) { return e; } })();
  assert.equal(err.code, "missing_model");
  assert.ok(!err.message.includes(KEY));
});

test("non-2xx: a provider that echoes the key in its error body is redacted", async () => {
  const client = live(async () => json(400, { error: `invalid request for Bearer ${KEY}` }), { maxRetries: 0 });
  const err = await caught(client.chat(REQ));
  assert.equal(err.status, 400);
  assert.ok(!err.message.includes(KEY), err.message);
  assert.ok(!err.stack.includes(KEY));
});

test("non-2xx: error body that cannot be read still yields a status error", async () => {
  const res = new Response("x", { status: 502 });
  res.text = async () => { throw new Error("socket reset"); };
  const err = await caught(live(async () => res, { maxRetries: 0 }).chat(REQ));
  assert.equal(err.status, 502);
  assert.equal(err.code, "http_error");
});

test("non-2xx: long error bodies are truncated", async () => {
  const err = await caught(live(async () => json(400, "x".repeat(5000)), { maxRetries: 0 }).chat(REQ));
  assert.ok(err.message.length < 400);
});

test("malformed or empty 200 bodies are bad_response and not retried", async () => {
  const bodies = [
    "", "{", "null", "[]", "42", '"str"', "{}",
    '{"choices":null}', '{"choices":[null]}', '{"choices":[{}]}',
    '{"choices":[{"message":{"content":null}}]}', '{"choices":[{"message":{"content":["a"]}}]}',
    '{"choices":[{"message":{"content":""}}]}', '{"choices":[{"message":{"content":"   "}}]}',
  ];
  for (const body of bodies) {
    let calls = 0;
    const client = live(async () => { calls += 1; return json(200, body); });
    const err = await caught(client.chat(REQ));
    assert.ok(err instanceof InferenceError, body);
    assert.equal(err.code, "bad_response", body);
    assert.equal(err.retryable, false, body);
    assert.equal(calls, 1, body);
  }
});

test("a response missing usage/id/model falls back instead of returning NaN", async () => {
  const reply = await live(async () => json(200, { choices: [{ message: { content: "fine" } }] })).chat(REQ);
  assert.deepEqual(reply.usage, { promptTokens: 0, completionTokens: 0 });
  assert.equal(reply.id, "");
  assert.equal(reply.model, "m");
  const weird = await live(async () => json(200, {
    choices: [{ message: { content: "x" } }], usage: { prompt_tokens: "abc", completion_tokens: null },
  })).chat(REQ);
  assert.deepEqual(weird.usage, { promptTokens: 0, completionTokens: 0 });
});

test("timeout while reading the body is reported as a retryable timeout", async () => {
  const res = new Response("x", { status: 200 });
  res.json = async () => { throw new DOMException("timed out", "TimeoutError"); };
  let calls = 0;
  const client = live(async () => { calls += 1; return calls === 1 ? res : ok("later"); }, { maxRetries: 1 });
  assert.equal((await client.chat(REQ)).content, "later");
  assert.equal(calls, 2);
});

test("retry backoff is exponential and bounded by maxRetries", async () => {
  const delays = [];
  let calls = 0;
  const client = live(async () => { calls += 1; return json(503, "busy"); }, {
    maxRetries: 3,
    sleep: async (ms) => { delays.push(ms); },
  });
  const err = await caught(client.chat(REQ));
  assert.equal(err.status, 503);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [250, 500, 1000]);
});

test("backoff delay is capped even with a large maxRetries", async () => {
  const delays = [];
  const client = live(async () => json(500, "x"), { maxRetries: 12, sleep: async (ms) => { delays.push(ms); } });
  await caught(client.chat(REQ));
  assert.equal(delays.length, 12);
  assert.ok(Math.max(...delays) <= 8000, `max delay ${Math.max(...delays)}`);
});

test("maxRetries: 0 means one attempt; 408/429/5xx retry, other 4xx do not", async () => {
  for (const [status, expectCalls] of [[408, 2], [429, 2], [500, 2], [504, 2], [400, 1], [401, 1], [404, 1], [422, 1]]) {
    let calls = 0;
    const client = live(async () => { calls += 1; return json(status, "no"); }, { maxRetries: 1 });
    await caught(client.chat(REQ));
    assert.equal(calls, expectCalls, `status ${status}`);
  }
  let calls = 0;
  await caught(live(async () => { calls += 1; return json(500, "no"); }, { maxRetries: 0 }).chat(REQ));
  assert.equal(calls, 1);
});

test("invalid retry/timeout options are rejected up front", () => {
  for (const extra of [{ maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: NaN }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: -5 }]) {
    const err = (() => { try { live(async () => ok(), extra); } catch (e) { return e; } })();
    assert.ok(err instanceof InferenceError, JSON.stringify(extra));
    assert.equal(err.code, "bad_config");
  }
});

test("network error during fetch is retried then surfaced without the key", async () => {
  let calls = 0;
  const client = live(async () => { calls += 1; throw new TypeError(`fetch failed (${KEY})`); }, { maxRetries: 1 });
  const err = await caught(client.chat(REQ));
  assert.equal(err.code, "network");
  assert.equal(calls, 2);
  assert.ok(!err.message.includes(KEY));
});

test("mock mode: same request gives same bytes across fresh clients and processes", async () => {
  const req = { system: "You are Ada.", messages: [{ role: "user", content: "Should we trust the validators?" }], seed: 7 };
  const a = await createMockClient().chat(req);
  const b = await createMockClient().chat(structuredClone(req));
  assert.deepEqual(a, b);
  const script = `import {createMockClient} from ${JSON.stringify(new URL("./client.mjs", import.meta.url).href)};
    const r = await createMockClient().chat(${JSON.stringify(req)}); process.stdout.write(JSON.stringify(r));`;
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run(), run());
  assert.deepEqual(JSON.parse(run()), a);
});

test("mock mode: unaffected by interleaving, extra message fields or key order, and ignores network env", async () => {
  const client = createInferenceClient({ env: { NEAR_AI_API_KEY: KEY, NEAR_AI_BASE_URL: "http://127.0.0.1:1" } });
  const m1 = { role: "user", content: "alpha beta gamma" };
  const first = await client.chat({ messages: [m1] });
  await client.chat({ messages: [{ role: "user", content: "something else entirely" }] });
  const again = await client.chat({ messages: [{ content: "alpha beta gamma", role: "user", extra: 1 }] });
  assert.deepEqual(again, first);
  assert.equal(first.mode, "mock");
  assert.ok(!JSON.stringify(first).includes(KEY));
});

test("mock mode: concurrent calls are independent and deterministic", async () => {
  const client = createMockClient();
  const reqs = Array.from({ length: 20 }, (_, i) => ({ messages: [{ role: "user", content: `question number ${i}` }] }));
  const one = await Promise.all(reqs.map((r) => client.chat(r)));
  const two = await Promise.all(reqs.map((r) => client.chat(r)));
  assert.deepEqual(one, two);
});
