import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Every run happens in a fresh temp directory: board.mjs resolves ./board from the
// working directory, so the repo's own board/ is never touched.
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "board.mjs");

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-gaps14-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args, env = {}) {
  const base = { ...process.env, BOARD_ACTOR: "tester" };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8" });
}

const events = (cwd) =>
  fs.readFileSync(path.join(cwd, "board", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const items = (cwd) => JSON.parse(run(cwd, ["list", "--json"]).stdout);

test("list --json on a missing board is an empty JSON list and creates nothing", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["list", "--json"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "[]\n");
  assert.equal(r.stderr, "");
  assert.ok(!fs.existsSync(path.join(cwd, "board")));
});

test("list with a filter that matches nothing prints (no items), and --json prints []", (t) => {
  const cwd = tempRepo(t);
  assert.equal(run(cwd, ["add", "Only task"]).status, 0);
  const plain = run(cwd, ["list", "--status", "done"]);
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, "(no items)\n");
  assert.equal(run(cwd, ["list", "--status", "done", "--json"]).stdout, "[]\n");
});

test("set to the current status and changed print the short '(status)' confirmation and log from == to", (t) => {
  const cwd = tempRepo(t);
  run(cwd, ["add", "Same state"]);
  const set = run(cwd, ["set", "same-state", "todo"]);
  assert.equal(set.stdout, "set same-state (todo)\n");
  const changed = run(cwd, ["changed", "same-state", "--note", "progress"]);
  assert.equal(changed.stdout, "changed same-state (todo)\n");
  const log = events(cwd);
  assert.deepEqual(log.slice(1).map((e) => [e.action, e.from, e.to]), [["set", "todo", "todo"], ["changed", "todo", "todo"]]);
  assert.equal(log[2].note, "progress");
});

test("set is unrestricted: a done item can go back to todo, and the arrow shows both ends", (t) => {
  const cwd = tempRepo(t);
  run(cwd, ["add", "Round trip"]);
  assert.equal(run(cwd, ["set", "round-trip", "done"]).stdout, "set round-trip todo -> done\n");
  assert.equal(run(cwd, ["set", "round-trip", "todo"]).stdout, "set round-trip done -> todo\n");
  assert.equal(items(cwd)[0].status, "todo");
});

test("suggest makes a suggestion-kind item with the note, accept turns it into a todo and keeps its kind", (t) => {
  const cwd = tempRepo(t);
  const s = run(cwd, ["suggest", "Add dark mode", "--note", "judges like it"]);
  assert.equal(s.stdout, "suggest add-dark-mode - -> suggested\n");
  let [item] = items(cwd);
  assert.deepEqual([item.kind, item.status, item.owner, item.lane, item.notes], ["suggestion", "suggested", "", "any", "judges like it"]);
  const a = run(cwd, ["accept", "add-dark-mode"]);
  assert.equal(a.stdout, "accept add-dark-mode suggested -> todo\n");
  [item] = items(cwd);
  assert.deepEqual([item.kind, item.status, item.notes], ["suggestion", "todo", "judges like it"]);
  const log = events(cwd);
  assert.deepEqual(log.map((e) => [e.action, e.from, e.to, e.note]), [
    ["suggest", null, "suggested", "judges like it"],
    ["accept", "suggested", "todo", ""],
  ]);
});

test("suggest without --note fails with '--note requires a value' and writes nothing", (t) => {
  const cwd = tempRepo(t);
  const r = run(cwd, ["suggest", "No reason"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "error: --note requires a value\n");
  assert.ok(!fs.existsSync(path.join(cwd, "board")));
});

test("add --owner stores the trimmed owner; a bare --owner is an error and nothing is written", (t) => {
  const cwd = tempRepo(t);
  assert.equal(run(cwd, ["add", "Owned", "--owner", "  ada  "]).status, 0);
  assert.equal(items(cwd)[0].owner, "ada");
  const bare = run(cwd, ["add", "Orphan", "--owner"]);
  assert.equal(bare.status, 1);
  assert.equal(bare.stderr, "error: --owner requires a value\n");
  assert.equal(items(cwd).length, 1);
  assert.equal(events(cwd).length, 1);
});

test("claim trims the owner, records it, and lists it in the table", (t) => {
  const cwd = tempRepo(t);
  run(cwd, ["add", "Claimable"]);
  const r = run(cwd, ["claim", "claimable", "--owner", " bob "]);
  assert.equal(r.stdout, "claim claimable todo -> doing\n");
  assert.equal(items(cwd)[0].owner, "bob");
  assert.match(run(cwd, ["list"]).stdout, /^claimable\tdoing\tany\tbob\ttask\tClaimable$/m);
});

test("log --since is inclusive of an event stamped exactly at the cutoff and drops earlier ones", (t) => {
  const cwd = tempRepo(t);
  fs.mkdirSync(path.join(cwd, "board"));
  const mk = (ts, id) => JSON.stringify({ ts, actor: "a", item_id: id, action: "set", from: null, to: "todo", note: "" });
  const lines = [mk("2026-11-01T00:00:00.000Z", "early"), mk("2026-11-02T00:00:00.000Z", "edge"), mk("2026-11-03T00:00:00.000Z", "late")];
  fs.writeFileSync(path.join(cwd, "board", "events.jsonl"), `${lines.join("\n")}\n`);
  const r = run(cwd, ["log", "--since", "2026-11-02T00:00:00.000Z"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${lines[1]}\n${lines[2]}\n`);
});

test("list --lane and --status together intersect, and the table is sorted by id", (t) => {
  const cwd = tempRepo(t);
  run(cwd, ["add", "Zeta", "--lane", "grok"]);
  run(cwd, ["add", "Alpha", "--lane", "grok"]);
  run(cwd, ["add", "Beta", "--lane", "claude"]);
  run(cwd, ["set", "zeta", "done"]);
  const both = run(cwd, ["list", "--lane", "grok", "--status", "todo"]).stdout.trim().split("\n");
  assert.equal(both.length, 2);
  assert.match(both[1], /^alpha\ttodo\tgrok\t/);
  const grok = run(cwd, ["list", "--lane", "grok"]).stdout.trim().split("\n").slice(1).map((l) => l.split("\t")[0]);
  assert.deepEqual(grok, ["alpha", "zeta"]);
});
