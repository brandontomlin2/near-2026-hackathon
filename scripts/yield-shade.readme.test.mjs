// Locks the README's yield:shade:dry-run claims to the real output of the script.
// Every backticked line quoted in the Shade subsection (and in the Judge quick path
// Shade line) must be a full trimmed line of what the command really prints, under
// the `== header ==` the README names. The checks are functions of (readme text,
// output), so a negative test can run them on a mutated README and expect failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { numberedSteps, section, trimmedLines } from "./readme-yield-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const isHeader = (s) => /^== .* ==$/.test(s);

// ---- README parsing -------------------------------------------------------

function parseShade(text) {
  const y = section(text, "Yield Optimizer");
  const sub = y.match(/^### Shade Agent runner plan[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
  const steps = numberedSteps(sub).map(({ n, text: t }) => {
    const [command, ...quotes] = spans(t);
    return { n, text: t, command, quotes };
  });
  const block = sub.match(/<!-- judge:run -->\n((?:<!-- judge:expect .*? -->\n)+)```sh\n([\s\S]*?)```/);
  const expects = block ? [...block[1].matchAll(/<!-- judge:expect (.*?) -->/g)].map((m) => m[1]) : [];
  const blockCommands = block ? block[2].split("\n").filter(Boolean) : [];
  return { text: sub, steps, expects, blockCommands };
}

// The quick path keeps at most 4 numbered steps (scripts/readme-commands.test.mjs), so the
// Shade pointer is the unnumbered paragraph there whose first command is yield:shade:dry-run.
function parseQuickShadeStep(text) {
  for (const t of section(text, "Judge quick path").split(/\n\s*\n/)) {
    const [command, ...quotes] = spans(t);
    if (command === "npm run yield:shade:dry-run") return { command, quotes, text: t };
  }
  return null;
}

// ---- running the script ---------------------------------------------------

function run(args = [], extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [join(root, "scripts/yield-shade-dry-run.mjs"), ...args], { cwd: tmpCwd, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
// Run from a directory that is not the repo to prove cwd independence.
const tmpCwd = tmpdir();

let cache;
function outputs() {
  cache ??= { plain: run(), json: run(["--json"]), send: run(["--send"]) };
  return cache;
}

// ---- comparisons (pure: readme text + outputs) ----------------------------

/** Step 1: banner/lines quoted under README headers are full lines under those headers. */
function checkStep1(shade, stdout) {
  const step = shade.steps[0];
  assert.equal(step.command, "npm run yield:shade:dry-run");
  const lines = trimmedLines(stdout);
  const nonEmpty = lines.filter(Boolean);
  let header = null;
  const last = step.quotes.length - 1;
  for (const [i, q] of step.quotes.entries()) {
    const quote = q.trim();
    if (isHeader(quote)) {
      assert.ok(lines.includes(quote), `README quotes header not printed: ${quote}`);
      header = quote;
      continue;
    }
    assert.ok(lines.includes(quote), `README quotes a line that is not a full line of stdout: ${quote}`);
    if (header && i < last) {
      // the final line is README's "last", after the final section, so it is checked below instead
      const start = lines.indexOf(header);
      let end = lines.findIndex((l, i) => i > start && l.startsWith("== "));
      if (end < 0) end = lines.length;
      assert.ok(lines.slice(start + 1, end).includes(quote), `README puts "${quote}" under ${header} but stdout does not`);
    }
  }
  assert.equal(step.quotes.at(-1).trim(), nonEmpty.at(-1), "README's last quoted line is stdout's last non-empty line");
  assert.equal(nonEmpty.at(-1), "dry_run: true, signed: false, sent: false");
  assert.equal(nonEmpty[0], step.quotes.find((q) => !isHeader(q)).trim(), "README's first quote is the banner (first line)");
}

/** Step 2: each quoted `"key": value` matches the parsed JSON document. */
function checkStep2(shade, stdout) {
  const step = shade.steps[1];
  assert.equal(step.command, "npm run yield:shade:dry-run -- --json");
  const doc = JSON.parse(stdout);
  assert.deepEqual([doc.dry_run, doc.signed, doc.sent], [true, false, false]);
  const kv = step.quotes.slice(0).filter((q) => /^"[^"]+": /.test(q));
  assert.ok(kv.length >= 3, "step 2 quotes at least 3 key/value spans");
  for (const q of kv) {
    const obj = JSON.parse(`{${q}}`);
    const [key, value] = Object.entries(obj)[0];
    assert.deepEqual(doc[key], value, `JSON ${q} does not match the real document`);
    assert.ok(trimmedLines(stdout).some((l) => l.replace(/,$/, "") === q.trim()), `no JSON line ${q}`);
  }
}

/** Step 3: the quoted refusal is a full line of stderr (not stdout). */
function checkStep3(shade, { status, stdout, stderr }) {
  const step = shade.steps[2];
  assert.equal(step.command, "npm run yield:shade:dry-run -- --send");
  assert.equal(status, 1);
  assert.equal(stdout, "", "refusal prints nothing on stdout");
  const refusal = step.quotes[0].trim();
  assert.ok(trimmedLines(stderr).includes(refusal), `README refusal is not a full line of stderr: ${refusal}`);
}

/** Quick path Shade line: first and last quoted lines are stdout's first and last non-empty lines. */
function checkQuick(text, stdout) {
  const quick = parseQuickShadeStep(text);
  assert.ok(quick, "Judge quick path has the yield:shade:dry-run step");
  const nonEmpty = trimmedLines(stdout).filter(Boolean);
  const m = quick.text.match(/first `([^`\n]+)`.*last `([^`\n]+)`/);
  assert.ok(m, "quick path quotes a first and a last line");
  assert.equal(m[1].trim(), nonEmpty[0]);
  assert.equal(m[2].trim(), nonEmpty.at(-1));
}

/** judge:expect strings appear in the combined stdout+stderr of the block's commands. */
function checkExpects(shade, combined) {
  assert.ok(shade.expects.length >= 4, "a judge:run block with expectations");
  for (const e of shade.expects) assert.ok(combined.includes(e), `judge:expect not in output: ${e}`);
}

// ---- tests ----------------------------------------------------------------

test("package.json script yield:shade:dry-run is node scripts/yield-shade-dry-run.mjs", () => {
  assert.equal(pkg.scripts["yield:shade:dry-run"], "node scripts/yield-shade-dry-run.mjs");
});

test("README Shade subsection has exactly 3 steps with run, --json and --send", () => {
  const shade = parseShade(readme);
  assert.deepEqual(shade.steps.map((s) => s.command), [
    "npm run yield:shade:dry-run",
    "npm run yield:shade:dry-run -- --json",
    "npm run yield:shade:dry-run -- --send",
  ]);
  assert.deepEqual(shade.blockCommands, [
    "npm run yield:shade:dry-run",
    "npm run yield:shade:dry-run -- --json",
    "npm run yield:shade:dry-run -- --send 2>&1 || true",
  ]);
});

test("step 1: quoted lines are full stdout lines under the named headers; ends with the dry_run line; exit 0", () => {
  const { plain } = outputs();
  assert.equal(plain.status, 0, plain.stderr);
  checkStep1(parseShade(readme), plain.stdout);
});

test("step 2: --json is one JSON document and the quoted key/values match", () => {
  const { json } = outputs();
  assert.equal(json.status, 0, json.stderr);
  checkStep2(parseShade(readme), json.stdout);
});

test("step 3: --send exits 1 with the quoted refusal line on stderr", () => {
  checkStep3(parseShade(readme), outputs().send);
});

test("step 3: the other listed flags, NEAR_NETWORK=mainnet and a .near account are refused with exit 1", () => {
  const listed = ["--sign", "--broadcast", "--i-approve", "--mainnet"];
  for (const flag of listed) assert.match(parseShade(readme).steps[2].text, new RegExp(`\`${flag}\``), `README lists ${flag}`);
  const cases = [
    ...listed.map((f) => [f, run([f])]),
    ["NEAR_NETWORK=mainnet", run([], { NEAR_NETWORK: "mainnet" })],
    ["--agent-contract foo.near", run(["--agent-contract", "foo.near"])],
  ];
  for (const [label, r] of cases) {
    assert.equal(r.status, 1, `${label} exits 1 (stderr: ${r.stderr})`);
    assert.match(r.stderr, /refused/, `${label} prints a refusal`);
  }
});

test("Judge quick path Shade line quotes stdout's first and last non-empty lines", () => {
  checkQuick(readme, outputs().plain.stdout);
});

test("judge:expect strings appear in the combined output of the block's three commands", () => {
  const { plain, json, send } = outputs();
  checkExpects(parseShade(readme), [plain, json, send].map((r) => r.stdout + r.stderr).join("\n"));
});

test("negative: the comparisons fail on mutated README text (not tautological)", () => {
  const o = outputs();
  const mutate = (from, to) => {
    assert.ok(readme.includes(from), `mutation anchor present: ${from}`);
    return readme.replace(from, to);
  };
  // wrong value inside a quoted line
  assert.throws(() => checkStep1(parseShade(mutate("300000000000000 (300 Tgas)", "30000000000000 (30 Tgas)")), o.plain.stdout), /full line/);
  // extra internal whitespace is compared exactly
  assert.throws(() => checkStep1(parseShade(mutate("`method              execute_swap`", "`method execute_swap`")), o.plain.stdout), /full line/);
  // right line, wrong header
  assert.throws(() => checkStep1(parseShade(mutate("under `== MPC sign request ==` the line `receiver            v1.signer-prod.testnet`", "under `== runner authorization ==` the line `receiver            v1.signer-prod.testnet`")), o.plain.stdout), /under/);
  // wrong JSON value
  assert.throws(() => checkStep2(parseShade(mutate("document with `\"dry_run\": true`, `\"signed\": false`", "document with `\"dry_run\": true`, `\"signed\": true`")), o.json.stdout));
  // wrong refusal text
  assert.throws(() => checkStep3(parseShade(mutate("--send is not allowed.", "--send is allowed.")), o.send), /stderr/);
  // wrong quick-path last line
  assert.throws(() => checkQuick(mutate("last `dry_run: true, signed: false, sent: false`", "last `dry_run: true, signed: false, sent: true`"), o.plain.stdout));
  // a judge:expect that the output does not contain
  assert.throws(() => checkExpects(parseShade(mutate("<!-- judge:expect refused: --send is not allowed -->", "<!-- judge:expect refused: --send is welcome -->")), [o.plain, o.json, o.send].map((r) => r.stdout + r.stderr).join("\n")), /judge:expect/);
});
