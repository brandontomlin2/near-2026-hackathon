import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  DEFAULT_BASE_URL,
  InferenceError,
  createInferenceClient,
  createLiveClient,
  createMockClient,
  defaultMockResponder,
  hashRequest,
  normalizeRequest,
  parseMode,
} from "./client.mjs";

const FAKE_KEY = "test-key-not-a-real-credential";

function noSleep() {
  return Promise.resolve();
}

/**
 * Start a local HTTP server that plays NEAR AI Cloud. `handler` receives the
 * parsed request and returns { status, body }. Requests are recorded.
 */
async function fakeCloud(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(record);
      const reply = handler(record, seen.length);
      res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function okCompletion(content, extra = {}) {
  return {
    status: 200,
    body: {
      id: "chatcmpl-123",
      model: "test/model",
      choices: [{ index: 0, message: { role: "assistant", content } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      ...extra,
    },
  };
}

test("parseMode defaults to mock and accepts 1/0/true/false", () => {
  assert.equal(parseMode(undefined), "mock");
  assert.equal(parseMode(""), "mock");
  assert.equal(parseMode("1"), "mock");
  assert.equal(parseMode("true"), "mock");
  assert.equal(parseMode(" TRUE "), "mock");
  assert.equal(parseMode("0"), "live");
  assert.equal(parseMode("false"), "live");
  assert.throws(() => parseMode("yes"), (err) => err instanceof InferenceError && err.code === "bad_config");
});

test("createInferenceClient picks mock when MOCK_INFERENCE is unset, without needing keys", async () => {
  const client = createInferenceClient({ env: {} });
  assert.equal(client.mode, "mock");
  const reply = await client.chat({ messages: [{ role: "user", content: "hello swarm" }] });
  assert.equal(reply.mode, "mock");
  assert.ok(reply.content.length > 0);
  assert.match(reply.id, /^mock-[0-9a-f]{16}$/);
});

test("createInferenceClient in live mode requires NEAR_AI_API_KEY and NEAR_AI_MODEL", () => {
  assert.throws(
    () => createInferenceClient({ env: { MOCK_INFERENCE: "0", NEAR_AI_MODEL: "m" } }),
    (err) => err instanceof InferenceError && err.code === "missing_api_key",
  );
  assert.throws(
    () => createInferenceClient({ env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY } }),
    (err) => err instanceof InferenceError && err.code === "missing_model",
  );
  const client = createInferenceClient({
    env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "m" },
  });
  assert.equal(client.mode, "live");
  assert.equal(client.baseUrl, DEFAULT_BASE_URL);
});

test("normalizeRequest prepends system and rejects malformed messages", () => {
  const normalized = normalizeRequest(
    { system: "be brief", messages: [{ role: "user", content: "hi" }] },
    "m",
  );
  assert.deepEqual(normalized.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  assert.throws(() => normalizeRequest({ messages: [] }, "m"), /at least one message/);
  assert.throws(() => normalizeRequest({ messages: [{ role: "tool", content: "x" }] }, "m"), /messages\[0\]/);
  assert.throws(() => normalizeRequest({ messages: [{ role: "user", content: 1 }] }, "m"), /messages\[0\]/);
  assert.throws(() => normalizeRequest({ messages: "nope" }, "m"), /messages must be an array/);
  assert.throws(() => normalizeRequest(null, "m"), /request must be an object/);
});

test("mock replies are byte-identical for the same request and differ otherwise", async () => {
  const a = createMockClient();
  const b = createMockClient();
  const request = {
    system: "You are Aloof, an observer.",
    messages: [{ role: "user", content: "What do you make of the treasury proposal?" }],
    seed: 7,
  };
  const first = await a.chat(request);
  const second = await b.chat(request);
  assert.deepEqual(first, second);

  const other = await a.chat({ ...request, seed: 8 });
  assert.notEqual(other.id, first.id);

  const differentPrompt = await a.chat({
    ...request,
    messages: [{ role: "user", content: "Who is the loudest agent in the channel?" }],
  });
  assert.notEqual(differentPrompt.id, first.id);
});

test("hashRequest changes when the model, temperature or maxTokens change", () => {
  const base = normalizeRequest({ messages: [{ role: "user", content: "x" }] }, "m");
  const h = hashRequest(base);
  assert.notEqual(hashRequest({ ...base, model: "other" }), h);
  assert.notEqual(hashRequest({ ...base, temperature: 0.2 }), h);
  assert.notEqual(hashRequest({ ...base, maxTokens: 10 }), h);
  assert.equal(hashRequest({ ...base }), h);
});

test("default mock responder mentions a word from the last user message", () => {
  const request = normalizeRequest(
    { messages: [{ role: "user", content: "Tell me about the treasury." }] },
    "m",
  );
  const text = defaultMockResponder(request, hashRequest(request));
  assert.match(text, /treasury/);
});

test("default mock responder falls back when the prompt has no long words", () => {
  const request = normalizeRequest({ messages: [{ role: "user", content: "hi ok no" }] }, "m");
  const text = defaultMockResponder(request, hashRequest(request));
  assert.match(text, /\bthis\b/);
});

test("a custom mock responder is used and must return a string", async () => {
  const client = createMockClient({ responder: (req, hash) => `${req.messages.length}:${hash.slice(0, 4)}` });
  const reply = await client.chat({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] });
  assert.match(reply.content, /^2:[0-9a-f]{4}$/);

  const bad = createMockClient({ responder: () => 42 });
  await assert.rejects(bad.chat({ messages: [{ role: "user", content: "a" }] }), /must return a string/);
});

test("live client sends an OpenAI-compatible request with a bearer token", async () => {
  const cloud = await fakeCloud(() => okCompletion("hello from the tee"));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "test/model", baseUrl: cloud.baseUrl, sleep: noSleep });
    const reply = await client.chat({
      system: "sys",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0.3,
      maxTokens: 64,
      seed: 11,
    });
    assert.equal(reply.mode, "live");
    assert.equal(reply.content, "hello from the tee");
    assert.equal(reply.model, "test/model");
    assert.equal(reply.id, "chatcmpl-123");
    assert.deepEqual(reply.usage, { promptTokens: 7, completionTokens: 3 });

    assert.equal(cloud.seen.length, 1);
    const [req] = cloud.seen;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(req.body, {
      model: "test/model",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "ping" }],
      temperature: 0.3,
      max_tokens: 64,
      seed: 11,
    });
  } finally {
    await cloud.close();
  }
});

test("live client strips a trailing slash from the base url", async () => {
  const cloud = await fakeCloud(() => okCompletion("ok"));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: `${cloud.baseUrl}/`, sleep: noSleep });
    await client.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(cloud.seen[0].url, "/v1/chat/completions");
  } finally {
    await cloud.close();
  }
});

test("live client retries 429 and 5xx, then succeeds", async () => {
  const cloud = await fakeCloud((_req, n) => {
    if (n === 1) return { status: 429, body: { error: "slow down" } };
    if (n === 2) return { status: 503, body: { error: "busy" } };
    return okCompletion("third time");
  });
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: cloud.baseUrl, maxRetries: 2, sleep: noSleep });
    const reply = await client.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(reply.content, "third time");
    assert.equal(cloud.seen.length, 3);
  } finally {
    await cloud.close();
  }
});

test("live client gives up after maxRetries and reports the status", async () => {
  const cloud = await fakeCloud(() => ({ status: 500, body: { error: "down" } }));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: cloud.baseUrl, maxRetries: 1, sleep: noSleep });
    await assert.rejects(
      client.chat({ messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof InferenceError && err.status === 500 && err.code === "http_error",
    );
    assert.equal(cloud.seen.length, 2);
  } finally {
    await cloud.close();
  }
});

test("live client does not retry 4xx client errors and never leaks the key", async () => {
  const cloud = await fakeCloud(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: cloud.baseUrl, sleep: noSleep });
    let caught;
    try {
      await client.chat({ messages: [{ role: "user", content: "x" }] });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof InferenceError);
    assert.equal(caught.status, 401);
    assert.equal(caught.retryable, false);
    assert.equal(cloud.seen.length, 1);
    assert.ok(!caught.message.includes(FAKE_KEY));
    assert.ok(!JSON.stringify({ ...caught, stack: caught.stack }).includes(FAKE_KEY));
  } finally {
    await cloud.close();
  }
});

test("live client rejects a body with no assistant content", async () => {
  const cloud = await fakeCloud(() => ({ status: 200, body: { choices: [] } }));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: cloud.baseUrl, sleep: noSleep });
    await assert.rejects(
      client.chat({ messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof InferenceError && err.code === "bad_response",
    );
  } finally {
    await cloud.close();
  }
});

test("live client rejects a non-JSON body", async () => {
  const cloud = await fakeCloud(() => ({ status: 200, contentType: "text/html", body: "<html>oops</html>" }));
  try {
    const client = createLiveClient({ apiKey: FAKE_KEY, model: "m", baseUrl: cloud.baseUrl, sleep: noSleep });
    await assert.rejects(
      client.chat({ messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof InferenceError && err.code === "bad_response",
    );
  } finally {
    await cloud.close();
  }
});

test("live client times out and surfaces a timeout error", async () => {
  const server = http.createServer(() => { /* never answer */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const client = createLiveClient({
      apiKey: FAKE_KEY,
      model: "m",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      timeoutMs: 50,
      maxRetries: 0,
    });
    await assert.rejects(
      client.chat({ messages: [{ role: "user", content: "x" }] }),
      (err) => err instanceof InferenceError && err.code === "timeout" && err.retryable === true,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("live client wraps network failures as retryable errors", async () => {
  const client = createLiveClient({
    apiKey: FAKE_KEY,
    model: "m",
    baseUrl: "http://127.0.0.1:1/v1",
    maxRetries: 0,
  });
  await assert.rejects(
    client.chat({ messages: [{ role: "user", content: "x" }] }),
    (err) => err instanceof InferenceError && err.code === "network" && err.retryable === true,
  );
});
