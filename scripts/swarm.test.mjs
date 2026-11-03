import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./swarm.mjs", import.meta.url));

test("CLI prints a verified transcript, byte-identical on every run, with no keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    const args = [script, "--rounds", "3", "--out", dir];
    const first = await run(process.execPath, args, { env });
    const transcript = await readFile(join(dir, "transcript.txt"), "utf8");
    const second = await run(process.execPath, args, { env });
    assert.equal(first.stdout, second.stdout);
    assert.equal(transcript, await readFile(join(dir, "transcript.txt"), "utf8"));
    assert.match(first.stdout, /verify: ok \(3 rounds\)/);
    assert.equal(first.stdout.split("\n").filter((l) => /^\[/.test(l)).length, 3 * 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI writes a sheet per agent and a memory loop linked to the final hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    const { stdout } = await run(process.execPath, [script, "--rounds", "2", "--out", dir], { env });
    const loop = JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8"));
    assert.equal(loop.tokens.length, 4);
    for (const id of ["aloof", "chaotic", "social", "skeptic"]) {
      const sheet = JSON.parse(await readFile(join(dir, "sheets", `${id}.json`), "utf8"));
      const token = loop.tokens.find((t) => t.tokenId === id);
      assert.equal(token.anchor.args.sheet_hash, sheet.sheetHash);
      assert.equal(token.anchor.linkedRoundHash, loop.finalRoundHash);
      assert.equal(token.anchor.status, "dry-run");
    }
    assert.match(stdout, new RegExp(`final round hash: ${loop.finalRoundHash}`));
    assert.match(stdout, new RegExp(`^4 anchor dry-runs, each linked to its round hash; final round hash ${loop.finalRoundHash} \\(MOCK, not on-chain\\)$`, "m"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--every and SUMMARY_EVERY_N_ROUNDS set the sheet cadence, with a sheet file per round", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    await run(process.execPath, [script, "--rounds", "4", "--every", "2", "--out", dir], { env });
    const loop = JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8"));
    assert.equal(loop.every, 2);
    for (const t of loop.tokens) {
      assert.deepEqual(t.sheets.map((s) => s.round), [2, 4]);
      assert.equal(t.sheets[1].diff.previousHash, t.sheets[0].sheet.sheetHash);
      for (const s of t.sheets) {
        const file = JSON.parse(await readFile(join(dir, "sheets", `${t.tokenId}.round-${s.round}.json`), "utf8"));
        assert.equal(file.sheetHash, s.sheet.sheetHash);
      }
    }
    // The env var applies when the flag is absent; the flag wins when both are given.
    await run(process.execPath, [script, "--rounds", "4", "--out", dir], { env: { ...env, SUMMARY_EVERY_N_ROUNDS: "1" } });
    assert.equal(JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8")).tokens[0].sheets.length, 4);
    await run(process.execPath, [script, "--rounds", "4", "--every", "4", "--out", dir], { env: { ...env, SUMMARY_EVERY_N_ROUNDS: "1" } });
    assert.equal(JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8")).tokens[0].sheets.length, 1);
    // The default cadence is 3, like npm run demo.
    await run(process.execPath, [script, "--rounds", "6", "--out", dir], { env });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8")).tokens[0].sheets.map((s) => s.round), [3, 6]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bad SUMMARY_EVERY_N_ROUNDS or --every exits 2", async () => {
  const env = { ...process.env, MOCK_INFERENCE: "1", SUMMARY_EVERY_N_ROUNDS: "zero" };
  await assert.rejects(run(process.execPath, [script, "--rounds", "1"], { env }), (err) => err.code === 2);
  await assert.rejects(run(process.execPath, [script, "--every", "0"]), (err) => err.code === 2 && /--every/.test(err.stderr));
});

test("live mode without a key fails instead of falling back to the mock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "0" };
    delete env.NEAR_AI_API_KEY;
    await assert.rejects(
      run(process.execPath, [script, "--rounds", "1", "--out", dir], { env }),
      (err) => err.code === 1 && /^swarm: /.test(err.stderr),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects unknown flags with exit status 2", async () => {
  await assert.rejects(
    run(process.execPath, [script, "--wallet", "x"]),
    (err) => err.code === 2 && /unknown argument "--wallet"/.test(err.stderr),
  );
});

test("npm run swarm and npm run demo defaults do not overwrite each other", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "swarm-demo-"));
  try {
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    // Same default layout as the npm scripts, relocated under a temp cwd.
    const demo = fileURLToPath(new URL("./demo.mjs", import.meta.url));
    await run(process.execPath, [demo, "--rounds", "3", "--out", join(dir, "out")], { env, cwd: root });
    const demoEvents = await readFile(join(dir, "out", "events.json"), "utf8");
    await run(process.execPath, [script, "--rounds", "2", "--seed", "9", "--out", join(dir, "out", "swarm")], { env, cwd: root });
    assert.equal(await readFile(join(dir, "out", "events.json"), "utf8"), demoEvents);
    assert.notEqual(await readFile(join(dir, "out", "swarm", "events.json"), "utf8"), demoEvents);
    assert.ok((await readFile(join(dir, "out", "swarm", "memory-loop.json"), "utf8")).length > 0);
    assert.ok((await readFile(join(dir, "out", "index.html"), "utf8")).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("swarm default output directory is out/swarm, distinct from the demo's out/", async () => {
  const src = await readFile(script, "utf8");
  assert.match(src, /out: "out\/swarm"/);
});

// Audit L-2: in live mode the model's text reaches transcript.txt and stdout; control, OSC
// and bidi characters must not survive into either. Local stub server, no real service.
test("live mode: control characters in replies never reach transcript.txt, events.json, the sheets or stdout", async () => {
  const { createServer } = await import("node:http");
  const hostile = "\u001b[2J\u001b]0;pwned\u0007\u001b]8;;http://evil.example\u0007link\u001b]8;;\u0007 \u202ereversed\u202c ok";
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c1", model: "stub", choices: [{ message: { content: hostile } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "swarm-cli-"));
  const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  try {
    const env = { ...process.env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "stub-key-not-real", NEAR_AI_MODEL: "stub", NEAR_AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
    const { stdout, stderr } = await run(process.execPath, [script, "--rounds", "2", "--out", dir], { env });
    assert.doesNotMatch(stdout, unsafe);
    assert.doesNotMatch(stderr, unsafe);
    assert.match(stdout, /link\uFFFD/);
    for (const file of ["transcript.txt", "events.json", "memory-loop.json", "sheets/aloof.json"]) {
      const text = await readFile(join(dir, file), "utf8");
      assert.doesNotMatch(text, unsafe, file);
      assert.doesNotMatch(text, /\\u001b|\\u0007|\\u202e/i, `${file}: control character stored as a JSON escape`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
