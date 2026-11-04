import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));
const noNetwork = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));

/** Run the CLI in a scratch cwd; resolves with { code, stdout, stderr } whatever the exit status. */
function swarm(args, { env = {}, cwd, preload = true } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...(preload ? ["--import", noNetwork] : []), script, ...args],
      { cwd, env: { ...process.env, MOCK_INFERENCE: "1", ...env } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "swarm-gaps14-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("every bad argument exits 2 with one exact 'swarm: ...' line on stderr and nothing on stdout", async (t) => {
  const cwd = await scratch(t);
  const rows = [
    [["--rounds", "0"], 'swarm: --rounds must be a positive integer, got "0" (see --help)\n'],
    [["--rounds"], "swarm: --rounds needs a value (see --help)\n"],
    [["--rounds", "007"], 'swarm: --rounds must be a positive integer, got "007" (see --help)\n'],
    [["--rounds", "1001"], "swarm: --rounds must be at most 1000, got 1001 (see --help)\n"],
    [["--every", "1001"], "swarm: --every must be at most 1000, got 1001 (see --help)\n"],
    [["--seed", "-1"], 'swarm: --seed must be a non-negative integer, got "-1" (see --help)\n'],
    [["--seed", "1.5"], 'swarm: --seed must be a non-negative integer, got "1.5" (see --help)\n'],
    [["--out"], "swarm: --out needs a value (see --help)\n"],
    [["--out", "--rounds"], 'swarm: --out needs a directory, got "--rounds" (see --help)\n'],
    [["stray"], 'swarm: unknown argument "stray" (see --help)\n'],
  ];
  for (const [args, stderr] of rows) {
    const r = await swarm(args, { cwd });
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stderr, stderr, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
  }
  assert.deepEqual(await readdir(cwd), [], "a refused run writes nothing");
});

test("a bad SUMMARY_EVERY_N_ROUNDS is reported on stderr as a 'swarm:' line with exit 2 and writes nothing", async (t) => {
  const cwd = await scratch(t);
  const r = await swarm(["--rounds", "1", "--out", "o"], { cwd, env: { SUMMARY_EVERY_N_ROUNDS: "abc" } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^swarm: .*SUMMARY_EVERY_N_ROUNDS.* \(see --help\)\n$/);
  assert.equal(r.stdout, "");
  assert.deepEqual(await readdir(cwd), []);
});

test("-h prints the usage on stdout, exits 0, names the round cap and writes nothing", async (t) => {
  const cwd = await scratch(t);
  const r = await swarm(["--rounds", "3", "-h"], { cwd });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^Usage: node scripts\/swarm\.mjs \[--rounds N\] \[--seed N\] \[--every N\] \[--out DIR\]$/m);
  assert.match(r.stdout, /--rounds N {2}swarm rounds, 1 to 1000 \(default 5\)/);
  assert.match(r.stdout, /--every N {3}write a sheet every N rounds, 1 to 1000 \(default 3, or SUMMARY_EVERY_N_ROUNDS\)/);
  assert.deepEqual(await readdir(cwd), []);
});

test("an --out that contains the filesystem root is refused with exit 2 and no '(see --help)' hint", async (t) => {
  const cwd = await scratch(t);
  const r = await swarm(["--rounds", "1", "--out", "/"], { cwd });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^swarm: refusing --out "\/": /);
  assert.doesNotMatch(r.stderr, /--help/);
  assert.equal(r.stdout, "");
  assert.deepEqual(await readdir(cwd), []);
});

test("the seed picks the run: same seed same final hash, another seed another one, and events.json records it", async (t) => {
  const cwd = await scratch(t);
  const finalHash = (stdout) => /^final round hash: ([0-9a-f]{64})$/m.exec(stdout)?.[1];
  const a = await swarm(["--rounds", "2", "--seed", "7", "--out", "a"], { cwd });
  const b = await swarm(["--rounds", "2", "--seed", "7", "--out", "b"], { cwd });
  const c = await swarm(["--rounds", "2", "--seed", "8", "--out", "c"], { cwd });
  const z = await swarm(["--rounds", "2", "--seed", "0", "--out", "z"], { cwd });
  assert.ok(finalHash(a.stdout));
  assert.equal(finalHash(a.stdout), finalHash(b.stdout));
  assert.notEqual(finalHash(a.stdout), finalHash(c.stdout));
  assert.notEqual(finalHash(a.stdout), finalHash(z.stdout));
  for (const [dir, seed] of [["a", 7], ["c", 8], ["z", 0]]) {
    assert.equal(JSON.parse(await readFile(join(cwd, dir, "events.json"), "utf8")).seed, seed);
  }
});

test("a repeated flag is not an error: the last value wins", async (t) => {
  const cwd = await scratch(t);
  const r = await swarm(["--rounds", "2", "--rounds", "3", "--every", "1", "--every", "3", "--out", "o"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^verify: ok \(3 rounds\)$/m);
  assert.equal(JSON.parse(await readFile(join(cwd, "o", "memory-loop.json"), "utf8")).every, 3);
});

test("stdout is the transcript, then the hash and verify lines, then one sheet line per sheet in agent and round order", async (t) => {
  const cwd = await scratch(t);
  const r = await swarm(["--rounds", "5", "--every", "2", "--out", "o"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const transcript = await readFile(join(cwd, "o", "transcript.txt"), "utf8");
  const loop = JSON.parse(await readFile(join(cwd, "o", "memory-loop.json"), "utf8"));
  assert.ok(r.stdout.startsWith(`${transcript.trimEnd()}\n\nfinal round hash: ${loop.finalRoundHash}\nverify: ok (5 rounds)\n`));
  const expected = loop.tokens.flatMap((t) => t.sheets.map(
    ({ round, sheet, diff }) => `sheet ${t.tokenId} round ${round} ${sheet.sheetHash} (+${diff.added.length} -${diff.removed.length}) -> anchor_sheet dry-run (not sent)`,
  ));
  assert.deepEqual(expected.map((l) => /^sheet (\S+) round (\d+)/.exec(l).slice(1, 3).join(":")), [
    ...["aloof", "chaotic", "social", "skeptic"].flatMap((id) => [2, 4, 5].map((n) => `${id}:${n}`)),
  ]);
  const printed = r.stdout.split("\n").filter((l) => l.startsWith("sheet "));
  assert.deepEqual(printed, expected);
  assert.match(r.stdout.trimEnd().split("\n").at(-1), /^12 anchor dry-runs, each linked to its round hash; final round hash [0-9a-f]{64} \(MOCK, not on-chain\)$/);
});

test("live mode: sheets are written by the model, the closing line says so, and one request is made per turn and per sheet", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c1", model: "stub", choices: [{ message: { content: "Stub model says hello." } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const cwd = await scratch(t);
  const env = { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "stub-key-not-real", NEAR_AI_MODEL: "stub", NEAR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
  const r = await swarm(["--rounds", "2", "--out", "o"], { cwd, env, preload: false });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(requests, 2 * 4 + 4, "8 agent turns plus one sheet per agent at the final round");
  assert.match(r.stdout.trimEnd().split("\n").at(-1), /^4 anchor dry-runs, each linked to its round hash; final round hash [0-9a-f]{64} \(live inference, dry-run anchors, not on-chain\)$/);
  assert.doesNotMatch(r.stdout, /MOCK/);
  const sheet = JSON.parse(await readFile(join(cwd, "o", "sheets", "aloof.json"), "utf8"));
  assert.equal(sheet.sheet, "Stub model says hello.");
});
