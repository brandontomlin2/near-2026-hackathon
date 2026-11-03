// Live mode (MOCK_INFERENCE=0) against a local stub: the API key must not appear in stdout,
// stderr or any file written under the run's out dir. No real service is contacted.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));
const KEY = "stub-key-not-real-9f8e7d6c5b4a";

async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out;
}

test("live swarm run against the stub: the API key is in no out/ file, stdout or stderr", async () => {
  let authSeen = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers.authorization === `Bearer ${KEY}`) authSeen += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", model: "stub/m", choices: [{ index: 0, message: { role: "assistant", content: "stub reply" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "swarm-live-out-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: KEY, NEAR_AI_MODEL: "stub/m", NEAR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
    const { stdout, stderr } = await run(process.execPath, [script, "--rounds", "1", "--out", dir], { env });
    assert.ok(authSeen > 0, "the live path really ran: the stub saw the bearer key");
    const files = await filesUnder(dir);
    assert.ok(files.length > 0, "the run wrote files");
    for (const file of files) assert.ok(!(await readFile(file, "utf8")).includes(KEY), `key found in ${file}`);
    assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), "key found in stdout or stderr");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
