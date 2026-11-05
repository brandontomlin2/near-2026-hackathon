// Edge-case tests for `npm run site` (scripts/site.mjs), asserting what a user sees:
// stdout/stderr, exit codes and files on disk. Every run is a child process with a
// scratch cwd, mock mode on and no keys.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "site.mjs");

function run(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, MOCK_INFERENCE: "1", ...env },
  });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

describe("site CLI edge cases", () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-edge40b-")); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fresh = () => fs.mkdtempSync(path.join(tmp, "case-"));

  it("--help and -h print usage with the default dir, exit 0, and write nothing", () => {
    for (const flag of ["--help", "-h"]) {
      const cwd = fresh();
      const r = run([flag], { cwd });
      assert.equal(r.status, 0, flag);
      assert.match(r.out, /^Usage: node scripts\/site\.mjs \[DIR\]/);
      assert.match(r.out, /default out\/site/);
      assert.equal(r.err, "");
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
  });

  it("--help wins over an unknown flag or extra arguments", () => {
    for (const args of [["--bogus", "--help"], ["a", "b", "-h"]]) {
      const cwd = fresh();
      const r = run(args, { cwd });
      assert.equal(r.status, 0, args.join(" "));
      assert.match(r.out, /^Usage:/);
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
  });

  it("an unknown flag exits 2, names the flag, points at --help, builds nothing", () => {
    for (const bad of ["--bogus", "-x", "--", "--out=foo"]) {
      const cwd = fresh();
      const r = run([bad], { cwd });
      assert.equal(r.status, 2, bad);
      assert.match(r.err, /^site: unknown argument /);
      assert.ok(r.err.includes(JSON.stringify(bad)), r.err);
      assert.match(r.err, /see --help/);
      assert.equal(r.out, "");
      assert.doesNotMatch(r.err, /undefined|\n\s+at /);
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
  });

  it("two directories exit 2 with the count and build nothing", () => {
    const cwd = fresh();
    const r = run(["one", "two"], { cwd });
    assert.equal(r.status, 2);
    assert.match(r.err, /expected one output directory, got 2 arguments/);
    assert.equal(r.out, "");
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("an empty directory name exits 2 and builds nothing", () => {
    for (const bad of [""]) {
      const cwd = fresh();
      const r = run([bad], { cwd });
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.match(r.err, /output directory must not be empty/);
      assert.doesNotMatch(r.out, /Site ready/);
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
  });

  it("no argument builds out/site under the cwd and prints the README ready line", () => {
    const cwd = fresh();
    const r = run([], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.statSync(path.join(cwd, "out", "site", "index.html")).isFile());
    assert.equal(r.out.trimEnd().split("\n").at(-1),
      "Site ready: out/site/index.html (open it, or upload the folder to a static host; see docs/hosting.md)");
  });

  it("a directory name with spaces works and the ready line shows it unmangled", () => {
    const cwd = fresh();
    const r = run(["my site"], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.statSync(path.join(cwd, "my site", "index.html")).isFile());
    assert.match(r.out, /\nSite ready: my site\/index\.html /);
  });

  it("rebuilding into an existing, populated folder succeeds with identical index.html", () => {
    const cwd = fresh();
    const dir = path.join(cwd, "s");
    assert.equal(run([dir], { cwd }).status, 0);
    const first = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    const r = run([dir], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(path.join(dir, "index.html"), "utf8"), first);
  });

  it("a path that is a file exits 1 with a clear message and no ready line", () => {
    const cwd = fresh();
    const file = path.join(cwd, "afile");
    fs.writeFileSync(file, "keep me");
    for (const target of [file, path.join(file, "sub")]) {
      const r = run([target], { cwd });
      assert.equal(r.status, 1, target);
      assert.match(r.err, /is a file, not a directory/);
      assert.doesNotMatch(r.out + r.err, /Site ready|\n\s+at /);
    }
    assert.equal(fs.readFileSync(file, "utf8"), "keep me");
  });

  it("an unwritable parent exits 1, names the problem, prints no ready line", { skip: process.getuid?.() === 0 }, () => {
    const cwd = fresh();
    const ro = path.join(cwd, "ro");
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    try {
      const r = run([path.join(ro, "site")], { cwd });
      assert.equal(r.status, 1);
      assert.match(r.err, /EACCES|permission denied/i);
      assert.doesNotMatch(r.out, /Site ready/);
      assert.doesNotMatch(r.err, /\n\s+at /);
      assert.deepEqual(fs.readdirSync(ro), []);
    } finally {
      fs.chmodSync(ro, 0o755);
    }
  });

  it("refuses to run outside mock mode and builds nothing", () => {
    const cwd = fresh();
    const r = run(["s"], { cwd, env: { MOCK_INFERENCE: "0" } });
    assert.notEqual(r.status, 0);
    assert.match(r.err, /mock mode only/);
    assert.doesNotMatch(r.out, /Site ready/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});
