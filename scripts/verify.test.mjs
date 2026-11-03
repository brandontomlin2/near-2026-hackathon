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

// Loads only secret_scan from verify.sh and runs it with PATH limited to binDir, which
// may hold a fake gitleaks. record() is stubbed to print RECORD rows; the last line
// reports the failed flag and the skipped flag the summary reads.
function runSecretScan(binDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-secret-scan-"));
  try {
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^secret_scan()/,/^}$/p" "$1")"',
      'record() { printf "RECORD\\t%s\\t%s\\t%s\\n" "$1" "$2" "$3"; }',
      "failed=0",
      "secret_scan_skipped=0",
      'export PATH="$2"',
      "secret_scan",
      'printf "failed=%s skipped=%s\\n" "$failed" "$secret_scan_skipped"',
    ].join("\n");
    return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, binDir], { cwd: dir, encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeGitleaksDir(t, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-fake-gitleaks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (exitCode !== null) {
    const bin = path.join(dir, "gitleaks");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf 'fake gitleaks argv: %s\\n' "$*"\nexit ${exitCode}\n`, { mode: 0o755 });
  }
  return dir;
}

test("secret scan without gitleaks prints a loud WARN with the install hint, records SKIP and does not fail", (t) => {
  const result = runSecretScan(fakeGitleaksDir(t, null));
  assert.equal(result.status, 0, result.stderr);
  const warns = result.stdout.split("\n").filter((line) => line.startsWith("WARN:"));
  assert.ok(warns.length >= 2, `expected WARN lines on stdout, got:\n${result.stdout}`);
  assert.match(warns[0], /secret scan did NOT run/);
  assert.match(warns.join("\n"), /gitleaks is not installed/);
  assert.match(warns.join("\n"), /brew install gitleaks/);
  assert.match(result.stdout, /^RECORD\tSKIP\tsecret scan\tNOT RUN: gitleaks not installed \(brew install gitleaks\)$/m);
  assert.doesNotMatch(result.stdout, /RECORD\t(PASS|FAIL)/);
  assert.match(result.stdout, /^failed=0 skipped=1$/m);
});

test("secret scan with a clean gitleaks run records PASS and passes the detect flags", (t) => {
  const result = runSecretScan(fakeGitleaksDir(t, 0));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fake gitleaks argv: detect --source \. --redact --no-banner --verbose/);
  assert.match(result.stdout, /^RECORD\tPASS\tsecret scan\tno findings$/m);
  assert.doesNotMatch(result.stdout, /WARN:/);
  assert.match(result.stdout, /^failed=0 skipped=0$/m);
});

test("secret scan with gitleaks findings records FAIL and sets the failed flag", (t) => {
  const result = runSecretScan(fakeGitleaksDir(t, 1));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^RECORD\tFAIL\tsecret scan\tgitleaks reported findings or failed$/m);
  assert.match(result.stdout, /^failed=1 skipped=0$/m);
});

// Loads only print_summary and runs it with the given flags and no results file.
function runPrintSummary({ failed, skipped }) {
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
    `failed=${failed}`,
    `secret_scan_skipped=${skipped}`,
    'results_file=""',
    "print_summary",
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY], { encoding: "utf8" });
}

test("summary repeats the gitleaks WARN right before the result line when the scan was skipped", () => {
  const skipped = runPrintSummary({ failed: 0, skipped: 1 });
  assert.equal(skipped.status, 0, skipped.stderr);
  const lines = skipped.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), "result: PASS", "result stays the last line");
  assert.match(lines.at(-2), /^WARN: the secret scan did NOT run because gitleaks is not installed; install it \(brew install gitleaks\)/);

  const scanned = runPrintSummary({ failed: 0, skipped: 0 });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.doesNotMatch(scanned.stdout, /WARN:/);
  assert.equal(scanned.stdout.trimEnd().split("\n").at(-1), "result: PASS");
});

test("package.json exposes evidence, viewer and verify scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
  for (const name of ["evidence", "viewer", "verify"]) assert.ok(pkg.scripts[name], name);
});
