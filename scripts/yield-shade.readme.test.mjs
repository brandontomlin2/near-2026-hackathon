// Locks the README's "Shade Agent dry run" subsection to the real output of
// scripts/yield-shade-dry-run.mjs, and checks the owner go/no-go checklist.
// Every backticked span after "See" in a step must be a full trimmed line of
// the command's stdout or stderr, and the exit code must match.
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

const sub = section(readme, "Yield Optimizer").match(/^### Shade Agent dry run[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
const steps = numberedSteps(sub).map(({ n, text }) => {
  const [head, ...rest] = text.split(/ See /);
  const [command] = spans(head);
  return { n, command, quotes: spans(rest.join(" See ")), exit: Number(/Exit (\d+)\.\s*$/.exec(text)?.[1]) };
});

function run(command) {
  if (command === "npm run yield:shade:check") return runScript("scripts/yield-shade-check.mjs", []);
  const m = /^npm run yield:shade:dry-run(?:\s+--\s+(.*))?$/.exec(command);
  assert.ok(m, `unexpected command: ${command}`);
  return runScript("scripts/yield-shade-dry-run.mjs", m[1] ? m[1].split(/\s+/) : []);
}

function runScript(script, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, lines: trimmedLines(`${r.stdout}\n${r.stderr}`) };
}

test("package.json maps yield:shade:dry-run to the script", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["yield:shade:dry-run"], "node scripts/yield-shade-dry-run.mjs");
});

test("README has the Shade Agent dry run subsection with four steps", () => {
  assert.ok(sub, "### Shade Agent dry run subsection exists under ## Yield Optimizer");
  assert.deepEqual(steps.map((s) => s.command), [
    "npm run yield:shade:dry-run",
    "npm run yield:shade:dry-run -- --json",
    "npm run yield:shade:dry-run -- --sign",
    "npm run yield:shade:check",
  ]);
  assert.deepEqual(steps.map((s) => s.exit), [0, 0, 1, 0]);
  for (const s of steps) assert.ok(s.quotes.length >= 1, `step ${s.n} quotes at least 1 line`);
});

test("README Shade steps: every quoted line is a full line of the real output and the exit code matches", () => {
  for (const step of steps) {
    const { status, lines } = run(step.command);
    assert.equal(status, step.exit, `step ${step.n} (${step.command}) exit code`);
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `step ${step.n} (${step.command}) quotes a line it does not print: ${q}`);
  }
});

test("README links the go/no-go checklist and the file links the plan's section 9", () => {
  assert.match(readme, /\]\(docs\/yield-shade-go-nogo\.md\)/);
  assert.match(readme, /\]\(docs\/yield-shade-agent-plan\.md\)/);
  const file = join(root, "docs/yield-shade-go-nogo.md");
  assert.ok(existsSync(file), "docs/yield-shade-go-nogo.md exists");
  assert.match(readFileSync(file, "utf8"), /\]\(yield-shade-agent-plan\.md#9-gono-go-for-brandon\)/);
});

test("go/no-go checklist: nothing is checked and every item needs YES and is NOT DONE", () => {
  const text = readFileSync(join(root, "docs/yield-shade-go-nogo.md"), "utf8");
  assert.match(text, /performs nothing/i);
  assert.match(text, /Nothing in it has been done/);
  const items = [...text.matchAll(/^- \[( |x|X)\] (.*)$/gm)];
  assert.ok(items.length >= 8, "at least 8 checklist items");
  for (const [, mark, body] of items) {
    assert.equal(mark, " ", `item is checked: ${body.slice(0, 60)}`);
    assert.ok(body.includes("needs YES"), `item lacks "needs YES": ${body.slice(0, 60)}`);
    assert.ok(body.includes("Status: NOT DONE - needs YES"), `item lacks the status line: ${body.slice(0, 60)}`);
  }
});

test("plan section 9 points at the checklist and cites existing step numbers", () => {
  const plan = readFileSync(join(root, "docs/yield-shade-agent-plan.md"), "utf8");
  const s9 = plan.match(/^## 9\. [^\n]*\n([\s\S]*?)(?=^## 10\.)/m)?.[1] ?? "";
  assert.match(s9, /yield-shade-go-nogo\.md/);
  const s7 = plan.match(/^## 7\. [^\n]*\n([\s\S]*?)(?=^## 8\.)/m)?.[1] ?? "";
  assert.match(s7, /^8\. First real signature/m);
  assert.match(s7, /^10\. Broadcast one `execute_swap`/m);
  assert.match(s7, /^12\. TEE:/m);
});
