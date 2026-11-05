// Locks the README's yield:demo claims to the real output of the demo.
// Every backticked line quoted in the "Offline demo" steps (and in the Judge
// quick path step for yield:demo) must be a full line of what the command
// really prints (plan.json quotes: a substring of a line). Also pins the
// cargo test count (number of #[test] fns in contracts/yield-vault/src) and
// the `node --test` pass count quoted for the yield tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { demoArgs, parseQuickYieldStep, parseYieldCounts, parseYieldDemo, sh, trimmedLines } from "./readme-yield-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const demo = parseYieldDemo(readme);
// Run the README's exact command with cwd = a temp dir, so the default out dir
// (out/yield-demo) and the "wrote out/yield-demo/plan.json" line match the README
// without touching the repo's own out/.
const work = mkdtempSync(join(tmpdir(), "yield-demo-readme-"));
test.after(() => rmSync(work, { recursive: true, force: true }));

function runDemo(command) {
  assert.equal(pkg.scripts["yield:demo"], "node scripts/yield-demo.mjs", "npm run yield:demo is node scripts/yield-demo.mjs");
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(root, "scripts/yield-demo.mjs"), ...demoArgs(command)], { cwd: work, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("README has the yield:demo subsection with run, --calls and plan.json steps", () => {
  assert.equal(demo.steps.length, 3, "three numbered steps");
  assert.deepEqual(demo.steps.map((s) => [s.command, s.kind]), [
    ["npm run yield:demo", "run"],
    ["npm run yield:demo -- --calls", "run"],
    ["out/yield-demo/plan.json", "file"],
  ]);
  for (const s of demo.steps) assert.ok(s.quotes.length >= 3, `step ${s.n} quotes at least 3 lines`);
  assert.match(demo.text, /<!-- judge:run -->/, "a judge:run block");
});

test("README yield:demo steps: every quoted line is a full line of the real output", () => {
  for (const step of demo.steps.filter((s) => s.kind === "run")) {
    const lines = trimmedLines(runDemo(step.command));
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `step ${step.n} (${step.command}) quotes a line it does not print: ${q}`);
  }
});

test("README yield:demo plan.json step: quoted keys appear in the written plan.json", () => {
  const step = demo.steps.find((s) => s.kind === "file");
  assert.equal(step.command, "out/yield-demo/plan.json", "README path is the default out dir");
  runDemo("npm run yield:demo");
  const lines = trimmedLines(readFileSync(join(work, "out/yield-demo/plan.json"), "utf8"));
  for (const q of step.quotes) {
    assert.ok(lines.some((l) => l.replace(/,$/, "") === q.trim()), `plan.json has no line ${q}`);
  }
});

test("Judge quick path step for yield:demo quotes real output lines", () => {
  const quick = parseQuickYieldStep(readme);
  assert.ok(quick, "Judge quick path has a yield:demo step");
  assert.equal(quick.command, "npm run yield:demo");
  assert.ok(quick.quotes.length >= 2);
  const lines = trimmedLines(runDemo(quick.command));
  for (const q of quick.quotes) assert.ok(lines.includes(q.trim()), `quick path quotes a line it does not print: ${q}`);
});

test("README judge:expect markers for the demo block are lines or substrings of the real output", () => {
  const expects = [...demo.text.matchAll(/<!-- judge:expect (.*?) -->/g)].map((m) => m[1]);
  assert.ok(expects.length >= 4);
  const all = [runDemo("npm run yield:demo"), runDemo("npm run yield:demo -- --calls"), readFileSync(join(work, "out/yield-demo/plan.json"), "utf8")].join("\n");
  for (const e of expects) assert.ok(all.includes(e), `judge:expect text not in output: ${e}`);
});

function countRustTests(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += countRustTests(p);
    else if (e.name.endsWith(".rs")) n += (readFileSync(p, "utf8").match(/^\s*#\[test\]/gm) ?? []).length;
  }
  return n;
}

test("README cargo test count equals the number of #[test] functions in contracts/yield-vault/src", () => {
  const { cargoPassed } = parseYieldCounts(readme);
  assert.ok(cargoPassed, "README quotes `test result: ok. N passed; 0 failed`");
  assert.equal(cargoPassed, countRustTests(join(root, "contracts/yield-vault/src")));
});

test("README node --test pass count matches a real run of the quoted command", () => {
  const { nodeCommand, nodePass } = parseYieldCounts(readme);
  assert.ok(nodeCommand && nodePass, "README quotes the node --test command and `# pass N`");
  assert.ok(nodeCommand.includes("src/yield-optimizer/") && nodeCommand.includes("scripts/yield-demo.test.mjs"));
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const r = sh(nodeCommand, { cwd: root, env, timeoutMs: 300_000 });
  assert.equal(r.status, 0, r.stdout.slice(-2000) + r.stderr);
  const pass = Number(/^(?:# |ℹ )pass (\d+)/m.exec(r.stdout)?.[1]);
  const fail = Number(/^(?:# |ℹ )fail (\d+)/m.exec(r.stdout)?.[1]);
  assert.equal(fail, 0);
  assert.equal(pass, nodePass, "README `# pass N` is stale");
});
