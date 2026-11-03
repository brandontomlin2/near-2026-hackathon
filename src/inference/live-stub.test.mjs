// End to end proof of the live code path (MOCK_INFERENCE=0) against a local
// stub HTTP server on 127.0.0.1. No real service is contacted. The client is
// built through createInferenceClient with env, exactly as the CLI does, so
// NEAR_AI_BASE_URL, NEAR_AI_API_KEY and NEAR_AI_MODEL are all exercised.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { DEFAULT_MAX_RESPONSE_BYTES, InferenceError, createInferenceClient } from "./client.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { runMemoryLoop } from "../memory/loop.mjs";

const KEY = "stub-key-not-real-0123456789";
const MODEL = "stub/model-1";

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
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(entry);
      handler(entry, res, seen.length);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const completion = (content) => ({
  id: "chatcmpl-stub",
  model: MODEL,
  choices: [{ index: 0, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
});

/** Client from env, like the CLI. Sleep is a no-op so backoff costs no time. */
function clientFor(s, extra = {}) {
  return createInferenceClient({
    env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: MODEL, NEAR_AI_BASE_URL: s.baseUrl },
    ...extra,
  });
}
const ask = { messages: [{ role: "user", content: "ping" }] };

async function withStub(handler, fn) {
  const s = await stub(handler);
  try { return await fn(s); } finally { await s.close(); }
}

test("live path via env: normal completion and documented request shape", () =>
  withStub((_r, res) => json(res, 200, completion("pong")), async (s) => {
    const client = clientFor(s, { maxRetries: 0 });
    assert.equal(client.mode, "live");
    const reply = await client.chat({ system: "be brief", ...ask, temperature: 0.2, maxTokens: 32, seed: 7 });
    assert.equal(reply.content, "pong");
    assert.equal(reply.mode, "live");
    assert.equal(reply.model, MODEL);
    assert.deepEqual(reply.usage, { promptTokens: 5, completionTokens: 2 });
    const [req] = s.seen;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(req.body, {
      model: MODEL,
      messages: [{ role: "system", content: "be brief" }, { role: "user", content: "ping" }],
      temperature: 0.2,
      max_tokens: 32,
      seed: 7,
    });
  }));

test("401: not retried, status surfaced, key never in the error", () =>
  withStub((_r, res) => json(res, 401, { error: { message: `bad key ${KEY}` } }), async (s) => {
    await assert.rejects(clientFor(s).chat(ask), (e) => {
      assert.ok(e instanceof InferenceError);
      assert.equal(e.status, 401);
      assert.equal(e.retryable, false);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    assert.equal(s.seen.length, 1);
  }));

test("429 then success: retried with backoff and recovers", async () => {
  await withStub((_r, res, n) => (n < 3 ? json(res, 429, { error: "slow down" }) : json(res, 200, completion("ok"))), async (s) => {
    const client = createInferenceClient({
      env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: MODEL, NEAR_AI_BASE_URL: s.baseUrl },
    });
    // Default client uses real backoff (250ms + 500ms); bounded and short.
    const reply = await client.chat(ask);
    assert.equal(reply.content, "ok");
    assert.equal(s.seen.length, 3);
  });
});

test("429 forever: bounded by maxRetries, then reports 429", () =>
  withStub((_r, res) => json(res, 429, { error: "slow down" }), async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 2 }).chat(ask), (e) => e.status === 429 && e.retryable === true);
    assert.equal(s.seen.length, 3);
  }));

test("5xx: retried then surfaced with the status", () =>
  withStub((_r, res) => json(res, 503, { error: "down" }), async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 1 }).chat(ask), (e) => e.status === 503 && e.code === "http_error");
    assert.equal(s.seen.length, 2);
  }));

test("timeout: a server that never answers gives a retryable timeout error", () =>
  withStub(() => { /* never respond */ }, async (s) => {
    await assert.rejects(clientFor(s, { timeoutMs: 80, maxRetries: 0 }).chat(ask), (e) => e.code === "timeout" && e.retryable);
    assert.equal(s.seen.length, 1);
  }));

test("non-JSON 200 body: bad_response, not retried", () =>
  withStub((_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>oops</html>"); }, async (s) => {
    await assert.rejects(clientFor(s).chat(ask), (e) => e.code === "bad_response");
    assert.equal(s.seen.length, 1);
  }));

test("truncated JSON body: bad_response, not retried", () =>
  withStub((_r, res) => {
    const full = JSON.stringify(completion("cut off"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(full.slice(0, Math.floor(full.length / 2)));
  }, async (s) => {
    await assert.rejects(clientFor(s).chat(ask), (e) => e.code === "bad_response");
    assert.equal(s.seen.length, 1);
  }));

test("connection cut mid-body is an error, not a hang or a fake reply", () =>
  withStub((_r, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
    res.write('{"id":"x","choices":[');
    setTimeout(() => res.destroy(), 10);
  }, async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 0, timeoutMs: 2000 }).chat(ask), (e) => e instanceof InferenceError);
  }));

/** A completion whose serialized body is exactly `bytes` long. */
function completionOfSize(bytes) {
  const frame = Buffer.byteLength(JSON.stringify(completion("")));
  assert.ok(bytes > frame, `cannot build a ${bytes} byte completion`);
  const body = completion("a".repeat(bytes - frame));
  assert.equal(Buffer.byteLength(JSON.stringify(body)), bytes);
  return body;
}

function assertNoKey(e) {
  assert.ok(!e.message.includes(KEY), e.message);
  assert.ok(!e.stack.includes(KEY));
  assert.ok(!String(e.cause ?? "").includes(KEY));
  assert.ok(!JSON.stringify(e.cause ?? null).includes(KEY));
}

test("response cap: a 1 MiB reply is well under the default cap and comes back whole", () =>
  withStub((_r, res) => json(res, 200, completionOfSize(1024 * 1024)), async (s) => {
    const reply = await clientFor(s, { maxRetries: 0 }).chat(ask);
    assert.equal(Buffer.byteLength(reply.content), 1024 * 1024 - Buffer.byteLength(JSON.stringify(completion(""))));
  }));

test("response cap: a body exactly at the default cap passes", () =>
  withStub((_r, res) => json(res, 200, completionOfSize(DEFAULT_MAX_RESPONSE_BYTES)), async (s) => {
    assert.ok(DEFAULT_MAX_RESPONSE_BYTES >= 2 * 1024 * 1024, "cap is comfortably above any real chat completion");
    const reply = await clientFor(s, { maxRetries: 0 }).chat(ask);
    assert.ok(reply.content.length > 1024 * 1024);
  }));

test("response cap: one byte over the default cap fails with a clear error, no retry, no key", () =>
  withStub((_r, res) => json(res, 200, completionOfSize(DEFAULT_MAX_RESPONSE_BYTES + 1)), async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 2 }).chat(ask), (e) => {
      assert.ok(e instanceof InferenceError);
      assert.equal(e.code, "response_too_large");
      assert.equal(e.retryable, false);
      assert.match(e.message, new RegExp(`${DEFAULT_MAX_RESPONSE_BYTES}`));
      assertNoKey(e);
      return true;
    });
    assert.equal(s.seen.length, 1);
  }));

test("response cap: maxResponseBytes option is honoured on both sides of the line", async () => {
  const cap = 4096;
  await withStub((_r, res) => json(res, 200, completionOfSize(cap)), async (s) => {
    const reply = await clientFor(s, { maxRetries: 0, maxResponseBytes: cap }).chat(ask);
    assert.ok(reply.content.length > 3000);
  });
  await withStub((_r, res) => json(res, 200, completionOfSize(cap + 1)), async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 0, maxResponseBytes: cap }).chat(ask), (e) => {
      assert.equal(e.code, "response_too_large");
      assert.match(e.message, /4096/);
      assertNoKey(e);
      return true;
    });
  });
});

test("response cap: an endless chunked body without content-length is aborted once past the cap", () =>
  withStub((_r, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"choices":[{"message":{"content":"');
    const chunk = "b".repeat(16 * 1024);
    let closed = false;
    res.on("close", () => { closed = true; });
    const pump = () => {
      if (closed || res.destroyed) return;
      if (res.write(chunk)) setImmediate(pump); else res.once("drain", pump);
    };
    pump();
  }, async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 0, maxResponseBytes: 256 * 1024, timeoutMs: 5000 }).chat(ask), (e) => {
      assert.equal(e.code, "response_too_large");
      assert.equal(e.retryable, false);
      assertNoKey(e);
      return true;
    });
    assert.equal(s.seen.length, 1);
  }));

test("response cap: a content-length header over the cap is refused before the body is read", () =>
  withStub((_r, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": String(DEFAULT_MAX_RESPONSE_BYTES + 1) });
    res.write("{");
  }, async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 0, timeoutMs: 5000 }).chat(ask), (e) => {
      assert.equal(e.code, "response_too_large");
      assertNoKey(e);
      return true;
    });
  }));

test("response cap: an oversized non-2xx body still yields the status error without the key", () =>
  withStub((_r, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `bad request for Bearer ${KEY} ${"x".repeat(8192)}` }));
  }, async (s) => {
    await assert.rejects(clientFor(s, { maxRetries: 0, maxResponseBytes: 1024 }).chat(ask), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.code, "http_error");
      assertNoKey(e);
      return true;
    });
  }));

test("missing or empty choices: bad_response", async () => {
  const bodies = [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: "  " } }] }];
  for (const body of bodies) {
    await withStub((_r, res) => json(res, 200, body), async (s) => {
      await assert.rejects(clientFor(s).chat(ask), (e) => e.code === "bad_response", JSON.stringify(body));
      assert.equal(s.seen.length, 1);
    });
  }
});

test("one swarm round through the live path against the stub", () =>
  withStub((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${KEY}`);
    json(res, 200, completion(`line ${req.body.messages.length}`));
  }, async (s) => {
    const swarm = await runSwarm({ rounds: 1, seed: 3, client: clientFor(s) });
    assert.equal(swarm.events.length, AGENTS.length);
    assert.equal(s.seen.length, AGENTS.length);
    for (const e of swarm.events) assert.match(e.text, /line \d+$/);
    for (const r of s.seen) {
      assert.equal(r.url, "/v1/chat/completions");
      assert.equal(r.body.model, MODEL);
      assert.ok(r.body.messages.length >= 1);
    }
  }));

test("memory loop produces a sheet per token through the live path against the stub", () =>
  withStub((req, res) => {
    const prompt = req.body.messages.map((m) => m.content).join("\n");
    json(res, 200, completion(prompt.includes("Summarize") || prompt.includes("sheet") ? "Sheet: guarded, curious, remembers." : "short post"));
  }, async (s) => {
    const client = clientFor(s);
    const swarm = await runSwarm({ rounds: 2, seed: 5, client });
    const before = s.seen.length;
    const result = await runMemoryLoop({ swarm, client });
    assert.equal(s.seen.length - before, AGENTS.length);
    assert.equal(result.tokens.length, AGENTS.length);
    for (const t of result.tokens) {
      assert.equal(t.sheet.mode, "live");
      assert.equal(t.sheet.model, MODEL);
      assert.ok(t.sheet.sheet.length > 0);
      assert.equal(t.anchor.status, "dry-run");
      assert.equal(t.anchor.args.sheet_hash, t.sheet.sheetHash);
    }
  }));
