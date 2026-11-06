#!/usr/bin/env node
// Judge-screen check for the unsigned live-path planner (the "yield live" stage of scripts/verify.sh).
//
//   node scripts/yield-live-check.mjs [--timeout-ms N]
//
// Runs `node scripts/yield-live.mjs dry-run --json` from an empty directory under the same no-near-CLI,
// no-network, no-subprocess guard the Shade check uses (scripts/yield-shade-check.mjs) and PROVES it never
// signs or sends: the plan must say unsigned true, network testnet and no problems, contain no signed/sent
// flag and no private key, and the guard and the near shims must record nothing. Every signing flag and
// NEAR_NETWORK=mainnet must exit 2 with nothing on stdout. Only dry-run is exercised: preflight spawns cargo.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TIMEOUT_MS, SHIM_MARKER, createShims, runGuarded } from "./yield-shade-check.mjs";

export { DEFAULT_TIMEOUT_MS };
export const REFUSED_FLAGS = ["--send", "--sign", "--i-approve", "--broadcast", "--sign-with-keychain", "--private-key"];
export const LIVE_SCRIPT = fileURLToPath(new URL("./yield-live.mjs", import.meta.url));
export const MIN_STEPS = 30;

const USAGE = "Usage: node scripts/yield-live-check.mjs [--timeout-ms N]";
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A NEAR/ed25519 secret key is 64 bytes: ed25519: plus 86-88 base58 chars. Public keys are 43-44 chars.
const PRIVATE_KEY_RE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/;
const SECRET_FIELD_RE = /(secret_key|private_key|seed_phrase)["']?\s*[:=]\s*["']?[^\s"',}]+/i;

function walk(value, path, visit) {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, visit);
}

/** Problems found in the planner's stdout text and parsed plan; an empty list means it is a safe unsigned plan. */
export function checkLivePlan(plan, stdout = JSON.stringify(plan)) {
  if (!isObject(plan)) return ["plan is not a JSON object"];
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  expect(plan.unsigned === true, `plan unsigned must be true (got ${JSON.stringify(plan.unsigned)})`);
  expect(plan.network === "testnet", `plan network must be "testnet" (got ${JSON.stringify(plan.network)})`);
  expect(Array.isArray(plan.problems) && plan.problems.length === 0, `plan problems must be an empty list (got ${JSON.stringify(plan.problems)})`);
  expect(Array.isArray(plan.transactions) && plan.transactions.length >= MIN_STEPS, `plan must list at least ${MIN_STEPS} transactions (got ${Array.isArray(plan.transactions) ? plan.transactions.length : JSON.stringify(plan.transactions)})`);
  walk(plan, "", (value, path) => {
    const key = path.split(/[.[]/).pop().replace(/\]$/, "");
    if ((key === "signed" || key === "sent") && value === true) problems.push(`plan ${path} is true`);
    if (key === "unsigned" && value === false) problems.push(`plan ${path} is false`);
  });
  if (PRIVATE_KEY_RE.test(stdout)) problems.push("output contains something that looks like an ed25519 private key");
  if (SECRET_FIELD_RE.test(stdout)) problems.push("output contains a secret_key/private_key/seed_phrase value");
  return problems;
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

/** Run every check; returns { problems, steps }. */
export function runChecks({ timeoutMs = DEFAULT_TIMEOUT_MS, script = LIVE_SCRIPT } = {}) {
  const problems = [];
  let steps = 0;
  const root = mkdtempSync(join(tmpdir(), "yield-live-check-"));
  try {
    const shimDir = join(root, "bin");
    const emptyCwd = join(root, "cwd");
    mkdirSync(shimDir);
    mkdirSync(emptyCwd);
    createShims(shimDir);
    const ctx = { shimDir, guardLog: join(root, "guard.log"), timeoutMs, script, cwd: emptyCwd };
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
    const main = runGuarded({ ...ctx, args: ["dry-run", "--json"] });
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
      if (plan !== undefined) {
        problems.push(...checkLivePlan(plan, main.run.stdout));
        if (Array.isArray(plan?.transactions)) steps = plan.transactions.length;
      }
    }
    hits("dry run", main);
    if (existsSync(join(shimDir, SHIM_MARKER))) problems.push("near shim marker file exists");
    const left = readdirSync(emptyCwd);
    if (left.length > 0) problems.push(`dry run wrote files: ${left.join(", ")}`);

    // 2. Every refusal path exits 2 with nothing on stdout.
    const refusals = [
      ...REFUSED_FLAGS.map((flag) => ({ label: flag, args: ["dry-run", flag], extraEnv: {} })),
      { label: "NEAR_NETWORK=mainnet", args: ["dry-run"], extraEnv: { NEAR_NETWORK: "mainnet" } },
    ];
    for (const { label, args, extraEnv } of refusals) {
      const r = runGuarded({ ...ctx, args, extraEnv });
      const failure = failed(`${label} run`, r.run);
      if (failure) problems.push(failure);
      else {
        if (r.run.status !== 2) problems.push(`${label} must exit 2 (got ${r.run.status ?? r.run.signal})`);
        if (r.run.stdout !== "") problems.push(`${label} must print nothing on stdout`);
      }
      hits(label, r);
    }
    const leftAfter = readdirSync(emptyCwd);
    if (leftAfter.length > 0) problems.push(`refused runs wrote files: ${leftAfter.join(", ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { problems, steps };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }
  const { problems, steps } = runChecks(opts);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    return 1;
  }
  console.log(`yield live: dry-run unsigned true, network testnet, ${steps} steps, plan valid; no near CLI, network or subprocess call; ${REFUSED_FLAGS.length} refused flags and NEAR_NETWORK=mainnet exit 2`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
