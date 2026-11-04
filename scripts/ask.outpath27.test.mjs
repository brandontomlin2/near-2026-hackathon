import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./ask.mjs", import.meta.url));

test("ask: --out at a file says so in one line, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "ask-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    const r = spawnSync(process.execPath, [script, "--out", file, "aloof", "hi"], { env, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, /is a file, not a directory/);
    assert.match(r.stderr, /--help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
