import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
