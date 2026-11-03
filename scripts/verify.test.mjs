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

// Loads only evidence_ok from verify.sh and runs it in a dir holding out/evidence.json.
function runEvidenceOk(evidence, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-evidence-"));
  try {
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "evidence.json"), JSON.stringify(evidence));
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^evidence_ok()/,/^results_file=/p" "$1" | sed "\\$d")"',
      'evidence_ok "$2"',
    ].join("\n");
    return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, mode], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("evidence_ok accepts the mock evidence file in mock mode", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  assert.equal(runEvidenceOk(mockEvidence(), "mock").status, 0);
});

test("evidence_ok rejects mock evidence in live mode", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  assert.notEqual(runEvidenceOk(mockEvidence(), "live").status, 0);
});

test("evidence_ok rejects real-looking or unmarked entries in mock mode", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  const real = mockEvidence();
  real.transactions[0].hash = "9".repeat(44);
  assert.notEqual(runEvidenceOk(real, "mock").status, 0);
  const unmarked = mockEvidence();
  delete unmarked.mock;
  assert.notEqual(runEvidenceOk(unmarked, "mock").status, 0);
});

test("package.json exposes evidence, viewer and verify scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
  for (const name of ["evidence", "viewer", "verify"]) assert.ok(pkg.scripts[name], name);
});
