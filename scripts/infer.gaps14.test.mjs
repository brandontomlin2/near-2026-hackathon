// CLI behaviour gaps for scripts/infer.mjs: argument validation, exit codes,
// help, trimming, and live-config failures. Mock mode only; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./infer.mjs", import.meta.url));

function run(args, envExtra = {}) {
  const env = { ...process.env, MOCK_INFERENCE: "1", ...envExtra };
  for (const [k, v] of Object.entries(envExtra)) if (v === undefined) delete env[k];
  if (!("NEAR_AI_API_KEY" in envExtra)) delete env.NEAR_AI_API_KEY;
  if (!("NEAR_AI_MODEL" in envExtra)) delete env.NEAR_AI_MODEL;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

const BAD_ARGS = [
  ["--seed with no value", ["--seed"], /^infer: --seed must be a non-negative integer, got undefined \(see --help\)\n$/],
  ["--seed negative", ["--seed", "-1", "hi"], /--seed must be a non-negative integer, got "-1"/],
  ["--seed leading zero", ["--seed", "01", "hi"], /--seed must be a non-negative integer, got "01"/],
  ["--seed fractional", ["--seed", "1.5", "hi"], /--seed must be a non-negative integer, got "1.5"/],
  ["--seed beyond the safe integer range", ["--seed", "9007199254740993", "hi"], /--seed must be a non-negative integer/],
  ["--seed not a number", ["--seed", "abc", "hi"], /--seed must be a non-negative integer, got "abc"/],
  ["--system with no value", ["--system"], /^infer: --system needs a non-empty value, got undefined \(see --help\)\n$/],
  ["--system blank", ["--system", "   ", "hi"], /--system needs a non-empty value, got "   "/],
  ["--system followed by a flag", ["--system", "--json", "hi"], /--system needs a non-empty value, got "--json"/],
  ["unknown long flag", ["--bogus", "hi"], /^infer: unknown flag --bogus \(see --help\)\n$/],
  ["unknown short flag", ["-x", "hi"], /^infer: unknown flag -x \(see --help\)\n$/],
  ["no prompt", [], /^infer: a prompt is required \(see --help\)\n$/],
  ["only flags, no prompt", ["--json"], /^infer: a prompt is required \(see --help\)\n$/],
  ["whitespace-only prompt", ["   ", "\t"], /^infer: a prompt is required \(see --help\)\n$/],
];
for (const [label, args, expected] of BAD_ARGS) {
  test(`bad argument (${label}): one stderr line, exit 2, nothing on stdout`, () => {
    const r = run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, expected);
    assert.equal(r.stderr.trimEnd().split("\n").length, 1, "no stack trace");
  });
}

test("--help and -h print the usage to stdout and exit 0, with no mode line; help beats a following bad argument", () => {
  for (const flag of ["--help", "-h"]) {
    const r = run([flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: node scripts\/infer\.mjs \[--system TEXT\] \[--seed N\] \[--json\] <prompt>\n/);
    assert.equal(r.stderr, "");
  }
  const r = run(["--help", "--seed", "bad"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage:/);
});

test("a bare dash and a negative number are prompt words, not flags", () => {
  const dash = run(["--json", "-"]);
  assert.equal(dash.status, 0, dash.stderr);
  const neg = run(["--json", "-5"]);
  assert.equal(neg.status, 0, neg.stderr);
  assert.notEqual(JSON.parse(dash.stdout).id, JSON.parse(neg.stdout).id, "the dash and the number reach the model as different prompts");
});

test("the prompt is trimmed: padding does not change the reply or id", () => {
  const padded = JSON.parse(run(["--json", "  hello there \n"]).stdout);
  const plain = JSON.parse(run(["--json", "hello there"]).stdout);
  assert.deepEqual(padded, plain);
});

test("--json output is pretty-printed JSON with the documented fields and usage", () => {
  const r = run(["--json", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("{\n  \""), "two-space indented");
  assert.ok(r.stdout.endsWith("}\n"));
  const body = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(body).sort(), ["content", "id", "mode", "model", "usage"]);
  assert.deepEqual(Object.keys(body.usage).sort(), ["completionTokens", "promptTokens"]);
});

test("NEAR_AI_MODEL in mock mode shows in the mode line and the reply model", () => {
  const r = run(["--json", "hello"], { NEAR_AI_MODEL: "my-model" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "mode: mock model: my-model\n");
  assert.equal(JSON.parse(r.stdout).model, "my-model");
});

test("live mode without a key or model: exit 1, one coded line, no mode line, nothing on stdout", () => {
  const noKey = run(["hello"], { MOCK_INFERENCE: "0", NEAR_AI_MODEL: "m" });
  assert.equal(noKey.status, 1);
  assert.equal(noKey.stdout, "");
  assert.equal(noKey.stderr, "infer: inference error (missing_api_key): live mode needs NEAR_AI_API_KEY\n");

  const noModel = run(["hello"], { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "test-fake-key-gaps14-do-not-print" });
  assert.equal(noModel.status, 1);
  assert.equal(noModel.stderr, "infer: inference error (missing_model): live mode needs NEAR_AI_MODEL\n");
  assert.ok(!noModel.stderr.includes("test-fake-key-gaps14-do-not-print") && !noModel.stdout.includes("test-fake-key-gaps14-do-not-print"));
});

test("an invalid MOCK_INFERENCE is a coded bad_config error with exit 1, not a silent mock run", () => {
  const r = run(["hello"], { MOCK_INFERENCE: "maybe" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^infer: inference error \(bad_config\): MOCK_INFERENCE must be 1 or 0, got "maybe"\n$/);
});

test("live mode against a refused connection: coded network error, exit 1, the key never printed", () => {
  const r = run(["hello"], {
    MOCK_INFERENCE: "0",
    NEAR_AI_API_KEY: "test-fake-key-gaps14-do-not-print",
    NEAR_AI_MODEL: "m",
    NEAR_AI_BASE_URL: "http://127.0.0.1:1/v1",
  });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^mode: live model: m\ninfer: inference error \(network\): request to http:\/\/127\.0\.0\.1:1\/v1\/chat\/completions failed\n$/);
  assert.ok(!r.stderr.includes("test-fake-key-gaps14-do-not-print"));
});
