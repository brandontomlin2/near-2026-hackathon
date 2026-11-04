// Behaviour tests for the verify.sh stages that run inline inside the fresh clone and so were
// only ever exercised by a full run: workflows, symlinks, secret files, test discovery and the
// SWARM_ROUNDS guard. Each stage's text is cut out of verify.sh with sed and run in a temp git
// repo with a stub record(), so nothing clones, installs or touches the network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VERIFY = path.join(path.dirname(fileURLToPath(import.meta.url)), "verify.sh");

function repo(t, files, { links = {}, commit = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-gaps17-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name));
  const git = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-f", "-A");
  if (commit) git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  return dir;
}

// Runs the verify.sh text from the line matching `from` up to (not including) the line matching `to`.
function runStage(dir, from, to, pre = "") {
  const script = [
    "set -euo pipefail",
    'results_file="$2"; : > "$results_file"; failed=0',
    'record() { printf "%s\\t%s\\t%s\\n" "$1" "$2" "$3" >> "$results_file"; }',
    pre,
    `eval "$(sed -n '/${from}/,/${to}/p' "$1" | sed '$d')"`,
    'echo "failed=$failed"',
  ].join("\n");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const results = path.join(dir, "..", `${path.basename(dir)}.tsv`);
  const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, results], { cwd: dir, encoding: "utf8", env }); // NODE_TEST_CONTEXT would make a nested node --test report success
  const rows = fs.existsSync(results) ? fs.readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  fs.rmSync(results, { force: true });
  return { ...r, rows, failed: /failed=1/.test(r.stdout) };
}

const stage = (dir, name, next) => runStage(dir, `^echo "==> ${name}"`, `^echo "==> ${next}"`);

test("workflows stage: any tracked .github/workflows file fails the screen and names the file", (t) => {
  const bad = stage(repo(t, { ".github/workflows/ci.yml": "on: push\n", "a.txt": "x" }), "workflows", "symlinks");
  assert.deepEqual(bad.rows, [["FAIL", "workflows", "workflow files present; CI is disabled"]]);
  assert.match(bad.stdout, /^FAIL: GitHub Actions workflow files are not allowed: \.github\/workflows\/ci\.yml$/m);
  assert.ok(bad.failed);
  const ok = stage(repo(t, { ".github/dependabot.yml": "version: 2\n" }), "workflows", "symlinks");
  assert.deepEqual(ok.rows, [["PASS", "workflows", "no workflow files; CI disabled"]]);
  assert.ok(!ok.failed);
});

test("symlinks stage: a dangling tracked symlink fails and names it on stderr; a resolving one passes", (t) => {
  const bad = stage(repo(t, { "real.txt": "x" }, { links: { dangling: "missing-target", good: "real.txt" } }), "symlinks", "secret files");
  assert.deepEqual(bad.rows, [["FAIL", "symlinks", "broken tracked symlink"]]);
  assert.match(bad.stderr, /^broken symlink: dangling -> missing-target$/m);
  assert.doesNotMatch(bad.stderr, /good/);
  assert.ok(bad.failed);
  const ok = stage(repo(t, { "real.txt": "x" }, { links: { good: "real.txt" } }), "symlinks", "secret files");
  assert.deepEqual(ok.rows, [["PASS", "symlinks", "tracked symlinks resolve"]]);
});

test("secret files stage: tracked .env variants, .pem and .key fail (nested too); .env.example and lookalikes pass", (t) => {
  const bad = stage(repo(t, { ".env": "A=1", "sub/.env.local": "A=1", "id.pem": "x", "deep/dir/server.key": "x", ".env.example": "A=", "environment.md": "x", "keyboard.txt": "x" }), "secret files", "npm install");
  assert.deepEqual(bad.rows, [["FAIL", "secret files", "tracked env or key filenames"]]);
  assert.deepEqual(bad.stderr.trim().split("\n").sort(), [".env", "deep/dir/server.key", "id.pem", "sub/.env.local"]);
  assert.ok(bad.failed);
  const ok = stage(repo(t, { ".env.example": "A=", "environment.md": "x", "keyboard.txt": "x", "docs/.envrc.md": "x" }), "secret files", "npm install");
  assert.deepEqual(ok.rows, [["PASS", "secret files", "no tracked env or key files"]]);
  assert.equal(ok.stderr, "");
});

test("secret files stage looks at tracked files only: an untracked .env is not reported", (t) => {
  const dir = repo(t, { "a.txt": "x" });
  fs.writeFileSync(path.join(dir, ".env"), "K=1");
  assert.deepEqual(stage(dir, "secret files", "npm install").rows, [["PASS", "secret files", "no tracked env or key files"]]);
});

test("tests stage: finds *.test.mjs/.spec.js files, skips node_modules and out, and counts the files it ran", (t) => {
  const pass = "import test from 'node:test'; test('ok', () => {});\n";
  const dir = repo(t, {
    "a.test.mjs": pass,
    "src/b.spec.js": pass.replace("import test from 'node:test';", "const test = require('node:test');"),
    "node_modules/x/bad.test.mjs": "throw new Error('must not run');\n",
    "out/bad.test.mjs": "throw new Error('must not run');\n",
    "helper.mjs": "throw new Error('not a test');\n",
  });
  const r = runStage(dir, '^echo "==> tests"', "^secret_scan$");
  assert.deepEqual(r.rows, [["PASS", "tests", "2 file(s)"]], r.stdout + r.stderr);
  assert.ok(!r.failed);
});

test("tests stage: a failing test file is a FAIL row with the node --test message; no test files is a SKIP", (t) => {
  const bad = runStage(repo(t, { "a.test.mjs": "import test from 'node:test'; test('boom', () => { throw new Error('boom'); });\n" }), '^echo "==> tests"', "^secret_scan$");
  assert.deepEqual(bad.rows, [["FAIL", "tests", "node --test failed"]]);
  assert.match(bad.stdout, /^FAIL: node --test failed$/m);
  assert.ok(bad.failed);
  const none = runStage(repo(t, { "a.txt": "x" }), '^echo "==> tests"', "^secret_scan$");
  assert.deepEqual(none.rows, [["SKIP", "tests", "no test files"]]);
  assert.match(none.stdout, /^no test files$/m);
  assert.ok(!none.failed);
});

// The SWARM_ROUNDS guard plus the planned call that follows it.
function runRounds(t, value) {
  const dir = repo(t, { "package.json": JSON.stringify({ scripts: { swarm: "x" } }) });
  const pre = [
    'LIVE=0; last_outcome=""',
    'planned() { echo "PLANNED $*"; }',
    value === undefined ? "unset SWARM_ROUNDS" : `export SWARM_ROUNDS='${value}'`,
  ].join("\n");
  return runStage(dir, '^rounds="\\${SWARM_ROUNDS', '^planned "demo"', pre);
}

test("SWARM_ROUNDS: unset defaults to 5 rounds; a positive integer is passed through as --rounds", (t) => {
  assert.match(runRounds(t, undefined).stdout, /^PLANNED swarm swarm mock --rounds 5$/m);
  assert.match(runRounds(t, "12").stdout, /^PLANNED swarm swarm mock --rounds 12$/m);
});

test("SWARM_ROUNDS: 0, negatives, decimals, leading zeros, junk and empty-with-space are a FAIL swarm row and never reach npm", (t) => {
  for (const bad of ["0", "-3", "2.5", "05", "abc", "3 4", "1e3"]) {
    const r = runRounds(t, bad);
    assert.deepEqual(r.rows, [["FAIL", "swarm", "SWARM_ROUNDS must be a positive integer"]], bad);
    assert.match(r.stdout, /^FAIL: SWARM_ROUNDS must be a positive integer$/m, bad);
    assert.doesNotMatch(r.stdout, /PLANNED/, bad);
    assert.ok(r.failed, bad);
  }
});
