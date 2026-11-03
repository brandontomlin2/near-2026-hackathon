import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, "verify.sh");

// Loads only write_runner from verify.sh and calls it, printing the runner path.
// The function body is a heredoc ending at the line "JS", followed by "}".
function runWriteRunner(tmpdir) {
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^write_runner()/,/^JS$/p" "$1")"$\'\\n}\'',
    'runner=""',
    'runner_dir=""',
    "write_runner",
    'printf "%s\\n" "$runner"',
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: tmpdir },
  });
}

test("mktemp templates in verify.sh end with the random X's", () => {
  const text = fs.readFileSync(VERIFY, "utf8");
  const templates = [...text.matchAll(/mktemp(?:\s+-d)?\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(templates.length >= 2, "expected mktemp calls");
  for (const template of templates) {
    assert.match(template, /X{6,}$/, `${template} must end with X's so macOS mktemp randomises it`);
  }
});

test("two write_runner calls get distinct runner files that both exist", (t) => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
  t.after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));
  const first = runWriteRunner(tmpdir);
  const second = runWriteRunner(tmpdir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const a = first.stdout.trim();
  const b = second.stdout.trim();
  assert.notEqual(a, b);
  assert.ok(a.startsWith(tmpdir) && b.startsWith(tmpdir));
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  assert.match(fs.readFileSync(a, "utf8"), /spawnSync\("npm"/);
});
