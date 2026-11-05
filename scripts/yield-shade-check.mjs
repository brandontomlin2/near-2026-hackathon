#!/usr/bin/env node
// Judge-screen check for the Shade dry run (the "yield shade" stage of scripts/verify.sh).
//
//   node scripts/yield-shade-check.mjs [--timeout-ms N]
//
// Runs `node scripts/yield-shade-dry-run.mjs --json` in a sanitized environment and PROVES it never signs
// or sends: a PATH shim makes any `near` / `near-cli` / `near-cli-rs` execution leave a marker, and a preload
// guard (scripts/yield-shade-check-guard.mjs) records and blocks fetch, sockets, http(s) and every
// child_process call. The plan JSON must say dry_run true, signed false, sent false, network testnet and
// contain no private key. The refused flags and NEAR_NETWORK=mainnet must exit 1 with nothing on stdout.
// The run must also leave its working directory empty.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMEOUT_MS = 120000;
export const REFUSED_FLAGS = ["--sign", "--send", "--broadcast", "--i-approve", "--mainnet"];
export const SHIM_NAMES = ["near", "near-cli", "near-cli-rs"];
export const SHIM_MARKER = "near-shim-called";
export const GUARD_SCRIPT = fileURLToPath(new URL("./yield-shade-check-guard.mjs", import.meta.url));
export const DRY_RUN_SCRIPT = fileURLToPath(new URL("./yield-shade-dry-run.mjs", import.meta.url));

const USAGE = "Usage: node scripts/yield-shade-check.mjs [--timeout-ms N]";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A NEAR/ed25519 secret key is 64 bytes: ed25519: plus 86-88 base58 chars. Public keys are 43-44 chars.
const PRIVATE_KEY_RE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/;
const SECRET_FIELD_RE = /(secret_key|private_key|seed_phrase)["']?\s*[:=]\s*["']?[^\s"',}]+/i;

function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
}

/** Problems found in the dry run's stdout text and parsed plan; an empty list means it is a safe dry run. */
export function checkShadePlan(plan, stdout = JSON.stringify(plan)) {
  if (!isObject(plan)) return ["plan is not a JSON object"];
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  expect(plan.dry_run === true, `plan dry_run must be true (got ${JSON.stringify(plan.dry_run)})`);
  expect(plan.signed === false, `plan signed must be false (got ${JSON.stringify(plan.signed)})`);
  expect(plan.sent === false, `plan sent must be false (got ${JSON.stringify(plan.sent)})`);
  expect(plan.network === "testnet", `plan network must be "testnet" (got ${JSON.stringify(plan.network)})`);
  walk(plan, "", (value, path) => {
    const key = path.split(/[.[]/).pop().replace(/\]$/, "");
    if ((key === "signed" || key === "sent") && value === true) problems.push(`plan ${path} is true`);
    if (key === "dry_run" && value === false) problems.push(`plan ${path} is false`);
  });
  if (PRIVATE_KEY_RE.test(stdout)) problems.push("output contains something that looks like an ed25519 private key");
  if (SECRET_FIELD_RE.test(stdout)) problems.push("output contains a secret_key/private_key/seed_phrase value");
  return problems;
}

/** Create fake near CLIs in dir. Any execution appends to dir/SHIM_MARKER and exits 1. */
export function createShims(dir) {
  for (const name of SHIM_NAMES) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$(dirname "$0")/${SHIM_MARKER}"\nexit 1\n`);
    chmodSync(file, 0o755);
  }
}

/** The only environment the dry run sees: PATH (shims first) and HOME, plus the guard log path. */
export function sanitizedEnv(shimDir, guardLog, extra = {}) {
  return {
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "",
    YIELD_SHADE_GUARD_LOG: guardLog,
    ...extra,
  };
}

const readLog = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

/** Run one dry-run invocation under the guard. Returns the spawn result plus guard and shim hits. */
export function runGuarded({ args = [], extraEnv = {}, cwd, shimDir, guardLog, timeoutMs = DEFAULT_TIMEOUT_MS, script = DRY_RUN_SCRIPT }) {
  const run = spawnSync(process.execPath, ["--import", GUARD_SCRIPT, script, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    cwd,
    env: sanitizedEnv(shimDir, guardLog, extraEnv),
  });
  return { run, guardHits: readLog(guardLog), shimHits: readLog(join(shimDir, SHIM_MARKER)) };
}

function parseArgs(argv) {
  const opts = { timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout-ms") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--timeout-ms needs a value\n${USAGE}`);
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--timeout-ms must be a positive integer (got ${JSON.stringify(value)})\n${USAGE}`);
      opts.timeoutMs = Number(value);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argv[i])}\n${USAGE}`);
    }
  }
  return opts;
}

/** Run every check; returns the list of problems. */
export function runChecks({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const problems = [];
  const root = mkdtempSync(join(tmpdir(), "yield-shade-check-"));
  try {
    const shimDir = join(root, "bin");
    const emptyCwd = join(root, "cwd");
    mkdirSync(shimDir);
    mkdirSync(emptyCwd);
    createShims(shimDir);
    const guardLog = join(root, "guard.log");
    const ctx = { shimDir, guardLog, timeoutMs };
    const hits = (label, r) => {
      if (r.guardHits.length > 0) problems.push(`${label}: guard recorded ${r.guardHits.join(", ")}`);
      if (r.shimHits.length > 0) problems.push(`${label}: a near CLI was executed (${r.shimHits.join("; ")})`);
    };
    const failed = (label, run) => {
      if (run.error?.code === "ETIMEDOUT") return `${label} timed out after ${timeoutMs / 1000}s`;
      if (run.error) return `${label} could not run: ${run.error.message}`;
      return null;
    };

    // 1. The real run, in an empty directory so any file write is visible.
    const main = runGuarded({ ...ctx, args: ["--json"], cwd: emptyCwd });
    const mainFailure = failed("dry run", main.run);
    if (mainFailure) problems.push(mainFailure);
    else if (main.run.status !== 0) problems.push(`dry run exited with status ${main.run.status ?? main.run.signal}: ${(main.run.stderr ?? "").trim().split("\n")[0]}`);
    else {
      let plan;
      try {
        plan = JSON.parse(main.run.stdout);
      } catch (error) {
        problems.push(`dry run stdout is not JSON: ${String(error.message).split("\n")[0]}`);
      }
      if (plan !== undefined) problems.push(...checkShadePlan(plan, main.run.stdout));
    }
    hits("dry run", main);
    if (existsSync(join(shimDir, SHIM_MARKER))) problems.push("near shim marker file exists");
    const left = readdirSync(emptyCwd);
    if (left.length > 0) problems.push(`dry run wrote files: ${left.join(", ")}`);

    // 2. Every refusal path exits 1 with nothing on stdout.
    const refusals = [
      ...REFUSED_FLAGS.map((flag) => ({ label: flag, args: [flag], extraEnv: {} })),
      { label: "NEAR_NETWORK=mainnet", args: [], extraEnv: { NEAR_NETWORK: "mainnet" } },
    ];
    for (const { label, args, extraEnv } of refusals) {
      const r = runGuarded({ ...ctx, args, extraEnv, cwd: emptyCwd });
      const failure = failed(`${label} run`, r.run);
      if (failure) problems.push(failure);
      else {
        if (r.run.status !== 1) problems.push(`${label} must exit 1 (got ${r.run.status ?? r.run.signal})`);
        if (r.run.stdout !== "") problems.push(`${label} must print nothing on stdout`);
      }
      hits(label, r);
    }
    const leftAfter = readdirSync(emptyCwd);
    if (leftAfter.length > 0) problems.push(`refused runs wrote files: ${leftAfter.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return problems;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
  const problems = runChecks(opts);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    return 1;
  }
  console.log(`yield shade: dry_run true, signed false, sent false, network testnet; no near CLI, network or subprocess call; ${REFUSED_FLAGS.length} refused flags and NEAR_NETWORK=mainnet exit 1`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
