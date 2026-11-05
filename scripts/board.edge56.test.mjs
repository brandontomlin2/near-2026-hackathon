// Malformed-board edge tests for scripts/board.mjs: invalid/odd board.json
// contents and bad ids/args on mutating commands. Each case spawns the real
// script in a fresh temp dir; the real board/board.json is never touched.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-edge56-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args) {
  const env = { ...process.env };
  delete env.BOARD_ACTOR;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 20000 });
}

const boardPath = (cwd) => path.join(cwd, "board", "board.json");
const eventsPath = (cwd) => path.join(cwd, "board", "events.jsonl");
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

function seedRaw(cwd, raw) {
  fs.mkdirSync(path.join(cwd, "board"), { recursive: true });
  fs.writeFileSync(boardPath(cwd), raw);
}

function item(id, status = "todo", extra = {}) {
  return { id, title: id, status, owner: "", kind: "task", lane: "any", notes: "", updated_at: "t", updated_by: "u", ...extra };
}

const ACT = ["--actor", "ada"];

test("every mutating command on invalid JSON fails with one clean line and leaves board and events untouched", (t) => {
  const cmds = [
    ["add", "New thing"],
    ["suggest", "New thing", "--note", "n"],
    ["accept", "x"],
    ["claim", "x", "--owner", "me"],
    ["set", "x", "done"],
    ["changed", "x", "--note", "n"],
  ];
  for (const cmd of cmds) {
    const cwd = tempRepo(t);
    seedRaw(cwd, '[{"id": "x",');
    const r = run(cwd, [...cmd, ...ACT]);
    assert.equal(r.status, 1, `${cmd[0]}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^error: board\/board\.json is not valid JSON \(/);
    assert.equal(r.stderr.trim().split("\n").length, 1);
    assert.doesNotMatch(r.stderr, NO_STACK);
    assert.equal(readText(boardPath(cwd)), '[{"id": "x",');
    assert.equal(readText(eventsPath(cwd)), null, "no event may be logged");
  }
});

test("non-list top levels (null, string, number, boolean) are rejected by list and add, file unchanged", (t) => {
  for (const raw of ["null", '"hello"', "42", "true", '{"items": []}']) {
    for (const cmd of [["list"], ["add", "Thing", ...ACT]]) {
      const cwd = tempRepo(t);
      seedRaw(cwd, raw);
      const r = run(cwd, cmd);
      assert.equal(r.status, 1, `${raw} ${cmd[0]}: ${r.stdout}`);
      assert.equal(r.stderr, "error: board/board.json must be a JSON list\n");
      assert.equal(r.stdout, "");
      assert.equal(readText(boardPath(cwd)), raw);
      assert.equal(readText(eventsPath(cwd)), null);
    }
  }
});

test("a BOM-prefixed or trailing-garbage board.json is reported as invalid JSON, not a crash", (t) => {
  for (const raw of ['﻿[]', "[] extra", "[,]", "[1,]", "NaN"]) {
    const cwd = tempRepo(t);
    seedRaw(cwd, raw);
    const r = run(cwd, ["list"]);
    assert.equal(r.status, 1, `${JSON.stringify(raw)}: ${r.stdout}`);
    assert.match(r.stderr, /^error: board\/board\.json is not valid JSON/);
    assert.doesNotMatch(r.stderr, NO_STACK);
    assert.equal(readText(boardPath(cwd)), raw);
  }
});

test("an empty JSON list lists as no items and add writes a one-item list", (t) => {
  const cwd = tempRepo(t);
  seedRaw(cwd, "[]");
  const listed = run(cwd, ["list"]);
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, "(no items)\n");
  const add = run(cwd, ["add", "First", ...ACT]);
  assert.equal(add.status, 0, add.stderr);
  const board = JSON.parse(readText(boardPath(cwd)));
  assert.deepEqual(board.map((i) => i.id), ["first"]);
});

test("unknown id on claim, set, changed and accept fails with 'unknown id' and changes nothing on a populated board", (t) => {
  const cmds = [
    ["claim", "ghost", "--owner", "me"],
    ["set", "ghost", "done"],
    ["changed", "ghost", "--note", "n"],
    ["accept", "ghost"],
  ];
  for (const cmd of cmds) {
    const cwd = tempRepo(t);
    seedRaw(cwd, JSON.stringify([item("real")]));
    const r = run(cwd, [...cmd, ...ACT]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, "error: unknown id: ghost\n");
    assert.equal(r.stdout, "");
    assert.equal(readText(eventsPath(cwd)), null);
    assert.equal(JSON.parse(readText(boardPath(cwd)))[0].status, "todo");
  }
});

test("ids are matched exactly: case and surrounding whitespace do not resolve to an item", (t) => {
  for (const id of ["REAL", " real", "real "]) {
    const cwd = tempRepo(t);
    seedRaw(cwd, JSON.stringify([item("real")]));
    const r = run(cwd, ["claim", id, "--owner", "me", ...ACT]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `error: unknown id: ${id}\n`);
  }
});

test("claim and changed on an empty board say unknown id; claim extra positionals print usage and write nothing", (t) => {
  const cwd = tempRepo(t);
  const r1 = run(cwd, ["claim", "a", "--owner", "me", ...ACT]);
  assert.equal(r1.status, 1);
  assert.equal(r1.stderr, "error: unknown id: a\n");
  const r2 = run(cwd, ["claim", "a", "b", "--owner", "me", ...ACT]);
  assert.equal(r2.status, 1);
  assert.equal(r2.stderr, "error: usage: claim <id> --owner NAME\n");
  const r3 = run(cwd, ["changed", ...ACT, "--note", "n"]);
  assert.equal(r3.status, 1);
  assert.equal(r3.stderr, "error: usage: changed <id> --note TEXT\n");
  assert.equal(fs.existsSync(path.join(cwd, "board")), false, "failed commands must not create the board dir");
});

test("set rejects unknown, wrong-case and empty status values before touching the item", (t) => {
  for (const status of ["Done", "finished", "", " done"]) {
    const cwd = tempRepo(t);
    seedRaw(cwd, JSON.stringify([item("real")]));
    const before = readText(boardPath(cwd));
    const r = run(cwd, ["set", "real", status, ...ACT]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`^error: invalid status: ${status} \\(expected suggested, todo, doing, review, done, dropped\\)\\n$`));
    assert.equal(readText(boardPath(cwd)), before);
    assert.equal(readText(eventsPath(cwd)), null);
  }
});

test("a command name is case-sensitive: 'LIST' and 'Claim' are unknown commands", (t) => {
  const cwd = tempRepo(t);
  for (const cmd of ["LIST", "Claim", "ls"]) {
    const r = run(cwd, [cmd]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `error: unknown command: ${cmd}\n`);
    assert.equal(r.stdout, "");
  }
});

test("status filter on a board holding only legacy values still validates the filter, not the data", (t) => {
  const cwd = tempRepo(t);
  seedRaw(cwd, JSON.stringify([item("a", "todo"), item("b", "done")]));
  const bad = run(cwd, ["list", "--status", "weird"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^error: invalid status: weird/);
  const ok = run(cwd, ["list", "--status", "done", "--json"]);
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(ok.stdout).map((i) => i.id), ["b"]);
});

test("a malformed events.jsonl does not stop mutations: new events are appended after the garbage", (t) => {
  const cwd = tempRepo(t);
  seedRaw(cwd, JSON.stringify([item("real")]));
  fs.writeFileSync(eventsPath(cwd), "not json\n");
  const r = run(cwd, ["changed", "real", "--note", "hi", ...ACT]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readText(eventsPath(cwd)).split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "not json");
  assert.equal(JSON.parse(lines[1]).action, "changed");
});
