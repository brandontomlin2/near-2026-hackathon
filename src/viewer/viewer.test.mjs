import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { AGENTS, GENESIS_HASH, RUN_SCHEMA, buildDemoRun, roundHash } from "./run.mjs";
import { chainStatus, escapeHtml, renderViewer, validateRun } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "..", "scripts", "viewer.mjs");

function mockRun(rounds = 3) {
  return buildDemoRun({ rounds, client: createMockClient() });
}

/** Re-chain a run after editing its posts, so only the intended check fails. */
function rechain(run) {
  let prev = GENESIS_HASH;
  for (const round of run.rounds) {
    round.hash = roundHash(prev, round.posts);
    prev = round.hash;
  }
  return run;
}

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("buildDemoRun is deterministic in mock mode", async () => {
  const a = await buildDemoRun({ rounds: 2, client: createMockClient() });
  const b = await buildDemoRun({ rounds: 2, client: createMockClient() });
  assert.deepEqual(a, b);
});

test("buildDemoRun has the four personas, one post each per round, and a valid hash chain", async () => {
  const run = await mockRun(3);
  assert.equal(run.schema, RUN_SCHEMA);
  assert.equal(run.mode, "mock");
  assert.deepEqual(run.agents.map((a) => a.name), AGENTS.map((a) => a.name));
  assert.equal(run.agents.length, 4);
  assert.equal(run.rounds.length, 3);
  for (const [i, round] of run.rounds.entries()) {
    assert.equal(round.round, i + 1);
    assert.deepEqual(round.posts.map((p) => p.author), AGENTS.map((a) => a.name));
    for (const post of round.posts) assert.ok(post.text.length > 0);
  }
  assert.deepEqual(chainStatus(run), { ok: true, brokenRound: null });
});

test("buildDemoRun rejects a round count that is not a positive integer", async () => {
  for (const rounds of [0, -1, 1.5, "3", Number.NaN]) {
    await assert.rejects(() => buildDemoRun({ rounds, client: createMockClient() }), TypeError);
  }
});

test("validateRun accepts a demo run and rejects a wrong schema", async () => {
  const run = await mockRun(1);
  assert.doesNotThrow(() => validateRun(run));
  assert.throws(() => validateRun({ ...run, schema: "other@9" }), /schema/);
});

test("validateRun rejects a post from an author who is not an agent", async () => {
  const run = await mockRun(1);
  run.rounds[0].posts[0].author = "Mallory";
  assert.throws(() => validateRun(run), /Mallory/);
});

test("validateRun rejects a malformed round hash", async () => {
  const run = await mockRun(1);
  run.rounds[0].hash = "not-a-hash";
  assert.throws(() => validateRun(run), /hash/);
});

test("validateRun rejects non-consecutive round numbers", async () => {
  const run = await mockRun(2);
  run.rounds[1].round = 5;
  assert.throws(() => validateRun(run), /round/);
});

test("chainStatus names the first round whose hash does not match its posts", async () => {
  const run = await mockRun(3);
  run.rounds[1].posts[0].text = "edited after the fact";
  assert.deepEqual(chainStatus(run), { ok: false, brokenRound: 2 });
});

test("renderViewer produces one self-contained page with every agent and round", async () => {
  const run = await mockRun(2);
  const html = renderViewer(run);
  assert.match(html, /^<!doctype html>/i);
  for (const agent of AGENTS) assert.ok(html.includes(escapeHtml(agent.name)), agent.name);
  assert.equal((html.match(/class="round"/g) || []).length, 2);
  assert.equal((html.match(/class="post"/g) || []).length, 8);
  assert.match(html, /chain: ok/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("renderViewer escapes post text so markup in a reply cannot run", async () => {
  const run = rechain(await mockRun(1));
  run.rounds[0].posts[0].text = `<img src=x onerror="alert(1)"> & <script>bad()</script>`;
  rechain(run);
  const html = renderViewer(run);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("renderViewer flags a broken hash chain on the page", async () => {
  const run = await mockRun(2);
  run.rounds[0].posts[2].text = "changed";
  const html = renderViewer(run);
  assert.match(html, /chain: broken at round 1/);
});

test("renderViewer refuses an invalid run instead of writing a partial page", async () => {
  const run = await mockRun(1);
  delete run.agents;
  assert.throws(() => renderViewer(run), /agents/);
});

test("CLI writes a demo page in mock mode without any keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const out = join(dir, "nested", "index.html");
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CLI, "--rounds", "2", "--out", out], { env }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr })); else resolve(stdout);
      });
    });
    const html = await readFile(out, "utf8");
    assert.match(html, /<!doctype html>/i);
    assert.equal((html.match(/class="round"/g) || []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI renders an existing run file and exits nonzero on a tampered one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    const run = await mockRun(1);
    await writeFile(good, JSON.stringify(run));
    await writeFile(bad, JSON.stringify({ ...run, schema: "nope" }));
    const env = { ...process.env, MOCK_INFERENCE: "1" };

    const okOut = join(dir, "ok.html");
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CLI, "--input", good, "--out", okOut], { env }, (err) => (err ? reject(err) : resolve()));
    });
    assert.match(await readFile(okOut, "utf8"), /<!doctype html>/i);

    const code = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, "--input", bad, "--out", join(dir, "bad.html")], { env }, (err) => {
        resolve(err ? err.code : 0);
      });
    });
    assert.equal(code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
