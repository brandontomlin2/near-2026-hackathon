import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./live-proof.mjs", import.meta.url));

function proof(out) {
  return spawnSync(process.execPath, [script, "--out", out], { encoding: "utf8" });
}

test("live-proof: --out under a file is one plain line, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-proof-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    const r = proof(join(file, "x.json"));
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /EEXIST|ENOTDIR|EISDIR/);
    assert.match(r.stderr, /is a file, not a directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("live-proof: --out at a directory (with spaces) names the problem without a raw error", () => {
  const dir = mkdtempSync(join(tmpdir(), "live proof op27-"));
  try {
    const r = proof(dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /EEXIST|ENOTDIR|EISDIR|illegal operation/);
    assert.match(r.stderr, /is a directory/);
    assert.match(r.stderr, /--help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
