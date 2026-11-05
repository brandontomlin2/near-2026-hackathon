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

const nogoPath = join(root, "docs/yield-shade-go-nogo.md");
const nogo = existsSync(nogoPath) ? readFileSync(nogoPath, "utf8") : "";
const plan = readFileSync(join(root, "docs/yield-shade-agent-plan.md"), "utf8");
const nogoSection = (title) => nogo.match(new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1] ?? "";
const tableRow = (text, label) => text.match(new RegExp(`^\\| ${label} \\| (.*) \\|$`, "m"))?.[1];
const yesItems = [...nogoSection("Steps that need an explicit yes").matchAll(/^- \[(.)\] \*\*(\d+)\. /gm)];

test("go/no-go checklist has exactly 10 yes-gated steps, numbered 1 to 10, none ticked", () => {
  assert.deepEqual(yesItems.map((m) => Number(m[2])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(yesItems.map((m) => m[1]), Array(10).fill(" "));
  // No checkbox anywhere in the file is ticked (the decision row included).
  assert.doesNotMatch(nogo, /\[[xX]\]/);
});

test("go/no-go decision is not decided: all three options unticked, recommendation stays Partial", () => {
  assert.equal(tableRow(nogoSection("Decision"), "My decision"), "[ ] Go   [ ] Partial   [ ] No-go   (not decided)");
  assert.equal(tableRow(nogoSection("Decision"), "Recommendation"), "**Partial**");
  assert.match(plan, /^\*\*Recommendation: Partial\.\*\*/m);
});

test("go/no-go status at a glance matches the checklist it summarizes", () => {
  const glance = nogoSection("Status at a glance");
  assert.match(tableRow(glance, "Decision") ?? "", /^not decided \(Brandon decides by 2026-11-06\)$/);
  assert.match(tableRow(glance, "Recommendation") ?? "", /^Partial \(not a decision\)$/);
  const done = tableRow(glance, "Yes-gated steps done") ?? "";
  const ticked = yesItems.filter((m) => m[1] !== " ").length;
  assert.match(done, new RegExp(`^${ticked} of ${yesItems.length}\\. All ${yesItems.length} are NOT DONE`));
  assert.match(tableRow(glance, "Live Shade evidence") ?? "", /^none: no transaction id/);
});

test("README Shade subsection states the same undecided status and counts as the checklist", () => {
  const status = sub.split("\n").find((l) => l.startsWith("Go/no-go status:")) ?? "";
  assert.match(status, /^Go\/no-go status: not decided \(the owner decides by 2026-11-06; the plan recommends Partial\)\./);
  const ticked = yesItems.filter((m) => m[1] !== " ").length;
  assert.ok(status.includes(`${ticked} of ${yesItems.length} yes-gated steps are done; all ${yesItems.length} are NOT DONE`), status);
  assert.match(status, /No Shade account, deployment, signature or transaction id exists\./);
});

test("go/no-go 'What runs today without a yes' steps: quoted lines are real output and exit codes match", () => {
  const today = numberedSteps(nogoSection("What runs today without a yes")).map(({ n, text }) => {
    const [head, ...rest] = text.split(/ See /);
    return { n, command: spans(head)[0], quotes: spans(rest.join(" See ")), exit: Number(/Exit (\d+)\.\s*$/.exec(text)?.[1]) };
  });
  // Same commands as the README steps, so a judge sees one consistent path.
  assert.deepEqual(today.map((s) => s.command), steps.map((s) => s.command));
  for (const step of today) {
    assert.ok(step.quotes.length >= 1, `step ${step.n} quotes at least 1 line`);
    const { status, lines } = run(step.command);
    assert.equal(status, step.exit, `checklist step ${step.n} (${step.command}) exit code`);
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `checklist step ${step.n} quotes a line it does not print: ${q}`);
  }
});

test("No-go fallback is dry-run only and every command and file it names exists", () => {
  const fallback = nogoSection("No-go fallback");
  assert.ok(fallback, "## No-go fallback section exists");
  assert.match(fallback, /dry-run evidence and nothing live/);
  assert.match(fallback, /`dry_run: true, signed: false, sent: false`/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = [...fallback.matchAll(/`npm run ([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2);
  for (const s of scripts) assert.ok(pkg.scripts[s], `package.json has script ${s}`);
  for (const [, file] of fallback.matchAll(/`(spikes\/[^`\s]+\.txt)`/g)) assert.ok(existsSync(join(root, file)), `${file} exists`);
  // No live artifacts: no explorer links and no 64-hex or base58 transaction hash.
  assert.doesNotMatch(fallback, /nearblocks|explorer\.|testnet\.near\.org\/txns/i);
  assert.doesNotMatch(fallback, /\b[0-9a-f]{64}\b|\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/);
});

test("every link into the go/no-go checklist from README and plan resolves to a heading", () => {
  const slug = (h) => h.trim().toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
  const anchors = new Set([...nogo.matchAll(/^#{1,6} (.*)$/gm)].map((m) => slug(m[1])));
  const links = [
    ...[...readme.matchAll(/\]\(docs\/yield-shade-go-nogo\.md#([^)]+)\)/g)].map((m) => ["README.md", m[1]]),
    ...[...plan.matchAll(/\]\(yield-shade-go-nogo\.md#([^)]+)\)/g)].map((m) => ["plan", m[1]]),
    ...[...nogo.matchAll(/\]\(#([^)]+)\)/g)].map((m) => ["checklist", m[1]]),
  ];
  assert.ok(links.length >= 4, `expected at least 4 anchored links, found ${links.length}`);
  for (const [from, anchor] of links) assert.ok(anchors.has(anchor), `${from} links to missing anchor #${anchor}`);
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
