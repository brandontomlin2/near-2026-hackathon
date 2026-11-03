// Behaviour gaps in the inference client: exact byte boundaries of the response
// cap and the content cap, streamed vs content-length bodies, empty and
// non-JSON bodies, error-status messages, and request/config details.
// Injected fetch only; nothing touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_TOKENS,
  MAX_CONTENT_BYTES,
  InferenceError,
  createInferenceClient,
  createLiveClient,
  createMockClient,
  parseMode,
} from "./client.mjs";

const KEY = "test-fake-key-gaps14-secret-key";
const REQ = { messages: [{ role: "user", content: "hello" }] };
const noSleep = async () => {};

/** Response whose body streams the given chunks, so there is no content-length header. */
function streamed(chunks, init = {}) {
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

/** A fetch that records calls (url, init) and answers from `make(callIndex)`. */
function spyFetch(make) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return make(calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function client(fetch, extra = {}) {
  return createLiveClient({ apiKey: KEY, model: "m", fetch, sleep: noSleep, ...extra });
}

/** A JSON completion body padded with whitespace to exactly `size` bytes. */
function bodyOfSize(size, content = "ok") {
  const base = JSON.stringify({ id: "x", model: "m", choices: [{ message: { content } }] });
  assert.ok(size >= base.length);
  return Buffer.from(base + " ".repeat(size - base.length));
}

const rejects = (promise, check) => assert.rejects(promise, check);

test("a streamed body (no content-length) of exactly maxResponseBytes is accepted; one byte more is response_too_large", async () => {
  const cap = 600;
  const exact = bodyOfSize(cap);
  const okFetch = spyFetch(() => streamed([exact.subarray(0, 100), exact.subarray(100)]));
  const reply = await client(okFetch, { maxResponseBytes: cap }).chat(REQ);
  assert.equal(reply.content, "ok");

  const over = bodyOfSize(cap + 1);
  const badFetch = spyFetch(() => streamed([over.subarray(0, 100), over.subarray(100)]));
  await rejects(client(badFetch, { maxResponseBytes: cap }).chat(REQ), (e) => {
    assert.ok(e instanceof InferenceError);
    assert.equal(e.code, "response_too_large");
    assert.equal(e.retryable, false);
    assert.equal(e.message, `NEAR AI Cloud response body exceeded the ${cap} byte limit`);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  assert.equal(badFetch.calls.length, 1, "an oversized body is not retried");
});

test("over the cap aborts the in-flight request through the signal handed to fetch", async () => {
  const over = bodyOfSize(101);
  const f = spyFetch(() => streamed([over]));
  await rejects(client(f, { maxResponseBytes: 100 }).chat(REQ), (e) => e.code === "response_too_large");
  assert.equal(f.calls[0].init.signal.aborted, true);
  const f2 = spyFetch(() => streamed([bodyOfSize(100)]));
  await client(f2, { maxResponseBytes: 100 }).chat(REQ);
  assert.equal(f2.calls[0].init.signal.aborted, false, "a body within the cap leaves the signal alone");
});

test("a streamed body of exactly DEFAULT_MAX_RESPONSE_BYTES is accepted; a content-length of one more is refused unread", async () => {
  assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 4 * 1024 * 1024);
  const exact = bodyOfSize(DEFAULT_MAX_RESPONSE_BYTES);
  const chunks = [];
  for (let off = 0; off < exact.length; off += 1024 * 1024) chunks.push(exact.subarray(off, off + 1024 * 1024));
  const reply = await client(spyFetch(() => streamed(chunks))).chat(REQ);
  assert.equal(reply.content, "ok");

  let pulled = 0;
  const unread = new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new Uint8Array(8)); } }, { highWaterMark: 0 });
  const declared = spyFetch(() => new Response(unread, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1) },
  }));
  await rejects(client(declared).chat(REQ), (e) => e.code === "response_too_large");
  assert.equal(pulled, 0, "the declared length alone is enough to refuse");
});

test("an unparseable content-length is ignored and the streamed bytes are still capped", async () => {
  const mk = (n) => spyFetch(() => streamed([bodyOfSize(n)], {
    headers: { "content-type": "application/json", "content-length": "not-a-number" },
  }));
  assert.equal((await client(mk(200), { maxResponseBytes: 200 }).chat(REQ)).content, "ok");
  await rejects(client(mk(201), { maxResponseBytes: 200 }).chat(REQ), (e) => e.code === "response_too_large");
});

test("a multi-byte character split across stream chunks is decoded whole", async () => {
  const raw = Buffer.from(JSON.stringify({ choices: [{ message: { content: "a€b\u{1F600}c" } }] }));
  const euro = raw.indexOf(Buffer.from("€"));
  const emoji = raw.indexOf(Buffer.from("\u{1F600}"));
  const chunks = [raw.subarray(0, euro + 1), raw.subarray(euro + 1, emoji + 2), raw.subarray(emoji + 2)];
  const reply = await client(spyFetch(() => streamed(chunks))).chat(REQ);
  assert.equal(reply.content, "a€b\u{1F600}c");
});

test("a 200 with no body or an empty body is bad_response (non-JSON) and not retried", async () => {
  for (const make of [
    () => new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response("", { status: 200 }),
  ]) {
    const f = spyFetch(make);
    await rejects(client(f).chat(REQ), (e) => {
      assert.equal(e.code, "bad_response");
      assert.match(e.message, /^NEAR AI Cloud returned a non-JSON body \(content-type /);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test("a non-JSON body names the content-type (or unknown) but never quotes the body", async () => {
  const html = spyFetch(() => new Response("<html>SECRET-PAGE-TEXT</html>", { status: 200, headers: { "content-type": "text/html" } }));
  await rejects(client(html).chat(REQ), (e) => {
    assert.equal(e.message, "NEAR AI Cloud returned a non-JSON body (content-type text/html)");
    assert.equal(e.cause, undefined, "no cause: a SyntaxError would quote the body");
    return true;
  });
  const bare = spyFetch(() => streamed([Buffer.from("nope")], { headers: {} }));
  await rejects(client(bare).chat(REQ), (e) => e.message === "NEAR AI Cloud returned a non-JSON body (content-type unknown)");
});

test("error statuses: empty body gives a bare status message; the snippet collapses whitespace; 4xx is not retried", async () => {
  const empty = spyFetch(() => new Response(null, { status: 400 }));
  await rejects(client(empty).chat(REQ), (e) => {
    assert.equal(e.message, "NEAR AI Cloud returned HTTP 400");
    assert.equal(e.status, 400);
    assert.equal(e.code, "http_error");
    assert.equal(e.retryable, false);
    return true;
  });
  assert.equal(empty.calls.length, 1);

  const spaced = spyFetch(() => new Response("  bad \n\n\t request  ", { status: 422 }));
  await rejects(client(spaced).chat(REQ), (e) => e.message === "NEAR AI Cloud returned HTTP 422: bad request");
});

test("a retryable status is retried exactly maxRetries times, then the last status is thrown with retryable true", async () => {
  const f = spyFetch(() => new Response("busy", { status: 503 }));
  await rejects(client(f, { maxRetries: 3 }).chat(REQ), (e) => e.status === 503 && e.retryable === true && e.message === "NEAR AI Cloud returned HTTP 503: busy");
  assert.equal(f.calls.length, 4);
});

test("reply content: exactly MAX_CONTENT_BYTES is untouched, one over is cut, and a 3-byte character is never split", async () => {
  const reply = (content) => client(spyFetch(() => new Response(JSON.stringify({ choices: [{ message: { content } }] })))).chat(REQ);
  assert.equal((await reply("a".repeat(MAX_CONTENT_BYTES))).content.length, MAX_CONTENT_BYTES);
  assert.equal((await reply("a".repeat(MAX_CONTENT_BYTES + 1))).content, "a".repeat(MAX_CONTENT_BYTES));
  // 'a' + euro signs: byte 32768 falls inside the last euro sign that would fit.
  const cut = (await reply("a" + "€".repeat(20000))).content;
  assert.ok(Buffer.byteLength(cut) <= MAX_CONTENT_BYTES);
  assert.ok(!cut.includes("�"));
  assert.equal(cut, "a" + "€".repeat(Math.floor((MAX_CONTENT_BYTES - 1) / 3)));
});

test("the mock client applies the same content cap to a responder's reply", async () => {
  const mock = createMockClient({ responder: () => "b".repeat(MAX_CONTENT_BYTES + 5) });
  assert.equal((await mock.chat(REQ)).content, "b".repeat(MAX_CONTENT_BYTES));
});

test("content that is blank, non-string or missing is bad_response; surrounding whitespace in real content is kept", async () => {
  const reply = (message) => client(spyFetch(() => new Response(JSON.stringify({ choices: [{ message }] })))).chat(REQ);
  for (const message of [{ content: "   \n" }, { content: 42 }, { content: ["x"] }, { content: null }, {}, null]) {
    await rejects(reply(message), (e) => e.code === "bad_response" && e.message === "NEAR AI Cloud response has no non-empty choices[0].message.content");
  }
  assert.equal((await reply({ content: "  hi \n" })).content, "  hi \n");
});

test("request body: zero temperature, zero seed and zero maxTokens are sent; a string seed and absent temperature are not", async () => {
  const sent = async (extra) => {
    const f = spyFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
    await client(f).chat({ ...REQ, ...extra });
    return JSON.parse(f.calls[0].init.body);
  };
  const zeros = await sent({ temperature: 0, seed: 0, maxTokens: 0 });
  assert.equal(zeros.temperature, 0);
  assert.equal(zeros.seed, 0);
  assert.equal(zeros.max_tokens, 0);
  const plain = await sent({ seed: "abc" });
  assert.ok(!("temperature" in plain) && !("seed" in plain));
  assert.equal(plain.max_tokens, DEFAULT_MAX_TOKENS);
});

test("the API key is trimmed in the header; repeated trailing slashes are stripped; an empty NEAR_AI_BASE_URL falls back to the default", async () => {
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  const f = spyFetch(ok);
  const c = createLiveClient({ apiKey: `  ${KEY}\n`, model: "m", baseUrl: "http://127.0.0.1:9/v1///", fetch: f });
  assert.equal(c.baseUrl, "http://127.0.0.1:9/v1");
  await c.chat(REQ);
  assert.equal(f.calls[0].url, "http://127.0.0.1:9/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${KEY}`);

  const g = spyFetch(ok);
  const viaEnv = createInferenceClient({
    env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "m", NEAR_AI_BASE_URL: "" },
    fetch: g,
  });
  assert.equal(viaEnv.baseUrl, DEFAULT_BASE_URL);
  await viaEnv.chat(REQ);
  assert.equal(g.calls[0].url, `${DEFAULT_BASE_URL}/chat/completions`);
});

test("reply labels and usage: non-string model/id fall back, string token counts count as zero", async () => {
  const f = spyFetch(() => new Response(JSON.stringify({
    id: 7,
    model: { name: "x" },
    choices: [{ message: { content: "ok" } }],
    usage: { prompt_tokens: "12", completion_tokens: 5 },
  })));
  const r = await client(f).chat(REQ);
  assert.equal(r.model, "m");
  assert.equal(r.id, "");
  assert.deepEqual(r.usage, { promptTokens: 0, completionTokens: 5 });
});

test("MOCK_INFERENCE parsing: case and whitespace are tolerated, empty means mock, anything else is bad_config", () => {
  for (const raw of [" TRUE ", "True", "", "  ", " 1"]) assert.equal(parseMode(raw), "mock", JSON.stringify(raw));
  for (const raw of [" FALSE", "0 ", "False"]) assert.equal(parseMode(raw), "live", JSON.stringify(raw));
  for (const raw of ["maybe", "2", "no", "yes"]) {
    assert.throws(() => parseMode(raw), (e) => e instanceof InferenceError && e.code === "bad_config" && e.message.startsWith("MOCK_INFERENCE must be 1 or 0"));
  }
});

test("createInferenceClient: an empty NEAR_AI_MODEL in mock mode falls back to the mock model", () => {
  const c = createInferenceClient({ env: { MOCK_INFERENCE: "1", NEAR_AI_MODEL: "" } });
  assert.equal(c.mode, "mock");
  assert.equal(c.model, "mock");
});

test("live config errors carry their code and never the key: missing model, blank key", () => {
  assert.throws(() => createLiveClient({ apiKey: KEY, model: "" }), (e) => e.code === "missing_model" && !e.message.includes(KEY));
  for (const apiKey of ["", "   ", undefined]) {
    assert.throws(() => createLiveClient({ apiKey, model: "m" }), (e) => e.code === "missing_api_key");
  }
  assert.throws(() => createLiveClient(undefined), (e) => e.code === "missing_api_key");
});

test("a content-length equal to maxResponseBytes is accepted; one more is refused", async () => {
  const cap = 300;
  const withLength = (n) => spyFetch(() => {
    const body = bodyOfSize(n);
    return new Response(body, { status: 200, headers: { "content-type": "application/json", "content-length": String(body.length) } });
  });
  const okFetch = withLength(cap);
  assert.equal((await client(okFetch, { maxResponseBytes: cap }).chat(REQ)).content, "ok");
  assert.equal(okFetch.calls[0].init.signal.aborted, false);
  await rejects(client(withLength(cap + 1), { maxResponseBytes: cap }).chat(REQ), (e) => e.code === "response_too_large" && !e.retryable);
});
