// Edge-case behaviour tests for npm run ask (scripts/ask.mjs -> src/owner/ask.mjs):
// what a user sees (stdout, stderr, exit code) for odd names and questions,
// no demo output, damaged memory, repeated asks, and the offline/no-keys promise.
// Every case spawns the real script in mock mode against a copy of one demo output.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { hashSheet } from "../src/anchor/hash.mjs";
import { runOffline } from "./test-helpers/run-offline.mjs";

const SCRIPT = fileURLToPath(new URL("./ask.mjs", import.meta.url));
const DEMO = fileURLToPath(new URL("./demo.mjs", import.meta.url));
const SCRUB = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_BASE_URL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "SWARM_ROUNDS", "SUMMARY_EVERY_N_ROUNDS"];
const MODE_LINE = "mode: mock model: mock-persona\n";
const FAKE_KEY = "test-fake-key-edges16-SECRET-KEY-do-not-print";

const dirs = [];
const scratch = (prefix = "ask-e16-") => {
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
const logEvents = (out, id = "chaotic") => read(out, "memory", id, "log.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sheetOf = (out, id = "chaotic") => JSON.parse(read(out, "memory", id, "sheet.json"));
const lastLine = (stdout) => stdout.trimEnd().split("\n").at(-2);

let demoSrc;
before(() => {
  demoSrc = scratch("ask-e16-demo-");
  const r = spawnSync(process.execPath, [DEMO, "--out", demoSrc], { env: env(), encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
});
function fresh() {
  const dir = scratch("ask-e16-copy-");
  cpSync(demoSrc, dir, { recursive: true });
  return dir;
}
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

// ---- agent name ----------------------------------------------------------------

test("agent names that are near misses are rejected with the list of real ones, exit 2, nothing written", () => {
  const out = fresh();
  const before = snapshot(out);
  for (const name of ["chaotic ", "chaotic2", "Chaotic Agent", "../chaotic", "chaotic/../aloof", "__proto__", "constructor", "0", "çhaotic", "🙂"]) {
    const r = ask(["--out", out, name, "hello?"]);
    assert.equal(r.code, 2, JSON.stringify(name));
    assert.equal(r.stdout, "", JSON.stringify(name));
    assert.match(r.stderr, /^ask: unknown agent ".*"; one of aloof, chaotic, social, skeptic \(see --help\)\n$/, JSON.stringify(name));
    assert.ok(noStack(r.stderr));
  }
  assert.deepEqual(snapshot(out), before);
});

test("an empty-string agent name is an unknown agent, not a crash", () => {
  const r = ask(["--out", fresh(), "", "hello?"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'ask: unknown agent ""; one of aloof, chaotic, social, skeptic (see --help)\n');
});

// ---- missing / empty question ---------------------------------------------------

test("a question of only invisible whitespace (tab, newline, NBSP, ideographic space) is 'a question is required' or an empty-question error, never an answer", () => {
  const out = fresh();
  const before = snapshot(out);
  for (const q of ["\t", "\n\n", " ", "　", " \t\n "]) {
    const r = ask(["--out", out, "chaotic", q]);
    assert.equal(r.code, 2, JSON.stringify(q));
    assert.equal(r.stdout, "", JSON.stringify(q));
    assert.match(r.stderr, /^(mode: mock model: mock-persona\n)?ask: (a question is required|question must not be empty) \(see --help\)\n$/, JSON.stringify(q));
  }
  assert.deepEqual(snapshot(out), before);
});

test("a question made only of control characters is not silently accepted as blank text", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "\u0007\u0008"]);
  // Control characters become U+FFFD, which is visible text: it is asked, and logged as such.
  assert.equal(r.code, 0, r.stderr);
  assert.equal(logEvents(out).at(-2).text, "��");
});

// ---- very long question --------------------------------------------------------

test("exactly 500 characters is accepted; 501 is refused with the count; 100k characters is refused fast without echoing it", () => {
  const out = fresh();
  assert.equal(ask(["--out", out, "chaotic", "q".repeat(500)]).code, 0);
  const before = snapshot(out);
  const r501 = ask(["--out", out, "chaotic", "q".repeat(501)]);
  assert.equal(r501.code, 2);
  assert.match(r501.stderr, /question must be at most 500 characters, got 501 \(see --help\)\n$/);
  const huge = ask(["--out", out, "chaotic", "q".repeat(100_000)]);
  assert.equal(huge.code, 2);
  assert.match(huge.stderr, /got 100000 \(see --help\)\n$/);
  assert.ok(huge.stderr.length < 300, "the error must not echo the question");
  assert.deepEqual(snapshot(out), before);
});

test("the limit counts characters, not UTF-16 units or bytes: 500 emoji are refused only if they exceed 500 code points", () => {
  const out = fresh();
  const five = "\u{1F600}".repeat(250); // 250 code points, 500 UTF-16 units, 1000 bytes
  const r = ask(["--out", out, "chaotic", five]);
  assert.equal(r.code, 0, r.stderr);
  const stored = logEvents(out).at(-2).text;
  assert.equal(stored, five);
});

// ---- unicode / emoji ------------------------------------------------------------

test("unicode, emoji, combining marks and RTL text are asked, stored verbatim, and the run exits 0", () => {
  const out = fresh();
  const questions = ["What about Skeptic? \u{1F680}\u{1F525}", "café naïve 日本語 مرحبا", "é \u{1F468}‍\u{1F469}‍\u{1F467}"];
  for (const q of questions) {
    const r = ask(["--out", out, "chaotic", q]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, MODE_LINE);
    assert.match(lastLine(r.stdout), /^sheet chaotic round \d+ [0-9a-f]{64} /);
    const events = logEvents(out);
    assert.equal(events.at(-2).from, "Owner");
    assert.equal(events.at(-2).text, q);
  }
});

test("a lone surrogate or invalid UTF-8 byte in the question never crashes the run", () => {
  const out = fresh();
  const r = spawnSync(process.execPath, [SCRIPT, "--out", out, "chaotic", Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]).toString("latin1")], { env: env(), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const text = logEvents(out).at(-2).text;
  assert.ok(typeof text === "string" && text.length > 0);
  assert.equal(JSON.parse(JSON.stringify(text)), text);
});

// ---- shell-special characters ---------------------------------------------------

test("shell-special characters passed as one argv word are asked literally: no expansion, no extra files", () => {
  const out = fresh();
  const cwd = scratch("ask-e16-cwd-");
  const questions = [
    "$(touch pwned) `touch pwned2` ; rm -rf / && echo hi | cat > pwned3",
    "$HOME ${PATH} %PATH% ~ * ? [a-z] {1,2} \\n \\t",
    "it's \"quoted\" and <redirect> >file 2>&1 #comment !!",
  ];
  for (const q of questions) {
    const r = ask(["--out", out, "chaotic", q], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, MODE_LINE);
    assert.equal(logEvents(out).at(-2).text, q);
  }
  assert.deepEqual(readdirSync(cwd), [], "no file was created in the working directory");
});

test("a question that looks like a flag after the agent id is still a question", () => {
  const out = fresh();
  for (const q of ["--help", "-h", "--out=/tmp/x", "-1", "--"]) {
    const r = ask(["--out", out, "chaotic", q]);
    // --help/-h anywhere wins (documented); the others are plain question text.
    if (q === "--help" || q === "-h") {
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^Usage: /);
    } else {
      assert.equal(r.code, 0, `${q}: ${r.stderr}`);
      assert.equal(logEvents(out).at(-2).text, q);
    }
  }
});

// ---- no demo yet ---------------------------------------------------------------

test("before any npm run demo: every agent says to run npm run demo, exit 2, the out dir is not created", () => {
  const root = scratch("ask-e16-nodemo-");
  const out = join(root, "does", "not", "exist");
  for (const id of ["aloof", "chaotic", "social", "skeptic"]) {
    const r = ask(["--out", out, id, "hello?"]);
    assert.equal(r.code, 2, id);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, new RegExp(`^${MODE_LINE}ask: no character sheet for ${id} under .*memory \\(expected .*${id}.sheet\\.json\\)\\. Run npm run demo first, then ask again\\.\\n$`));
  }
  assert.deepEqual(readdirSync(root), []);
});

test("memory dir exists but is empty, or has a log without a sheet: still 'no character sheet', log untouched", () => {
  const out = fresh();
  rmSync(join(out, "memory", "aloof", "sheet.json"));
  const before = snapshot(out);
  const r = ask(["--out", out, "aloof", "hello?"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ask: no character sheet for aloof/);
  assert.deepEqual(snapshot(out), before);
});

test("--out pointing at a file, not a directory, is a one-line failure with a nonzero exit and no stack", () => {
  const root = scratch("ask-e16-file-");
  const file = join(root, "afile");
  writeFileSync(file, "x");
  const r = ask(["--out", file, "chaotic", "hello?"]);
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, "");
  assert.ok(noStack(r.stderr), r.stderr);
  assert.equal(readFileSync(file, "utf8"), "x");
});

// ---- corrupt / hand-edited sheet.json -------------------------------------------

const sheetPath = (out, id = "chaotic") => join(out, "memory", id, "sheet.json");

test("sheet.json that is valid JSON of the wrong shape fails cleanly: nonzero, one line, no stack, nothing written", () => {
  const shapes = ["null", "[]", "{}", "42", '"text"', "true", '{"round":"seven","sheet":"x"}', '{"round":6}', '{"sheet":"x"}', '{"round":6,"sheet":""}', '{"round":6,"sheet":42}'];
  for (const body of shapes) {
    const out = fresh();
    writeFileSync(sheetPath(out), body);
    const before = snapshot(out);
    const r = ask(["--out", out, "chaotic", "hello?"]);
    assert.notEqual(r.code, 0, `${body}: ${r.stdout}`);
    assert.equal(r.stdout, "", body);
    assert.ok(noStack(r.stderr), `${body}: ${r.stderr}`);
    assert.match(r.stderr, /^(mode: mock model: mock-persona\n)?ask: [^\n]+\n$/, body);
    assert.deepEqual(snapshot(out), before, `${body}: files changed`);
  }
});

test("a hand-edited negative round with a sheet text is tolerated: the round comes from the log, the hash is recomputed, the output is coherent", () => {
  const out = fresh();
  const lastLogRound = logEvents(out).at(-1).round;
  writeFileSync(sheetPath(out), '{"round":-1,"sheet":"x","sheetHash":"y","throughIndex":0}');
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 0, r.stderr);
  const after = sheetOf(out);
  assert.equal(after.round, lastLogRound + 1);
  assert.equal(after.sheetHash, hashSheet(after.sheet));
  assert.match(lastLine(r.stdout), new RegExp(`^sheet chaotic round ${after.round} ${after.sheetHash} `));
});

test("empty and truncated sheet.json are a bad_sheet memory error, nothing written", () => {
  for (const body of ["", "   \n", "{", '{"round": 6, "sheet": "abc', "\u0000\u0000"]) {
    const out = fresh();
    writeFileSync(sheetPath(out), body);
    const before = snapshot(out);
    const r = ask(["--out", out, "chaotic", "hello?"]);
    assert.equal(r.code, 1, JSON.stringify(body));
    assert.equal(r.stderr, `${MODE_LINE}ask: memory error (bad_sheet): the sheet file ${sheetPath(out)} is malformed\n`);
    assert.deepEqual(snapshot(out), before);
  }
});

test("a corrupt log.jsonl line is a bad_log memory error naming the line, nothing written", () => {
  const out = fresh();
  const file = join(out, "memory", "chaotic", "log.jsonl");
  writeFileSync(file, `${read(out, "memory", "chaotic", "log.jsonl")}{broken\n`);
  const before = snapshot(out);
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^mode: mock model: mock-persona\nask: memory error \(bad_log\): event log line \d+ is malformed\n$/);
  assert.deepEqual(snapshot(out), before);
});

test("a hand-edited sheet text is taken as the agent's memory: the ask succeeds and the new hash matches the new sheet", () => {
  const out = fresh();
  const rec = sheetOf(out);
  const edited = { ...rec, sheet: `${rec.sheet} (edited by hand)`, sheetHash: hashSheet(`${rec.sheet} (edited by hand)`) };
  writeFileSync(sheetPath(out), JSON.stringify(edited, null, 2));
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 0, r.stderr);
  const after = sheetOf(out);
  assert.equal(after.sheetHash, hashSheet(after.sheet));
  assert.match(lastLine(r.stdout), new RegExp(`^sheet chaotic round ${after.round} ${after.sheetHash} `));
});

test("a hand-edited sheet whose stored hash is stale: the printed and stored hash is recomputed from the new sheet, never copied from the stale one", () => {
  const out = fresh();
  const rec = sheetOf(out);
  writeFileSync(sheetPath(out), JSON.stringify({ ...rec, sheetHash: "0".repeat(64) }, null, 2));
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 0, r.stderr);
  const after = sheetOf(out);
  assert.notEqual(after.sheetHash, "0".repeat(64));
  assert.equal(after.sheetHash, hashSheet(after.sheet));
  assert.ok(!r.stdout.includes("0".repeat(64)), "the stale hash is not printed");
});

test("a hand-edited round number that is behind the log is not reused: the new round follows the log", () => {
  const out = fresh();
  const rec = sheetOf(out);
  const lastLogRound = logEvents(out).at(-1).round;
  writeFileSync(sheetPath(out), JSON.stringify({ ...rec, round: 0 }, null, 2));
  const r = ask(["--out", out, "chaotic", "hello?"]);
  assert.equal(r.code, 0, r.stderr);
  const events = logEvents(out);
  assert.equal(events.at(-2).round, lastLogRound + 1);
  assert.equal(sheetOf(out).round, lastLogRound + 1);
});

// ---- repeated asks keep hashes consistent --------------------------------------

test("five asks in a row: every printed hash equals sheet.json, each is the hash of the sheet text, rounds step by one, the log grows by two", () => {
  const out = fresh();
  let prev = sheetOf(out);
  let events = logEvents(out).length;
  const questions = ["hello?", "I hate you", "what do you think of Skeptic?", "who is your enemy?", "love you \u{1F496}"];
  for (const q of questions) {
    const r = ask(["--out", out, "chaotic", q]);
    assert.equal(r.code, 0, r.stderr);
    const now = sheetOf(out);
    assert.equal(now.round, prev.round + 1);
    assert.equal(now.sheetHash, hashSheet(now.sheet));
    assert.equal(lastLine(r.stdout), `sheet chaotic round ${now.round} ${now.sheetHash} (+${(r.stdout.match(/^ {2}\+ /gm) ?? []).length} -${(r.stdout.match(/^ {2}- /gm) ?? []).length}) -> anchor_sheet dry-run (not sent)`);
    assert.match(r.stdout, new RegExp(`sheet diff \\(round ${prev.round} -> ${now.round},`));
    assert.equal(logEvents(out).length, events + 2);
    events += 2;
    prev = now;
  }
});

test("the same question asked twice differs from the first answer only through the new round: both runs are internally consistent", () => {
  const out = fresh();
  const a = ask(["--out", out, "skeptic", "same question"]);
  const hashA = sheetOf(out, "skeptic").sheetHash;
  const b = ask(["--out", out, "skeptic", "same question"]);
  const hashB = sheetOf(out, "skeptic").sheetHash;
  assert.equal(a.code + b.code, 0);
  assert.notEqual(hashA, hashB, "a second ask is a new round, so a new sheet");
  assert.ok(lastLine(a.stdout).includes(hashA));
  assert.ok(lastLine(b.stdout).includes(hashB));
});

test("asking one agent leaves the other agents' sheets and logs byte-identical", () => {
  const out = fresh();
  const before = snapshot(out);
  assert.equal(ask(["--out", out, "social", "hi"]).code, 0);
  const after = snapshot(out);
  for (const [path, bytes] of Object.entries(before)) {
    if (path.includes(`${join("memory", "social")}`)) continue;
    assert.equal(after[path], bytes, path);
  }
});

// ---- offline, no keys ----------------------------------------------------------

test("with a key in the environment, mock mode never prints it, never uses the network, and exits 0", async () => {
  const out = fresh();
  const r = await runOffline([SCRIPT, "--out", out, "aloof", "hello?"], {
    env: { MOCK_INFERENCE: "1", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "some/model", NEAR_AI_BASE_URL: "https://example.invalid/v1" },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.violations, []);
  assert.equal(r.stderr, MODE_LINE);
  for (const text of [r.stdout, r.stderr, read(out, "memory", "aloof", "log.jsonl"), read(out, "memory", "aloof", "sheet.json")]) {
    assert.ok(!text.includes(FAKE_KEY));
    assert.ok(!text.includes("example.invalid"));
  }
});

test("live mode with a key but the network blocked: the failure is one line, the key is never printed, and nothing is written", async () => {
  const out = fresh();
  const before = snapshot(out);
  const r = await runOffline([SCRIPT, "--out", out, "aloof", "hello?"], {
    env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: FAKE_KEY, NEAR_AI_MODEL: "some/model" },
  });
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.ok(!r.stderr.includes(FAKE_KEY), r.stderr);
  assert.ok(noStack(r.stderr), r.stderr);
  assert.match(r.stderr, /ask: inference error \(/);
  assert.deepEqual(snapshot(out), before);
});

test("a key in the question itself is stored as the owner's words but the key variable never leaks into output", () => {
  const out = fresh();
  const r = ask(["--out", out, "chaotic", "hello?"], { env: { NEAR_AI_API_KEY: FAKE_KEY } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY));
});
