import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "readme-asset.mjs");

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 120000 });
}

test("readme-asset --force: a directory at chaotic-sheet.txt is refused before anything is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "readme-asset-fix59-"));
  try {
    mkdirSync(join(dir, "chaotic-sheet.txt"));
    const r = cli(["--out", dir, "--force"]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /is a directory/);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.equal(existsSync(join(dir, "chaotic-share.svg")), false, "no partial write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const force of [false, true]) {
  test(`readme-asset${force ? " --force" : ""}: a dangling symlink at chaotic-share.svg is refused, target not created`, () => {
    const dir = mkdtempSync(join(tmpdir(), "readme-asset-fix59-"));
    try {
      const target = join(dir, "elsewhere.svg");
      const link = join(dir, "chaotic-share.svg");
      symlinkSync(target, link);
      const r = cli(["--out", dir, ...(force ? ["--force"] : [])]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /symbolic link/);
      assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
      assert.equal(existsSync(target), false, "link target must not be created");
      assert.equal(existsSync(join(dir, "chaotic-sheet.txt")), false, "nothing written");
      assert.ok(lstatSync(link).isSymbolicLink());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
