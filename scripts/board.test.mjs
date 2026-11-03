import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "board.mjs");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ITEM_KEYS = [
  "id",
  "title",
  "status",
  "owner",
  "kind",
  "lane",
  "notes",
  "updated_at",
  "updated_by",
];
const EVENT_KEYS = ["ts", "actor", "item_id", "action", "from", "to", "note"];
const SEED_TITLES = [
  "NEP-171 contract",
  "inference client + mock mode",
  "shared channel + on-chain anchor",
  "memory/summarizer",
  "testnet deploy + mint 3 agents",
  "sim mode",
  "viewer",
  "contract audit",
  "feature freeze Nov 11",
  "fresh-clone test + demo video",
  "README + X post draft",
  "submission buffer Nov 14",
];

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
}

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function boardFile(cwd) {
  return path.join(cwd, "board", "board.json");
}

function eventsFile(cwd) {
  return path.join(cwd, "board", "events.jsonl");
}

function readBoard(cwd) {
  return JSON.parse(fs.readFileSync(boardFile(cwd), "utf8"));
}

function readEvents(cwd) {
  const raw = fs.readFileSync(eventsFile(cwd), "utf8");
  if (raw.trim() === "") return [];
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

test("add creates a todo task", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const created = run(cwd, ["add", "NEP-171 contract", "--owner", "ada"], {
    BOARD_ACTOR: "ada",
  });
  assert.equal(created.status, 0, created.stderr);

  const items = readBoard(cwd);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "nep-171-contract");
  assert.equal(items[0].title, "NEP-171 contract");
  assert.equal(items[0].status, "todo");
  assert.equal(items[0].owner, "ada");
  assert.equal(items[0].kind, "task");
  assert.equal(items[0].lane, "any");
  assert.equal(items[0].notes, "");
  assert.equal(items[0].updated_by, "ada");
  assert.deepEqual(Object.keys(items[0]), ITEM_KEYS);

  const events = readEvents(cwd);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "add");
  assert.equal(events[0].actor, "ada");
  assert.equal(events[0].item_id, "nep-171-contract");
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, "todo");
  assert.deepEqual(Object.keys(events[0]), EVENT_KEYS);
});

test("suggest then accept moves a suggestion to todo", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const missing = run(cwd, ["suggest", "Use mocks", "--actor", "ada"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--note requires a value/);

  const suggested = run(cwd, [
    "suggest",
    "Use mocks",
    "--note",
    "faster tests",
    "--actor",
    "ada",
  ]);
  assert.equal(suggested.status, 0, suggested.stderr);

  let items = readBoard(cwd);
  assert.equal(items[0].id, "use-mocks");
  assert.equal(items[0].status, "suggested");
  assert.equal(items[0].kind, "suggestion");
  assert.equal(items[0].notes, "faster tests");

  const accepted = run(cwd, ["accept", "use-mocks", "--actor", "ada"]);
  assert.equal(accepted.status, 0, accepted.stderr);
  items = readBoard(cwd);
  assert.equal(items[0].status, "todo");
  assert.equal(items[0].kind, "suggestion");
  assert.equal(items[0].notes, "faster tests");

  const events = readEvents(cwd);
  assert.deepEqual(
    events.map((event) => event.action),
    ["suggest", "accept"],
  );
  assert.equal(events[1].from, "suggested");
  assert.equal(events[1].to, "todo");
});

test("claim fails when the item is already doing for another owner", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Contract", "--actor", "ada"]).status, 0);
  const claimed = run(cwd, ["claim", "contract", "--owner", "alice", "--actor", "alice"]);
  assert.equal(claimed.status, 0, claimed.stderr);

  const before = fs.readFileSync(boardFile(cwd), "utf8");
  const eventsBefore = fs.readFileSync(eventsFile(cwd), "utf8");
  const conflict = run(cwd, ["claim", "contract", "--owner", "bob", "--actor", "bob"]);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /already doing for alice/);
  assert.equal(fs.readFileSync(boardFile(cwd), "utf8"), before);
  assert.equal(fs.readFileSync(eventsFile(cwd), "utf8"), eventsBefore);

  const item = readBoard(cwd)[0];
  assert.equal(item.status, "doing");
  assert.equal(item.owner, "alice");
});

test("invalid status and unknown id are rejected", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Thing", "--actor", "ada"]).status, 0);
  const before = fs.readFileSync(boardFile(cwd), "utf8");
  const eventsBefore = fs.readFileSync(eventsFile(cwd), "utf8");

  const badStatus = run(cwd, ["set", "thing", "shipped", "--actor", "ada"]);
  assert.notEqual(badStatus.status, 0);
  assert.match(badStatus.stderr, /invalid status: shipped/);
  assert.match(badStatus.stderr, /suggested, todo, doing, review, done, dropped/);

  const unknown = run(cwd, ["set", "nope", "done", "--actor", "ada"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown id: nope/);

  assert.equal(fs.readFileSync(boardFile(cwd), "utf8"), before);
  assert.equal(fs.readFileSync(eventsFile(cwd), "utf8"), eventsBefore);
});

test("event log records changes and filters with --since", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Widget", "--actor", "ada"]).status, 0);
  const firstLine = fs.readFileSync(eventsFile(cwd), "utf8").split("\n")[0];

  assert.equal(
    run(cwd, ["set", "widget", "doing", "--actor", "ada"]).status,
    0,
  );
  assert.equal(fs.readFileSync(eventsFile(cwd), "utf8").split("\n")[0], firstLine);

  const changed = run(cwd, [
    "changed",
    "widget",
    "--note",
    "pushed the branch",
    "--actor",
    "claude",
  ]);
  assert.equal(changed.status, 0, changed.stderr);

  const item = readBoard(cwd)[0];
  assert.equal(item.status, "doing");
  assert.equal(item.notes, "pushed the branch");

  const events = readEvents(cwd);
  assert.deepEqual(
    events.map((event) => event.action),
    ["add", "set", "changed"],
  );
  assert.equal(events[2].from, "doing");
  assert.equal(events[2].to, "doing");
  assert.equal(events[2].note, "pushed the branch");
  assert.equal(events[2].actor, "claude");

  const logged = run(cwd, ["log"]);
  assert.equal(logged.status, 0, logged.stderr);
  assert.match(logged.stdout, /"action":"add"/);
  assert.match(logged.stdout, /"action":"changed"/);

  const future = run(cwd, ["log", "--since", "2999-01-01T00:00:00.000Z"]);
  assert.equal(future.status, 0, future.stderr);
  assert.equal(future.stdout, "");

  const past = run(cwd, ["log", "--since", "2000-01-01T00:00:00.000Z"]);
  assert.equal(past.stdout, logged.stdout);

  const badSince = run(cwd, ["log", "--since", "not-a-date"]);
  assert.notEqual(badSince.status, 0);
  assert.match(badSince.stderr, /invalid --since/);
});

test("board json stays sorted and list --json is stable", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Bravo", "--actor", "ada"]).status, 0);
  assert.equal(run(cwd, ["add", "Alpha", "--actor", "ada"]).status, 0);

  const text = fs.readFileSync(boardFile(cwd), "utf8");
  const items = JSON.parse(text);
  assert.deepEqual(
    items.map((item) => item.id),
    ["alpha", "bravo"],
  );
  assert.deepEqual(Object.keys(items[0]), ITEM_KEYS);
  assert.equal(text, `${JSON.stringify(items, null, 2)}\n`);

  const first = run(cwd, ["list", "--json"]);
  const second = run(cwd, ["list", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.stdout, text);

  const seeded = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "board", "board.json"), "utf8"),
  );
  const seedText = fs.readFileSync(path.join(REPO_ROOT, "board", "board.json"), "utf8");
  assert.equal(seedText, `${JSON.stringify(seeded, null, 2)}\n`);
  assert.deepEqual(
    seeded.map((item) => item.id),
    [...seeded.map((item) => item.id)].sort(),
  );
  assert.deepEqual(seeded.map((item) => item.title).sort(), [...SEED_TITLES].sort());
  const statuses = ["suggested", "todo", "doing", "review", "done", "dropped"];
  for (const item of seeded) {
    assert.ok(statuses.includes(item.status), `${item.id} status ${item.status}`);
    assert.equal(item.kind, "task");
    assert.ok(["grok", "claude", "human", "any"].includes(item.lane), `${item.id} lane ${item.lane}`);
    assert.deepEqual(Object.keys(item), ITEM_KEYS);
  }
});

test("list --json filters by status", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Open", "--actor", "ada"]).status, 0);
  assert.equal(run(cwd, ["add", "Closed", "--actor", "ada"]).status, 0);
  assert.equal(run(cwd, ["set", "closed", "done", "--actor", "ada"]).status, 0);

  const listed = run(cwd, ["list", "--status", "todo", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const items = JSON.parse(listed.stdout);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "open");
  assert.equal(items[0].status, "todo");
});

test("set stores --note on the item and the event", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Widget", "--actor", "ada"]).status, 0);
  const updated = run(cwd, [
    "set",
    "widget",
    "review",
    "--note",
    "ready for eyes",
    "--actor",
    "ada",
  ]);
  assert.equal(updated.status, 0, updated.stderr);

  let item = readBoard(cwd)[0];
  assert.equal(item.status, "review");
  assert.equal(item.notes, "ready for eyes");

  const setEvent = readEvents(cwd).find((event) => event.action === "set");
  assert.equal(setEvent.from, "todo");
  assert.equal(setEvent.to, "review");
  assert.equal(setEvent.note, "ready for eyes");

  assert.equal(run(cwd, ["set", "widget", "done", "--actor", "ada"]).status, 0);
  item = readBoard(cwd)[0];
  assert.equal(item.status, "done");
  assert.equal(item.notes, "ready for eyes");
});

test("lane defaults to any and list --lane filters", (t) => {
  const cwd = tempRepo();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  assert.equal(run(cwd, ["add", "Shared", "--actor", "ada"]).status, 0);
  assert.equal(
    run(cwd, ["add", "Grok task", "--lane", "grok", "--actor", "ada"]).status,
    0,
  );
  assert.equal(
    run(cwd, ["add", "Claude task", "--lane", "claude", "--actor", "ada"]).status,
    0,
  );

  const before = fs.readFileSync(boardFile(cwd), "utf8");
  const bad = run(cwd, ["add", "Nope", "--lane", "bot", "--actor", "ada"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid lane: bot/);
  assert.equal(fs.readFileSync(boardFile(cwd), "utf8"), before);

  const items = readBoard(cwd);
  assert.equal(items.find((item) => item.title === "Shared").lane, "any");
  assert.equal(items.find((item) => item.title === "Grok task").lane, "grok");

  const grok = JSON.parse(run(cwd, ["list", "--lane", "grok", "--json"]).stdout);
  assert.deepEqual(
    grok.map((item) => item.id),
    ["grok-task"],
  );
  const claude = JSON.parse(run(cwd, ["list", "--lane", "claude", "--json"]).stdout);
  assert.deepEqual(
    claude.map((item) => item.id),
    ["claude-task"],
  );
  const shared = JSON.parse(
    run(cwd, ["list", "--lane", "any", "--status", "todo", "--json"]).stdout,
  );
  assert.deepEqual(
    shared.map((item) => item.id),
    ["shared"],
  );
});
