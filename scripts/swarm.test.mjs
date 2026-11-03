import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));

test("CLI prints a verified transcript, byte-identical on every run, with no keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    const args = [script, "--rounds", "3", "--out", dir];
    const first = await run(process.execPath, args, { env });
    const transcript = await readFile(join(dir, "transcript.txt"), "utf8");
    const second = await run(process.execPath, args, { env });
    assert.equal(first.stdout, second.stdout);
    assert.equal(transcript, await readFile(join(dir, "transcript.txt"), "utf8"));
    assert.match(first.stdout, /verify: ok \(3 rounds\)/);
    assert.equal(first.stdout.split("\n").filter((l) => /^\[/.test(l)).length, 3 * 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live mode without a key fails instead of falling back to the mock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "0" };
    delete env.NEAR_AI_API_KEY;
    await assert.rejects(
      run(process.execPath, [script, "--rounds", "1", "--out", dir], { env }),
      (err) => err.code === 1 && /^swarm: /.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects unknown flags with exit status 2", async () => {
  await assert.rejects(
    run(process.execPath, [script, "--wallet", "x"]),
    (err) => err.code === 2 && /unknown argument "--wallet"/.test(err.stderr),
  );
});
