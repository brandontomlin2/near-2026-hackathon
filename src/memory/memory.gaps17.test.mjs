// Gaps17: failure paths of npm run swarm (memory loop + swarm rounds) that a user can hit
// and that no earlier test asserts: an unwritable --out, and a live inference error mid-run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/swarm.mjs", import.meta.url));
const noNetwork = fileURLToPath(new URL("../../scripts/test-helpers/no-network.mjs", import.meta.url));
const KEY = "stub-key-gaps17-3c2b1a09";

function swarm(args, env, preload) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...(preload ? ["--import", noNetwork] : []), script, ...args],
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

test("npm run swarm with an --out that sits under a regular file exits 1 with one 'cannot write' line naming the path, no stack and no transcript on stdout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-gaps17-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "afile"), "x");
  const out = join(dir, "afile", "sub");
  const r = await swarm(["--rounds", "1", "--out", out], { MOCK_INFERENCE: "1" }, true);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "", "nothing is reported as done when nothing was written");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.ok(lines[0].startsWith(`swarm: cannot write to ${JSON.stringify(out)}: `), lines[0]);
  assert.match(lines[0], /ENOTDIR|EEXIST/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("a live inference error (HTTP 401) stops npm run swarm with exit 1, one 'swarm: ... HTTP 401' line, the key nowhere, and no output directory created", async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "swarm-gaps17-"));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const out = join(dir, "run");
  const r = await swarm(["--rounds", "1", "--out", out], {
    MOCK_INFERENCE: "0",
    NEAR_AI_API_KEY: KEY,
    NEAR_AI_MODEL: "openai/gpt-oss-120b",
    NEAR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  }, false);
  assert.ok(hits >= 1, "the live path really ran");
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "", "no transcript is printed for a run that failed");
  const lines = r.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^swarm: NEAR AI Cloud returned HTTP 401/);
  assert.ok(!r.stderr.includes(KEY));
  assert.equal(existsSync(out), false, "a failed run leaves no half-written output directory");
});
