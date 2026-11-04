import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const run = (args, env = {}) =>
  spawnSync(process.execPath, ["scripts/viewer.mjs", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const withDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "viewer-hard31-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("viewer: a flag followed by another flag says what it got", () => {
  const r = run(["--out", "--force"]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'viewer: --out needs a value, got "--force" (see --help)');
});

test("viewer: --input of an empty, null, array or non-swarm JSON file is one usage line and writes nothing", () => {
  withDir((dir) => {
    const out = join(dir, "page.html");
    for (const [body, want] of [
      ["", /is not JSON/],
      ["null", /must be an object/],
      ["[]", /must be an object/],
      ["{}", /events must be an array/],
    ]) {
      const input = join(dir, "in.json");
      writeFileSync(input, body);
      const r = run(["--input", input, "--out", out]);
      assert.equal(r.status, 2, body);
      assert.equal(r.stdout, "");
      assert.match(r.stderr.trim(), want);
      assert.equal(r.stderr.trim().split("\n").length, 1);
      assert.ok(r.stderr.trim().endsWith("(see --help)"));
      assert.equal(existsSync(out), false, "no page is written for a bad input");
    }
  });
});

test("viewer: --input that is a directory or missing exits 2 naming the flag", () => {
  withDir((dir) => {
    for (const input of [dir, join(dir, "nope.json")]) {
      const r = run(["--input", input]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /^viewer: cannot read --input /);
    }
  });
});

test("viewer: a bad SWARM_ROUNDS is ignored when --input is given, and --rounds beats it", () => {
  withDir((dir) => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{}");
    // With --input the env is never read: the error is about the file, not rounds.
    const r = run(["--input", bad], { SWARM_ROUNDS: "abc" });
    assert.match(r.stderr, /events must be an array/);
    assert.doesNotMatch(r.stderr, /rounds/);
    // Without --input a bad env value is a usage error before anything runs.
    const r2 = run(["--out", join(dir, "x.html")], { SWARM_ROUNDS: "abc" });
    assert.equal(r2.status, 2);
    assert.match(r2.stderr, /rounds must be a positive integer, got "abc"/);
  });
});

test("viewer: --out under a regular file is a write failure (exit 1) naming the path, no stack", () => {
  withDir((dir) => {
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    const r = run(["--out", join(file, "x.html"), "--rounds", "1"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr.trim(), /^viewer: cannot write .*afile.*x\.html/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });
});
