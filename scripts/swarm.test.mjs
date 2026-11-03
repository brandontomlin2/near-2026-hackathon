import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));

function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SWARM_ROUNDS;
  return env;
}

test("CLI prints a verified transcript, the same on every run, with live env set", async () => {
  // Live inference is set on purpose: sim mode must ignore it.
  const env = cliEnv({ MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "test-key-not-a-real-credential", NEAR_AI_MODEL: "test/model" });
  const first = await run(process.execPath, [script, "--rounds", "2"], { env });
  const second = await run(process.execPath, [script, "--rounds", "2"], { env });
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /verify: ok \(2 rounds\)/);
  assert.match(first.stderr, /mode: sim \(mock inference, offline\)/);
  assert.equal(first.stdout.split("\n").filter((l) => /^r\d+ /.test(l)).length, 2 * 4);
});

test("CLI --json prints the full run with its round chain", async () => {
  const { stdout } = await run(process.execPath, [script, "--rounds", "3", "--json"], { env: cliEnv() });
  const result = JSON.parse(stdout);
  assert.equal(result.rounds.length, 3);
  assert.equal(typeof result.headHash, "string");
  assert.equal(Object.keys(result.logs).length, 4);
});

test("CLI rejects a bad round count with exit status 2", async () => {
  await assert.rejects(
    run(process.execPath, [script, "--rounds", "0"], { env: cliEnv() }),
    (err) => err.code === 2 && /rounds must be a positive integer/.test(err.stderr),
  );
});

test("CLI rejects unknown flags with exit status 2", async () => {
  await assert.rejects(
    run(process.execPath, [script, "--wallet", "x"], { env: cliEnv() }),
    (err) => err.code === 2 && /unknown argument --wallet/.test(err.stderr),
  );
});
