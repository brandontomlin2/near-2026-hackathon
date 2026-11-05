// The Judge quick path promises that a machine without Rust still gets an 18-row
// table and result: PASS from verify.sh, with the `vault tests` row a SKIP (not a
// FAIL) and a WARN line, and that without gitleaks the secret scan row is the
// narrower FALLBACK scan. This test runs verify.sh's own `vault tests` block with
// no cargo on PATH and checks that the lines README step 4 quotes are the lines
// that block and the summary really print.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const VERIFY = path.join(root, "scripts/verify.sh");
const verify = fs.readFileSync(VERIFY, "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const quick = readme.match(/## Judge quick path\n([\s\S]*?)\n## /)?.[1] ?? "";
const step4 = quick.split(/^4\. /m)[1]?.split(/^5\. /m)[0] ?? "";
const quoted = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// verify.sh's stage list, read from print_summary so this test follows the script.
const stages = [...verify.match(/local expected_stages=\(([\s\S]*?)\n\s*\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

// The exact `vault tests` block from verify.sh, from its banner to the closing fi.
const vaultBlock = verify.match(/\necho "==> vault tests"\n([\s\S]*?\nfi\n)/)?.[1];

// Runs record + print_summary + the vault tests block with PATH holding only an empty
// directory, so `command -v cargo` fails exactly as on a machine without Rust.
function runVaultBlockWithoutCargo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-nocargo-"));
  try {
    fs.mkdirSync(path.join(dir, "contracts/yield-vault"), { recursive: true });
    fs.writeFileSync(path.join(dir, "contracts/yield-vault/Cargo.toml"), "[package]\n");
    fs.mkdirSync(path.join(dir, "emptybin"));
    fs.writeFileSync(path.join(dir, "block.sh"), vaultBlock);
    const others = stages.filter((s) => s !== "vault tests").map((s) => `record PASS "${s}" "ok"`);
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
      "failed=0",
      "secret_scan_skipped=0",
      'source_root="$2"',
      'results_file="$2/results.tsv"',
      ': > "$results_file"',
      ...others,
      'cd "$2"',
      'PATH="$2/emptybin"',
      'source "$2/block.sh"',
      "print_summary",
    ].join("\n");
    // sed must still be found while the functions are loaded, so PATH is cut only
    // inside the script, after the eval lines.
    return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, dir], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("without cargo, verify.sh's vault tests stage is SKIP with a WARN, the table keeps 18 rows and the result is PASS", () => {
  assert.equal(stages.length, 18, "verify.sh expects 18 stages");
  assert.ok(stages.includes("vault tests"));
  assert.ok(vaultBlock, "verify.sh has a vault tests block");
  const run = runVaultBlockWithoutCargo();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /^WARN: cargo not installed; the yield vault contract tests did NOT run$/m);
  assert.match(run.stdout, /^SKIP\s+vault tests\s+NOT RUN: cargo not installed$/m);
  const rows = run.stdout.split("------\n")[1].trim().split("\n").filter((l) => /^(PASS|SKIP|FAIL)\s/.test(l));
  assert.equal(rows.length, 18);
  assert.doesNotMatch(run.stdout, /^FAIL/m);
  assert.equal(run.stdout.trimEnd().split("\n").at(-1), "result: PASS");
});

test("Judge quick path step 4 quotes the real no-cargo and no-gitleaks lines and does not claim the Rust tests ran", () => {
  const q = quoted(step4);
  const run = runVaultBlockWithoutCargo();
  for (const line of ["NOT RUN: cargo not installed", "WARN: cargo not installed; the yield vault contract tests did NOT run"]) {
    assert.ok(q.includes(line), `step 4 quotes: ${line}`);
    assert.ok(run.stdout.includes(line) || run.stderr.includes(line), `verify.sh prints: ${line}`);
  }
  const fallback = "FALLBACK scan, no findings (gitleaks not installed; narrower than gitleaks)";
  assert.ok(q.includes(fallback), "step 4 quotes the fallback secret scan detail");
  assert.ok(verify.includes(`record PASS "secret scan" "${fallback}"`), "verify.sh records that detail");
  assert.match(step4, /not a gitleaks pass/);
  assert.match(step4, /18 rows/);
  assert.match(step4, /Rust tests did not run/);
  assert.match(quick, /no Rust is needed for steps 1, 2 and 3/, "the intro does not say step 4 needs no Rust");
});

test("the README refund caveat points at a vault README paragraph that exists and names the mock-only limit", () => {
  const vault = fs.readFileSync(path.join(root, "contracts/yield-vault/README.md"), "utf8");
  const para = vault.split("\n").find((l) => l.startsWith("Refund trust model:"));
  assert.ok(para, "vault README has the Refund trust model paragraph");
  assert.match(para, /does not independently check/);
  assert.match(para, /only against the mock Ref/);
  assert.match(para, /have not run on testnet/);
  const bullet = readme.split("\n").find((l) => l.includes("`swap_refunded`") && l.includes("Refund trust model"));
  assert.ok(bullet, "the root README refund bullet links the trust model");
  assert.match(bullet, /not testnet/);
  assert.match(bullet, /`revoke_runner` \(next item\) is the remedy/);
  const next = readme.split("\n")[readme.split("\n").indexOf(bullet) + 1];
  assert.match(next, /`revoke_runner`/, "the next item really is the revoke_runner one");
});
