// Edge-case pass 40 for scripts/viewer.mjs: what a judge sees when they feed the
// viewer bad flags, empty or malformed input files and unwritable output paths,
// and that the demo's own events.json renders. Every run happens in a fresh temp
// dir, offline, with fake env only. Complements viewer.gaps14 / errors19 / outpath27.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./viewer.mjs", import.meta.url));
const DEMO = fileURLToPath(new URL("./demo.mjs", import.meta.url));

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "viewer-edge40-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args, envExtra = {}) {
  const env = { ...process.env, MOCK_INFERENCE: "1", ...envExtra };
  delete env.NEAR_AI_API_KEY;
  delete env.SWARM_ROUNDS;
  Object.assign(env, envExtra);
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env });
}

function assertOneLineUsageError(r, expected) {
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `viewer: ${expected} (see --help)\n`);
}

test("--help prints every flag, exits 0, writes nothing", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--help"]);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^usage: node scripts\/viewer\.mjs /);
    for (const flag of ["--input", "--rounds", "--out", "--force"]) assert.ok(r.stdout.includes(flag), flag);
    assert.match(r.stdout, /default out\/viewer\/index\.html/);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("-h works and wins over a bad argument", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--bogus", "-h"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage: /);
    assert.equal(r.stderr, "");
  });
});

test("a stray positional argument is refused with exit 2 and nothing written", () => {
  inTempDir((dir) => {
    assertOneLineUsageError(run(dir, ["page.html"]), 'unknown argument "page.html"');
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("bad --rounds values are named in one line; no page is written", () => {
  inTempDir((dir) => {
    for (const [value, message] of [
      ["0", 'rounds must be a positive integer, got "0"'],
      ["-1", 'rounds must be a positive integer, got "-1"'],
      ["1.5", 'rounds must be a positive integer, got "1.5"'],
      ["abc", 'rounds must be a positive integer, got "abc"'],
      ["1001", "rounds must be at most 1000, got 1001"],
    ]) {
      // "-1" looks like a flag only if it starts with "--", so it reaches the rounds check.
      assertOneLineUsageError(run(dir, ["--rounds", value, "--out", "p.html"]), message);
    }
    assert.deepEqual(readdirSync(dir), []);
  });
});

test("--rounds as the last argument says it needs a value", () => {
  inTempDir((dir) => assertOneLineUsageError(run(dir, ["--rounds"]), "--rounds needs a value"));
});

test("SWARM_ROUNDS=abc without --input is refused naming the value", () => {
  inTempDir((dir) => {
    assertOneLineUsageError(run(dir, ["--out", "p.html"], { SWARM_ROUNDS: "abc" }), 'rounds must be a positive integer, got "abc"');
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("SWARM_ROUNDS=2 is honoured when --rounds is absent", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--out", "p.html"], { SWARM_ROUNDS: "2" });
    assert.equal(r.status, 0, r.stderr);
    const page = readFileSync(join(dir, "p.html"), "utf8");
    assert.match(page, /2 rounds/);
    assert.doesNotMatch(page, /Round 3</);
  });
});

test("--out \"\" is refused", () => {
  inTempDir((dir) => assertOneLineUsageError(run(dir, ["--out", ""]), '--out must not be empty, got ""'));
});

test("--input together with --rounds is refused and explains why", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "in.json"), "{}");
    assertOneLineUsageError(
      run(dir, ["--input", "in.json", "--rounds", "2"]),
      "--rounds cannot be combined with --input (the file already holds its rounds)",
    );
  });
});

test("--input of an empty file: exit 2, names the flag and file, no page", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "empty.json"), "");
    const r = run(dir, ["--input", "empty.json", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: --input empty\.json is not JSON: .+ \(see --help\)\n$/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("--input of truncated JSON: exit 2, not JSON, no page", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "cut.json"), '{"events":[{"round":1');
    const r = run(dir, ["--input", "cut.json", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: --input cut\.json is not JSON: /);
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("--input of a missing file: exit 2, names the flag and file", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--input", "nope.json", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: cannot read --input nope\.json: ENOENT/);
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("--input that is a directory: exit 2, names the flag and path", () => {
  inTempDir((dir) => {
    mkdirSync(join(dir, "adir"));
    const r = run(dir, ["--input", "adir", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: cannot read --input adir: /);
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("--input of an empty object is an invalid swarm result, exit 2", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "in.json"), "{}");
    const r = run(dir, ["--input", "in.json", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: --input in\.json: invalid swarm result: .+ \(see --help\)\n$/);
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("the demo's own out/events.json renders: 'wrote <path>' and a page with the same rounds", () => {
  inTempDir((dir) => {
    const demo = spawnSync(process.execPath, [DEMO, "--rounds", "3", "--out", join(dir, "demo")], {
      cwd: dir, encoding: "utf8", env: { ...process.env, MOCK_INFERENCE: "1" },
    });
    assert.equal(demo.status, 0, demo.stderr);
    const r = run(dir, ["--input", "demo/events.json", "--out", "v.html"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^wrote .+\/v\.html\n$/);
    const page = readFileSync(join(dir, "v.html"), "utf8");
    assert.ok(page.startsWith("<!doctype html>"));
    assert.match(page, /3 rounds/);
    assert.match(page, /chain: ok/);
    assert.doesNotMatch(page, /<script/i);
  });
});

test("a foreign --out file is refused, then --force replaces it with a page", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "notes.html"), "<p>mine</p>");
    const refused = run(dir, ["--rounds", "1", "--out", "notes.html"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /pass --force to replace it/);
    assert.equal(readFileSync(join(dir, "notes.html"), "utf8"), "<p>mine</p>");
    const forced = run(dir, ["--rounds", "1", "--out", "notes.html", "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(readFileSync(join(dir, "notes.html"), "utf8").startsWith("<!doctype html>"));
  });
});

test("re-running over its own earlier page needs no --force", () => {
  inTempDir((dir) => {
    assert.equal(run(dir, ["--rounds", "1", "--out", "p.html"]).status, 0);
    const again = run(dir, ["--rounds", "2", "--out", "p.html"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(readFileSync(join(dir, "p.html"), "utf8"), /2 rounds/);
  });
});

test("an unwritable output directory: exit 1, one line saying cannot write <path>, no stack trace", { skip: process.getuid?.() === 0 }, () => {
  inTempDir((dir) => {
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      const r = run(dir, ["--rounds", "1", "--out", "ro/sub/p.html"]);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^viewer: cannot write ro\/sub\/p\.html: /);
      assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
      assert.doesNotMatch(r.stderr, /\n\s+at /);
    } finally {
      chmodSync(ro, 0o755);
    }
  });
});
