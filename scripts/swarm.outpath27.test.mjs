import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));
const env = { ...process.env, MOCK_INFERENCE: "1" };
delete env.NEAR_AI_API_KEY;

function swarm(out) {
  return spawnSync(process.execPath, [script, "--rounds", "1", "--out", out], { env, encoding: "utf8" });
}

function assertOneLine(r) {
  assert.equal(r.status, 1);
  const lines = r.stderr.trim().split("\n");
  assert.equal(lines.length, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /EEXIST|ENOTDIR|EISDIR|\n\s+at /);
  assert.match(r.stderr, /is a file, not a directory/);
  assert.match(r.stderr, /--help/);
}

test("swarm: --out at an existing file is one plain line, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    assertOneLine(swarm(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swarm: --out under a file is one plain line, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    assertOneLine(swarm(join(file, "sub")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("swarm: --out in a directory with spaces still works", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-op27-"));
  try {
    const out = join(dir, "with space", "run");
    mkdirSync(join(dir, "with space"));
    const r = swarm(out);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(out, "events.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
