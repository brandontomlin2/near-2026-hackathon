// Locks the README's "Judge path (offline, yield)" subsection to real output.
// Every backticked span after "See" in a step must be a full trimmed line of the
// command's stdout or stderr, and the exit code must match.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { numberedSteps, section, trimmedLines } from "./readme-yield-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

const sub = section(readme, "Yield Optimizer").match(/^### Judge path \(offline, yield\)[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
const steps = numberedSteps(sub).map(({ n, text }) => {
  const [head, ...rest] = text.split(/ See /);
  const [command] = spans(head);
  return { n, command, quotes: spans(rest.join(" See ")), exit: Number(/Exit (\d+)\./.exec(text)?.[1]) };
});

function run(command) {
  const m = /^npm run (\S+)(?:\s+--\s+(.*))?$/.exec(command);
  assert.ok(m, `unexpected command: ${command}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = ["run", "-s", m[1], ...(m[2] ? ["--", ...m[2].split(/\s+/)] : [])];
  const r = spawnSync("npm", args, { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, lines: trimmedLines(`${r.stdout}\n${r.stderr}`) };
}

test("README has the judge path subsection with the four expected commands in order", () => {
  assert.ok(sub, "### Judge path (offline, yield) subsection exists under ## Yield Optimizer");
  assert.deepEqual(steps.map((s) => s.command), [
    "npm run yield:demo",
    "npm run yield:shade:check",
    "npm run yield:live:check",
    "npm run yield:live:dry-run -- --send",
  ]);
  assert.deepEqual(steps.map((s) => s.exit), [0, 0, 0, 2]);
  for (const s of steps) assert.ok(s.quotes.length >= 1, `step ${s.n} quotes at least 1 line`);
});

test("README judge path: every quoted line is a full line of the real output and the exit code matches", () => {
  for (const step of steps) {
    const { status, lines } = run(step.command);
    assert.equal(status, step.exit, `step ${step.n} (${step.command}) exit code`);
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `step ${step.n} (${step.command}) quotes a line it does not print: ${q}`);
  }
});

test("README judge path never quotes an absolute path", () => {
  for (const s of steps) for (const q of s.quotes) {
    assert.doesNotMatch(q, /(^|\s)\/(Users|home|tmp|var|private)\//, `absolute path in step ${s.n}`);
  }
});
