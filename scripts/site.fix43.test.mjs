import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("./site.mjs", import.meta.url));

describe("site.mjs DIR validation (fix43)", () => {
  let cwd;
  before(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "site-fix43-"));
  });
  after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const run = (dir) => spawnSync(process.execPath, [SITE, dir], { cwd, encoding: "utf8", timeout: 120000 });

  it("rejects empty DIR with exit 2", () => {
    const r = run("");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /output directory must not be empty/);
  });

  for (const ws of ["   ", "\t", " \n "]) {
    it(`rejects whitespace-only DIR ${JSON.stringify(ws)} like empty, creating nothing`, () => {
      const empty = run("");
      const r = run(ws);
      assert.equal(r.status, empty.status);
      assert.match(r.stderr, /output directory must not be empty/);
      assert.deepEqual(fs.readdirSync(cwd), []);
    });
  }

  it("still accepts a DIR with a space inside", () => {
    const r = run("a b");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(path.join(cwd, "a b", "index.html")).isFile());
  });
});
