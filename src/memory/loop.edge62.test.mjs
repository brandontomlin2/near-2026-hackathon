// Edge62: the memory loop, the counting sheet stand-in and the file-backed sheet
// store working together over several rounds, when one sheet file on disk is
// damaged between two rounds. Everything runs offline on the mock responder in
// a temp directory: no network, no keys, nothing signed or sent.
//
// runMemoryLoop itself keeps its sheets in memory (it never reads the store), so
// the disk side is driven by a small two-phase round runner below: summarize
// every agent first (nothing written), then write every sheet. That is the
// shape of "a failing round does not partly apply". Tests marked todo state the
// behavior we want where the store (summarizer.mjs, owned by another PR) does
// not deliver it yet; they are reported, not failing the run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createMockClient } from "../inference/client.mjs";
import { runSwarm } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { runMemoryLoop, tokenLogs } from "./loop.mjs";
import { sheetResponder } from "./sheet-responder.mjs";
import { MemoryError, createMemoryStore, summarize } from "./summarizer.mjs";

const ROUNDS = 4;
const VICTIM = "chaotic"; // a middle agent: some agents before it and some after
const scriptPath = fileURLToPath(new URL("../../scripts/swarm.mjs", import.meta.url));
const noNetwork = fileURLToPath(new URL("../../scripts/test-helpers/no-network.mjs", import.meta.url));

const tempRoot = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memory-edge62-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const mockClient = () => createMockClient({ responder: sheetResponder });
const swarmOf = (seed = 1) => runSwarm({ rounds: ROUNDS, seed });

/** Every file under root -> its bytes (hex), directories as "<dir>". */
async function snapshot(root) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out[relative(root, full)] = "<dir>";
        await walk(full);
      } else out[relative(root, full)] = (await readFile(full)).toString("hex");
    }
  };
  await walk(root);
  return out;
}

const sheetFile = (root, id) => join(root, id, "sheet.json");

/**
 * One round for every agent, two phases. Phase 1 reads every stored sheet and
 * summarizes every agent in memory; phase 2 writes. Any error in phase 1 means
 * no file has been touched.
 */
async function runRound({ root, swarm, round, client = mockClient(), agents = AGENTS }) {
  const store = createMemoryStore(root);
  const logs = tokenLogs(swarm.events, agents);
  const records = [];
  for (const agent of agents) {
    const previous = await store.readSheet(agent.id);
    const log = logs[agent.id].filter((e) => e.round <= round);
    records.push(await summarize({ client, tokenId: agent.id, name: agent.name, round, log, previous }));
  }
  for (const record of records) await store.writeSheet(record.tokenId, record);
  return records;
}

async function runRounds(root, swarm, from, to, opts = {}) {
  for (let round = from; round <= to; round++) await runRound({ root, swarm, round, ...opts });
}

/** A clean, uninterrupted run, for comparing resumed runs against. */
async function cleanRun(t, swarm, rounds) {
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, rounds);
  return snapshot(root);
}

const leftovers = (snap) => Object.keys(snap).filter((p) => /\.(tmp|temp|part|bak)$|~$|\.tmp\b/.test(p));

// The ways to damage one sheet file between rounds.
const CORRUPTIONS = [
  { name: "truncated JSON", write: (good) => good.subarray(0, Math.floor(good.length / 2)), code: "bad_sheet" },
  { name: "non-JSON garbage", write: () => Buffer.from("\u0000\u0001\u0002 not a sheet at all <<<>>>", "utf8"), code: "bad_sheet" },
  { name: "an empty file", write: () => Buffer.alloc(0), code: "bad_sheet" },
  { name: "valid JSON of the wrong shape: an array", write: () => Buffer.from("[1, 2, 3]"), code: "bad_state" },
  { name: "valid JSON of the wrong shape: an empty object", write: () => Buffer.from("{}"), code: "bad_state" },
  { name: "valid JSON of the wrong shape: a number", write: () => Buffer.from("42"), code: "bad_state" },
  { name: "valid JSON of the wrong shape: throughIndex missing", write: () => Buffer.from('{"sheet":"Hi."}'), code: "bad_state" },
];

/** Set up: two good rounds, then damage the victim's sheet. Returns what is needed to assert. */
async function damaged(t, corrupt) {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, 2);
  const good = await readFile(sheetFile(root, VICTIM));
  await writeFile(sheetFile(root, VICTIM), corrupt.write(good));
  return { swarm, root, good, before: await snapshot(root) };
}

const oneLine = (message) => !/[\r\n]/.test(message) && message.length > 0 && message.length < 200;

for (const corrupt of CORRUPTIONS) {
  test(`${corrupt.name}: the next round fails with one clean coded line, and not one byte on disk changes`, async (t) => {
    const { swarm, root, before } = await damaged(t, corrupt);
    await assert.rejects(runRound({ root, swarm, round: 3 }), (e) => {
      assert.ok(e instanceof MemoryError, `${e?.name}: ${e?.message}`);
      assert.equal(e.code, corrupt.code);
      assert.ok(oneLine(e.message), JSON.stringify(e.message));
      assert.ok(!/\n\s+at /.test(e.message), "no stack trace in the message");
      assert.ok(!/Unexpected token|is not valid JSON|SyntaxError/.test(e.message), `raw parser text leaked: ${e.message}`);
      return true;
    });
    const after = await snapshot(root);
    assert.deepEqual(after, before, "every sheet, including the damaged one, is byte-identical after the failed round");
    assert.deepEqual(leftovers(after), []);
  });

  test(`${corrupt.name}: restoring the file lets the run resume and end byte-identical to an uninterrupted run`, async (t) => {
    const { swarm, root, good } = await damaged(t, corrupt);
    await assert.rejects(runRound({ root, swarm, round: 3 }));
    await writeFile(sheetFile(root, VICTIM), good);
    await runRounds(root, swarm, 3, ROUNDS);
    assert.deepEqual(await snapshot(root), await cleanRun(t, swarm, ROUNDS));
  });
}

test("the failed round touches no other agent: their sheets are byte-identical whichever agent comes first or last", async (t) => {
  // The victim sits in the middle, so agents before it would already have been
  // summarized when it fails; two-phase rounds keep them unwritten.
  const { swarm, root, before } = await damaged(t, CORRUPTIONS[0]);
  const others = AGENTS.map((a) => a.id).filter((id) => id !== VICTIM);
  assert.ok(others.length >= 3);
  await assert.rejects(runRound({ root, swarm, round: 3 }));
  for (const id of others) {
    assert.equal((await readFile(sheetFile(root, id))).toString("hex"), before[relative(root, sheetFile(root, id))], id);
  }
});

test("a sheet file replaced by a directory: one clean io_error, directory and every sheet left as they were", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, 2);
  await rm(sheetFile(root, VICTIM));
  await mkdir(sheetFile(root, VICTIM));
  const before = await snapshot(root);
  await assert.rejects(runRound({ root, swarm, round: 3 }), (e) => {
    assert.ok(e instanceof MemoryError);
    assert.equal(e.code, "io_error");
    assert.ok(oneLine(e.message), e.message);
    assert.ok(!/\n\s+at /.test(e.message));
    assert.equal(e.cause?.code, "EISDIR", "the OS error is kept as cause, not pasted into the message");
    return true;
  });
  const after = await snapshot(root);
  assert.deepEqual(after, before);
  assert.deepEqual(leftovers(after), []);
  assert.equal((await stat(sheetFile(root, VICTIM))).isDirectory(), true, "the directory is not replaced by a fresh sheet");
});

test("a missing sheet file is the one case that starts fresh: the agent gets a first sheet while the rest build on theirs", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, 2);
  await rm(sheetFile(root, VICTIM));
  const records = await runRound({ root, swarm, round: 3 });
  const byId = Object.fromEntries(records.map((r) => [r.tokenId, r]));
  // A fresh sheet reads the whole log (throughIndex events), a continued one only the new events.
  const fullLog = tokenLogs(swarm.events)[VICTIM].filter((e) => e.round <= 3).length;
  assert.equal(byId[VICTIM].newEvents, fullLog);
  for (const a of AGENTS.filter((x) => x.id !== VICTIM)) {
    const total = tokenLogs(swarm.events)[a.id].filter((e) => e.round <= 3).length;
    assert.equal(byId[a.id].newEvents, total - tokenLogs(swarm.events)[a.id].filter((e) => e.round <= 2).length, a.id);
  }
});

test("a round whose model call fails midway applies nothing: every file is byte-identical, then a retry matches a clean run", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, 2);
  const before = await snapshot(root);
  let calls = 0;
  const flaky = {
    chat: async (req) => {
      if (++calls === 3) throw new Error("inference exploded on agent 3");
      return mockClient().chat(req);
    },
  };
  await assert.rejects(runRound({ root, swarm, round: 3, client: flaky }), /inference exploded on agent 3/);
  assert.equal(calls, 3, "stopped at the failing call");
  const after = await snapshot(root);
  assert.deepEqual(after, before);
  assert.deepEqual(leftovers(after), []);
  await runRounds(root, swarm, 3, ROUNDS);
  assert.deepEqual(await snapshot(root), await cleanRun(t, swarm, ROUNDS));
});

test("a model that answers blank for one agent stops the round with empty_sheet and leaves the disk as it was", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  await runRounds(root, swarm, 1, 2);
  const before = await snapshot(root);
  let calls = 0;
  const blankOnTwo = { chat: async (req) => (++calls === 2 ? { content: "  \n ", mode: "mock", model: "m" } : mockClient().chat(req)) };
  await assert.rejects(runRound({ root, swarm, round: 3, client: blankOnTwo }), (e) => e instanceof MemoryError && e.code === "empty_sheet");
  assert.deepEqual(await snapshot(root), before);
});

test("the same seed gives byte-identical sheet files on two disks; another seed gives different ones", async (t) => {
  const a = await cleanRun(t, await swarmOf(1), ROUNDS);
  const b = await cleanRun(t, await swarmOf(1), ROUNDS);
  const c = await cleanRun(t, await swarmOf(2), ROUNDS);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(Object.keys(a).sort(), AGENTS.map((x) => `${x.id}/sheet.json`).concat(AGENTS.map((x) => x.id)).sort());
});

test("each round's stored record continues the last: round numbers climb, throughIndex never shrinks, hashes chain to the file", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  const seen = Object.fromEntries(AGENTS.map((a) => [a.id, -1]));
  for (let round = 1; round <= ROUNDS; round++) {
    await runRound({ root, swarm, round });
    for (const a of AGENTS) {
      const rec = JSON.parse(await readFile(sheetFile(root, a.id), "utf8"));
      assert.equal(rec.round, round);
      assert.ok(rec.throughIndex >= seen[a.id], `${a.id} cursor went back`);
      seen[a.id] = rec.throughIndex;
      assert.match(rec.sheetHash, /^[0-9a-f]{64}$/);
    }
  }
});

test("runMemoryLoop in memory: a client failing midway rejects with that error, returns nothing and leaves the swarm untouched", async () => {
  const swarm = await swarmOf();
  const copy = structuredClone(swarm);
  let calls = 0;
  const client = { chat: async (req) => (++calls === 5 ? Promise.reject(new Error("model went away")) : mockClient().chat(req)) };
  await assert.rejects(runMemoryLoop({ swarm, client, every: 1 }), /^Error: model went away$/);
  assert.deepEqual(swarm, copy);
  // And a clean rerun on the same swarm is the same as one that never saw the failure.
  const first = await runMemoryLoop({ swarm, client: mockClient(), every: 1 });
  const second = await runMemoryLoop({ swarm, client: mockClient(), every: 1 });
  assert.deepEqual(first, second);
});

test("runMemoryLoop's per-round sheets equal the sheets the disk runner stores round by round (same seed, every=1)", async (t) => {
  const swarm = await swarmOf();
  const root = await tempRoot(t);
  const memory = await runMemoryLoop({ swarm, client: mockClient(), every: 1 });
  for (let round = 1; round <= ROUNDS; round++) {
    await runRound({ root, swarm, round });
    for (const token of memory.tokens) {
      const rec = JSON.parse(await readFile(sheetFile(root, token.tokenId), "utf8"));
      const inMemory = token.sheets.find((s) => s.round === round).sheet;
      assert.equal(rec.sheet, inMemory.sheet, `${token.tokenId} round ${round}`);
      assert.equal(rec.sheetHash, inMemory.sheetHash);
    }
  }
});

// --- wanted behavior the store does not have yet (summarizer.mjs) -------------

for (const corrupt of CORRUPTIONS) {
  test(`wanted: the ${corrupt.name} error names the damaged file`, { todo: "summarizer.mjs readSheet messages do not carry the file path" }, async (t) => {
    const { swarm, root } = await damaged(t, corrupt);
    await assert.rejects(runRound({ root, swarm, round: 3 }), (e) => e.message.includes("sheet.json"));
  });
}

test("wanted: a sheet file holding JSON null is refused, not silently replaced by a fresh sheet", { todo: "readSheet returns null for 'null', which means 'no sheet yet'" }, async (t) => {
  const { swarm, root, before } = await damaged(t, { write: () => Buffer.from("null") });
  await assert.rejects(runRound({ root, swarm, round: 3 }));
  assert.deepEqual(await snapshot(root), { ...before });
});

test("wanted: a record with a cursor but no sheet text is refused instead of being summarized from nothing", { todo: "summarize only checks throughIndex" }, async (t) => {
  const { swarm, root, before } = await damaged(t, { write: () => Buffer.from('{"throughIndex":0}') });
  await assert.rejects(runRound({ root, swarm, round: 3 }));
  assert.deepEqual(await snapshot(root), before);
});

test("wanted: a failed writeSheet (sheet.json is a directory) leaves no sheet.json.tmp", { todo: "writeSheet does not clean its temp file when rename fails" }, async (t) => {
  const root = await tempRoot(t);
  await mkdir(sheetFile(root, "a"), { recursive: true });
  await assert.rejects(createMemoryStore(root).writeSheet("a", { tokenId: "a", round: 1, sheet: "x", sheetHash: "h", throughIndex: 0 }));
  assert.deepEqual(leftovers(await snapshot(root)), []);
});

// --- the CLI: npm run swarm owns its sheets, so damage there is overwritten ---

function swarmCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", noNetwork, scriptPath, ...args],
      { env: { ...process.env, MOCK_INFERENCE: "1" } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

const CLI_DAMAGE = [
  ["truncated JSON", (good) => good.subarray(0, 20)],
  ["non-JSON garbage", () => Buffer.from("\u0000 garbage")],
  ["an array", () => Buffer.from("[]")],
  ["null", () => Buffer.from("null")],
  ["an empty file", () => Buffer.alloc(0)],
];

for (const [label, write] of CLI_DAMAGE) {
  test(`swarm CLI: a damaged previous sheets/${VICTIM}.json (${label}) is regenerated; same output, exit 0, empty stderr`, async (t) => {
    const out = join(await tempRoot(t), "o");
    const args = ["--rounds", String(ROUNDS), "--seed", "3", "--every", "1", "--out", out];
    const first = await swarmCli(args);
    assert.equal(first.code, 0, first.stderr);
    const good = await snapshot(out);
    const file = join(out, "sheets", `${VICTIM}.json`);
    await writeFile(file, write(await readFile(file)));
    const second = await swarmCli(args);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stderr, "");
    assert.equal(second.stdout, first.stdout);
    const after = await snapshot(out);
    assert.deepEqual(after, good);
    assert.deepEqual(leftovers(after), []);
  });
}

test(`swarm CLI: sheets/${VICTIM}.json replaced by a directory ends in exit 1 with one 'swarm: cannot write' line and no stack, or recovers cleanly`, async (t) => {
  const out = join(await tempRoot(t), "o");
  const args = ["--rounds", "2", "--seed", "3", "--every", "1", "--out", out];
  const first = await swarmCli(args);
  assert.equal(first.code, 0, first.stderr);
  const good = await snapshot(out);
  const file = join(out, "sheets", `${VICTIM}.json`);
  await rm(file);
  await mkdir(file);
  const second = await swarmCli(args);
  if (second.code === 0) {
    assert.deepEqual(await snapshot(out), good, "recovery is deterministic");
    return;
  }
  assert.equal(second.code, 1);
  assert.equal(second.stdout, "", "nothing is reported as done");
  const lines = second.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 1, second.stderr);
  assert.match(lines[0], /^swarm: cannot write to /);
  assert.doesNotMatch(second.stderr, /\n\s+at |Unexpected token/);
  assert.deepEqual(leftovers(await snapshot(out)), []);
});
