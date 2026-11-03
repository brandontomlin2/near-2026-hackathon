// Edge-case tests for the inference client. Uses injected fetch stubs, so no
// sockets and no real keys. The key below is a throwaway string.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { DEFAULT_MAX_TOKENS, InferenceError, MAX_CONTENT_BYTES, createInferenceClient, createLiveClient, createMockClient } from "./client.mjs";

const KEY = "test-fake-key-hardening-secret-0123456789";
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
  const broken = new ReadableStream({ pull() { throw new Error("socket reset"); } });
  const res = new Response(broken, { status: 502 });
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
  const stalled = new ReadableStream({ pull() { throw new DOMException("timed out", "TimeoutError"); } });
  const res = new Response(stalled, { status: 200 });
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

test("invalid retry/timeout/size options are rejected up front", () => {
  for (const extra of [
    { maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: NaN }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: -5 },
    { maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 1.5 }, { maxResponseBytes: NaN }, { maxResponseBytes: "4m" },
  ]) {
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

// Audit L-1: credentials in NEAR_AI_BASE_URL. A base URL with userinfo is refused when the
// client is created, and the error never echoes it, so it cannot reach "request to <url> failed".
test("a base URL with user:password@ is refused at creation and never echoed", () => {
  const secret = "s3cr3t-userinfo-pw";
  for (const baseUrl of [`http://alice:${secret}@127.0.0.1:1/v1`, `https://${secret}@cloud-api.near.ai/v1`, `http://alice:@127.0.0.1:1/v1`]) {
    const err = (() => { try { live(async () => ok(), { baseUrl }); } catch (e) { return e; } })();
    assert.ok(err instanceof InferenceError, baseUrl);
    assert.equal(err.code, "bad_config", baseUrl);
    assert.match(err.message, /credentials|user:password/);
    assert.ok(!err.message.includes(secret) && !err.message.includes("alice"), err.message);
    assert.ok(!err.stack.includes(secret));
  }
  // Through the env, exactly as the CLI builds it.
  const env = { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "m", NEAR_AI_BASE_URL: `http://bob:${secret}@127.0.0.1:1/v1` };
  const err = (() => { try { createInferenceClient({ env }); } catch (e) { return e; } })();
  assert.equal(err.code, "bad_config");
  assert.ok(!err.message.includes(secret) && !err.message.includes(KEY), err.message);
});

test("a base URL that is not an absolute http(s) URL is refused without being echoed", () => {
  for (const baseUrl of ["not a url", "ftp://host/v1", "file:///etc/passwd", "//host/v1"]) {
    const err = (() => { try { live(async () => ok(), { baseUrl }); } catch (e) { return e; } })();
    assert.ok(err instanceof InferenceError, baseUrl);
    assert.equal(err.code, "bad_config", baseUrl);
    assert.ok(!err.message.includes(baseUrl), err.message);
  }
  // Plain URLs still work, with or without a trailing slash.
  assert.equal(live(async () => ok(), { baseUrl: "http://127.0.0.1:1/v1/" }).baseUrl, "http://127.0.0.1:1/v1");
});

// Audit L-1 (privacy): plain http to a remote host would send the bearer key and the prompt
// in cleartext. http is for the local stub servers only; everything else must be https.
test("plain http is refused for every host except loopback, without echoing the URL or the key", () => {
  const refused = [
    "http://cloud-api.near.ai/v1", // the real endpoint with the wrong scheme (a copied typo)
    "http://example.com/v1",
    "http://10.0.0.7:8080/v1",
    "http://localhost.example.com/v1", // loopback-looking names are not loopback
    "http://127.0.0.1.nip.io/v1",
    "http://0.0.0.0:1/v1",
    "http://[::ffff:127.0.0.1]:1/v1",
  ];
  for (const baseUrl of refused) {
    const err = (() => { try { live(async () => ok(), { baseUrl }); } catch (e) { return e; } })();
    assert.ok(err instanceof InferenceError, baseUrl);
    assert.equal(err.code, "bad_config", baseUrl);
    assert.match(err.message, /https/, baseUrl);
    assert.ok(!err.message.includes(baseUrl), err.message);
    assert.ok(!err.message.includes(new URL(baseUrl).hostname), err.message);
    assert.ok(!err.message.includes(KEY) && !err.stack.includes(KEY), err.message);
  }
  const accepted = ["http://localhost:1/v1", "http://LOCALHOST:1/v1", "http://127.0.0.1:1/v1", "http://[::1]:1/v1", "https://cloud-api.near.ai/v1", "https://example.com/v1"];
  for (const baseUrl of accepted) {
    assert.equal(live(async () => ok(), { baseUrl }).baseUrl, baseUrl); // kept as given (host matching is case-insensitive)
  }
  // Through the env, exactly as the CLI builds it: still bad_config, key and URL absent.
  const env = { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "m", NEAR_AI_BASE_URL: "http://cloud-api.near.ai/v1" };
  const err = (() => { try { createInferenceClient({ env }); } catch (e) { return e; } })();
  assert.equal(err.code, "bad_config");
  assert.ok(!err.message.includes(KEY) && !err.message.includes("cloud-api.near.ai"), err.message);
  assert.equal(createInferenceClient({ env: { ...env, NEAR_AI_BASE_URL: "http://127.0.0.1:1/v1" } }).baseUrl, "http://127.0.0.1:1/v1");
});

// Audit L-2: model text reaches the terminal unfiltered. The client is the chokepoint:
// no reply content carries ANSI, OSC or bidi control characters, in either mode.
const HOSTILE = "\u001b[2J\u001b[H\u001b]0;pwned\u0007\u001b]8;;http://evil.example\u0007click\u001b]8;;\u0007 \u202ereversed\u202c \u0000\u009c end";
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

test("live reply: control, OSC and bidi characters are replaced before the caller sees them", async () => {
  const reply = await live(async () => ok(HOSTILE)).chat(REQ);
  assert.doesNotMatch(reply.content, UNSAFE);
  assert.ok(reply.content.includes("\uFFFD[2J"), "ESC became U+FFFD, the rest of the text is kept");
  assert.ok(reply.content.includes("click") && reply.content.includes("reversed") && reply.content.endsWith(" end"));
  assert.equal(reply.content.length, HOSTILE.length, "replacement is one for one");
});

test("mock reply: a responder's control and bidi characters are replaced too", async () => {
  const reply = await createMockClient({ responder: () => HOSTILE }).chat(REQ);
  assert.doesNotMatch(reply.content, UNSAFE);
  assert.ok(reply.content.includes("click"));
});

// Audit L-3: no cap on a live reply's size, and no max_tokens on the request.
// This is the text layer. The reply stays under the 4 MiB raw body cap
// (DEFAULT_MAX_RESPONSE_BYTES, covered in live-stub.test.mjs) so the request
// succeeds and only the content cap is exercised here.
test("a 2 MiB reply is cut to MAX_CONTENT_BYTES on a code point boundary", async () => {
  const huge = "é".repeat(1024 * 1024); // 2 bytes each: 2 MiB, under the body cap
  const reply = await live(async () => ok(huge)).chat(REQ);
  const bytes = Buffer.byteLength(reply.content, "utf8");
  assert.ok(bytes <= MAX_CONTENT_BYTES, `${bytes} bytes`);
  assert.ok(bytes > MAX_CONTENT_BYTES - 4, "cut close to the cap, not far below it");
  assert.ok(!reply.content.includes("\uFFFD"), "no split code point");
  assert.ok([...reply.content].every((c) => c === "é"));
  const emoji = "\u{1F480}".repeat(MAX_CONTENT_BYTES); // 4 bytes each, surrogate pairs
  const cut = await live(async () => ok(emoji)).chat(REQ);
  assert.equal(Buffer.byteLength(cut.content, "utf8") % 4, 0, "never splits a surrogate pair");
  assert.equal(cut.content.length, (MAX_CONTENT_BYTES / 4) * 2);
  const mock = await createMockClient({ responder: () => huge }).chat(REQ);
  assert.ok(Buffer.byteLength(mock.content, "utf8") <= MAX_CONTENT_BYTES);
});

test("every live request carries max_tokens: the default when unset, the caller's value otherwise", async () => {
  const bodies = [];
  const client = live(async (_url, init) => { bodies.push(JSON.parse(init.body)); return ok(); });
  await client.chat(REQ);
  await client.chat({ ...REQ, maxTokens: 32 });
  assert.equal(bodies[0].max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(bodies[1].max_tokens, 32);
  assert.ok(Number.isInteger(DEFAULT_MAX_TOKENS) && DEFAULT_MAX_TOKENS > 0);
});

test("provider model, id and error bodies are terminal-safe and short as well", async () => {
  const reply = await live(async () => json(200, { id: `c\u001b]0;x\u0007${"i".repeat(500)}`, model: `m\u202E${"o".repeat(500)}`, choices: [{ message: { content: "hi" } }] })).chat(REQ);
  assert.doesNotMatch(reply.id, UNSAFE);
  assert.doesNotMatch(reply.model, UNSAFE);
  assert.ok(reply.id.startsWith("c\uFFFD") && reply.model.startsWith("m\uFFFD"));
  assert.ok(Buffer.byteLength(reply.id, "utf8") <= 200 && Buffer.byteLength(reply.model, "utf8") <= 200);
  const err = await caught(live(async () => json(400, "bad\u001b[2J\u001b]8;;http://evil.example\u0007x"), { maxRetries: 0 }).chat(REQ));
  assert.equal(err.status, 400);
  assert.doesNotMatch(err.message, UNSAFE);
  assert.ok(err.message.includes("bad\uFFFD[2J"), err.message);
});
