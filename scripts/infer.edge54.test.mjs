// Edge cases for scripts/infer.mjs beyond infer.test.mjs and infer.gaps14.test.mjs:
// flag parsing corners, garbled live responses from a loopback stub server, and
// terminal-safety of what the CLI prints. No test touches the network: mock mode,
// or a live run pointed at a 127.0.0.1 stub started by the test.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./infer.mjs", import.meta.url));
const FAKE_KEY = "edge54-fake-key-do-not-print";
const T = { timeout: 30000 };
// Any C0/C1 control except tab, LF, CR, plus bidi overrides.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

function mockEnv(extra = {}) {
  const env = { ...process.env, MOCK_INFERENCE: "1", ...extra };
  for (const key of ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_BASE_URL"]) if (!(key in extra)) delete env[key];
  return env;
}

function run(args, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: mockEnv(extra), timeout: 20000 });
}

// Async: the stub server lives in this process and needs the event loop.
function runAsync(args, env) {
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

/** Start a stub that answers every request with `reply({ url })` = { status, headers, body }. */
async function withStub(reply, fn) {
  const hits = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push(req.url);
      const { status = 200, headers = { "content-type": "application/json" }, body = "" } = reply(hits.length);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/v1`, hits);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function runLive(args, baseUrl, extra = {}) {
  const env = mockEnv({ MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "stub-model", NEAR_AI_BASE_URL: baseUrl, ...extra });
  return runAsync(args, env);
}

function assertCleanFailure(r, expectedLine) {
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.ok(!r.stderr.includes(FAKE_KEY), "key must not be printed");
  assert.ok(!/\n\s+at /.test(r.stderr), `no stack trace: ${r.stderr}`);
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.at(-1), expectedLine, r.stderr);
  assert.equal(lines.filter((l) => l.startsWith("infer:")).length, 1);
}

describe("argument parsing corners", () => {
  const SEED_REJECTS = [
    ["plus sign", "+1"],
    ["exponent", "1e3"],
    ["hex", "0x10"],
    ["leading space", " 1"],
    ["empty string", ""],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["negative zero", "-0"],
  ];
  for (const [label, value] of SEED_REJECTS) {
    test(`--seed ${label} (${JSON.stringify(value)}) is rejected with exit 2`, T, () => {
      const r = run(["--seed", value, "hi"]);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, "");
      assert.equal(r.stderr, `infer: --seed must be a non-negative integer, got ${JSON.stringify(value)} (see --help)\n`);
    });
  }

  test("--seed at Number.MAX_SAFE_INTEGER is accepted; one above is rejected", T, () => {
    const ok = run(["--seed", "9007199254740991", "--json", "hi"]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(JSON.parse(ok.stdout).id, /^mock-[0-9a-f]{16}$/);
    const over = run(["--seed", "9007199254740992", "hi"]);
    assert.equal(over.status, 2);
    assert.match(over.stderr, /--seed must be a non-negative integer/);
  });

  test("--seed swallows the next word as its value: a flag there is a seed error, not a flag", T, () => {
    const r = run(["--seed", "--json", "hi"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--seed must be a non-negative integer, got "--json"/);
  });

  test("a repeated --seed or --system: the last one wins", T, () => {
    const last = JSON.parse(run(["--seed", "1", "--seed", "2", "--json", "hi"]).stdout);
    const two = JSON.parse(run(["--seed", "2", "--json", "hi"]).stdout);
    assert.equal(last.id, two.id);
    const sysLast = JSON.parse(run(["--system", "a", "--system", "b", "--json", "hi"]).stdout);
    const sysB = JSON.parse(run(["--system", "b", "--json", "hi"]).stdout);
    assert.equal(sysLast.id, sysB.id);
  });

  test("--json repeated is harmless and flags may follow the prompt", T, () => {
    const r = run(["hi", "--json", "--json", "there"]);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.id, JSON.parse(run(["--json", "hi there"]).stdout).id, "prompt words around the flags are joined");
  });

  test("a bare -- is an unknown flag (exit 2), so a dash-leading prompt cannot be forced with it", T, () => {
    const r = run(["--", "-x"]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "infer: unknown flag -- (see --help)\n");
  });

  test("flag names are case sensitive: --JSON and -H are unknown", T, () => {
    for (const flag of ["--JSON", "-H", "--Help", "--json=true", "--seed=3"]) {
      const r = run([flag, "hi"]);
      assert.equal(r.status, 2, flag);
      assert.equal(r.stderr, `infer: unknown flag ${flag} (see --help)\n`);
    }
  });

  test("the first bad argument is the one reported, and --help after it is never reached", T, () => {
    const r = run(["--bogus", "--seed", "x", "--help"]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "infer: unknown flag --bogus (see --help)\n");
  });

  test("an empty-string argument among words is kept as a double space; an all-empty prompt is refused", T, () => {
    const joined = JSON.parse(run(["--json", "hello", "", "there"]).stdout);
    // "hello  there" (double space) is a different prompt from "hello there": nothing is silently collapsed.
    assert.notEqual(joined.id, JSON.parse(run(["--json", "hello there"]).stdout).id);
    const empty = run(["", ""]);
    assert.equal(empty.status, 2);
    assert.equal(empty.stderr, "infer: a prompt is required (see --help)\n");
  });

  test("non-ASCII, emoji and very long prompts work in mock mode", T, () => {
    const uni = run(["--json", "héllo \u{1F600} 世界"]);
    assert.equal(uni.status, 0, uni.stderr);
    assert.equal(typeof JSON.parse(uni.stdout).content, "string");
    const long = run(["--json", "word ".repeat(20000)]);
    assert.equal(long.status, 0, long.stderr);
    assert.ok(JSON.parse(long.stdout).usage.promptTokens >= 20000);
  });

  test("a prompt of only control whitespace is refused like blank input", T, () => {
    const r = run(["\n\n", " \t "]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "infer: a prompt is required (see --help)\n");
  });
});

describe("environment edge cases", () => {
  for (const [raw, expected] of [["", "mock"], ["TRUE", "mock"], [" 1 ", "mock"]]) {
    test(`MOCK_INFERENCE=${JSON.stringify(raw)} runs in ${expected} mode`, T, () => {
      const r = run(["hi"], { MOCK_INFERENCE: raw });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /^mode: mock model: /);
    });
  }

  test("MOCK_INFERENCE=2 and =yes are coded bad_config errors", T, () => {
    for (const raw of ["2", "yes", "on"]) {
      const r = run(["hi"], { MOCK_INFERENCE: raw });
      assert.equal(r.status, 1, raw);
      assert.equal(r.stderr, `infer: inference error (bad_config): MOCK_INFERENCE must be 1 or 0, got ${JSON.stringify(raw)}\n`);
    }
  });

  test("a bad MOCK_INFERENCE is reported even when the arguments are fine, but bad arguments win first", T, () => {
    const bothBad = run(["--bogus"], { MOCK_INFERENCE: "maybe" });
    assert.equal(bothBad.status, 2);
    assert.match(bothBad.stderr, /unknown flag --bogus/);
  });

  test("live mode with a whitespace-only key is missing_api_key; an empty model is missing_model", T, () => {
    const blankKey = run(["hi"], { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "   ", NEAR_AI_MODEL: "m" });
    assert.equal(blankKey.status, 1);
    assert.equal(blankKey.stderr, "infer: inference error (missing_api_key): live mode needs NEAR_AI_API_KEY\n");
    const blankModel = run(["hi"], { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "" });
    assert.equal(blankModel.status, 1);
    assert.equal(blankModel.stderr, "infer: inference error (missing_model): live mode needs NEAR_AI_MODEL\n");
  });

  test("bad NEAR_AI_BASE_URL values are refused before any request, without echoing them", T, () => {
    const cases = [
      ["not a url", "not a url", /NEAR_AI_BASE_URL must be an absolute http\(s\) URL/],
      ["ftp scheme", "ftp://host.invalid/v1", /NEAR_AI_BASE_URL must be an absolute http\(s\) URL/],
      ["file scheme", "file:///etc/passwd", /NEAR_AI_BASE_URL must be an absolute http\(s\) URL/],
      ["plain http to a remote host", "http://secret-host.invalid/v1", /NEAR_AI_BASE_URL must use https/],
      ["credentials over https", "https://bob:hunter2@host.invalid/v1", /must not contain credentials/],
    ];
    for (const [label, url, pattern] of cases) {
      const r = run(["hi"], { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "openai/gpt-oss-120b", NEAR_AI_BASE_URL: url });
      assert.equal(r.status, 1, label);
      assert.equal(r.stdout, "", label);
      assert.match(r.stderr, pattern, label);
      assert.match(r.stderr, /\(bad_config\)/, label);
      assert.ok(!/secret-host|hunter2|passwd/.test(r.stderr), `${label}: value echoed: ${r.stderr}`);
      assert.ok(!r.stderr.includes("mode:"), `${label}: no mode line before config is valid`);
    }
  });

  test("a non-TEE model in live mode warns on stderr before the mode line; the model is still used", T, () =>
    withStub(() => ({ body: JSON.stringify({ id: "x", choices: [{ message: { content: "ok" } }] }) }), async (baseUrl) => {
      const r = await runLive(["hi"], baseUrl, { NEAR_AI_MODEL: "some/other-model" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "ok\n");
      const [warn, mode] = r.stderr.trimEnd().split("\n");
      assert.match(warn, /^warning: NEAR_AI_MODEL "some\/other-model" is not one of the TEE/);
      assert.equal(mode, "mode: live model: some/other-model");
    }));
});

describe("garbled live responses never crash or leak", () => {
  const CASES = [
    ["malformed JSON", { body: "{not json" }, "infer: inference error (bad_response): NEAR AI Cloud returned a non-JSON body (content-type application/json)"],
    ["empty body", { body: "" }, "infer: inference error (bad_response): NEAR AI Cloud returned a non-JSON body (content-type application/json)"],
    ["HTML error page with 200", { headers: { "content-type": "text/html" }, body: "<html>oops</html>" }, "infer: inference error (bad_response): NEAR AI Cloud returned a non-JSON body (content-type text/html)"],
    ["JSON null", { body: "null" }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["JSON array", { body: "[]" }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["empty object", { body: "{}" }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["empty choices", { body: '{"choices":[]}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["choices not an array", { body: '{"choices":"nope"}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["null message", { body: '{"choices":[{"message":null}]}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["numeric content", { body: '{"choices":[{"message":{"content":42}}]}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["null content (tool call reply)", { body: '{"choices":[{"message":{"content":null,"tool_calls":[{}]}}]}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
    ["whitespace-only content", { body: '{"choices":[{"message":{"content":"  \\n\\t "}}]}' }, "infer: inference error (bad_response): NEAR AI Cloud response has no non-empty choices[0].message.content"],
  ];
  for (const [label, response, line] of CASES) {
    test(`${label}: one coded line, exit 1, nothing on stdout, no retry`, T, () =>
      withStub(() => response, async (baseUrl, hits) => {
        const r = await runLive(["hi"], baseUrl);
        assertCleanFailure(r, line);
        assert.equal(hits.length, 1, "a bad_response is not retryable");
      }));
  }

  test("a provider body echoing the key in an HTTP 400 is redacted and the line is short", T, () =>
    withStub(() => ({ status: 400, body: `{"error":"bad key ${FAKE_KEY} \u001b[2J"}` }), async (baseUrl, hits) => {
      const r = await runLive(["hi"], baseUrl);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.ok(!r.stderr.includes(FAKE_KEY));
      assert.doesNotMatch(r.stderr, UNSAFE);
      assert.match(r.stderr, /infer: inference error \(http_error\): NEAR AI Cloud returned HTTP 400: .*\[redacted\]/);
      assert.equal(hits.length, 1, "4xx other than 408/409/429 is not retried");
    }));

  test("HTTP 503 is retried (3 attempts) and then fails cleanly", T, () =>
    withStub(() => ({ status: 503, headers: { "content-type": "text/plain" }, body: "down" }), async (baseUrl, hits) => {
      const r = await runLive(["hi"], baseUrl);
      assertCleanFailure(r, "infer: inference error (http_error): NEAR AI Cloud returned HTTP 503: down");
      assert.equal(hits.length, 3);
    }));

  test("an HTTP error with an empty body has no trailing colon", T, () =>
    withStub(() => ({ status: 401, body: "" }), async (baseUrl) => {
      const r = await runLive(["hi"], baseUrl);
      assertCleanFailure(r, "infer: inference error (http_error): NEAR AI Cloud returned HTTP 401");
    }));

  test("a response that fails once then succeeds is retried transparently", T, () =>
    withStub((n) => (n === 1
      ? { status: 429, body: "slow down" }
      : { body: JSON.stringify({ id: "r2", choices: [{ message: { content: "second time" } }] }) }), async (baseUrl, hits) => {
      const r = await runLive(["hi"], baseUrl);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "second time\n");
      assert.equal(hits.length, 2);
    }));

  test("the request goes to <base>/chat/completions even with trailing slashes on the base URL", T, () =>
    withStub(() => ({ body: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) }), async (baseUrl, hits) => {
      const r = await runLive(["hi"], `${baseUrl}///`);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(hits, ["/v1/chat/completions"]);
    }));

  test("--json with a hostile model/id in the response: bounded, control characters replaced, key absent", T, () =>
    withStub(() => ({
      body: JSON.stringify({
        id: `\u001b]0;pwn\u0007${"i".repeat(5000)}`,
        model: `‮${"m".repeat(5000)}`,
        choices: [{ message: { content: "fine" } }],
        usage: { prompt_tokens: -5, completion_tokens: "lots" },
      }),
    }), async (baseUrl) => {
      const r = await runLive(["--json", "hi"], baseUrl);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, UNSAFE);
      const body = JSON.parse(r.stdout);
      assert.ok(Buffer.byteLength(body.id) <= 200 && Buffer.byteLength(body.model) <= 200);
      assert.deepEqual(body.usage, { promptTokens: 0, completionTokens: 0 }, "negative or non-numeric usage counts become 0");
      assert.ok(!r.stdout.includes(FAKE_KEY));
    }));

  test("non-string id/model in the response fall back to empty id and the configured model", T, () =>
    withStub(() => ({ body: JSON.stringify({ id: 7, model: { x: 1 }, choices: [{ message: { content: "fine" } }] }) }), async (baseUrl) => {
      const r = await runLive(["--json", "hi"], baseUrl);
      assert.equal(r.status, 0, r.stderr);
      const body = JSON.parse(r.stdout);
      assert.equal(body.id, "");
      assert.equal(body.model, "stub-model");
    }));

  test("a closed port after valid config: coded network error without the key", T, async () => {
    const r = await runLive(["hi"], "http://127.0.0.1:1/v1");
    assertCleanFailure(r, "infer: inference error (network): request to http://127.0.0.1:1/v1/chat/completions failed");
  });
});

describe("terminal safety of what the CLI itself prints", () => {
  test("a reply with CR, tab and LF keeps them; other controls become U+FFFD", T, () =>
    withStub(() => ({ body: JSON.stringify({ choices: [{ message: { content: "a\tb\r\nc\u0000d\u007fe\u0085f" } }] }) }), async (baseUrl) => {
      const r = await runLive(["hi"], baseUrl);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "a\tb\r\nc�d�e�f\n");
    }));

  test("multi-byte reply cut at 32 KiB never ends in a split code point", T, () =>
    withStub(() => ({ body: JSON.stringify({ choices: [{ message: { content: "\u{1F600}".repeat(20000) } }] }) }), async (baseUrl) => {
      const r = await runLive(["hi"], baseUrl);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes("�"), "no replacement characters from a split sequence");
      assert.ok(Buffer.byteLength(r.stdout) <= 32 * 1024 + 1);
      assert.equal([...r.stdout.trimEnd()].every((c) => c === "\u{1F600}"), true);
    }));
});
