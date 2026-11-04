import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args, cwd) => spawnSync(process.execPath, [path.join(root, "scripts", `${script}.mjs`), ...args], { encoding: "utf8", cwd });

describe("demo --out edge cases", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo out paths-"));
    fs.writeFileSync(path.join(dir, "afile"), "hi\n");
    fs.symlinkSync("afile", path.join(dir, "link-to-file"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a parent that is a file gives the one clear line and leaves the file alone", () => {
    const r = run("demo", ["--out", "afile/sub/deeper"], dir);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.match(r.stderr, /^demo: cannot write to "afile\/sub\/deeper": .*is a file, not a directory/);
    assert.doesNotMatch(r.stderr, /ENOTDIR|\n\s+at /);
    assert.equal(fs.readFileSync(path.join(dir, "afile"), "utf8"), "hi\n");
  });

  it("a symlink to a file is refused the same way", () => {
    const r = run("demo", ["--out", "link-to-file"], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^demo: cannot write to "link-to-file": .*is a file, not a directory/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
  });

  it("a missing nested directory with spaces in the name is created and the page link is quoted", () => {
    const r = run("demo", ["--out", "new dir/with space", "--rounds", "3"], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, "new dir", "with space", "index.html")));
    const last = r.stdout.trim().split("\n").pop();
    assert.match(last, /^Open the page: open "new dir\/with space\/index\.html"  \(file:\/\/\/.*new%20dir\/with%20space\/index\.html\)$/);
  });

  it("an existing empty directory is accepted and rerunning it is idempotent", () => {
    fs.mkdirSync(path.join(dir, "empty"));
    const a = run("demo", ["--out", "empty", "--rounds", "3"], dir);
    const b = run("demo", ["--out", "empty", "--rounds", "3"], dir);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, b.stdout);
  });

  it("an absolute --out works from an unrelated cwd", () => {
    const out = path.join(dir, "abs out");
    const r = run("demo", ["--out", out, "--rounds", "3"], os.tmpdir());
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, "index.html")));
  });

  it("--out with a missing or empty value is a usage error (exit 2), not a path error", () => {
    for (const args of [["--out"], ["--out", ""], ["--out", "--rounds"]]) {
      const r = run("demo", args, dir);
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /^demo: --out needs a directory/);
    }
  });
});
