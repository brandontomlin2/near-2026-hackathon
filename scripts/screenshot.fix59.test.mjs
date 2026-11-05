import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "./screenshot.mjs";

for (const force of [false, true]) {
  test(`screenshot${force ? " --force" : ""}: a dangling symlink at --out is refused, target not created`, () => {
    const dir = mkdtempSync(join(tmpdir(), "screenshot-fix59-"));
    try {
      const target = join(dir, "elsewhere.png");
      const out = join(dir, "page.png");
      symlinkSync(target, out);
      const errs = [];
      const code = run({ candidates: ["/fake/browser"], exists: (p) => p === "/fake/browser", out, force, log: () => {}, err: (m) => errs.push(m) });
      assert.equal(code, 1);
      assert.equal(errs.length, 1);
      assert.equal(errs[0].split("\n").length, 1, errs[0]);
      assert.match(errs[0], /symbolic link/);
      assert.equal(existsSync(target), false, "link target must not be created");
      assert.ok(lstatSync(out).isSymbolicLink());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
