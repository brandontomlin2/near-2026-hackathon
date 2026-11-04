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
    'tmp_root="$TMPDIR"',
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

test("evidence_ok in live mode needs every transaction hash valid, not just one", async () => {
  const live = {
    network: "testnet",
    transactions: [{ hash: "9".repeat(44) }, { hash: "9".repeat(43) + "8" }],
    views: [{ method: "sheet_anchor", result: null }],
  };
  assert.equal(runEvidenceOk(live, "live").status, 0);
  const oneBad = structuredClone(live);
  oneBad.transactions.push({ hash: "not-a-hash" });
  assert.notEqual(runEvidenceOk(oneBad, "live").status, 0, "one valid hash must not rescue an invalid one");
  const none = structuredClone(live);
  none.transactions = [];
  assert.notEqual(runEvidenceOk(none, "live").status, 0);
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

// --live queries the contract account, which deploy calls NEAR_CONTRACT_ACCOUNT_ID
// (NEAR_ACCOUNT_ID is the signer there and only a fallback here). The gate runs before
// anything is cloned, so these runs take no time and touch no network.
test("verify.sh --live needs NEAR_NETWORK=testnet and a contract account: NEAR_CONTRACT_ACCOUNT_ID or NEAR_ACCOUNT_ID", () => {
  const base = { ...process.env };
  for (const name of ["NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_TX_FILE"]) delete base[name];
  const live = (env) => spawnSync("/bin/bash", [VERIFY, "--live"], { encoding: "utf8", env: { ...base, ...env } });
  const refused = [
    ["no network", { NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" }],
    ["no account", { NEAR_NETWORK: "testnet" }],
    ["empty accounts", { NEAR_NETWORK: "testnet", NEAR_CONTRACT_ACCOUNT_ID: "", NEAR_ACCOUNT_ID: "" }],
  ];
  for (const [label, env] of refused) {
    const r = live(env);
    assert.equal(r.status, 1, label);
    assert.match(r.stderr, /^error: --live requires NEAR_NETWORK=testnet and NEAR_CONTRACT_ACCOUNT_ID \(or NEAR_ACCOUNT_ID\)\.$/m, label);
    assert.doesNotMatch(r.stdout, /fresh clone/, `${label}: refused before the clone`);
    assert.doesNotMatch(r.stdout, /nft\.alice/, `${label}: the account value is never printed`);
  }
});

test("verify.sh --live passes the env gate with NEAR_CONTRACT_ACCOUNT_ID alone, and with NEAR_ACCOUNT_ID as the fallback", (t) => {
  // A throwaway repository holding only the script: every npm stage SKIPs, so the run is
  // quick and offline. The live evidence stage cannot pass there (no evidence file), so the
  // assertions are about the gate and the mode line, not the final result.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-live-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(VERIFY, path.join(repo, "scripts", "verify.sh"));
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-q", "-m", "fixture").status, 0);
  const base = { ...process.env, TMPDIR: root };
  for (const name of ["NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_TX_FILE"]) delete base[name];
  const live = (env) => spawnSync("/bin/bash", ["scripts/verify.sh", "--live"], { cwd: repo, encoding: "utf8", env: { ...base, NEAR_NETWORK: "testnet", ...env } });

  const contractOnly = live({ NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" });
  assert.doesNotMatch(contractOnly.stderr, /--live requires/, contractOnly.stderr);
  assert.match(contractOnly.stdout, /^mode: live \(testnet, contract account NEAR_CONTRACT_ACCOUNT_ID set, keys not printed\)$/m);
  assert.match(contractOnly.stdout, /fresh clone/, "the gate passed and the run went on");
  assert.doesNotMatch(contractOnly.stdout + contractOnly.stderr, /nft\.alice/, "the account value is never printed");

  const fallback = live({ NEAR_ACCOUNT_ID: "alice.testnet" });
  assert.doesNotMatch(fallback.stderr, /--live requires/, fallback.stderr);
  assert.match(fallback.stdout, /^mode: live \(testnet, contract account from NEAR_ACCOUNT_ID, keys not printed\)$/m);
  assert.match(fallback.stdout, /fresh clone/);
});

// The mainnet refusal runs before any clone or install, so both modes exit at once.
test("verify.sh refuses NEAR_NETWORK=mainnet in mock and --live mode: non-zero, a FAIL network row, nothing cloned", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-mainnet-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // Only the PATH-level basics plus mainnet: no secret-looking or account variables reach the child.
  const env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, NEAR_NETWORK: "mainnet" };
  for (const args of [[], ["--live"]]) {
    const label = args.join(" ") || "mock";
    const started = Date.now();
    const r = spawnSync("/bin/bash", [VERIFY, ...args], { encoding: "utf8", env, timeout: 20000 });
    assert.notEqual(r.status, 0, label);
    assert.equal(r.status, 1, label);
    assert.match(r.stderr, /^error: NEAR_NETWORK=mainnet is refused\. This script never uses mainnet\.$/m, label);
    assert.match(r.stdout, /FAIL\s+network\s+mainnet is refused/, `${label}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /fresh clone/, `${label}: refused before the clone`);
    assert.ok(Date.now() - started < 15000, `${label}: exits quickly`);
    assert.deepEqual(fs.readdirSync(tmp), [], `${label}: nothing left under TMPDIR`);
  }
});

test("the mock runner drops both account variables and key-like names from the child env", () => {
  const text = fs.readFileSync(VERIFY, "utf8");
  assert.match(text, /mode === "mock" && \(isSecretName\(name\) \|\| name === "NEAR_ACCOUNT_ID" \|\| name === "NEAR_CONTRACT_ACCOUNT_ID"\)/);
});

test("verify.sh --help prints usage and exits 0", () => {
  const r = spawnSync("/bin/bash", [VERIFY, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: bash scripts\/verify\.sh/);
  assert.equal(r.stderr, "");
});

test("verify.sh refuses a TMPDIR that is not a directory with one line and runs nothing", () => {
  const r = spawnSync("/bin/bash", [VERIFY], { encoding: "utf8", env: { ...process.env, TMPDIR: "../does-not-exist-tmp" } });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "", "nothing on stdout");
  assert.equal(r.stderr.trim(), 'verify: TMPDIR is not a directory: "../does-not-exist-tmp"');
});

// Every temp path is created after the TMPDIR resolution and used again after the script
// has cd'd into the fresh clone, so the templates must hang off the resolved absolute root.
test("verify.sh builds every temp path from the resolved absolute tmp_root, never raw TMPDIR", () => {
  const text = fs.readFileSync(VERIFY, "utf8");
  const templates = [...text.matchAll(/mktemp(?:\s+-d)?\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(templates.length >= 3, "expected mktemp calls");
  for (const template of templates) assert.match(template, /^\$tmp_root\//, template);
  assert.match(text, /^tmp_root=\$\(cd "\$\{TMPDIR:-\/tmp\}" .*&& pwd -P\)/m);
  assert.match(text, /^export TMPDIR="\$tmp_root"$/m);
});

// Loads only resolve_evidence_tx_file from verify.sh and calls it with the given
// source root, from the given working directory, with EVIDENCE_TX_FILE set as given
// (or unset). Prints the exported value (or "<unset>") on the last stdout line.
function runResolveTxFile({ root, cwd, txFile }) {
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^resolve_evidence_tx_file()/,/^}$/p" "$1")"',
    'resolve_evidence_tx_file "$2"',
    'printf "%s\\n" "${EVIDENCE_TX_FILE-<unset>}"',
  ].join("\n");
  const env = { ...process.env };
  delete env.EVIDENCE_TX_FILE;
  if (txFile !== undefined) env.EVIDENCE_TX_FILE = txFile;
  const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, root], { cwd, encoding: "utf8", env });
  return { ...r, resolved: r.stdout.trimEnd().split("\n").at(-1) };
}

// The live evidence stage runs inside the fresh clone, where the gitignored out/
// does not exist, so the relative path live-proof prints must be made absolute
// against the source checkout before the cd. Offline: no network, no near CLI.
test("resolve_evidence_tx_file makes the documented relative path absolute against the source checkout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-txfile-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "verify-txfile-cwd-"));
  t.after(() => { for (const d of [root, elsewhere]) fs.rmSync(d, { recursive: true, force: true }); });
  const txs = path.join(root, "out", "live-proof", "txs.json");
  fs.mkdirSync(path.dirname(txs), { recursive: true });
  fs.writeFileSync(txs, "[]");

  // The path `npm run live-proof` prints, run from a directory that is not the checkout.
  const relative = runResolveTxFile({ root, cwd: elsewhere, txFile: "out/live-proof/txs.json" });
  assert.equal(relative.status, 0, relative.stderr);
  assert.equal(relative.resolved, txs);
  assert.equal(relative.stderr, "", "an existing file draws no WARN");
  assert.match(relative.stdout, /^evidence tx file: /m);

  // Unset: the live-proof file in the source checkout is the default.
  const unset = runResolveTxFile({ root, cwd: elsewhere });
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(unset.resolved, txs);

  // An absolute path is kept as is.
  const absolute = runResolveTxFile({ root, cwd: elsewhere, txFile: txs });
  assert.equal(absolute.status, 0, absolute.stderr);
  assert.equal(absolute.resolved, txs);
});

test("resolve_evidence_tx_file prefers the invoking directory for a relative path, and leaves nothing set when there is no file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-txfile-"));
  // bash's $PWD is the physical path (macOS: /tmp -> /private/tmp), so compare against it.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-txfile-cwd-")));
  t.after(() => { for (const d of [root, cwd]) fs.rmSync(d, { recursive: true, force: true }); });
  const inRoot = path.join(root, "txs.json");
  const inCwd = path.join(cwd, "txs.json");
  fs.writeFileSync(inRoot, "[]");
  fs.writeFileSync(inCwd, "[]");

  // Plain shell semantics first: a relative path that exists where the user stands wins.
  const both = runResolveTxFile({ root, cwd, txFile: "txs.json" });
  assert.equal(both.status, 0, both.stderr);
  assert.equal(both.resolved, inCwd);

  // A relative path that exists nowhere still resolves (against the checkout) and warns, never fails:
  // the evidence stage reports the missing file itself.
  const missing = runResolveTxFile({ root, cwd, txFile: "nope/txs.json" });
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.resolved, path.join(root, "nope/txs.json"));
  assert.match(missing.stderr, /^WARN: evidence tx file .*nope\/txs\.json does not exist/m);

  // Unset and no default file: leave EVIDENCE_TX_FILE unset and say so.
  const none = runResolveTxFile({ root, cwd });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.resolved, "<unset>");
  assert.match(none.stdout, /^evidence tx file: none \(EVIDENCE_TX_FILE unset, no out\/live-proof\/txs\.json in /m);
});

test("verify.sh resolves the evidence tx file only with --live and before entering the fresh clone", () => {
  const text = fs.readFileSync(VERIFY, "utf8");
  const call = text.indexOf('resolve_evidence_tx_file "$source_root"');
  const enter = text.indexOf('cd "$work/repo"');
  assert.ok(call > 0 && enter > 0 && call < enter, "the call must come before cd into the clone");
  assert.match(text, /if \[\[ "\$LIVE" -eq 1 \]\]; then\n  resolve_evidence_tx_file "\$source_root"\nfi/);
  const usage = text.slice(text.indexOf("usage() {"), text.indexOf("\nEOF\n"));
  assert.match(usage, /EVIDENCE_TX_FILE/, "usage documents the variable");
  assert.match(usage, /out\/live-proof\/txs\.json exists in the\n\s+source checkout, that file is used/);
});

// Every stage a complete mock run records, in order. The summary only prints
// result: PASS when each of these has a row, so a run that lost its results file
// (or skipped a stage by accident) can never look like a clean pass.
const STAGES = [
  "fresh clone", "workflows", "symlinks", "secret files", "npm install", "tests",
  "secret scan", "deploy nft", "mint", "swarm", "demo", "round hash", "yield", "vault tests",
  "evidence",
];

// Bash lines that record one row per stage, so a summary test starts from a complete table.
function recordAllStages() {
  return STAGES.map((stage) => `record PASS "${stage}" "ok"`);
}

// Loads record, print_summary and cleanup from verify.sh, installs cleanup as the EXIT
// trap exactly as the script does, records every stage, then exits with the given status.
function runCleanupOnExit(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cleanup-"));
  try {
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^cleanup()/,/^}$/p" "$1")"',
      "failed=0",
      "secret_scan_skipped=0",
      'work=""',
      'runner_dir=""',
      'results_file=$(mktemp "$2/results.XXXXXX")',
      "trap 'cleanup' EXIT",
      ...recordAllStages(),
      `exit ${exitCode}`,
    ].join("\n");
    return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, dir], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an abnormal exit through the EXIT trap ends in result: FAIL with an aborted row, never PASS", () => {
  const aborted = runCleanupOnExit(3);
  assert.equal(aborted.status, 3, "the original exit status is kept");
  const lines = aborted.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), "result: FAIL");
  assert.match(aborted.stdout, /^FAIL\s+aborted\s+exited with status 3 before the last stage$/m);
  assert.match(aborted.stdout, /^PASS\s+fresh clone\s+ok$/m, "earlier rows are kept");

  const clean = runCleanupOnExit(0);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout.trimEnd().split("\n").at(-1), "result: PASS");
  assert.doesNotMatch(clean.stdout, /aborted/);
});

// The original bug: the results file was created under a relative TMPDIR (a directory
// next to the repo), the script then cd'd into the fresh clone where that relative
// directory does not exist, and every record() failed, leaving an empty table under
// "result: PASS". Reproduce that with a results file in a relative directory plus a cd,
// with the EXIT trap installed exactly as the script does.
test("a record that cannot write is a hard FAIL: nonzero exit, loud stderr, result: FAIL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-record-"));
  fs.mkdirSync(path.join(dir, "reltmp"));
  try {
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^cleanup()/,/^}$/p" "$1")"',
      "failed=0",
      "secret_scan_skipped=0",
      'work=""',
      'runner_dir=""',
      'results_file=$(mktemp "reltmp/results.XXXXXX")',
      "trap 'cleanup' EXIT",
      'record PASS "fresh clone" "abc123"',
      'cd "$2"',
      'record PASS "workflows" "no workflow files; CI disabled"',
      'echo "unreachable: record must abort the run"',
    ].join("\n");
    const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, os.tmpdir()], { cwd: dir, encoding: "utf8" });
    assert.notEqual(r.status, 0, "exit status must be nonzero");
    assert.doesNotMatch(r.stdout, /unreachable/);
    assert.match(r.stderr, /could not record stage "workflows"/);
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines.at(-1), "result: FAIL");
    assert.doesNotMatch(r.stdout, /result: PASS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Even if record() somehow kept going, a summary with missing rows must not exit 0.
test("cleanup exits nonzero when the summary finds a stage with no row, even on a clean exit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-gap-"));
  try {
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^cleanup()/,/^}$/p" "$1")"',
      "failed=0",
      "secret_scan_skipped=0",
      'work=""',
      'runner_dir=""',
      'results_file=$(mktemp "$2/results.XXXXXX")',
      "trap 'cleanup' EXIT",
      'record PASS "fresh clone" "abc123"',
      "exit 0",
    ].join("\n");
    const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, dir], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.stdout.trimEnd().split("\n").at(-1), "result: FAIL");
    assert.match(r.stdout, /^FAIL: no row was recorded for: workflows, symlinks, .*evidence$/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs the real verify.sh end to end from a tiny throwaway repository that holds only the
// script, with TMPDIR given as a relative path (the judge's TMPDIR=$(mktemp -d ../x.XXXX)
// case). No package.json, so the npm stages SKIP and the run takes about a second.
test("verify.sh with a relative TMPDIR records every stage and passes; the table is never empty", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-reltmp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.copyFileSync(VERIFY, path.join(repo, "scripts", "verify.sh"));
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("add", "-A").status, 0);
  assert.equal(git("commit", "-q", "-m", "fixture").status, 0, git("commit", "-q", "-m", "fixture").stderr);
  fs.mkdirSync(path.join(root, "reltmp"));

  const r = spawnSync("/bin/bash", ["scripts/verify.sh"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: "../reltmp" },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-1), "result: PASS");
  assert.doesNotMatch(r.stderr, /No such file or directory/);
  const rows = lines.filter((line) => /^(PASS|SKIP|FAIL)\s{2,}/.test(line));
  assert.deepEqual(rows.map((line) => line.split(/\s{2,}/)[1]), STAGES, "one row per stage, in order");
  assert.ok(rows.every((line) => !line.startsWith("FAIL")), r.stdout);
  assert.equal(fs.readdirSync(path.join(root, "reltmp")).length, 0, "temp files under TMPDIR are cleaned up");
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

// Loads record and print_summary, records the given stages (default: all of them), then
// prints the summary with the given flags. Pass stages: null for no results file at all.
function runPrintSummary({ failed, skipped, stages = STAGES }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-summary-"));
  try {
    const script = [
      "set -euo pipefail",
      'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
      'eval "$(sed -n "/^print_summary()/,/^}$/p" "$1")"',
      `failed=${failed}`,
      `secret_scan_skipped=${skipped}`,
      stages === null ? 'results_file=""' : 'results_file=$(mktemp "$2/results.XXXXXX")',
      ...(stages ?? []).map((stage) => `record PASS "${stage}" "ok"`),
      "print_summary",
      'printf "failed=%s\\n" "$failed"',
    ].join("\n");
    return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, dir], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function resultLine(r) {
  return r.stdout.trimEnd().split("\n").at(-2);
}

test("summary repeats the gitleaks WARN right before the result line when the scan was skipped", () => {
  const skipped = runPrintSummary({ failed: 0, skipped: 1 });
  assert.equal(skipped.status, 0, skipped.stderr);
  const lines = skipped.stdout.trimEnd().split("\n");
  assert.equal(lines.at(-2), "result: PASS", "result stays the last line of the summary");
  assert.match(lines.at(-3), /^WARN: the secret scan did NOT run because gitleaks is not installed; install it \(brew install gitleaks\)/);

  const scanned = runPrintSummary({ failed: 0, skipped: 0 });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.doesNotMatch(scanned.stdout, /WARN:/);
  assert.equal(resultLine(scanned), "result: PASS");
});

test("summary refuses result: PASS when any stage has no row, naming the missing stages", () => {
  const empty = runPrintSummary({ failed: 0, skipped: 0, stages: [] });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(resultLine(empty), "result: FAIL");
  assert.match(empty.stdout, /^FAIL: no row was recorded for: fresh clone, workflows, .*evidence/m);
  assert.match(empty.stdout, /^failed=1$/m, "the failed flag is set so the exit status is nonzero");

  const missingFile = runPrintSummary({ failed: 0, skipped: 0, stages: null });
  assert.equal(missingFile.status, 0, missingFile.stderr);
  assert.equal(resultLine(missingFile), "result: FAIL");

  const partial = runPrintSummary({ failed: 0, skipped: 0, stages: STAGES.filter((s) => s !== "tests" && s !== "demo") });
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(resultLine(partial), "result: FAIL");
  assert.match(partial.stdout, /^FAIL: no row was recorded for: tests, demo$/m);

  const complete = runPrintSummary({ failed: 0, skipped: 0 });
  assert.equal(resultLine(complete), "result: PASS");
  assert.doesNotMatch(complete.stdout, /no row was recorded/);
});

// Privacy audit L-4: the "wrote ..." line is pasted into every PR's Proof section, so it
// must name the repo-relative file, not ${source_root}/... with the home directory.
test("the evidence stage reports its file as a repo-relative path", () => {
  const text = fs.readFileSync(VERIFY, "utf8");
  assert.ok(text.includes('echo "wrote out/evidence.json"'), "expected a repo-relative wrote line");
  assert.doesNotMatch(text, /echo "wrote \$\{?source_root/, "the wrote line must not print source_root");
  for (const line of text.split("\n").filter((l) => /^\s*echo /.test(l))) {
    assert.ok(!/\$\{?source_root/.test(line), `echo prints an absolute path: ${line.trim()}`);
  }
});

test("package.json exposes evidence, viewer and verify scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
  for (const name of ["evidence", "viewer", "verify"]) assert.ok(pkg.scripts[name], name);
});
