// Edge cases for the static swarm viewer and its demo run.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { AGENTS, GENESIS_HASH, RUN_SCHEMA, buildDemoRun, roundHash } from "./run.mjs";
import { chainStatus, renderViewer, validateRun } from "./render.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "viewer.mjs");

function runWith(agents, rounds = []) {
  return { schema: RUN_SCHEMA, mode: "mock", model: "mock", agents, rounds };
}
const agent = (name, extra = {}) => ({ id: name.toLowerCase(), name, role: "observer", traits: {}, ...extra });

function chained(posts) {
  const hash = roundHash(GENESIS_HASH, posts);
  return { round: 1, hash, posts };
}

function cli(args, env = {}) {
  const e = { ...process.env, MOCK_INFERENCE: "1", ...env };
  delete e.NEAR_AI_API_KEY;
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: e }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

test("zero rounds renders the agents and an ok chain", () => {
  const html = renderViewer(runWith([agent("Solo")]));
  assert.match(html, /0 rounds/);
  assert.match(html, /chain: ok/);
  assert.match(html, /<td>Solo<\/td>/);
  assert.doesNotMatch(html, /class="round"/);
});

test("one agent, one round, one post renders cleanly", () => {
  const html = renderViewer(runWith([agent("Solo")], [chained([{ author: "Solo", text: "hi" }])]));
  assert.equal((html.match(/class="round"/g) || []).length, 1);
  assert.equal((html.match(/class="post"/g) || []).length, 1);
  assert.match(html, /1 posts/);
  assert.match(html, /chain: ok/);
});

test("a round with no posts is allowed and hashes as an empty round", () => {
  const html = renderViewer(runWith([agent("Solo")], [chained([])]));
  assert.match(html, /chain: ok/);
  assert.match(html, /0 posts/);
});

test("zero agents is refused", () => {
  assert.throws(() => renderViewer(runWith([])), /agents/);
});

test("duplicate agent ids or names are refused", () => {
  assert.throws(() => validateRun(runWith([agent("A"), agent("A", { id: "other" })])), /duplicate/);
  assert.throws(() => validateRun(runWith([agent("A"), agent("B", { id: "a" })])), /duplicate/);
});

test("non-object runs and malformed entries throw a TypeError naming the problem", () => {
  for (const bad of [null, undefined, 5, "run", [], {}]) {
    assert.throws(() => validateRun(bad), TypeError);
  }
  assert.throws(() => validateRun(runWith([null])), /agent/);
  assert.throws(() => validateRun(runWith([{ id: 1, name: "x", role: "y" }])), /agent/);
  assert.throws(() => validateRun({ ...runWith([agent("A")]), rounds: null }), /rounds/);
  assert.throws(() => validateRun(runWith([agent("A")], [null])), /round/);
  assert.throws(() => validateRun(runWith([agent("A")], [{ ...chained([]), posts: null }])), /posts/);
  assert.throws(() => validateRun(runWith([agent("A")], [{ round: 1, hash: "a".repeat(64), posts: [null] }])), /post/);
  assert.throws(() => validateRun(runWith([agent("A")], [{ ...chained([]), hash: "A".repeat(64) }])), /hash/);
});

test("unicode, emoji and RTL text are preserved and hash-chained", () => {
  const posts = [{ author: "Solo", text: "héllo 世界 🌍 ‮ abc" }];
  const html = renderViewer(runWith([agent("Solo")], [chained(posts)]));
  assert.ok(html.includes("héllo 世界 🌍 ‮ abc"));
  assert.match(html, /chain: ok/);
});

test("markup in agent names, roles, traits, mode and model is escaped", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const run = runWith([agent("Solo", { role: evil, traits: { [evil]: evil } })]);
  run.mode = evil;
  run.model = evil;
  const html = renderViewer(run);
  assert.ok(!html.includes(evil));
  assert.doesNotMatch(html, /<script/i);
});

test("a missing mode, model or traits block still renders", () => {
  const run = runWith([{ id: "a", name: "A", role: "r" }]);
  delete run.mode;
  delete run.model;
  const html = renderViewer(run);
  assert.match(html, /mode: unknown · model: unknown/);
});

test("a huge run renders every round and keeps the chain verifiable", async () => {
  const run = await buildDemoRun({ rounds: 300, client: createMockClient() });
  assert.deepEqual(chainStatus(run), { ok: true, brokenRound: null });
  const html = renderViewer(run);
  assert.equal((html.match(/class="round"/g) || []).length, 300);
});

test("a very long post is rendered whole, not truncated or broken out of its tag", () => {
  const text = "z".repeat(200_000);
  const html = renderViewer(runWith([agent("Solo")], [chained([{ author: "Solo", text }])]));
  assert.ok(html.includes(text));
});

test("reordering posts within a round is detected", async () => {
  const run = await buildDemoRun({ rounds: 2, client: createMockClient() });
  run.rounds[0].posts.reverse();
  assert.deepEqual(chainStatus(run), { ok: false, brokenRound: 1 });
  assert.match(renderViewer(run), /chain: broken at round 1/);
});

test("dropping an early round is detected as a round-number error", async () => {
  const run = await buildDemoRun({ rounds: 3, client: createMockClient() });
  run.rounds.splice(0, 1);
  assert.throws(() => validateRun(run), /round numbers/);
});

test("the demo run with a single custom agent works and uses only that agent", async () => {
  const run = await buildDemoRun({ rounds: 2, client: createMockClient(), agents: [AGENTS[0]] });
  assert.equal(run.agents.length, 1);
  assert.deepEqual(run.rounds.map((r) => r.posts.length), [1, 1]);
  renderViewer(run);
});

test("the demo run with zero agents has empty rounds, and the page is refused", async () => {
  const run = await buildDemoRun({ rounds: 2, client: createMockClient(), agents: [] });
  assert.deepEqual(run.rounds.map((r) => r.posts.length), [0, 0]);
  assert.throws(() => renderViewer(run), /agents/);
});

test("CLI: missing input file exits 1 with an error, and writes no page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-edge-"));
  try {
    const out = join(dir, "x.html");
    const r = await cli(["--input", join(dir, "nope.json"), "--out", out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error/);
    await assert.rejects(access(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: input that is not JSON exits 1 and writes no page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-edge-"));
  try {
    const input = join(dir, "bad.json");
    const out = join(dir, "x.html");
    await writeFile(input, "{ not json");
    const r = await cli(["--input", input, "--out", out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error/);
    await assert.rejects(access(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: bad flags and bad round counts exit with a clear message", async () => {
  assert.equal((await cli(["--bogus"])).code, 2);
  assert.equal((await cli(["--out"])).code, 2);
  for (const rounds of ["0", "-1", "1.5", "abc", ""]) {
    const r = await cli(["--rounds", rounds, "--out", join(tmpdir(), "never-written.html")]);
    assert.equal(r.code, 1, `--rounds ${JSON.stringify(rounds)}`);
    assert.match(r.stderr, /rounds must be a positive integer/);
  }
});

test("CLI: SWARM_ROUNDS is honoured and an invalid value is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-edge-"));
  try {
    const out = join(dir, "x.html");
    assert.equal((await cli(["--out", out], { SWARM_ROUNDS: "1" })).code, 0);
    assert.equal(((await readFile(out, "utf8")).match(/class="round"/g) || []).length, 1);
    const bad = await cli(["--out", join(dir, "y.html")], { SWARM_ROUNDS: "zero" });
    assert.equal(bad.code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI: the demo page in mock mode contains no script, no external URL and is repeatable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-edge-"));
  try {
    const a = join(dir, "a.html");
    const b = join(dir, "b.html");
    await cli(["--rounds", "2", "--out", a]);
    await cli(["--rounds", "2", "--out", b]);
    const html = await readFile(a, "utf8");
    assert.equal(html, await readFile(b, "utf8"));
    assert.doesNotMatch(html, /<script|https?:\/\//i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
