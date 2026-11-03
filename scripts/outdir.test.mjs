import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const swarm = fileURLToPath(new URL("./swarm.mjs", import.meta.url));
const demo = fileURLToPath(new URL("./demo.mjs", import.meta.url));
const env = { ...process.env, MOCK_INFERENCE: "1" };
delete env.NEAR_AI_API_KEY;

async function snapshot(root, rel = "") {
  const out = {};
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, await snapshot(root, p));
    else out[p] = (await readFile(join(root, p))).toString("base64");
  }
  return out;
}

// Run config A then config B into one dir, config B into a fresh dir; B must own the result.
async function twoRuns(script, first, second) {
  const shared = await mkdtemp(join(tmpdir(), "outdir-shared-"));
  const fresh = await mkdtemp(join(tmpdir(), "outdir-fresh-"));
  try {
    await run(process.execPath, [script, ...first, "--out", shared], { env });
    const afterFirst = Object.keys(await snapshot(shared));
    await run(process.execPath, [script, ...second, "--out", shared], { env });
    await run(process.execPath, [script, ...second, "--out", fresh], { env });
    const reused = await snapshot(shared);
    const clean = await snapshot(fresh);
    return { afterFirst, reused, clean };
  } finally {
    await rm(shared, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
  }
}

test("swarm: a second config into the same --out leaves nothing of the first run", async () => {
  const { afterFirst, reused, clean } = await twoRuns(swarm, ["--rounds", "5"], ["--rounds", "7", "--every", "3"]);
  assert.ok(afterFirst.includes("sheets/aloof.round-5.json"), "first run writes a round-5 sheet");
  assert.equal(reused["sheets/aloof.round-5.json"], undefined, "stale round-5 sheet is gone");
  assert.deepEqual(reused, clean, "same bytes and same file set as a fresh dir");
});

test("demo: a second config into the same --out leaves no stale art or share cards", async () => {
  const { afterFirst, reused, clean } = await twoRuns(demo, ["--rounds", "6", "--style", "sticker"], ["--rounds", "3", "--every", "3", "--style", "default"]);
  assert.ok(afterFirst.some((f) => f.startsWith("share/") && f.endsWith("-6.svg")), "first run writes round-6 share cards");
  assert.deepEqual(Object.keys(reused), Object.keys(clean));
  assert.deepEqual(reused, clean);
});

test("swarm and demo only remove their own files, never other files in --out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outdir-keep-"));
  try {
    for (const sub of ["sheets", "art", "share"]) await mkdir(join(dir, sub), { recursive: true });
    const keep = ["sheets/notes.json", "sheets/aloof.backup.json", "art/logo.svg", "share/readme.txt", "mine.txt"];
    for (const f of keep) await writeFile(join(dir, f), "keep");
    await run(process.execPath, [swarm, "--rounds", "2", "--out", dir], { env });
    await run(process.execPath, [demo, "--rounds", "3", "--every", "3", "--out", dir], { env });
    for (const f of keep) assert.equal(await readFile(join(dir, f), "utf8"), "keep", f);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("swarm and demo refuse dangerous --out dirs without touching anything", async () => {
  for (const script of [swarm, demo]) {
    for (const bad of ["/", homedir(), fileURLToPath(new URL("..", import.meta.url)), fileURLToPath(new URL("../..", import.meta.url))]) {
      await assert.rejects(run(process.execPath, [script, "--rounds", "1", "--every", "1", "--out", bad], { env }), (e) => {
        assert.notEqual(e.code, 0);
        assert.match(e.stderr, /refusing --out/);
        assert.equal(e.stderr.trim().split("\n").length, 1, "one-line error");
        return true;
      });
    }
  }
});
