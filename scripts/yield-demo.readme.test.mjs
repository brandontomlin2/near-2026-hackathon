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
import { STRATEGIES, WNEAR, defaultVaultConfig, limitFor } from "../src/yield/strategies.mjs";
import { demoArgs, numberedSteps, parseQuickYieldStep, parseYieldCounts, parseYieldDemo, section, sh, trimmedLines } from "./readme-yield-lib.mjs";

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

test("numberedSteps folds indented sub-bullets into their step and a non-indented line ends it", () => {
  const md = "Intro\n1. Run `a`. See these lines:\n   - `x`, `y`,\n   - then `z`.\nplain line\n2. Open `f`. See `q`.\n  - `r`\n\n3. Last `l`";
  assert.deepEqual(numberedSteps(md), [
    { n: 1, text: "Run `a`. See these lines: `x`, `y`, then `z`." },
    { n: 2, text: "Open `f`. See `q`. `r`" },
    { n: 3, text: "Last `l`" },
  ]);
});

test("README has the yield:demo subsection with run, --calls and plan.json steps", () => {
  assert.equal(demo.steps.length, 4, "four numbered steps");
  assert.deepEqual(demo.steps.map((s) => [s.command, s.kind]), [
    ["npm run yield:demo", "run"],
    ["npm run yield:demo -- --calls", "run"],
    ["out/yield-demo/plan.json", "file"],
    ["out/yield-demo/index.html", "file"],
  ]);
  // The --calls step prints the optimizer's one call on the real snapshot, so it quotes that call's lines.
  for (const s of demo.steps.filter((x) => x.command !== "npm run yield:demo -- --calls")) assert.ok(s.quotes.length >= 3, `step ${s.n} quotes at least 3 lines`);
  assert.deepEqual(demo.steps[1].quotes, ["call 1 of 1 (yield-optimizer)", "method: execute_swap", "gas: 280.0 Tgas", "signed: false", "sent: false"]);
  assert.match(demo.text, /<!-- judge:run -->/, "a judge:run block");
});

test("README yield:demo steps: every quoted line is a full line of the real output", () => {
  for (const step of demo.steps.filter((s) => s.kind === "run")) {
    const lines = trimmedLines(runDemo(step.command));
    for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `step ${step.n} (${step.command}) quotes a line it does not print: ${q}`);
  }
});

test("README yield:demo plan.json step: quoted keys appear in the written plan.json", () => {
  const step = demo.steps.find((s) => s.kind === "file" && s.command.endsWith("plan.json"));
  assert.equal(step.command, "out/yield-demo/plan.json", "README path is the default out dir");
  runDemo("npm run yield:demo");
  const lines = trimmedLines(readFileSync(join(work, "out/yield-demo/plan.json"), "utf8"));
  for (const q of step.quotes) {
    assert.ok(lines.some((l) => l.replace(/,$/, "") === q.trim()), `plan.json has no line ${q}`);
  }
});

// The page's visible text: tags removed, entities decoded, whitespace collapsed.
function pageText(html) {
  const entities = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  return html.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, (m) => entities[m]).replace(/\s+/g, " ");
}

test("README yield:demo index.html step: every quoted text is visible on the written page", () => {
  const step = demo.steps.find((s) => s.kind === "file" && s.command.endsWith("index.html"));
  assert.ok(step, "an Open out/yield-demo/index.html step");
  runDemo("npm run yield:demo");
  const text = pageText(readFileSync(join(work, "out/yield-demo/index.html"), "utf8"));
  for (const q of step.quotes) assert.ok(text.includes(q.trim().replace(/\s+/g, " ")), `index.html does not show: ${q}`);
});

test("Judge quick path step for yield:demo quotes real output lines", () => {
  const quick = parseQuickYieldStep(readme);
  assert.ok(quick, "Judge quick path has a yield:demo step");
  assert.equal(quick.command, "npm run yield:demo");
  assert.ok(quick.quotes.length >= 2);
  const lines = trimmedLines(runDemo(quick.command));
  for (const q of quick.quotes) assert.ok(lines.includes(q.trim()), `quick path quotes a line it does not print: ${q}`);
});

test("README's note on the --calls command line matches the output: it is the last line, a near-cli-rs command printed as text", () => {
  const step = demo.steps.find((s) => s.command === "npm run yield:demo -- --calls");
  assert.ok(step, "Offline demo has a --calls step");
  const raw = numberedSteps(section(readme, "Yield Optimizer")).find((s) => s.text.startsWith("Run `npm run yield:demo -- --calls`"));
  assert.match(raw.text, /The last line, starting with command:, is the near-cli-rs command an owner would run by hand after review; the demo prints it as text and never runs it/);
  const lines = runDemo(step.command).split("\n").filter((l) => l.trim());
  const last = lines.at(-1).trim();
  assert.match(last, /^command: near contract call-function as-transaction vault\.yield-demo\.testnet execute_swap /);
  assert.equal(lines.filter((l) => l.trim().startsWith("command: ")).length, 1, "exactly one command line, for the one planned call");
  assert.ok(lines.some((l) => l.trim() === "signed: false") && lines.some((l) => l.trim() === "sent: false"));
});

test("README judge:expect markers for the demo block are lines or substrings of the real output", () => {
  const expects = [...demo.text.matchAll(/<!-- judge:expect (.*?) -->/g)].map((m) => m[1]);
  assert.ok(expects.length >= 4);
  const all = [runDemo("npm run yield:demo"), runDemo("npm run yield:demo -- --calls"), readFileSync(join(work, "out/yield-demo/plan.json"), "utf8")].join("\n");
  for (const e of expects) assert.ok(all.includes(e), `judge:expect text not in output: ${e}`);
});

// The "planner alone" table: `| command | expected line |` rows under "### The planner alone".
// Each expected cell must be a full trimmed line of that command's real output, or
// (for cells that start mid-line) a substring of one line. The planner is run
// offline; its default run plans over the shared Ref snapshot and holds.
function plannerRows() {
  const sub = section(readme, "Yield Optimizer").match(/^### The planner alone[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
  return [...sub.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)].map((m) => ({ command: m[1], expected: m[2] }));
}

test("README planner table: every expected line is printed by that command", () => {
  const rows = plannerRows();
  assert.ok(rows.length >= 8, "a table with one row per check");
  assert.deepEqual([...new Set(rows.map((r) => r.command))], [
    "node scripts/yield-optimizer.mjs",
    "node scripts/yield-optimizer.mjs --snapshot src/yield-optimizer/fixtures/scenario.hand-built.json",
  ]);
  const outputs = new Map();
  for (const { command } of rows) {
    const args = command.replace(/^node scripts\/yield-optimizer\.mjs\s*/, "").split(/\s+/).filter(Boolean).map((a) => (a.startsWith("src/") ? join(root, a) : a));
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [join(root, "scripts/yield-optimizer.mjs"), ...args], { cwd: work, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    outputs.set(command, trimmedLines(r.stdout));
  }
  for (const { command, expected } of rows) {
    const lines = outputs.get(command);
    assert.ok(lines.includes(expected) || lines.some((l) => l.includes(expected)), `${command} does not print: ${expected}`);
  }
});

test("README names the shared snapshot, the optimizer's pool 747 swap and one 280 TGas figure that the real output shows", () => {
  const out = runDemo("npm run yield:demo");
  const calls = runDemo("npm run yield:demo -- --calls");
  assert.match(out, /snapshot: one committed Ref testnet snapshot at block 276332963/);
  assert.match(out, /^yield-optimizer {2}pool 747: 0\.05 usdc -> min 0\.050406 usdt {2}OK +execute$/m);
  // The real snapshot plans the optimizer's one call (pool 747), with the one shared gas figure; the hand-built scenario plans another.
  assert.match(calls, /^call 1 of 1 \(yield-optimizer\)$/m);
  assert.deepEqual([...calls.matchAll(/^ {2}gas: (.*)$/gm)].map((m) => m[1]), ["280.0 Tgas"]);
  assert.match(calls, /"pool_id":747/);
  const scenario = runDemo(`npm run yield:demo -- --calls --snapshot ${join(root, "src/yield-optimizer/fixtures/scenario.hand-built.json")}`);
  assert.equal([...scenario.matchAll(/^ {2}gas: (.*)$/gm)].map((m) => m[1]).join("|"), "280.0 Tgas");
  assert.match(scenario, /^call 1 of 1 \(yield-optimizer\)$/m);
  assert.match(readme, /`npm run yield:demo -- --calls --snapshot src\/yield-optimizer\/fixtures\/scenario\.hand-built\.json`/);
  assert.match(readme, /`gas: 280\.0 Tgas`/);
  assert.doesNotMatch(section(readme, "Yield Optimizer"), /\b300 ?T[Gg]as|Rhea snapshot|rhea-testnet-snapshot|pool 99/);
});

test("README's reason for Chaotic's veto matches the strategy parameters and the demo's veto line", () => {
  const para = parseYieldDemo(readme).text;
  const m = para.match(/Chaotic sizes a trade at (\d+) bps \(all\) of its vault's max_trade, which is (\d+) wNEAR, and Skeptic vetoes any proposal above its (\d+) bps audit line/);
  assert.ok(m, "README explains why Chaotic is vetoed");
  const [, sizeBps, maxTrade, auditBps] = m;
  assert.equal(Number(sizeBps), STRATEGIES.chaotic.params.size_bps);
  assert.equal(Number(auditBps), STRATEGIES.skeptic.params.audit.veto_size_bps);
  assert.equal(BigInt(limitFor(defaultVaultConfig("chaotic"), WNEAR).max_trade), BigInt(maxTrade) * 10n ** 24n, "chaotic max_trade for wNEAR (24 decimals)");
  const out = runDemo("npm run yield:demo");
  assert.ok(trimmedLines(out).includes(`chaotic vetoed by skeptic: size is ${sizeBps} bps of max_trade, above the ${auditBps} bps audit line`));
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

test("README verify.sh paragraph states the yield demo stage's real call and rejection counts", async () => {
  const { EXPECTED_CALLS, EXPECTED_REJECTIONS, EXPECTED_SIGNED, EXPECTED_SENT } = await import("./yield-demo-check.mjs");
  const para = readme.split("\n").find((l) => l.includes("`yield demo` runs `npm run yield:demo` with a timeout"));
  assert.ok(para, "verify.sh paragraph about the yield demo stage");
  const calls = EXPECTED_CALLS === 1 ? "1 call planned" : `${EXPECTED_CALLS} calls planned`;
  assert.ok(para.includes(calls), `paragraph says ${calls}`);
  assert.ok(para.includes(`${EXPECTED_SIGNED} signed, ${EXPECTED_SENT} sent and ${EXPECTED_REJECTIONS} rule rejections`));
});
