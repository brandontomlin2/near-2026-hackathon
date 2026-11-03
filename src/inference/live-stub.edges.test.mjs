// Live-path behaviour against a local stub on 127.0.0.1 only. Never the real
// service. Covers the exact wire shape, retry policy per status, backoff
// schedule, per-attempt timeouts, oversized bodies, and that the API key is
// confined to the authorization header: it is absent from bodies, urls,
// messages, causes, inspected errors and console output.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { inspect } from "node:util";

import { DEFAULT_MAX_TOKENS, InferenceError, MAX_CONTENT_BYTES, createInferenceClient, createLiveClient } from "./client.mjs";

const KEY = "sk-stub-edges-not-real-ABCDEFGHIJKLMNOP0123456789";
const MODEL = "stub/edges-model";
const ask = { messages: [{ role: "user", content: "ping" }] };
const noSleep = async () => {};

/** @param {(req: object, res: import("node:http").ServerResponse, n: number) => void} handler */
async function stub(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* keep null */ }
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, body };
      seen.push(entry);
      handler(entry, res, seen.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function withStub(handler, fn) {
  const s = await stub(handler);
  try { return await fn(s); } finally { await s.close(); }
}

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
};
const completion = (content) => ({
  id: "chatcmpl-edges",
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
});

/** Direct live client so sleep can be injected and the backoff recorded. */
function client(s, extra = {}) {
  return createLiveClient({ apiKey: KEY, model: MODEL, baseUrl: s.baseUrl, sleep: noSleep, ...extra });
}

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected rejection");
}

/** Every place a key could surface from one thrown error. */
function errorText(err) {
  return [err.message, err.stack ?? "", inspect(err, { depth: 10 }), JSON.stringify({ ...err })].join("\n");
}

/** Any 8-char window of the key counts as a leak, not only the whole string. */
function containsKeyFragment(text) {
  for (let i = 0; i + 8 <= KEY.length; i += 1) {
    if (text.includes(KEY.slice(i, i + 8))) return true;
  }
  return false;
}

test("request shape: model, messages and the default max_tokens when no options are given; string seeds are not sent", () =>
  withStub((_r, res) => json(res, 200, completion("pong")), async (s) => {
    const c = client(s);
    await c.chat(ask);
    await c.chat({ ...ask, seed: "run-7" });
    await c.chat({ ...ask, temperature: 0, maxTokens: 0, seed: 0 });
    assert.deepEqual(s.seen[0].body, { model: MODEL, messages: ask.messages, max_tokens: DEFAULT_MAX_TOKENS });
    assert.deepEqual(Object.keys(s.seen[1].body).sort(), ["max_tokens", "messages", "model"], "a string seed is mock-only");
    assert.deepEqual(s.seen[2].body, { model: MODEL, messages: ask.messages, temperature: 0, max_tokens: 0, seed: 0 });
    for (const r of s.seen) {
      assert.equal(r.headers["content-type"], "application/json");
      assert.equal(r.headers.authorization, `Bearer ${KEY}`);
      assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.raw));
    }
  }));

test("the key appears in the authorization header only: never in the url, body or other headers", () =>
  withStub((_r, res) => json(res, 200, completion("pong")), async (s) => {
    await createInferenceClient({
      env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: `  ${KEY}\n`, NEAR_AI_MODEL: MODEL, NEAR_AI_BASE_URL: `${s.baseUrl}/` },
    }).chat({ ...ask, system: "sys" });
    const [r] = s.seen;
    assert.equal(r.url, "/v1/chat/completions");
    assert.equal(r.headers.authorization, `Bearer ${KEY}`, "surrounding whitespace in the env var is trimmed");
    assert.ok(!r.raw.includes(KEY));
    assert.ok(!r.url.includes(KEY));
    const leaky = Object.entries(r.headers).filter(([, v]) => String(v).includes(KEY)).map(([k]) => k);
    assert.deepEqual(leaky, ["authorization"]);
  }));

test("retry policy per status against the stub: 408/409/429/5xx retry, other 4xx do not", async () => {
  const table = [[408, 2], [409, 2], [429, 2], [500, 2], [502, 2], [503, 2], [599, 2], [400, 1], [401, 1], [403, 1], [404, 1], [413, 1], [422, 1]];
  for (const [status, attempts] of table) {
    await withStub((_r, res) => json(res, status, { error: `status ${status}` }), async (s) => {
      const err = await caught(client(s, { maxRetries: 1 }).chat(ask));
      assert.ok(err instanceof InferenceError, `status ${status}`);
      assert.equal(err.status, status);
      assert.equal(err.code, "http_error");
      assert.equal(err.retryable, attempts > 1, `status ${status} retryable`);
      assert.equal(s.seen.length, attempts, `status ${status} attempts`);
      assert.match(err.message, new RegExp(`HTTP ${status}: .*status ${status}`), "status and a body snippet are reported");
    });
  }
});

test("backoff schedule: 250ms doubling per attempt, one sleep per retry, none after the last attempt", async () => {
  for (const status of [429, 503]) {
    await withStub((_r, res) => json(res, status, "no"), async (s) => {
      const delays = [];
      const err = await caught(client(s, { maxRetries: 3, sleep: async (ms) => { delays.push(ms); } }).chat(ask));
      assert.equal(err.status, status);
      assert.deepEqual(delays, [250, 500, 1000]);
      assert.equal(s.seen.length, 4);
    });
  }
  await withStub((_r, res, n) => (n === 1 ? json(res, 429, "no") : json(res, 200, completion("ok"))), async (s) => {
    const delays = [];
    const reply = await client(s, { maxRetries: 5, sleep: async (ms) => { delays.push(ms); } }).chat(ask);
    assert.equal(reply.content, "ok");
    assert.deepEqual(delays, [250], "stops retrying as soon as one attempt succeeds");
  });
  await withStub((_r, res) => json(res, 200, completion("ok")), async (s) => {
    const delays = [];
    await client(s, { sleep: async (ms) => { delays.push(ms); } }).chat(ask);
    assert.deepEqual(delays, []);
  });
});

test("every retry resends the identical request: same body bytes, same headers, no retry markers", () =>
  withStub((_r, res, n) => (n < 3 ? json(res, 503, "busy") : json(res, 200, completion("ok"))), async (s) => {
    const reply = await client(s, { maxRetries: 2 }).chat({ ...ask, temperature: 0.5, seed: 3 });
    assert.equal(reply.content, "ok");
    assert.equal(s.seen.length, 3);
    const strip = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !["connection", "keep-alive"].includes(k)));
    for (const r of s.seen.slice(1)) {
      assert.equal(r.raw, s.seen[0].raw);
      assert.equal(r.method, "POST");
      assert.equal(r.url, s.seen[0].url);
      assert.deepEqual(strip(r.headers), strip(s.seen[0].headers));
    }
  }));

test("timeout applies per attempt: a stalled first attempt is retried and the second succeeds", async () => {
  const stalled = [];
  const arrivals = [];
  await withStub((_r, res, n) => {
    arrivals.shift()?.();
    if (n === 1) { stalled.push(res); return; }
    json(res, 200, completion("late but fine"));
  }, async (s) => {
    // The client arms its per-attempt timer before the request has left the
    // process. On a loaded machine that timer can fire before the stub has
    // received the request, and the stub would then stall the retry instead of
    // the first attempt. This fetch sends the request without the client's
    // signal and lets the abort win only once the stub has the request, so the
    // stub always stalls attempt 1. The rejection is the client's own timeout
    // reason, exactly what fetch throws for an aborted request.
    const fetchReachingStub = async (url, init) => {
      const arrived = new Promise((resolve) => arrivals.push(resolve));
      const response = fetch(url, { ...init, signal: undefined });
      await arrived;
      return new Promise((resolve, reject) => {
        const abort = () => reject(init.signal.reason);
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
        response.then(resolve, reject);
      });
    };
    const delays = [];
    const started = Date.now();
    const reply = await client(s, { timeoutMs: 100, maxRetries: 1, fetch: fetchReachingStub, sleep: async (ms) => { delays.push(ms); } }).chat(ask);
    assert.equal(reply.content, "late but fine");
    assert.equal(s.seen.length, 2);
    assert.deepEqual(delays, [250]);
    assert.ok(Date.now() - started >= 90, "the first attempt really waited for its timeout");
    for (const res of stalled) res.destroy();
  });
});

test("timeout and connection errors name the url and never the key, in message, cause or inspect output", async () => {
  await withStub(() => { /* never answer */ }, async (s) => {
    const err = await caught(client(s, { timeoutMs: 50, maxRetries: 0 }).chat(ask));
    assert.equal(err.code, "timeout");
    assert.match(err.message, /timed out after 50ms/);
    assert.ok(err.message.includes(`${s.baseUrl}/chat/completions`));
    assert.ok(!containsKeyFragment(errorText(err)), errorText(err));
  });
  const refused = await caught(createLiveClient({ apiKey: KEY, model: MODEL, baseUrl: "http://127.0.0.1:1/v1", maxRetries: 0 }).chat(ask));
  assert.equal(refused.code, "network");
  assert.ok(refused.cause instanceof Error, "the underlying fetch error is kept for debugging");
  assert.ok(!containsKeyFragment(errorText(refused)), errorText(refused));
});

test("a provider that echoes the key: redacted in HTTP errors on every retry and in non-JSON bodies", async () => {
  await withStub((_r, res) => json(res, 503, { error: `rejected token ${KEY} for ${KEY}` }), async (s) => {
    const err = await caught(client(s, { maxRetries: 2 }).chat(ask));
    assert.equal(s.seen.length, 3);
    assert.match(err.message, /\[redacted\]/);
    assert.ok(!containsKeyFragment(errorText(err)), errorText(err));
  });
  await withStub((_r, res) => { res.writeHead(400, { "content-type": "text/plain" }); res.end(KEY); }, async (s) => {
    const err = await caught(client(s).chat(ask));
    assert.equal(err.status, 400);
    assert.equal(err.message, "NEAR AI Cloud returned HTTP 400: [redacted]");
    assert.ok(!containsKeyFragment(errorText(err)), errorText(err));
  });
  for (const body of [KEY, `${KEY} is not valid`, `Bearer ${KEY}`, `<html>${KEY}</html>`]) {
    await withStub((_r, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); }, async (s) => {
      const err = await caught(client(s).chat(ask));
      assert.equal(err.code, "bad_response");
      assert.equal(err.message, "NEAR AI Cloud returned a non-JSON body (content-type text/html; charset=utf-8)");
      assert.equal(err.cause, undefined, "a parse error would quote the body");
      assert.equal(s.seen.length, 1);
      assert.ok(!containsKeyFragment(errorText(err)), `non-JSON body ${JSON.stringify(body)} leaked: ${errorText(err)}`);
    });
  }
});

test("a fetch implementation whose own error mentions the key is scrubbed before it becomes a cause", async () => {
  const c = createLiveClient({
    apiKey: KEY, model: MODEL, sleep: noSleep, maxRetries: 0,
    fetch: async () => { const e = new TypeError(`fetch failed for Bearer ${KEY}`); e.cause = new Error(`dial ${KEY}`); throw e; },
  });
  const err = await caught(c.chat(ask));
  assert.equal(err.code, "network");
  assert.ok(err.cause instanceof Error);
  assert.equal(err.cause.name, "TypeError");
  assert.ok(!containsKeyFragment(errorText(err)), errorText(err));
});

test("a cause that hides the key past util.inspect's default truncation is still scrubbed", async () => {
  // inspect() shows 100 array items and 10,000 characters of a string by default; a
  // check that trusts it keeps a cause whose key sits past either limit, and anything
  // that walks err.cause programmatically then reads the key.
  const fetch = async () => {
    const e = new TypeError("fetch failed");
    e.headers = [...Array.from({ length: 150 }, () => "x"), `authorization: Bearer ${KEY}`];
    e.detail = `${"y".repeat(20000)} ${KEY}`;
    throw e;
  };
  const err = await caught(createLiveClient({ apiKey: KEY, model: MODEL, sleep: noSleep, maxRetries: 0, fetch }).chat(ask));
  assert.equal(err.code, "network");
  assert.ok(err.cause instanceof Error);
  assert.equal(err.cause.name, "TypeError");
  assert.equal(err.cause.message, "fetch failed");
  const full = inspect(err, { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity, showHidden: true });
  assert.ok(!containsKeyFragment(full), full.slice(0, 400));
  assert.ok(!JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause)).includes(KEY));
});

test("the client never writes to the console, on success or on any failure", async () => {
  const calls = [];
  const names = ["log", "error", "warn", "info", "debug", "trace"];
  const originals = Object.fromEntries(names.map((n) => [n, console[n]]));
  for (const n of names) console[n] = (...args) => calls.push([n, ...args]);
  try {
    await withStub((_r, res, n) => {
      if (n === 1) return json(res, 200, completion("ok"));
      if (n === 2) return json(res, 429, { error: `slow ${KEY}` });
      if (n === 3) return json(res, 401, { error: "bad key" });
      return json(res, 200, "not json");
    }, async (s) => {
      const c = client(s, { maxRetries: 0 });
      await c.chat(ask);
      await caught(c.chat(ask));
      await caught(c.chat(ask));
      await caught(c.chat(ask));
      assert.equal(s.seen.length, 4);
    });
    await caught(createLiveClient({ apiKey: KEY, model: MODEL, baseUrl: "http://127.0.0.1:1/v1", maxRetries: 0 }).chat(ask));
  } finally {
    for (const n of names) console[n] = originals[n];
  }
  assert.deepEqual(calls, []);
});

test("oversized replies: a 1 MiB assistant message is cut to MAX_CONTENT_BYTES, the rest of the reply intact", () =>
  withStub((_r, res) => json(res, 200, completion("y".repeat(1 << 20))), async (s) => {
    const reply = await client(s).chat(ask);
    assert.equal(reply.content.length, MAX_CONTENT_BYTES);
    assert.equal(reply.content, "y".repeat(MAX_CONTENT_BYTES));
    assert.deepEqual(reply.usage, { promptTokens: 5, completionTokens: 2 });
    assert.equal(reply.id, "chatcmpl-edges");
  }));

test("oversized error and non-JSON bodies: the thrown message stays short and never quotes the key", async () => {
  const big = `${"z".repeat(300_000)}${KEY}${"z".repeat(300_000)}`;
  await withStub((_r, res) => json(res, 500, big), async (s) => {
    const err = await caught(client(s, { maxRetries: 1 }).chat(ask));
    assert.equal(err.status, 500);
    assert.ok(err.message.length <= 250, `message length ${err.message.length}`);
    assert.ok(!containsKeyFragment(errorText(err)));
    assert.equal(s.seen.length, 2);
  });
  await withStub((_r, res) => json(res, 422, `   ${"x".repeat(50)}\n\n${"y".repeat(50)}   ${"w".repeat(500)}`), async (s) => {
    const err = await caught(client(s).chat(ask));
    assert.match(err.message, /^NEAR AI Cloud returned HTTP 422: x{50} y{50} w{92}$/, "first 200 raw chars, then whitespace collapsed and trimmed");
  });
  await withStub((_r, res) => json(res, 200, big), async (s) => {
    const err = await caught(client(s).chat(ask));
    assert.equal(err.code, "bad_response");
    assert.ok(err.message.length <= 250, `message length ${err.message.length}`);
    assert.ok(!containsKeyFragment(errorText(err)));
  });
  await withStub((_r, res) => json(res, 200, { choices: [{ message: { content: "ok" } }], padding: "p".repeat(1 << 20) }), async (s) => {
    assert.equal((await client(s).chat(ask)).content, "ok", "large but valid JSON with extra fields still parses");
  });
});

test("the reply model falls back to the requested model and usage never goes negative or NaN", () =>
  withStub((_r, res, n) => json(res, 200, n === 1
    ? { choices: [{ message: { content: "a" } }], model: 42, id: 7, usage: { prompt_tokens: -3, completion_tokens: Infinity } }
    : { choices: [{ message: { content: "b" } }], model: "served/other", usage: { prompt_tokens: 1.5 } }), async (s) => {
    const first = await client(s).chat(ask);
    assert.equal(first.model, MODEL);
    assert.equal(first.id, "");
    assert.deepEqual(first.usage, { promptTokens: 0, completionTokens: 0 });
    const second = await client(s).chat(ask);
    assert.equal(second.model, "served/other", "the provider's model id is reported when it is a string");
    assert.deepEqual(second.usage, { promptTokens: 1.5, completionTokens: 0 });
  }));
