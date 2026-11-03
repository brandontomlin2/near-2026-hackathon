import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./infer.mjs", import.meta.url));

function run(args) {
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  delete env.NEAR_AI_API_KEY;
  delete env.NEAR_AI_MODEL;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

test("plain prompt: one mode line on stderr, newline-terminated reply, deterministic", () => {
  const a = run(["What do you make of the treasury proposal?"]);
  assert.equal(a.status, 0, a.stderr);
  const lines = a.stderr.split("\n");
  assert.equal(lines.length, 2, "exactly one line plus trailing newline");
  assert.equal(lines[1], "");
  const m = /^mode: mock model: (.+)$/.exec(lines[0]);
  assert.ok(m, `unexpected stderr: ${a.stderr}`);
  assert.ok(m[1].length > 0);
  assert.ok(a.stdout.trim().length > 0);
  assert.ok(a.stdout.endsWith("\n"));
  const b = run(["What do you make of the treasury proposal?"]);
  assert.equal(b.stdout, a.stdout);
});

test("--json prints the whole mock response and no key", () => {
  const plain = run(["hello"]);
  const j = run(["--json", "hello"]);
  assert.equal(j.status, 0, j.stderr);
  const body = JSON.parse(j.stdout);
  assert.equal(body.mode, "mock");
  assert.equal(typeof body.content, "string");
  assert.equal(body.content, plain.stdout.trim());
  assert.match(body.id, /^mock-/);
  assert.ok(!("apiKey" in body) && !("api_key" in body));
});

test("--system and --seed: seed is mixed into the mock id; seed 0 is accepted", () => {
  const seven = JSON.parse(run(["--system", "You are Aloof.", "--seed", "7", "--json", "hello"]).stdout);
  const eight = run(["--system", "You are Aloof.", "--seed", "8", "--json", "hello"]);
  assert.equal(eight.status, 0, eight.stderr);
  assert.notEqual(JSON.parse(eight.stdout).id, seven.id);
  const again = JSON.parse(run(["--system", "You are Aloof.", "--seed", "7", "--json", "hello"]).stdout);
  assert.equal(again.id, seven.id);
  const noSystem = JSON.parse(run(["--seed", "7", "--json", "hello"]).stdout);
  assert.notEqual(noSystem.id, seven.id, "system prompt changes the hash");
  const zero = run(["--seed", "0", "hello"]);
  assert.equal(zero.status, 0, zero.stderr);
});

test("multi-word prompt split across argv is joined with spaces", () => {
  const split = run(["--json", "hello", "there"]);
  const single = run(["--json", "hello there"]);
  assert.equal(split.status, 0, split.stderr);
  assert.equal(split.stdout, single.stdout);
});

// Audit L-1 and L-2 at the CLI boundary: a live reply through a local stub server.
import { createServer } from "node:http";

async function withStub(content, fn) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c1", model: "stub", choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// Asynchronous, unlike run() above: the stub server lives in this process and must get the event loop.
function runLive(args, baseUrl) {
  const env = { ...process.env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "stub-key-not-real", NEAR_AI_MODEL: "stub", NEAR_AI_BASE_URL: baseUrl };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

test("live reply: ANSI clear-screen, OSC title/hyperlink and bidi override never reach stdout", () =>
  withStub("\u001b[2J\u001b]0;pwned\u0007\u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007 \u202ereversed\u202c done", async (baseUrl) => {
    const plain = await runLive(["hello"], baseUrl);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, UNSAFE);
    assert.ok(plain.stdout.includes("link") && plain.stdout.endsWith(" done\n"), plain.stdout);
    const json = await runLive(["--json", "hello"], baseUrl);
    assert.equal(json.status, 0, json.stderr);
    assert.doesNotMatch(json.stdout, UNSAFE);
    assert.doesNotMatch(JSON.parse(json.stdout).content, UNSAFE);
  }));

test("live reply: a 4 MiB reply is cut before it is printed", () =>
  withStub("A".repeat(4 * 1024 * 1024), async (baseUrl) => {
    const r = await runLive(["hello"], baseUrl);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length <= 32 * 1024 + 1, `${r.stdout.length} bytes`);
  }));

test("credentials in NEAR_AI_BASE_URL: refused up front, and the password is not in the output", async () => {
  const r = await runLive(["hello"], "http://alice:s3cr3t-pw@127.0.0.1:1/v1");
  assert.equal(r.status, 1);
  assert.ok(!r.stderr.includes("s3cr3t-pw") && !r.stdout.includes("s3cr3t-pw"), r.stderr);
  assert.match(r.stderr, /^infer: inference error \(bad_config\): NEAR_AI_BASE_URL must not contain credentials/m);
});
