// Edge-case behaviour tests for scripts/board.mjs: argument parsing, usage
// errors, actor handling, notes, depends_on canonicalisation and the event log.
// Every case spawns the real script in a fresh temp dir.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "board.mjs");
const NO_STACK = /\n\s+at /;

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-edges-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args, env = {}) {
  const base = { ...process.env };
  delete base.BOARD_ACTOR;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8" });
  assert.ok(!NO_STACK.test(r.stderr), `stack trace leaked:\n${r.stderr}`);
  return r;
}

const boardPath = (cwd) => path.join(cwd, "board", "board.json");
const eventsPath = (cwd) => path.join(cwd, "board", "events.jsonl");
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const snapshot = (cwd) => ({ board: readText(boardPath(cwd)), events: readText(eventsPath(cwd)), dir: fs.existsSync(path.join(cwd, "board")) });
const readBoard = (cwd) => JSON.parse(fs.readFileSync(boardPath(cwd), "utf8"));
const readEvents = (cwd) =>
  fs
    .readFileSync(eventsPath(cwd), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function writeBoard(cwd, items) {
  fs.mkdirSync(path.join(cwd, "board"), { recursive: true });
  fs.writeFileSync(boardPath(cwd), typeof items === "string" ? items : JSON.stringify(items));
}

/** Runs a command that must fail: exact stderr, exit 1, empty stdout, board state untouched. */
function expectFail(t, args, stderr, { env = { BOARD_ACTOR: "ada" }, setup } = {}) {
  const cwd = tempRepo(t);
  if (setup) setup(cwd);
  const before = snapshot(cwd);
  const r = run(cwd, args, env);
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.stderr, stderr);
  assert.equal(r.stdout, "");
  assert.deepEqual(snapshot(cwd), before, "board files must be unchanged");
}

const ACT = ["--actor", "ada"];

function seed(cwd, ...cmds) {
  for (const cmd of cmds) {
    const r = run(cwd, [...cmd, ...ACT]);
    assert.equal(r.status, 0, r.stderr);
  }
}

// ---- parsing and usage errors ----

test("a bare -- token fails with 'missing flag name' and creates no board dir", (t) => {
  expectFail(t, ["--", "list"], "error: missing flag name\n");
});

test("add and suggest without a title fail and write nothing", (t) => {
  expectFail(t, ["add", "--actor", "ada"], "error: add requires a title\n", { env: {} });
  expectFail(t, ["suggest", "--note", "x", "--actor", "ada"], "error: suggest requires a title\n", { env: {} });
});

test("positional-count errors print the exact usage line and write nothing", (t) => {
  const cases = [
    [["list", "extra"], "list takes no arguments"],
    [["log", "extra"], "log takes no arguments"],
    [["accept"], "usage: accept <id>"],
    [["accept", "a", "b"], "usage: accept <id>"],
    [["set", "only-id"], "usage: set <id> <status> [--note TEXT]"],
    [["set", "a", "b", "c"], "usage: set <id> <status> [--note TEXT]"],
    [["changed"], "usage: changed <id> --note TEXT"],
    [["changed", "a", "b"], "usage: changed <id> --note TEXT"],
    [["claim", "--owner", "x"], "usage: claim <id> --owner NAME"],
  ];
  for (const [args, msg] of cases) expectFail(t, args, `error: ${msg}\n`);
});

test("changed without --note, and set with an empty --note, say '--note requires a value'", (t) => {
  const setup = (cwd) => seed(cwd, ["add", "thing"]);
  expectFail(t, ["changed", "thing"], "error: --note requires a value\n", { setup });
  expectFail(t, ["set", "thing", "done", "--note", ""], "error: --note requires a value\n", { setup });
});

test("list rejects bad or missing --status and --lane values", (t) => {
  expectFail(t, ["list", "--status", "bogus"], "error: invalid status: bogus (expected suggested, todo, doing, review, done, dropped)\n");
  expectFail(t, ["list", "--lane", "bot"], "error: invalid lane: bot (expected grok, claude, human, any)\n");
  expectFail(t, ["list", "--status"], "error: --status requires a value\n");
});

// ---- actor ----

test("empty or whitespace --actor is rejected; whitespace BOARD_ACTOR means no actor", (t) => {
  expectFail(t, ["add", "x", "--actor", ""], "error: --actor requires a value\n", { env: {} });
  expectFail(t, ["add", "x", "--actor", "   "], "error: --actor requires a value\n", { env: {} });
  expectFail(t, ["add", "x"], "error: actor required (pass --actor or set BOARD_ACTOR)\n", { env: { BOARD_ACTOR: "   " } });
  expectFail(t, ["add", "x"], "error: actor required (pass --actor or set BOARD_ACTOR)\n", { env: {} });
});

test("--actor beats BOARD_ACTOR and is trimmed", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["add", "who", "--actor", "  flagger  "], { BOARD_ACTOR: "envy" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readBoard(cwd)[0].updated_by, "flagger");
  assert.equal(readEvents(cwd)[0].actor, "flagger");
});

// ---- add / ids ----

test("multi-word title from several argv tokens becomes one title and a slug id", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["add", "NEP", "171", "contract", ...ACT]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "add nep-171-contract - -> todo\n");
  const [item] = readBoard(cwd);
  assert.equal(item.title, "NEP 171 contract");
  assert.equal(item.id, "nep-171-contract");
});

test("a title that slugifies to nothing gets id 'item', then 'item-2'", (t) => {
  const cwd = tempRepo(t);
  seed(cwd, ["add", "!!!"], ["add", "???"]);
  assert.deepEqual(
    readBoard(cwd).map((i) => i.id),
    ["item", "item-2"],
  );
});

test("--json on a non-list command is ignored", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["add", "x", "--json", ...ACT]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "add x - -> todo\n");
  assert.equal(readBoard(cwd).length, 1);
});

// ---- claim ----

test("claim rejects doing (even for the same owner), review and done items", (t) => {
  const setup = (status, owner) => (cwd) => {
    seed(cwd, ["add", "job"]);
    if (owner) seed(cwd, ["claim", "job", "--owner", owner]);
    if (status) seed(cwd, ["set", "job", status]);
  };
  // Current behaviour: re-claiming your own doing item is rejected.
  expectFail(t, ["claim", "job", "--owner", "bob"], "error: job is doing, not todo\n", { setup: setup(null, "bob") });
  expectFail(t, ["claim", "job", "--owner", "bob"], "error: job is review, not todo\n", { setup: setup("review") });
  expectFail(t, ["claim", "job", "--owner", "bob"], "error: job is done, not todo\n", { setup: setup("done") });
});

test("claim without --owner fails", (t) => {
  expectFail(t, ["claim", "job"], "error: --owner requires a value\n", { setup: (cwd) => seed(cwd, ["add", "job"]) });
});

// ---- notes ----

test("notes append with a newline; events carry each note separately", (t) => {
  const cwd = tempRepo(t);
  seed(cwd, ["add", "job"], ["set", "job", "doing", "--note", "first"], ["changed", "job", "--note", "second"]);
  assert.equal(readBoard(cwd)[0].notes, "first\nsecond");
  const events = readEvents(cwd);
  assert.deepEqual(
    events.map((e) => e.note),
    ["", "first", "second"],
  );
});

// ---- depends_on ----

test("depends_on is canonicalised on write, dropped when empty, and list --json matches the file", (t) => {
  const cwd = tempRepo(t);
  writeBoard(cwd, [
    { id: "one", title: "One", status: "todo", kind: "task", updated_at: "t", updated_by: "u", depends_on: ["b", "a", "a", "  c  ", 3, ""] },
    { id: "two", title: "Two", status: "todo", kind: "task", updated_at: "t", updated_by: "u", depends_on: [] },
    { id: "three", title: "Three", status: "todo", kind: "task", updated_at: "t", updated_by: "u" },
  ]);
  const r = run(cwd, ["set", "three", "doing", ...ACT]);
  assert.equal(r.status, 0, r.stderr);
  const items = readBoard(cwd);
  assert.deepEqual(
    items.map((i) => i.id),
    ["one", "three", "two"],
  );
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual(Object.keys(byId.one), ["id", "title", "status", "owner", "kind", "lane", "depends_on", "notes", "updated_at", "updated_by"]);
  assert.deepEqual(byId.one.depends_on, ["a", "b", "c"]);
  assert.equal("depends_on" in byId.two, false);
  assert.equal("depends_on" in byId.three, false);
  for (const i of items) {
    if (i.id === "three") continue;
    assert.equal(i.owner, "");
    assert.equal(i.notes, "");
    assert.equal(i.lane, "any");
  }
  const listed = run(cwd, ["list", "--json"]);
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, fs.readFileSync(boardPath(cwd), "utf8"));
});

// ---- empty board file ----

test("empty or whitespace-only board.json lists as no items and add recovers it", (t) => {
  for (const content of ["", "  \n\t\n"]) {
    const cwd = tempRepo(t);
    writeBoard(cwd, content);
    const r = run(cwd, ["list"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "(no items)\n");
    seed(cwd, ["add", "fresh"]);
    assert.deepEqual(
      readBoard(cwd).map((i) => i.id),
      ["fresh"],
    );
  }
});

// ---- log ----

test("log with no events file prints nothing and creates no board dir", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["log"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(fs.existsSync(path.join(cwd, "board")), false);
});

test("log --since skips unparseable timestamps and keeps the rest; --since '' is an error", (t) => {
  const cwd = tempRepo(t);
  seed(cwd, ["add", "job"]);
  const bad = JSON.stringify({ ts: "garbage", actor: "x", item_id: "z", action: "add", from: null, to: "todo", note: "" });
  fs.appendFileSync(eventsPath(cwd), `${bad}\n`);
  const all = run(cwd, ["log"]);
  assert.equal(all.stdout.split("\n").filter(Boolean).length, 2);
  const r = run(cwd, ["log", "--since", "2000-01-01T00:00:00Z"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).item_id, "job");
  expectFail(t, ["log", "--since", ""], "error: --since requires a value\n");
});

// ---- help ----

test("--help only wins when no command is given; 'list --help' runs list", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["list", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "(no items)\n");
});
