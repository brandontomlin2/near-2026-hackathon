// Behaviour tests for scripts/verify.sh that verify.test.mjs does not cover: the early
// network/live refusals, the npm runner's environment handling, the planned-stage
// outcomes and evidence_ok in live mode. Nothing here runs the full script past its
// first refusals: no clone, no install, no network. Functions are loaded out of
// verify.sh with sed, exactly as verify.test.mjs does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.join(HERE, "verify.sh");

function tmp(t, prefix = "verify-gaps14-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete env[k];
  return env;
};

// ---- early refusals of the whole script (all before the fresh clone) ----

function runVerify(t, args, env) {
  const dir = tmp(t);
  const base = cleanEnv({ TMPDIR: dir, NEAR_NETWORK: undefined, NEAR_ACCOUNT_ID: undefined, EVIDENCE_TX_FILE: undefined, ...env });
  return spawnSync("/bin/bash", [VERIFY, ...args], { encoding: "utf8", env: base, cwd: dir });
}

test("NEAR_NETWORK=mainnet is refused before anything runs: stderr line, network FAIL row, result: FAIL, exit 1", (t) => {
  const r = runVerify(t, [], { NEAR_NETWORK: "mainnet" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: NEAR_NETWORK=mainnet is refused\. This script never uses mainnet\.$/m);
  assert.match(r.stdout, /^FAIL\s+network\s+mainnet is refused$/m);
  assert.match(r.stdout, /^result: FAIL$/m);
  assert.doesNotMatch(r.stdout, /==> fresh clone/);
});

test("a NEAR_NETWORK other than testnet is refused with its own message and row", (t) => {
  const r = runVerify(t, [], { NEAR_NETWORK: "devnet" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^error: NEAR_NETWORK must be unset or testnet\.$/m);
  assert.match(r.stdout, /^FAIL\s+network\s+NEAR_NETWORK must be unset or testnet$/m);
  assert.match(r.stdout, /^result: FAIL$/m);
});

test("--live without NEAR_NETWORK=testnet and NEAR_ACCOUNT_ID is refused with a 'live env' row", (t) => {
  for (const env of [{}, { NEAR_NETWORK: "testnet" }, { NEAR_ACCOUNT_ID: "nft.testnet" }]) {
    const r = runVerify(t, ["--live"], env);
    const label = JSON.stringify(env);
    assert.equal(r.status, 1, label);
    assert.match(r.stderr, /^error: --live requires NEAR_NETWORK=testnet and NEAR_ACCOUNT_ID\.$/m, label);
    assert.match(r.stdout, /^FAIL\s+live env\s+--live requires NEAR_NETWORK=testnet and NEAR_ACCOUNT_ID$/m, label);
    assert.doesNotMatch(r.stdout, /^mode: live/m, label);
  }
});

test("a repeated --help or -h stops at usage: exit 0, usage mentions every flag and the exit-status rule", (t) => {
  const r = runVerify(t, ["-h"], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: bash scripts\/verify\.sh \[--live\]$/m);
  assert.match(r.stdout, /Exit status is 0 when every stage is PASS or SKIP, and nonzero on any failure\./);
  assert.equal(r.stderr, "");
});

// ---- the npm runner (write_runner's run.js) ----

function writeRunner(t) {
  const tmpRoot = tmp(t, "verify-gaps14-root-");
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^write_runner()/,/^JS$/p" "$1")"$\'\\n}\'',
    'runner=""; runner_dir=""; tmp_root="$2"',
    "write_runner",
    'printf "%s\\n" "$runner"',
  ].join("\n");
  const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, tmpRoot], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// A stub `npm` first on PATH that reports the environment it was started with.
function stubNpm(t) {
  const bin = tmp(t, "verify-gaps14-bin-");
  fs.writeFileSync(
    path.join(bin, "npm"),
    [
      "#!/bin/sh",
      'echo "ARGS=$*"',
      'echo "MOCK_INFERENCE=${MOCK_INFERENCE-<unset>}"',
      'echo "EVIDENCE_NETWORK=${EVIDENCE_NETWORK-<unset>}"',
      'echo "NEAR_NETWORK=${NEAR_NETWORK-<unset>}"',
      'echo "NEAR_ACCOUNT_ID=${NEAR_ACCOUNT_ID-<unset>}"',
      'echo "NEAR_AI_API_KEY=${NEAR_AI_API_KEY-<unset>}"',
      'echo "MY_SECRET_TOKEN=${MY_SECRET_TOKEN-<unset>}"',
      'echo "PLAIN=${PLAIN-<unset>}"',
      "exit ${STUB_EXIT:-0}",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

function runRunner(runner, bin, mode, npmArgs, env) {
  const r = spawnSync(process.execPath, [runner, mode, ...npmArgs], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, PLAIN: "kept", ...env },
  });
  const seen = Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { ...r, seen };
}

test("runner mock mode drops secrets and the account id, forces MOCK_INFERENCE=1 and EVIDENCE_NETWORK=mock, unsets NEAR_NETWORK", (t) => {
  const runner = writeRunner(t);
  const bin = stubNpm(t);
  const r = runRunner(runner, bin, "mock", ["run", "swarm", "--", "--rounds", "2"], {
    NEAR_AI_API_KEY: "secret-1",
    MY_SECRET_TOKEN: "secret-2",
    NEAR_ACCOUNT_ID: "alice.testnet",
    NEAR_NETWORK: "testnet",
    MOCK_INFERENCE: "0",
    EVIDENCE_NETWORK: "testnet",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.seen.ARGS, "run swarm -- --rounds 2");
  assert.equal(r.seen.NEAR_AI_API_KEY, "<unset>");
  assert.equal(r.seen.MY_SECRET_TOKEN, "<unset>");
  assert.equal(r.seen.NEAR_ACCOUNT_ID, "<unset>");
  assert.equal(r.seen.NEAR_NETWORK, "<unset>");
  assert.equal(r.seen.MOCK_INFERENCE, "1");
  assert.equal(r.seen.EVIDENCE_NETWORK, "mock");
  assert.equal(r.seen.PLAIN, "kept", "ordinary variables pass through");
  assert.ok(!r.stdout.includes("secret-1") && !r.stdout.includes("secret-2"));
});

test("runner live mode keeps the account id, sets testnet and MOCK_INFERENCE=0", (t) => {
  const runner = writeRunner(t);
  const bin = stubNpm(t);
  const r = runRunner(runner, bin, "live", ["run", "evidence"], {
    NEAR_ACCOUNT_ID: "alice.testnet",
    MOCK_INFERENCE: "1",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.seen.NEAR_ACCOUNT_ID, "alice.testnet");
  assert.equal(r.seen.NEAR_NETWORK, "testnet");
  assert.equal(r.seen.EVIDENCE_NETWORK, "testnet");
  assert.equal(r.seen.MOCK_INFERENCE, "0");
});

test("runner refuses mainnet in both modes and an unknown mode, before npm is started", (t) => {
  const runner = writeRunner(t);
  const bin = stubNpm(t);
  for (const mode of ["mock", "live"]) {
    const r = runRunner(runner, bin, mode, ["run", "x"], { NEAR_NETWORK: "mainnet" });
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, /refusing to run: NEAR_NETWORK=mainnet/, mode);
    assert.equal(r.stdout, "", `${mode}: npm must not have run`);
  }
  const bad = runRunner(runner, bin, "staging", ["run", "x"], {});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refusing to run: unknown npm mode/);
  assert.equal(bad.stdout, "");
});

test("runner passes npm's exit status through, and reports a missing npm as exit 1", (t) => {
  const runner = writeRunner(t);
  const bin = stubNpm(t);
  assert.equal(runRunner(runner, bin, "mock", ["run", "x"], { STUB_EXIT: "7" }).status, 7);
  const empty = tmp(t, "verify-gaps14-nobin-");
  const missing = runRunner(runner, empty, "mock", ["run", "x"], {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm failed to start/);
});

// ---- planned: per-stage outcomes ----

// Loads script_status and planned, replaces run_npm with an echo, and runs one stage
// in a directory holding the given package.json text (or none).
function runPlanned(t, { pkg, live = 0, stage = ["demo", "demo", "mock"], extra = [], npmFails = false }) {
  const dir = tmp(t);
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, "package.json"), pkg);
  const results = path.join(dir, "results.tsv");
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^script_status()/,/^last_outcome=/p" "$1")"',
    'eval "$(sed -n "/^record()/,/^}$/p" "$1")"',
    'eval "$(sed -n "/^planned()/,/^}$/p" "$1")"',
    `LIVE=${live}; failed=0; results_file="$2"; : > "$results_file"`,
    npmFails ? 'run_npm() { echo "NPM $*"; return 1; }' : 'run_npm() { echo "NPM $*"; }',
    `planned ${[...stage, ...extra].map((s) => `'${s}'`).join(" ")}`,
    'echo "failed=$failed outcome=$last_outcome"',
  ].join("\n");
  const r = spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, results], { cwd: dir, encoding: "utf8" });
  const rows = fs.existsSync(results)
    ? fs.readFileSync(results, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t"))
    : [];
  return { ...r, rows };
}

test("planned: no package.json is a SKIP row, not a failure", (t) => {
  const r = runPlanned(t, {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^==> demo$/m);
  assert.match(r.stdout, /^SKIP \(not built yet\)$/m);
  assert.deepEqual(r.rows, [["SKIP", "demo", "SKIP (not built yet)"]]);
  assert.match(r.stdout, /failed=0 outcome=skip/);
});

test("planned: an npm script that is not defined is a SKIP row; invalid package.json is a FAIL row", (t) => {
  const absent = runPlanned(t, { pkg: JSON.stringify({ scripts: { other: "true" } }) });
  assert.deepEqual(absent.rows, [["SKIP", "demo", "SKIP (not built yet)"]]);
  assert.match(absent.stdout, /failed=0 outcome=skip/);

  const broken = runPlanned(t, { pkg: "{ not json" });
  assert.deepEqual(broken.rows, [["FAIL", "demo", "package.json is not valid JSON"]]);
  assert.match(broken.stdout, /^FAIL: package\.json is not valid JSON$/m);
  assert.match(broken.stdout, /failed=1 outcome=fail/);
});

test("planned: a live-only stage is skipped without --live and never starts npm", (t) => {
  const pkg = JSON.stringify({ scripts: { "deploy:nft": "true" } });
  const r = runPlanned(t, { pkg, live: 0, stage: ["deploy nft", "deploy:nft", "live"] });
  assert.match(r.stdout, /^SKIP \(live testnet not requested\)$/m);
  assert.doesNotMatch(r.stdout, /^NPM /m);
  assert.deepEqual(r.rows, [["SKIP", "deploy nft", "npm run deploy:nft exists; live testnet not requested"]]);

  const live = runPlanned(t, { pkg, live: 1, stage: ["deploy nft", "deploy:nft", "live"] });
  assert.match(live.stdout, /^NPM live run deploy:nft --$/m);
  assert.deepEqual(live.rows, [["PASS", "deploy nft", "npm run deploy:nft (live)"]]);
});

test("planned: an auto stage follows --live, and extra arguments reach npm after --", (t) => {
  const pkg = JSON.stringify({ scripts: { anchor: "true", mint: "true" } });
  const mock = runPlanned(t, { pkg, live: 0, stage: ["mint", "mint", "auto"] });
  assert.match(mock.stdout, /^NPM mock run mint --$/m);
  assert.deepEqual(mock.rows, [["PASS", "mint", "npm run mint (mock)"]]);

  const live = runPlanned(t, { pkg, live: 1, stage: ["mint", "mint", "auto"] });
  assert.match(live.stdout, /^NPM live run mint --$/m);

  const args = runPlanned(t, { pkg, stage: ["round hash", "anchor", "mock"], extra: ["--dry-run", "--check"] });
  assert.match(args.stdout, /^NPM mock run anchor -- --dry-run --check$/m);
});

test("planned: a failing npm run is a FAIL row that sets failed; the evidence stage records no PASS itself", (t) => {
  const pkg = JSON.stringify({ scripts: { demo: "true", evidence: "true" } });
  const fail = runPlanned(t, { pkg, npmFails: true });
  assert.match(fail.stdout, /^FAIL: npm run demo failed$/m);
  assert.deepEqual(fail.rows, [["FAIL", "demo", "npm run demo failed"]]);
  assert.match(fail.stdout, /failed=1 outcome=fail/);

  const ev = runPlanned(t, { pkg, stage: ["evidence", "evidence", "auto"] });
  assert.deepEqual(ev.rows, [], "the PASS row for evidence is written only after evidence_ok");
  assert.match(ev.stdout, /failed=0 outcome=pass/);
});

test("planned: an unknown stage kind is a FAIL row", (t) => {
  const r = runPlanned(t, { pkg: JSON.stringify({ scripts: { demo: "true" } }), stage: ["demo", "demo", "bogus"] });
  assert.deepEqual(r.rows, [["FAIL", "demo", "unknown stage kind"]]);
  assert.match(r.stdout, /failed=1/);
});

// ---- evidence_ok in live mode ----

function evidenceOk(t, content, mode) {
  const dir = tmp(t);
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, "out"));
    fs.writeFileSync(path.join(dir, "out", "evidence.json"), typeof content === "string" ? content : JSON.stringify(content));
  }
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^evidence_ok()/,/^results_file=/p" "$1" | sed "\\$d")"',
    'evidence_ok "$2"',
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, mode], { cwd: dir, encoding: "utf8" });
}

const HASH = "9".repeat(44);
const liveEvidence = (over = {}) => ({
  network: "testnet",
  transactions: [{ label: "deploy", hash: HASH }],
  views: [{ method: "nft_tokens", result: [] }],
  ...over,
});

test("evidence_ok live accepts a hash plus a view that carries a result key (even a null result)", (t) => {
  assert.equal(evidenceOk(t, liveEvidence(), "live").status, 0);
  assert.equal(evidenceOk(t, liveEvidence({ views: [{ method: "sheet_anchor", result: null }] }), "live").status, 0);
});

test("evidence_ok live rejects a non-testnet network, a missing or short hash, and a view without a result key", (t) => {
  const bad = [
    [liveEvidence({ network: "mainnet" }), /evidence network must be testnet/],
    [liveEvidence({ transactions: [] }), /needs transaction hashes and RPC view results/],
    [liveEvidence({ transactions: [{ hash: "abc" }] }), /needs transaction hashes and RPC view results/],
    [liveEvidence({ transactions: [{ hash: `0${HASH}` }] }), /needs transaction hashes and RPC view results/],
    [liveEvidence({ views: [{ method: "nft_tokens", error: "HTTP 500" }] }), /needs transaction hashes and RPC view results/],
  ];
  for (const [ev, msg] of bad) {
    const r = evidenceOk(t, ev, "live");
    assert.equal(r.status, 1, JSON.stringify(ev));
    assert.match(r.stderr, msg);
  }
});

test("evidence_ok reports a missing file, non-JSON and a non-object file with distinct messages", (t) => {
  const cases = [
    [undefined, /^missing out\/evidence\.json$/m],
    ["{oops", /^out\/evidence\.json is not JSON$/m],
    ["[1,2]", /^out\/evidence\.json must be a JSON object$/m],
  ];
  for (const mode of ["mock", "live"]) {
    for (const [content, msg] of cases) {
      const r = evidenceOk(t, content, mode);
      assert.equal(r.status, 1, `${mode} ${content}`);
      assert.match(r.stderr, msg);
    }
  }
});
