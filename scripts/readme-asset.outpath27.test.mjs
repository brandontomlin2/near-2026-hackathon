import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./readme-asset.mjs", import.meta.url));

for (const [name, sub] of [["at a file", ""], ["under a file", "sub"]]) {
  test(`readme-asset: --out ${name} is one plain line, exit 1`, () => {
    const dir = mkdtempSync(join(tmpdir(), "readme-asset-op27-"));
    try {
      const file = join(dir, "file.txt");
      writeFileSync(file, "keep me");
      const r = spawnSync(process.execPath, [script, "--out", sub ? join(file, sub) : file], { encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
      assert.doesNotMatch(r.stderr, /EEXIST|ENOTDIR|EISDIR/);
      assert.match(r.stderr, /is a file, not a directory/);
      assert.match(r.stderr, /--help/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
