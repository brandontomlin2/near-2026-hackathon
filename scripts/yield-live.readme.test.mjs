// Locks the README's "Live testnet path, unsigned" subsection to the real output
// of scripts/yield-live.mjs. Every backticked span after "See" in a step must be
// a full trimmed line of the command's stdout or stderr, and the exit code must match.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { numberedSteps, section, trimmedLines } from "./readme-yield-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

const sub = section(readme, "Yield Optimizer").match(/^### Live testnet path, unsigned[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
const steps = numberedSteps(sub).map(({ n, text }) => {
  const [head, ...rest] = text.split(/ See /);
  const [command] = spans(head);
  return { n, command, quotes: spans(rest.join(" See ")), exit: Number(/Exit (\d+)\./.exec(text)?.[1]) };
});

function runScript(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(root, "scripts/yield-live.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, lines: trimmedLines(`${r.stdout}\n${r.stderr}`) };
}

function run(command) {
  const m = /^npm run yield:live:(dry-run|preflight)(?:\s+--\s+(.*))?$/.exec(command);
  assert.ok(m, `unexpected command: ${command}`);
  return runScript([m[1], ...(m[2] ? m[2].split(/\s+/) : [])]);
}

test("package.json maps yield:live:dry-run and yield:live:preflight to the script", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["yield:live:dry-run"], "node scripts/yield-live.mjs dry-run");
  assert.equal(pkg.scripts["yield:live:preflight"], "node scripts/yield-live.mjs preflight");
});

test("README has the live testnet path subsection with four steps", () => {
  assert.ok(sub, "### Live testnet path, unsigned subsection exists under ## Yield Optimizer");
  assert.deepEqual(steps.map((s) => s.command), [
    "npm run yield:live:dry-run",
    "npm run yield:live:dry-run -- --json",
    "npm run yield:live:dry-run -- --send",
    "npm run yield:live:preflight",
  ]);
  assert.deepEqual(steps.map((s) => s.exit), [0, 0, 2, 0]);
  for (const s of steps) assert.ok(s.quotes.length >= 1, `step ${s.n} quotes at least 1 line`);
});

test("README live steps: every quoted line is a full line of the real output and the exit code matches", () => {
  for (const step of steps) {
    const { status, lines } = run(step.command);
    assert.equal(status, step.exit, `step ${step.n} (${step.command}) exit code`);
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `step ${step.n} (${step.command}) quotes a line it does not print: ${q}`);
  }
});

test("README step 1 step count equals the transactions in dry-run --json", () => {
  const plan = JSON.parse(runScript(["dry-run", "--json"]).stdout);
  const count = /^Yield vault live path on testnet: (\d+) steps,/.exec(steps[0].quotes[0])?.[1];
  assert.equal(Number(count), plan.transactions.length);
  assert.equal(plan.unsigned, true);
  assert.deepEqual(plan.problems, []);
});

test("README never quotes an absolute path or claims READY FOR LIVE: yes", () => {
  for (const s of steps) for (const q of s.quotes) {
    assert.doesNotMatch(q, /(^|\s)\/(Users|home|tmp|var)\//, `absolute path in step ${s.n}`);
    assert.doesNotMatch(q, /READY FOR LIVE: yes/);
  }
});

test("subsection links the runbook and the go/no-go checklist, and both exist", () => {
  for (const f of ["docs/yield-vault-live-runbook.md", "docs/yield-shade-go-nogo.md"]) {
    assert.ok(sub.includes(`](${f})`), `subsection links ${f}`);
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  assert.ok(sub.includes("scripts/yield-live.readme.test.mjs"));
});
