// Tests for scripts/yield-live-check.mjs (the "yield live" stage of scripts/verify.sh).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { LIVE_SCRIPT, REFUSED_FLAGS, checkLivePlan, runChecks } from "./yield-live-check.mjs";

const CHECK = fileURLToPath(new URL("./yield-live-check.mjs", import.meta.url));
const VERIFY = fileURLToPath(new URL("./verify.sh", import.meta.url));

let root, realPlan, realStdout;

before(() => {
  root = mkdtempSync(join(tmpdir(), "yield-live-check-test-"));
  const r = spawnSync(process.execPath, [LIVE_SCRIPT, "dry-run", "--json"], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 0, r.stderr);
  realStdout = r.stdout;
  realPlan = JSON.parse(r.stdout);
});
after(() => rmSync(root, { recursive: true, force: true }));

function mutated(mutate) {
  const plan = structuredClone(realPlan);
  mutate(plan);
  return checkLivePlan(plan, JSON.stringify(plan));
}

// Built at runtime: 88 base58 chars after the prefix looks like a 64-byte ed25519 secret key.
const fakeSecret = () => `ed25519:${"Z".repeat(88)}`;

test("the real dry-run plan has no problems", () => {
  assert.deepEqual(checkLivePlan(realPlan, realStdout), []);
  assert.ok(realPlan.transactions.length >= 30);
});

const CASES = [
  ["unsigned false", (p) => { p.unsigned = false; }, /unsigned must be true/],
  ["network mainnet", (p) => { p.network = "mainnet"; }, /network must be "testnet"/],
  ["non-empty problems", (p) => { p.problems = ["bad config"]; }, /problems must be an empty list/],
  ["too few transactions", (p) => { p.transactions = p.transactions.slice(0, 3); }, /at least 30 transactions/],
  ["nested signed true", (p) => { p.transactions[0].signed = true; }, /plan transactions\[0\]\.signed is true/],
  ["nested sent true", (p) => { p.extra = { deep: [{ sent: true }] }; }, /plan extra\.deep\[0\]\.sent is true/],
  ["private key string", (p) => { p.note = fakeSecret(); }, /private key/],
  ["secret_key field", (p) => { p.note = 'secret_key: "abc123"'; }, /secret_key/],
];
for (const [name, mutate, pattern] of CASES) {
  test(`checkLivePlan flags ${name}`, () => {
    const problems = mutated(mutate);
    assert.ok(problems.some((m) => pattern.test(m)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  });
}

test("checkLivePlan rejects a non-object", () => {
  assert.deepEqual(checkLivePlan([]), ["plan is not a JSON object"]);
});

const PLAN_JS = `const plan = { network: "testnet", unsigned: true, problems: [], transactions: Array.from({ length: 36 }, (_, i) => ({ i })) };`;

function fake(name, body) {
  const file = join(root, name);
  writeFileSync(file, `${PLAN_JS}\n${body}\nconsole.log(JSON.stringify(plan));\n`);
  return file;
}

test("a planner that calls fetch is caught by the guard", () => {
  const { problems } = runChecks({ script: fake("fake-fetch.mjs", 'try { await fetch("http://127.0.0.1:9/"); } catch {}') });
  assert.ok(problems.some((m) => /guard recorded fetch/.test(m)), JSON.stringify(problems));
});

test("a planner that spawns a process is caught by the guard", () => {
  const body = 'import("node:child_process").then(() => {}); const cp = await import("node:child_process"); try { cp.spawnSync("true"); } catch {}';
  const { problems } = runChecks({ script: fake("fake-spawn.mjs", body) });
  assert.ok(problems.some((m) => /guard recorded child_process\.spawnSync/.test(m)), JSON.stringify(problems));
});

test("a planner that writes a file to its cwd is caught", () => {
  const body = 'const fs = await import("node:fs"); fs.writeFileSync("leak.txt", "x");';
  const { problems } = runChecks({ script: fake("fake-write.mjs", body) });
  assert.ok(problems.some((m) => /dry run wrote files: leak\.txt/.test(m)), JSON.stringify(problems));
});

test("a planner that does not refuse signing flags is caught", () => {
  const { problems } = runChecks({ script: fake("fake-no-refuse.mjs", "") });
  for (const flag of REFUSED_FLAGS) assert.ok(problems.some((m) => m.startsWith(`${flag} must exit 2`)), flag);
  assert.ok(problems.some((m) => m.startsWith("NEAR_NETWORK=mainnet must exit 2")));
});

test("the real planner passes every check", () => {
  const { problems, steps } = runChecks({});
  assert.deepEqual(problems, []);
  assert.equal(steps, realPlan.transactions.length);
});

test("CLI end to end exits 0 and prints exactly the success line", () => {
  const r = spawnSync(process.execPath, [CHECK], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, `yield live: dry-run unsigned true, network testnet, ${realPlan.transactions.length} steps, plan valid; no near CLI, network or subprocess call; 6 refused flags and NEAR_NETWORK=mainnet exit 2\n`);
});

test("CLI fails with usage on an unknown argument and on a bad timeout", () => {
  for (const args of [["--bogus"], ["--timeout-ms", "abc"], ["--timeout-ms"]]) {
    const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^FAIL: .*\nUsage: node scripts\/yield-live-check\.mjs/);
  }
});

test("CLI reports a timeout as FAIL", () => {
  const r = spawnSync(process.execPath, [CHECK, "--timeout-ms", "1"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^FAIL: dry run timed out after 0\.001s$/m);
});

test("verify.sh runs the live check after the yield shade stage and expects its row", () => {
  const text = readFileSync(VERIFY, "utf8");
  const shadeAt = text.indexOf('planned "yield shade" "yield:shade:check" mock');
  const liveAt = text.indexOf('planned "yield live" "yield:live:check" mock');
  assert.ok(shadeAt > 0 && liveAt > shadeAt, "yield live stage must follow the yield shade stage");
  assert.match(text, /"yield shade" "yield live" "vault tests"/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["yield:live:check"], "node scripts/yield-live-check.mjs");
});
