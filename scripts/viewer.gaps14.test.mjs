// CLI behaviour gaps for scripts/viewer.mjs: output location, --rounds, --input
// handling and the refusal rules around --out. Every run happens in a fresh
// temp dir; nothing is written into the repo. Offline swarm only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSwarm } from "../src/swarm/runner.mjs";

const SCRIPT = fileURLToPath(new URL("./viewer.mjs", import.meta.url));

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "viewer-gaps14-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir, args, envExtra = {}) {
  const env = { ...process.env, MOCK_INFERENCE: "1", ...envExtra };
  delete env.NEAR_AI_API_KEY;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env });
}

test("--out in a directory that does not exist yet: the directories are created and exactly 'wrote <abs path>' is printed", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--rounds", "1", "--out", "a/b/c/page.html"]);
    assert.equal(r.status, 0, r.stderr);
    const abs = join(dir, "a", "b", "c", "page.html");
    // macOS resolves /var to /private/var in the child's cwd; compare the tail.
    assert.match(r.stdout, /^wrote .+\/a\/b\/c\/page\.html\n$/);
    assert.ok(r.stdout.trimEnd().endsWith(join("a", "b", "c", "page.html")));
    assert.equal(r.stderr, "");
    assert.ok(existsSync(abs));
  });
});

test("--rounds N renders exactly N rounds", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--rounds", "3", "--out", "p.html"]);
    assert.equal(r.status, 0, r.stderr);
    const page = readFileSync(join(dir, "p.html"), "utf8");
    assert.match(page, /3 rounds/);
    assert.match(page, /Round 3</);
    assert.doesNotMatch(page, /Round 4</);
    assert.match(page, /chain: ok/);
  });
});

test("--rounds=3 (equals form) is an unknown argument, exit 2, nothing written", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--rounds=3", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'viewer: unknown argument "--rounds=3" (see --help)\n');
    assert.ok(!existsSync(join(dir, "p.html")));
  });
});

test("an --out value that looks like a flag is a missing value, not a file name", () => {
  inTempDir((dir) => {
    const r = run(dir, ["--out", "--force"]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'viewer: --out needs a value, got "--force" (see --help)\n');
  });
});

test("with --input, a bad SWARM_ROUNDS is irrelevant: the file's own rounds are rendered", async () => {
  const run2 = await runSwarm({ rounds: 2 });
  inTempDir((dir) => {
    writeFileSync(join(dir, "events.json"), JSON.stringify(run2));
    const r = run(dir, ["--input", "events.json", "--out", "p.html"], { SWARM_ROUNDS: "abc" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, "p.html"), "utf8"), /2 rounds/);
  });
});

test("--input holding JSON that is not an object: exit 2 naming the flag and the file, nothing written", () => {
  inTempDir((dir) => {
    for (const text of ["null", "[]", "42", '"x"']) {
      writeFileSync(join(dir, "in.json"), text);
      const r = run(dir, ["--input", "in.json", "--out", "p.html"]);
      assert.equal(r.status, 2, text);
      assert.equal(r.stderr, "viewer: --input in.json: invalid swarm result: must be an object (see --help)\n", text);
      assert.ok(!existsSync(join(dir, "p.html")), text);
    }
  });
});

test("--input with a tampered event still renders, and the page says the chain is broken at that round", async () => {
  const good = await runSwarm({ rounds: 2 });
  const tampered = structuredClone(good);
  const victim = tampered.events.find((e) => e.round === 2);
  victim.text = `${victim.text} (edited)`;
  inTempDir((dir) => {
    writeFileSync(join(dir, "in.json"), JSON.stringify(tampered));
    const r = run(dir, ["--input", "in.json", "--out", "p.html"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(dir, "p.html"), "utf8"), /chain: broken at round 2/);
  });
});

test("an --out that is a directory is refused even with --force", () => {
  inTempDir((dir) => {
    mkdirSync(join(dir, "adir"));
    const r = run(dir, ["--rounds", "1", "--out", "adir", "--force"]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "viewer: --out adir is a directory; give a file path (see --help)\n");
  });
});

test("a refused --out is checked before the input is read: a foreign file plus a missing --input reports the --out problem and leaves the file alone", () => {
  inTempDir((dir) => {
    writeFileSync(join(dir, "mine.txt"), "precious");
    const r = run(dir, ["--input", "missing.json", "--out", "mine.txt"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^viewer: --out mine\.txt exists and is not a page this tool wrote; pass --force to replace it/);
    assert.equal(readFileSync(join(dir, "mine.txt"), "utf8"), "precious");
  });
});

test("a failing render leaves an earlier viewer page byte-for-byte intact", () => {
  inTempDir((dir) => {
    const first = run(dir, ["--rounds", "1", "--out", "p.html"]);
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(join(dir, "p.html"), "utf8");
    writeFileSync(join(dir, "bad.json"), "{}");
    const r = run(dir, ["--input", "bad.json", "--out", "p.html"]);
    assert.equal(r.status, 2);
    assert.equal(readFileSync(join(dir, "p.html"), "utf8"), before);
  });
});
