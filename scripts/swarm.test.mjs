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
    assert.match(stdout, /linked to 4 anchor dry-runs \(MOCK, not on-chain\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
