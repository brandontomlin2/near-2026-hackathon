import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "./screenshot.mjs";

test("screenshot: --out under a file is one plain line, exit 1 (no browser is launched)", () => {
  const dir = mkdtempSync(join(tmpdir(), "screenshot-op27-"));
  try {
    const file = join(dir, "file.txt");
    writeFileSync(file, "keep me");
    const errs = [];
    // A stand-in browser path that "exists"; the run fails on the output path before it is ever started.
    const code = run({ candidates: ["/fake/browser"], exists: (p) => p === "/fake/browser" || p === file, out: join(file, "page.png"), log: () => {}, err: (m) => errs.push(m) });
    assert.equal(code, 1);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].split("\n").length, 1, errs[0]);
    assert.doesNotMatch(errs[0], /EEXIST|ENOTDIR|EISDIR/);
    assert.match(errs[0], /a file is in the way/);
    assert.match(errs[0], /--help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
