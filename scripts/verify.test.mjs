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
  assert.equal(runEvidenceOk(await mockEvidence(), "mock").status, 0);
});

test("evidence_ok rejects broken mock memory loops", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  const cases = {
    "memory_loop missing": (e) => delete e.memory_loop,
    "linked hash differs": (e) => { e.memory_loop.tokens[0].anchor.linked_round_hash = "a".repeat(64); },
    "sheet hash mismatch": (e) => { e.memory_loop.tokens[0].anchor.args.sheet_hash = "b".repeat(64); },
    "non-null tx hash": (e) => { e.memory_loop.tokens[0].anchor.transaction_hash = "MOCK-tx"; },
    "duplicate token": (e) => { e.memory_loop.tokens[1] = structuredClone(e.memory_loop.tokens[0]); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const ev = await mockEvidence();
    mutate(ev);
    assert.notEqual(runEvidenceOk(ev, "mock").status, 0, name);
  }
});

test("verify.sh labels mock evidence as not on-chain proof", () => {
  assert.match(fs.readFileSync(VERIFY, "utf8"), /mock, not on-chain proof/);
});

test("evidence_ok rejects mock evidence in live mode", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  assert.notEqual(runEvidenceOk(await mockEvidence(), "live").status, 0);
});

test("evidence_ok rejects real-looking or unmarked entries in mock mode", async () => {
  const { mockEvidence } = await import("./evidence.mjs");
  const real = await mockEvidence();
  real.transactions[0].hash = "9".repeat(44);
  assert.notEqual(runEvidenceOk(real, "mock").status, 0);
  const unmarked = await mockEvidence();
  delete unmarked.mock;
  assert.notEqual(runEvidenceOk(unmarked, "mock").status, 0);
});

test("verify.sh rejects an unknown argument with one line and runs nothing", () => {
  for (const args of [["--bogus"], ["--live", "--bogus"], ["stray"]]) {
    const r = spawnSync("/bin/bash", [VERIFY, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", "nothing on stdout");
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, /verify: unknown argument "(--bogus|stray)" \(see --help\)/);
  }
});

test("verify.sh --help prints usage and exits 0", () => {
  const r = spawnSync("/bin/bash", [VERIFY, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: bash scripts\/verify\.sh/);
  assert.equal(r.stderr, "");
});

test("package.json exposes evidence, viewer and verify scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
  for (const name of ["evidence", "viewer", "verify"]) assert.ok(pkg.scripts[name], name);
});
