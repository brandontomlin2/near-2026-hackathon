import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./evidence.mjs", import.meta.url));

test("evidence: EVIDENCE_OUT under a file is one plain line, exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    const env = { ...process.env, EVIDENCE_OUT: join(file, "evidence.json") };
    delete env.EVIDENCE_NETWORK;
    const r = spawnSync(process.execPath, [script], { env, encoding: "utf8", cwd: dir });
    assert.equal(r.status, 1);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /EEXIST|ENOTDIR|EISDIR/);
    assert.match(r.stderr, /a file is in the way/);
    assert.match(r.stderr, /EVIDENCE_OUT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
