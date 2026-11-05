// Tests for scripts/yield-shade-check.mjs (the "yield shade" stage of scripts/verify.sh).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DRY_RUN_SCRIPT, GUARD_SCRIPT, SHIM_MARKER, SHIM_NAMES, checkShadePlan, createShims, runGuarded } from "./yield-shade-check.mjs";

const CHECK = fileURLToPath(new URL("./yield-shade-check.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.sh", import.meta.url));

let root, shimDir, guardLog, realPlan, realStdout;

before(() => {
  root = mkdtempSync(join(tmpdir(), "yield-shade-check-test-"));
  shimDir = join(root, "bin");
  mkdirSync(shimDir);
  createShims(shimDir);
  guardLog = join(root, "guard.log");
  const r = spawnSync(process.execPath, [DRY_RUN_SCRIPT, "--json"], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 0, r.stderr);
  realStdout = r.stdout;
  realPlan = JSON.parse(r.stdout);
});
after(() => rmSync(root, { recursive: true, force: true }));

function mutated(mutate) {
  const plan = structuredClone(realPlan);
  mutate(plan);
  return checkShadePlan(plan, JSON.stringify(plan));
}

test("the real --json plan has no problems, and its public keys are not mistaken for private keys", () => {
  assert.match(realStdout, /ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}"/);
  assert.deepEqual(checkShadePlan(realPlan, realStdout), []);
});

const CASES = [
  ["signed true", (p) => { p.signed = true; }, /signed must be false/],
  ["sent true", (p) => { p.sent = true; }, /sent must be false/],
  ["dry_run false", (p) => { p.dry_run = false; }, /dry_run must be true/],
  ["network mainnet", (p) => { p.network = "mainnet"; }, /network must be "testnet"/],
  ["nested signed true", (p) => { p.execute_swap.signed = true; }, /plan execute_swap\.signed is true/],
  ["nested sent true in array", (p) => { p.extra = [{ sent: true }]; }, /plan extra\[0\]\.sent is true/],
  ["nested dry_run false", (p) => { p.mpc.dry_run = false; }, /plan mpc\.dry_run is false/],
  ["private-key-looking string", (p) => { p.note = `ed25519:${"Z".repeat(87)}`; }, /private key/],
  ["secret_key field", (p) => { p.note = 'secret_key: "abc123"'; }, /secret_key/],
];
for (const [name, mutate, pattern] of CASES) {
  test(`checkShadePlan flags ${name}`, () => {
    const problems = mutated(mutate);
    assert.ok(problems.some((m) => pattern.test(m)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  });
}

test("checkShadePlan rejects a non-object", () => {
  assert.deepEqual(checkShadePlan([]), ["plan is not a JSON object"]);
});

function toy(name, body) {
  const file = join(root, name);
  writeFileSync(file, body);
  return file;
}

test("the guard records and blocks fetch, child_process (named and default import), net and http", () => {
  const log = join(root, "toy.log");
  const file = toy("toy.mjs", `
import { spawnSync } from "node:child_process";
import cp from "node:child_process";
import net from "node:net";
import https from "node:https";
const out = {};
const attempt = async (name, fn) => { try { await fn(); out[name] = "ran"; } catch (e) { out[name] = /yield-shade-check guard/.test(e.message) ? "blocked" : "other:" + e.message; } };
await attempt("fetch", () => fetch("http://127.0.0.1:9/"));
await attempt("spawnSync", () => spawnSync("true"));
await attempt("execSync", () => cp.execSync("true"));
await attempt("net", () => net.connect(9, "127.0.0.1"));
await attempt("https", () => https.request("https://127.0.0.1:9/"));
console.log(JSON.stringify(out));
`);
  const r = spawnSync(process.execPath, ["--import", GUARD_SCRIPT, file], { encoding: "utf8", env: { PATH: process.env.PATH, YIELD_SHADE_GUARD_LOG: log } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { fetch: "blocked", spawnSync: "blocked", execSync: "blocked", net: "blocked", https: "blocked" });
  assert.deepEqual(readFileSync(log, "utf8").split("\n").filter(Boolean), ["fetch", "child_process.spawnSync", "child_process.execSync", "net.connect", "https.request"]);
});

test("without the guard the same toy script is not blocked (the guard is not a no-op)", () => {
  const file = toy("toy-plain.mjs", `
import { spawnSync } from "node:child_process";
console.log(spawnSync("true").status);
`);
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "0");
});

test("the near shims record an execution and fail, so a stray near call cannot go unseen", () => {
  assert.equal(existsSync(join(shimDir, SHIM_MARKER)), false);
  const local = join(root, "shim-run");
  mkdirSync(local);
  createShims(local);
  for (const name of SHIM_NAMES) {
    const r = spawnSync(name, ["tokens", "send"], { encoding: "utf8", env: { PATH: `${local}:${process.env.PATH}` } });
    assert.equal(r.status, 1, name);
  }
  const lines = readFileSync(join(local, SHIM_MARKER), "utf8").split("\n").filter(Boolean);
  assert.deepEqual(lines, SHIM_NAMES.map((n) => `${n} tokens send`));
});

test("a script that runs near under the guard is stopped before the shim runs, and recorded", () => {
  const log = join(root, "near.log");
  const file = toy("toy-near.mjs", `
import { spawnSync } from "node:child_process";
try { spawnSync("near", ["tokens"]); } catch { console.log("stopped"); }
`);
  const r = spawnSync(process.execPath, ["--import", GUARD_SCRIPT, file], { encoding: "utf8", env: { PATH: `${shimDir}:${process.env.PATH}`, YIELD_SHADE_GUARD_LOG: log } });
  assert.equal(r.stdout.trim(), "stopped");
  assert.match(readFileSync(log, "utf8"), /child_process\.spawnSync/);
  assert.equal(existsSync(join(shimDir, SHIM_MARKER)), false);
});

test("runGuarded runs the real dry run with no guard or shim hits", () => {
  const r = runGuarded({ args: ["--json"], cwd: root, shimDir, guardLog: join(root, "real.log") });
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.deepEqual(r.guardHits, []);
  assert.deepEqual(r.shimHits, []);
});

test("CLI end to end exits 0 and prints exactly the success line", () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, "yield shade: dry_run true, signed false, sent false, network testnet; no near CLI, network or subprocess call; 5 refused flags and NEAR_NETWORK=mainnet exit 1\n");
});

test("CLI fails with usage on an unknown argument and on a bad timeout", () => {
  for (const args of [["--bogus"], ["--timeout-ms", "abc"], ["--timeout-ms"]]) {
    const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^FAIL: .*\nUsage: node scripts\/yield-shade-check\.mjs/);
  }
});

test("CLI reports a timeout as FAIL", () => {
  const r = spawnSync(process.execPath, [CHECK, "--timeout-ms", "1"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^FAIL: dry run timed out after 0\.001s$/m);
});

test("verify.sh runs the shade check after the yield demo stage and expects its row", () => {
  const text = readFileSync(VERIFY, "utf8");
  const demoAt = text.indexOf('planned "yield demo" "yield:demo:check" mock');
  const shadeAt = text.indexOf('planned "yield shade" "yield:shade:check" mock');
  assert.ok(demoAt > 0 && shadeAt > demoAt, "yield shade stage must follow the yield demo stage");
  assert.match(text, /"yield demo" "yield shade" "vault tests"/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["yield:shade:check"], "node scripts/yield-shade-check.mjs");
});
