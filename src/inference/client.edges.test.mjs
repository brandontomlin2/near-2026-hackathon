// Behaviour gaps in the mock path, request normalisation and the error type.
// No sockets: the only child process started here runs under the no-network
// preload to prove the mock path never asks for one.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  InferenceError,
  createInferenceClient,
  createLiveClient,
  createMockClient,
  defaultMockResponder,
  hashRequest,
  normalizeRequest,
} from "./client.mjs";

const KEY = "sk-edges-not-a-real-key-0123456789";
const user = (content) => ({ role: "user", content });
const ask = (content, extra = {}) => ({ messages: [user(content)], ...extra });

test("InferenceError: name, default code, retryable default and preserved cause", () => {
  const plain = new InferenceError("boom");
  assert.ok(plain instanceof Error);
  assert.equal(plain.name, "InferenceError");
  assert.equal(plain.code, "inference_error");
  assert.equal(plain.retryable, false);
  assert.equal(plain.status, undefined);
  assert.equal("cause" in plain, false);
  const root = new Error("root");
  const wrapped = new InferenceError("outer", { status: 503, code: "http_error", retryable: true, cause: root });
  assert.equal(wrapped.cause, root);
  assert.equal(wrapped.status, 503);
  assert.equal(wrapped.retryable, true);
});

test("normalizeRequest: a non-string system prompt is a bad_request", () => {
  for (const system of [1, null, ["a"], { text: "x" }]) {
    assert.throws(
      () => normalizeRequest({ system, messages: [user("hi")] }, "m"),
      (err) => err instanceof InferenceError && err.code === "bad_request" && /system must be a string/.test(err.message),
      JSON.stringify(system),
    );
  }
});

test("normalizeRequest: carries temperature, maxTokens and seed through unchanged, including zero", () => {
  const n = normalizeRequest(ask("x", { temperature: 0, maxTokens: 0, seed: "run-1" }), "m");
  assert.equal(n.temperature, 0);
  assert.equal(n.maxTokens, 0);
  assert.equal(n.seed, "run-1");
  assert.equal(n.model, "m");
});

test("hashRequest: seed and system prompt both change the hash; numeric and string seeds differ", () => {
  const base = normalizeRequest(ask("same prompt"), "m");
  const h = hashRequest(base);
  assert.notEqual(hashRequest(normalizeRequest(ask("same prompt", { seed: 1 }), "m")), h);
  assert.notEqual(hashRequest(normalizeRequest(ask("same prompt", { seed: "1" }), "m")), hashRequest(normalizeRequest(ask("same prompt", { seed: 1 }), "m")));
  assert.notEqual(hashRequest(normalizeRequest(ask("same prompt", { system: "be terse" }), "m")), h);
  assert.notEqual(hashRequest(normalizeRequest(ask("same prompt", { system: "be verbose" }), "m")), hashRequest(normalizeRequest(ask("same prompt", { system: "be terse" }), "m")));
  // A system prompt given as a system message is the same conversation.
  assert.equal(
    hashRequest(normalizeRequest(ask("same prompt", { system: "be terse" }), "m")),
    hashRequest(normalizeRequest({ messages: [{ role: "system", content: "be terse" }, user("same prompt")] }, "m")),
  );
  assert.match(h, /^[0-9a-f]{64}$/);
});

test("mock: seed sweeps are stable and distinct per seed, and the same seed repeats across clients", async () => {
  const seeds = [0, 1, 2, 3, "a", "b"];
  const first = await Promise.all(seeds.map((seed) => createMockClient().chat(ask("the treasury vote", { seed }))));
  const second = await Promise.all(seeds.map((seed) => createMockClient().chat(ask("the treasury vote", { seed }))));
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((r) => r.id)).size, seeds.length, "every seed gives a different id");
});

test("mock: the reply id is derived from the request hash and usage is estimated from lengths", async () => {
  const request = ask("count my tokens please", { system: "sys" });
  const normalized = normalizeRequest(request, "mock");
  const hash = hashRequest(normalized);
  const reply = await createMockClient().chat(request);
  assert.equal(reply.id, `mock-${hash.slice(0, 16)}`);
  assert.equal(reply.content, defaultMockResponder(normalized, hash));
  assert.equal(reply.usage.promptTokens, Math.ceil("sys".length / 4) + Math.ceil("count my tokens please".length / 4));
  assert.equal(reply.usage.completionTokens, Math.ceil(reply.content.length / 4));
  assert.equal(reply.model, "mock");
});

test("mock: NEAR_AI_MODEL names the mock model and changes the hash, without any key", async () => {
  const named = createInferenceClient({ env: { NEAR_AI_MODEL: "demo/model" } });
  const plain = createInferenceClient({ env: {} });
  assert.equal(named.model, "demo/model");
  const a = await named.chat(ask("hello swarm"));
  const b = await plain.chat(ask("hello swarm"));
  assert.equal(a.model, "demo/model");
  assert.equal(b.model, "mock");
  assert.notEqual(a.id, b.id);
  // An explicit model option wins over the default on createMockClient too.
  assert.equal((await createMockClient({ model: "x" }).chat(ask("hello swarm"))).model, "x");
});

test("mock responder: topic is the longest word of the last user message, ties go to the earliest", () => {
  const topic = (content, messages = [user(content)]) => {
    const n = normalizeRequest({ messages }, "m");
    const text = defaultMockResponder(n, hashRequest(n));
    const m = text.match(/^(?:Noted\.|Hm\.|Fine\.|Interesting\.|Let me think\.|Right\.|Well\.|Okay\.) (.*)$/);
    assert.ok(m, text);
    return m[1];
  };
  assert.match(topic("alpha gamma omega"), /\balpha\b/); // all 5 letters: first wins
  assert.match(topic("alpha longer gamma"), /\blonger\b/);
  assert.match(topic("abcdefghijklmnopq short"), /\bshort\b/); // 17 letters is too long to be a topic
  assert.match(topic("abcdefghijklmnop short"), /\babcdefghijklmnop\b/); // 16 is the cap
  assert.match(topic("TREASURY vote"), /\btreasury\b/); // lower-cased
  // The last *user* message wins, even when an assistant message follows it.
  assert.match(topic(null, [user("validators matter"), { role: "assistant", content: "committee stuff" }]), /\bvalidators\b/);
  // With no user message at all, the last message is used.
  assert.match(topic(null, [{ role: "system", content: "quiet observer" }]), /\bobserver\b/);
  assert.match(topic("a b c"), /\bthis\b/);
});

test("mock responder: every reply is opener + body + closer drawn from the hash bytes", () => {
  const n = normalizeRequest(ask("anything"), "m");
  const h = "00" + "01" + "02" + "0".repeat(58);
  assert.equal(defaultMockResponder(n, h), "Noted. I have a question about anything: who checked it? Reply if you disagree.");
  const h2 = "07" + "07" + "03" + "0".repeat(58);
  assert.equal(defaultMockResponder(n, h2), "Okay. Show me the numbers on anything before I agree. Logging it.");
  const h3 = "08" + "09" + "06" + "0".repeat(58); // wraps modulo the table sizes (8, 8, 4)
  assert.equal(defaultMockResponder(n, h3), defaultMockResponder(n, h));
});

test("mock: a responder that throws propagates its own error and the reply is not cached", async () => {
  let calls = 0;
  const client = createMockClient({ responder: () => { calls += 1; if (calls === 1) throw new RangeError("first"); return "second"; } });
  await assert.rejects(client.chat(ask("x")), RangeError);
  assert.equal((await client.chat(ask("x"))).content, "second");
});

test("mock: invalid requests are rejected with bad_request before any responder runs", async () => {
  let calls = 0;
  const client = createMockClient({ responder: () => { calls += 1; return "never"; } });
  for (const bad of [undefined, 42, { messages: [] }, { messages: [user(7)] }, { system: 1, messages: [user("x")] }]) {
    await assert.rejects(client.chat(bad), (err) => err instanceof InferenceError && err.code === "bad_request");
  }
  assert.equal(calls, 0);
});

test("live client object exposes mode, model and baseUrl but never the key", () => {
  const client = createLiveClient({ apiKey: `  ${KEY}  `, model: "m", baseUrl: "http://127.0.0.1:1/v1/" });
  assert.deepEqual(Object.keys(client).sort(), ["baseUrl", "chat", "mode", "model"]);
  assert.equal(client.baseUrl, "http://127.0.0.1:1/v1");
  assert.ok(!JSON.stringify(client).includes(KEY.trim()));
  assert.ok(!Object.values(client).some((v) => typeof v === "string" && v.includes("edges")));
});

test("mock mode under the no-network preload: a chat completes with live env present and fetch tripped", () => {
  const script = `
    import { createInferenceClient } from ${JSON.stringify(new URL("./client.mjs", import.meta.url).href)};
    const client = createInferenceClient({ env: { NEAR_AI_API_KEY: ${JSON.stringify(KEY)}, NEAR_AI_MODEL: "m", NEAR_AI_BASE_URL: "http://127.0.0.1:1/v1" } });
    const r = await client.chat({ messages: [{ role: "user", content: "offline please" }] });
    process.stdout.write(JSON.stringify({ mode: r.mode, content: r.content, fetchTripped: (() => { try { fetch("http://127.0.0.1:1"); return false; } catch { return true; } })() }));
  `;
  const out = execFileSync(process.execPath, [
    "--import", new URL("../../scripts/test-helpers/no-network.mjs", import.meta.url).pathname,
    "--input-type=module", "-e", script,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, MOCK_INFERENCE: "0" } });
  const r = JSON.parse(out);
  assert.equal(r.mode, "mock", "env passed explicitly wins over process.env MOCK_INFERENCE=0");
  assert.ok(r.content.length > 0);
  assert.equal(r.fetchTripped, true, "the preload really blocks fetch in that process");
  assert.ok(!out.includes(KEY));
});
