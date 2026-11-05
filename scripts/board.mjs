#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const STATUSES = ["suggested", "todo", "doing", "review", "done", "dropped"];
const LANES = ["grok", "claude", "human", "any"];
const BOOLEAN_FLAGS = new Set(["json", "help"]);

const USAGE = `usage: node scripts/board.mjs [--actor NAME] <command> [args]

commands:
  list [--status STATUS] [--lane LANE] [--json]
  add <title> [--owner NAME] [--lane grok|claude|human|any]
  suggest <title> --note TEXT
  accept <id>
  claim <id> --owner NAME
  set <id> <status> [--note TEXT]
  changed <id> --note TEXT
  log [--since ISO]

actor: --actor or BOARD_ACTOR
`;

function fail(message) {
  fs.writeSync(2, `error: ${message}\n`);
  process.exit(1);
}

function out(text) {
  fs.writeSync(1, text);
}

function boardPaths() {
  const dir = path.resolve(process.cwd(), "board");
  return {
    board: path.join(dir, "board.json"),
    events: path.join(dir, "events.jsonl"),
  };
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!key) fail("missing flag name");
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = value;
    i += 1;
  }
  return { positionals, flags };
}

function requireString(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`--${name} requires a value`);
  }
  return value.trim();
}

function actor(flags) {
  if (flags.actor !== undefined) return requireString(flags, "actor");
  const fromEnv = process.env.BOARD_ACTOR;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  fail("actor required (pass --actor or set BOARD_ACTOR)");
}

function requireStatus(value) {
  if (!STATUSES.includes(value)) {
    fail(`invalid status: ${value} (expected ${STATUSES.join(", ")})`);
  }
  return value;
}

function requireLane(value) {
  if (!LANES.includes(value)) {
    fail(`invalid lane: ${value} (expected ${LANES.join(", ")})`);
  }
  return value;
}

function slugify(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "item";
}

function uniqueId(items, title) {
  const base = slugify(title);
  const ids = new Set(items.map((item) => item.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

// depends_on is optional: ids this item waits on. Kept only when non-empty so
// items without dependencies keep their original shape.
function dependsOn(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id) => typeof id === "string" && id.trim() !== "");
  return [...new Set(ids.map((id) => id.trim()))].sort();
}

function canonicalize(item) {
  const deps = dependsOn(item.depends_on);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    owner: item.owner ?? "",
    kind: item.kind,
    lane: item.lane || "any",
    ...(deps.length > 0 ? { depends_on: deps } : {}),
    notes: item.notes ?? "",
    updated_at: item.updated_at,
    updated_by: item.updated_by,
  };
}

function byId(a, b) {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function serializeItems(items) {
  const sorted = items.map(canonicalize).sort(byId);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function loadItems(file) {
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    fail(`board/board.json cannot be read (${err.code ?? err.message})`);
  }
  if (raw.trim() === "") return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    fail(`board/board.json is not valid JSON (${err.message})`);
  }
  if (!Array.isArray(data)) fail("board/board.json must be a JSON list");
  return data.map(canonicalize);
}

function writeBoard(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeItems(items));
}

function appendEvent(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ordered = {
    ts: event.ts,
    actor: event.actor,
    item_id: event.item_id,
    action: event.action,
    from: event.from ?? null,
    to: event.to ?? null,
    note: event.note ?? "",
  };
  fs.appendFileSync(file, `${JSON.stringify(ordered)}\n`);
}

function commit(items, event) {
  const paths = boardPaths();
  writeBoard(paths.board, items);
  appendEvent(paths.events, event);
}

function requireItem(items, id) {
  const item = items.find((entry) => entry.id === id);
  if (!item) fail(`unknown id: ${id}`);
  return item;
}

function touch(item, who, note) {
  const ts = new Date().toISOString();
  item.updated_at = ts;
  item.updated_by = who;
  if (note) item.notes = item.notes ? `${item.notes}\n${note}` : note;
  return ts;
}

function confirm(action, id, fromStatus, toStatus) {
  if (fromStatus === toStatus) {
    out(`${action} ${id} (${toStatus})\n`);
    return;
  }
  out(`${action} ${id} ${fromStatus ?? "-"} -> ${toStatus}\n`);
}

function cmdList(positionals, flags) {
  if (positionals.length !== 0) fail("list takes no arguments");
  let items = loadItems(boardPaths().board);
  if (flags.status !== undefined) {
    const status = requireStatus(requireString(flags, "status"));
    items = items.filter((item) => item.status === status);
  }
  if (flags.lane !== undefined) {
    const lane = requireLane(requireString(flags, "lane"));
    items = items.filter((item) => item.lane === lane);
  }
  items.sort(byId);
  if (flags.json === true) {
    out(serializeItems(items));
    return;
  }
  if (items.length === 0) {
    out("(no items)\n");
    return;
  }
  out("id\tstatus\tlane\towner\tkind\ttitle\n");
  for (const item of items) {
    out(
      `${item.id}\t${item.status}\t${item.lane}\t${item.owner || "-"}\t${item.kind}\t${item.title}\n`,
    );
  }
}

function cmdAdd(positionals, flags) {
  const title = positionals.join(" ").trim();
  if (!title) fail("add requires a title");
  const who = actor(flags);
  const owner = flags.owner === undefined ? "" : requireString(flags, "owner");
  const lane = flags.lane === undefined ? "any" : requireLane(requireString(flags, "lane"));
  const items = loadItems(boardPaths().board);
  const item = {
    id: uniqueId(items, title),
    title,
    status: "todo",
    owner,
    kind: "task",
    lane,
    notes: "",
    updated_at: "",
    updated_by: "",
  };
  const ts = touch(item, who, "");
  items.push(item);
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "add",
    from: null,
    to: "todo",
    note: "",
  });
  confirm("add", item.id, null, "todo");
}

function cmdSuggest(positionals, flags) {
  const title = positionals.join(" ").trim();
  if (!title) fail("suggest requires a title");
  const note = requireString(flags, "note");
  const who = actor(flags);
  const items = loadItems(boardPaths().board);
  const item = {
    id: uniqueId(items, title),
    title,
    status: "suggested",
    owner: "",
    kind: "suggestion",
    lane: "any",
    notes: "",
    updated_at: "",
    updated_by: "",
  };
  const ts = touch(item, who, note);
  items.push(item);
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "suggest",
    from: null,
    to: "suggested",
    note,
  });
  confirm("suggest", item.id, null, "suggested");
}

function cmdAccept(positionals, flags) {
  if (positionals.length !== 1) fail("usage: accept <id>");
  const who = actor(flags);
  const items = loadItems(boardPaths().board);
  const item = requireItem(items, positionals[0]);
  if (item.status !== "suggested") {
    fail(`${item.id} is ${item.status}, not suggested`);
  }
  const from = item.status;
  item.status = "todo";
  const ts = touch(item, who, "");
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "accept",
    from,
    to: "todo",
    note: "",
  });
  confirm("accept", item.id, from, "todo");
}

function cmdClaim(positionals, flags) {
  if (positionals.length !== 1) fail("usage: claim <id> --owner NAME");
  const owner = requireString(flags, "owner");
  const who = actor(flags);
  const items = loadItems(boardPaths().board);
  const item = requireItem(items, positionals[0]);
  if (item.status === "doing" && item.owner !== owner) {
    fail(`${item.id} is already doing for ${item.owner || "someone else"}`);
  }
  if (item.status !== "todo") fail(`${item.id} is ${item.status}, not todo`);
  const from = item.status;
  item.status = "doing";
  item.owner = owner;
  const ts = touch(item, who, "");
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "claim",
    from,
    to: "doing",
    note: "",
  });
  confirm("claim", item.id, from, "doing");
}

function cmdSet(positionals, flags) {
  if (positionals.length !== 2) fail("usage: set <id> <status> [--note TEXT]");
  const status = requireStatus(positionals[1]);
  const note = flags.note === undefined ? "" : requireString(flags, "note");
  const who = actor(flags);
  const items = loadItems(boardPaths().board);
  const item = requireItem(items, positionals[0]);
  const from = item.status;
  item.status = status;
  const ts = touch(item, who, note);
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "set",
    from,
    to: status,
    note,
  });
  confirm("set", item.id, from, status);
}

function cmdChanged(positionals, flags) {
  if (positionals.length !== 1) fail("usage: changed <id> --note TEXT");
  const note = requireString(flags, "note");
  const who = actor(flags);
  const items = loadItems(boardPaths().board);
  const item = requireItem(items, positionals[0]);
  const ts = touch(item, who, note);
  commit(items, {
    ts,
    actor: who,
    item_id: item.id,
    action: "changed",
    from: item.status,
    to: item.status,
    note,
  });
  confirm("changed", item.id, item.status, item.status);
}

function readEventLines(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return [];
  return raw.split("\n").filter((line) => line.trim() !== "");
}

function cmdLog(positionals, flags) {
  if (positionals.length !== 0) fail("log takes no arguments");
  let sinceMs = null;
  if (flags.since !== undefined) {
    const since = requireString(flags, "since");
    sinceMs = Date.parse(since);
    if (Number.isNaN(sinceMs)) fail(`invalid --since: ${since}`);
  }
  const lines = readEventLines(boardPaths().events);
  for (const line of lines) {
    if (sinceMs !== null) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        fail(`board/events.jsonl has a line that is not valid JSON (${err.message})`);
      }
      const ts = Date.parse(event.ts);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }
    out(`${line}\n`);
  }
}

function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help === true) {
    out(USAGE);
    return;
  }
  const [command, ...rest] = positionals;
  if (!command) {
    fs.writeSync(2, USAGE);
    process.exit(1);
  }
  switch (command) {
    case "list":
      cmdList(rest, flags);
      return;
    case "add":
      cmdAdd(rest, flags);
      return;
    case "suggest":
      cmdSuggest(rest, flags);
      return;
    case "accept":
      cmdAccept(rest, flags);
      return;
    case "claim":
      cmdClaim(rest, flags);
      return;
    case "set":
      cmdSet(rest, flags);
      return;
    case "changed":
      cmdChanged(rest, flags);
      return;
    case "log":
      cmdLog(rest, flags);
      return;
    default:
      fail(`unknown command: ${command}`);
  }
}

main();
