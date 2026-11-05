import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));

test("--out with only whitespace is refused, not written to a directory named ' ' in the cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "swarm63-ws-"));
  try {
    for (const out of [" ", "   ", "\t"]) {
      const r = spawnSync(process.execPath, [script, "--rounds", "1", "--out", out], {
        cwd,
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, MOCK_INFERENCE: "1" },
      });
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stderr, `swarm: --out needs a directory, got ${JSON.stringify(out)} (see --help)\n`);
      assert.equal(r.stdout, "");
    }
    assert.deepEqual(await readdir(cwd), [], "nothing may be created in the cwd");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
