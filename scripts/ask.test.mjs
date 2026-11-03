// Behaviour tests for scripts/ask.mjs: the output contract, argument handling, the
// error contract and "errors write nothing". Each case spawns the real script,
// offline and in mock mode, against a copy of one npm run demo output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { runOffline } from "./test-helpers/run-offline.mjs";

const SCRIPT = fileURLToPath(new URL("./ask.mjs", import.meta.url));
const DEMO = fileURLToPath(new URL("./demo.mjs", import.meta.url));
const SCRUB = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_BASE_URL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "SWARM_ROUNDS", "SUMMARY_EVERY_N_ROUNDS"];
const MODE_LINE = "mode: mock model: mock-persona\n";
const IDS = "aloof, chaotic, social, skeptic";
const MOCK_LINE = "Nothing was signed or sent; inference was mocked: the answer and the sheet come from deterministic stand-ins, not a model.";
/** The swarm-style anchor line: second to last, before the mock notice. */
const anchorLine = (stdout) => stdout.trimEnd().split("\n").at(-2);

const dirs = [];
const scratch = (prefix = "ask-cli-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function env(extra = {}) {
  const base = { ...process.env, MOCK_INFERENCE: "1" };
  for (const key of SCRUB) delete base[key];
  const merged = { ...base, ...extra };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return merged;
}

function ask(args, { cwd, env: extra } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: env(extra), encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const noStack = (text) => !/\n\s+at |node:internal|\bat file:\/\//.test(text);
const read = (...p) => readFileSync(join(...p), "utf8");
const logLines = (out, id = "chaotic") => read(out, "memory", id, "log.jsonl").split("\n").filter(Boolean);
const sheetOf = (out, id = "chaotic") => JSON.parse(read(out, "memory", id, "sheet.json"));

let demoSrc;
before(() => {
  demoSrc = scratch("ask-cli-demo-");
  const r = spawnSync(process.execPath, [DEMO, "--out", demoSrc], { env: env(), encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
});

/** A fresh copy of the demo output; returns the copy's root (it holds memory/). */
function fresh() {
  const dir = scratch("ask-cli-copy-");
  cpSync(demoSrc, dir, { recursive: true });
  return dir;
}
/** Every file under dir with its bytes, so "nothing written" is checkable. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

test("happy path: output contract, one mode line, exit 0", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "what do you think of Skeptic?"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, MODE_LINE);
  assert.ok(noStack(r.stdout) && noStack(r.stderr));
  assert.ok(r.stdout.endsWith("\n"));

  const lines = r.stdout.trimEnd().split("\n");
  const memDir = join(out, "memory");
  assert.match(lines[0], /^Chaotic \(mock\): Skeptic\?\? 5 fights and counting/);
  assert.equal(lines[1], "");
  assert.equal(lines[2], `memory: ${join(memDir, "chaotic", "log.jsonl")} +2 events (round 7: your question, its answer)`);
  assert.match(lines[3], new RegExp(`^sheet diff \\(round 6 -> 7, ${join(memDir, "chaotic", "sheet.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\):$`));
  const body = lines.slice(4, -2);
  assert.ok(body.length > 0);
  assert.ok(body.every((l) => /^ {2}[-+] /.test(l) || l.length > 0), "diff body");
  assert.ok(body.some((l) => l.startsWith("  - ")));
  assert.ok(body.some((l) => l.startsWith("  + ")));
  assert.ok(body.some((l) => l.startsWith("  + Scorecard:") && l.includes("Owner: 0 fights, 0 hugs, 1 shrug")));
  assert.match(lines.at(-2), /^sheet chaotic round 7 [0-9a-f]{64} \(\+\d+ -\d+\) -> anchor_sheet dry-run \(not sent\)$/);
  assert.equal(lines.at(-1), MOCK_LINE);
  // Sections, not sentences: the quoted answer stays on one diff line.
  assert.ok(body.some((l) => /^ {2}\+ Signature quote: "Skeptic\?\? 5 fights and counting, .*"\.$/.test(l)), "quote on one line");
});

test("the final line's hash equals sheetHash on disk and the counts match the diff lines", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "hello there"]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  const last = /^sheet chaotic round 7 ([0-9a-f]{64}) \(\+(\d+) -(\d+)\) -> anchor_sheet dry-run \(not sent\)$/.exec(lines.at(-2));
  assert.ok(last, lines.at(-2));
  const sheet = sheetOf(out);
  assert.equal(last[1], sheet.sheetHash);
  assert.equal(sheet.round, 7);
  assert.equal(Number(last[2]), lines.filter((l) => l.startsWith("  + ")).length);
  assert.equal(Number(last[3]), lines.filter((l) => l.startsWith("  - ")).length);
});

test("the log gains exactly two lines: the owner's mention, then the agent's reply", () => {
  const out = fresh();
  const before = logLines(out);
  const r = ask(["--out", out, "chaotic", "  spaced   out \t question "]);
  assert.equal(r.code, 0, r.stderr);
  const after = logLines(out);
  assert.equal(after.length, before.length + 2);
  assert.deepEqual(after.slice(0, before.length), before);
  const [mention, reply] = after.slice(-2).map((l) => JSON.parse(l));
  assert.equal(mention.kind, "mention");
  assert.equal(mention.from, "Owner");
  assert.equal(mention.text, "spaced out question");
  assert.equal(mention.round, 7);
  assert.equal(reply.kind, "reply");
  assert.equal(reply.from, "Chaotic");
  assert.equal(reply.round, 7);
  assert.equal(r.stdout.split("\n")[0], `Chaotic (mock): ${reply.text}`);
  assert.equal(sheetOf(out).throughIndex, after.length);
  // The other agents' memory is untouched.
  for (const id of ["aloof", "social", "skeptic"]) {
    assert.equal(read(out, "memory", id, "log.jsonl"), read(demoSrc, "memory", id, "log.jsonl"), id);
    assert.equal(read(out, "memory", id, "sheet.json"), read(demoSrc, "memory", id, "sheet.json"), id);
  }
});

test("same question on two fresh copies gives byte-identical stdout, stderr and files (paths aside)", () => {
  const a = fresh();
  const b = fresh();
  const ra = ask(["--out", a, "chaotic", "what do you think of Social?"]);
  const rb = ask(["--out", b, "chaotic", "what do you think of Social?"]);
  assert.equal(ra.code, 0);
  assert.equal(rb.code, 0);
  assert.equal(ra.stderr, rb.stderr);
  assert.equal(ra.stdout.split(a).join("<out>"), rb.stdout.split(b).join("<out>"));
  assert.equal(read(a, "memory", "chaotic", "sheet.json"), read(b, "memory", "chaotic", "sheet.json"));
  assert.equal(read(a, "memory", "chaotic", "log.jsonl"), read(b, "memory", "chaotic", "log.jsonl"));
});

test("a second ask in the same directory says round 7 -> 8", () => {
  const out = fresh();
  assert.equal(ask(["--out", out, "chaotic", "first"]).code, 0);
  const r = ask(["--out", out, "chaotic", "second"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^sheet diff \(round 7 -> 8, /m);
  assert.match(r.stdout, /^memory: .* \+2 events \(round 8: your question, its answer\)$/m);
  assert.match(anchorLine(r.stdout), /^sheet chaotic round 8 [0-9a-f]{64} /);
  assert.equal(logLines(out).length, logLines(demoSrc).length + 4);
  assert.equal(sheetOf(out).round, 8);
});

test("every agent can be asked, and the id is case-insensitive", () => {
  const out = fresh();
  for (const [given, id, name] of [["Chaotic", "chaotic", "Chaotic"], ["ALOOF", "aloof", "Aloof"], ["social", "social", "Social"], ["SkEpTiC", "skeptic", "Skeptic"]]) {
    const r = ask(["--out", out, given, "how are you?"]);
    assert.equal(r.code, 0, `${given}: ${r.stderr}`);
    assert.ok(r.stdout.startsWith(`${name} (mock): `), given);
    assert.match(anchorLine(r.stdout), new RegExp(`^sheet ${id} round 7 [0-9a-f]{64} `));
  }
});

test("a question of several argv words is joined with spaces; a word starting with - is kept", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "what", "about", "-Skeptic-", "and", "--Social"]);
  assert.equal(r.code, 0, r.stderr);
  const mention = JSON.parse(logLines(out).at(-2));
  assert.equal(mention.text, "what about -Skeptic- and --Social");
  assert.ok(r.stdout.startsWith("Chaotic (mock): "));
});

test("--out defaults to ./out relative to the working directory", () => {
  const cwd = scratch("ask-cli-cwd-");
  cpSync(demoSrc, join(cwd, "out"), { recursive: true });
  const r = ask(["chaotic", "hello?"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^memory: out\/memory\/chaotic\/log\.jsonl \+2 events/m);
  assert.equal(logLines(join(cwd, "out")).length, logLines(demoSrc).length + 2);
});

test("it runs under the offline guard without a single violation", async () => {
  const out = fresh();
  const r = await runOffline([SCRIPT, "--out", out, "chaotic", "what do you think of Skeptic?"], { env: { MOCK_INFERENCE: "1" } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.violations, []);
  assert.equal(r.stderr, MODE_LINE);
  assert.match(anchorLine(r.stdout), /^sheet chaotic round 7 [0-9a-f]{64} /);
});

test("--help and -h print usage on stdout and exit 0; help wins over other arguments", () => {
  for (const args of [["--help"], ["-h"], ["chaotic", "--help"], ["--out", "-h"], ["--bogus", "-h"], ["bogus", "x", "--help"]]) {
    const cwd = scratch("ask-cli-help-");
    const r = ask(args, { cwd });
    assert.equal(r.code, 0, args.join(" "));
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.startsWith("Usage: node scripts/ask.mjs [--out DIR] <agentId> <question>\n"), args.join(" "));
    assert.ok(r.stdout.includes(`one of ${IDS}`));
    assert.ok(r.stdout.includes("up to 500 characters"));
    assert.deepEqual(readdirSync(cwd), []);
  }
});

// ---- error contract --------------------------------------------------------------

test("no character sheet: exact message, exit 2, mode line first, nothing created", () => {
  const out = scratch("ask-cli-nomem-");
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  const mem = join(out, "memory");
  assert.equal(
    r.stderr,
    `${MODE_LINE}ask: no character sheet for chaotic under ${mem} (expected ${join(mem, "chaotic", "sheet.json")}). Run npm run demo first, then ask again.\n`,
  );
  assert.ok(noStack(r.stderr));
  assert.deepEqual(readdirSync(out), []);
});

test("a sheet missing for one agent only fails that agent and leaves the rest intact", () => {
  const out = fresh();
  rmSync(join(out, "memory", "social"), { recursive: true });
  const before = snapshot(out);
  const r = ask(["--out", out, "social", "hello?"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^mode: mock model: mock-persona\nask: no character sheet for social under /);
  assert.deepEqual(snapshot(out), before);
});

test("unknown agent: exact message, exit 2, empty stdout, no mode line, nothing written", () => {
  const out = fresh();
  const before = snapshot(out);
  const r = ask(["--out", out, "bogus", "hello?"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `ask: unknown agent "bogus"; one of ${IDS} (see --help)\n`);
  assert.deepEqual(snapshot(out), before);
});

test("missing question, missing agent id, unknown flag and --out without a value all exit 2 with (see --help)", () => {
  const out = fresh();
  const before = snapshot(out);
  const cases = [
    [["--out", out, "chaotic"], "ask: a question is required (see --help)\n"],
    [["--out", out, "chaotic", "   ", ""], "ask: a question is required (see --help)\n"],
    [["--out", out], "ask: an agent id is required (see --help)\n"],
    [[], "ask: an agent id is required (see --help)\n"],
    [["--bogus", "chaotic", "hi"], 'ask: unknown argument "--bogus" (see --help)\n'],
    [["-x", "chaotic", "hi"], 'ask: unknown argument "-x" (see --help)\n'],
    [["chaotic", "hi", "--out"], "ask: --out needs a directory, got undefined (see --help)\n"],
    [["--out"], null],
    [["--out", "--", "chaotic", "hi"], 'ask: --out needs a directory, got "--" (see --help)\n'],
  ];
  for (const [args, message] of cases) {
    const r = ask(args, { cwd: out });
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    if (message) assert.equal(r.stderr, message, args.join(" "));
    assert.match(r.stderr, /^ask: .* \(see --help\)\n$/, args.join(" "));
    assert.ok(noStack(r.stderr));
  }
  assert.deepEqual(snapshot(out), before);
});

test("an over-long question exits 2 naming the limit and writes nothing", () => {
  const out = fresh();
  const before = snapshot(out);
  const r = ask(["--out", out, "chaotic", "x".repeat(501)]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `${MODE_LINE}ask: question must be at most 500 characters, got 501 (see --help)\n`);
  assert.deepEqual(snapshot(out), before);

  // Whitespace collapsing counts: 500 characters of words plus padding is accepted.
  const ok = ask(["--out", out, "chaotic", `${"x".repeat(250)}      ${"y".repeat(249)}`]);
  assert.equal(ok.code, 0, ok.stderr);
});

test("control and bidi characters in the question are replaced before they reach the log", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "\u0007‮hello"]);
  assert.equal(r.code, 0, r.stderr);
  const mention = JSON.parse(logLines(out).at(-2));
  assert.equal(mention.text, "��hello");
});

test("MOCK_INFERENCE=0 without a key fails with exit 1 before reading or writing anything", () => {
  const out = fresh();
  const before = snapshot(out);
  const r = ask(["--out", out, "chaotic", "hello?"], { env: { MOCK_INFERENCE: "0" } });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(
    r.stderr,
    "ask: inference error (missing_api_key): live mode needs NEAR_AI_API_KEY (set NEAR_AI_API_KEY and NEAR_AI_MODEL in the environment, or unset MOCK_INFERENCE for mock mode)\n",
  );
  assert.deepEqual(snapshot(out), before);

  // Even with no demo output at all, a live run without a key creates nothing.
  const empty = scratch("ask-cli-live-");
  const r2 = ask(["--out", join(empty, "o"), "chaotic", "hello?"], { env: { MOCK_INFERENCE: "0" } });
  assert.equal(r2.code, 1);
  assert.deepEqual(readdirSync(empty), []);
});

test("MOCK_INFERENCE=2 is a bad_config error: exit 2, nothing written", () => {
  const out = fresh();
  const before = snapshot(out);
  const r = ask(["--out", out, "chaotic", "hello?"], { env: { MOCK_INFERENCE: "2" } });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^ask: inference error \(bad_config\): .+\n$/);
  assert.ok(noStack(r.stderr));
  assert.deepEqual(snapshot(out), before);
});
