import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("demo and site when the output path is a file", () => {
  let dir;
  let file;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "out is file-"));
    file = path.join(dir, "not-a-dir.txt");
    fs.writeFileSync(file, "hi\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const [script, args] of [["demo", ["--out"]], ["site", []]]) {
    it(`${script} prints one clear line, no raw errno text, and exits non-zero`, () => {
      const r = spawnSync(process.execPath, [path.join(root, "scripts", `${script}.mjs`), ...args, file], { encoding: "utf8", cwd: dir });
      assert.notEqual(r.status, 0);
      const lines = r.stderr.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.match(lines[0], new RegExp(`^${script}: cannot write to .*is a file, not a directory\\. Pass a directory path`));
      assert.doesNotMatch(r.stderr, /ENOTDIR|lstat|\n\s+at /);
      assert.equal(fs.readFileSync(file, "utf8"), "hi\n");
    });
  }
});
