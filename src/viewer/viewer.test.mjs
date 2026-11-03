// Behavior of the viewer: it renders canonical swarm output (runSwarm / events.json).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GENESIS_HASH, hashRound, runSwarm } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { chainStatus, escapeHtml, renderViewer, validateResult } from "./render.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "viewer.mjs");
const count = (html, re) => (html.match(re) || []).length;

/** Re-chain after editing events, so only the intended check fails. */
function rechain(result) {
  let prev = GENESIS_HASH;
  result.roundHashes = result.roundHashes.map((_, i) => {
    prev = hashRound(prev, result.events.filter((e) => e.round === i + 1));
    return prev;
  });
  return result;
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

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("renders a canonical swarm run: every agent, round and event, chain ok, no script or URL", async () => {
  const result = await runSwarm({ rounds: 3, seed: 7 });
  const html = renderViewer(result);
  assert.match(html, /^<!doctype html>/i);
  for (const agent of AGENTS) assert.ok(html.includes(agent.name), agent.name);
  assert.equal(count(html, /class="round"/g), 3);
  assert.equal(count(html, /class="post"/g), result.events.length);
  assert.match(html, /chain: ok/);
  assert.doesNotMatch(html, /<script|https?:\/\//i);
});

test("rendering is deterministic for the same swarm output", async () => {
  const a = renderViewer(await runSwarm({ rounds: 2 }));
  const b = renderViewer(await runSwarm({ rounds: 2 }));
  assert.equal(a, b);
});

test("replies show who they answer", async () => {
  const result = await runSwarm({ rounds: 4 });
  const replies = result.events.filter((e) => e.kind === "reply");
  assert.ok(replies.length > 0);
  assert.equal(count(renderViewer(result), /&rarr;/g), replies.length);
});

test("markup in event text is escaped, so a reply cannot run script", async () => {
  const result = await runSwarm({ rounds: 1 });
  result.events[0].text = `<img src=x onerror="alert(1)"> & <script>bad()</script>`;
  const html = renderViewer(rechain(result));
  assert.doesNotMatch(html, /<img src=x|<script/i);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("markup in agent fields passed to the renderer is escaped", async () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const agents = AGENTS.map((a) => ({ ...a, name: evil, personality: evil, traits: { [evil]: evil } }));
  const result = await runSwarm({ rounds: 1 });
  const html = renderViewer(result, agents);
  assert.ok(!html.includes(evil));
});

test("an agent without a string name is refused, so the page never shows \"undefined\"", async () => {
  const result = await runSwarm({ rounds: 1 });
  for (const name of [undefined, null, 7, ""]) {
    const agents = AGENTS.map((a, i) => (i === 0 ? { ...a, name } : a));
    assert.throws(() => renderViewer(result, agents), /name/, `name ${JSON.stringify(name)}`);
  }
  assert.doesNotMatch(renderViewer(result), /undefined/);
});

test("unicode and very long text are rendered whole", async () => {
  const result = await runSwarm({ rounds: 1 });
  const long = "z".repeat(100_000);
  result.events[0].text = "héllo 世界 🌍";
  result.events[1].text = long;
  const html = renderViewer(rechain(result));
  assert.ok(html.includes("héllo 世界 🌍"));
  assert.ok(html.includes(long));
});

test("a tampered event is flagged as a broken chain at its round", async () => {
  const result = await runSwarm({ rounds: 3 });
  result.events.find((e) => e.round === 2).text = "edited after the fact";
  assert.deepEqual(chainStatus(result), { ok: false, brokenRound: 2 });
  assert.match(renderViewer(result), /chain: broken at round 2/);
});

test("invalid swarm output is refused instead of rendering a partial page", async () => {
  const good = await runSwarm({ rounds: 1 });
  for (const bad of [null, 5, [], {}, { ...good, events: null }, { ...good, roundHashes: ["nope"] }]) {
    assert.throws(() => renderViewer(bad), TypeError);
  }
  const stranger = structuredClone(good);
  stranger.events[0].agentId = "mallory";
  assert.throws(() => validateResult(stranger), /mallory/);
  const lateRound = structuredClone(good);
  lateRound.events[0].round = 9;
  assert.throws(() => validateResult(lateRound), /round/);
  assert.throws(() => renderViewer(good, []), /agents/);
});

test("CLI writes a page from the canonical swarm without keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const out = join(dir, "nested", "index.html");
    const r = await cli(["--rounds", "2", "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const html = await readFile(out, "utf8");
    assert.equal(count(html, /class="round"/g), 2);
    assert.match(html, /chain: ok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI renders the same page from events.json as from a fresh swarm run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const input = join(dir, "events.json");
    await writeFile(input, JSON.stringify(await runSwarm({ rounds: 2 })));
    const fromFile = join(dir, "file.html");
    const fresh = join(dir, "fresh.html");
    assert.equal((await cli(["--input", input, "--out", fromFile])).code, 0);
    assert.equal((await cli(["--rounds", "2", "--out", fresh])).code, 0);
    assert.equal(await readFile(fromFile, "utf8"), await readFile(fresh, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI exits nonzero and writes no page for a missing, non-JSON or invalid input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const notJson = join(dir, "bad.json");
    const invalid = join(dir, "invalid.json");
    await writeFile(notJson, "{ not json");
    await writeFile(invalid, JSON.stringify({ events: [], roundHashes: ["x"] }));
    for (const input of [join(dir, "nope.json"), notJson, invalid]) {
      const out = join(dir, "x.html");
      const r = await cli(["--input", input, "--out", out]);
      assert.equal(r.code, 2, input);
      assert.match(r.stderr, /^viewer: .*--input .*\(see --help\)\n$/);
      await assert.rejects(access(out));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects bad flags and bad round counts, and honours SWARM_ROUNDS", async () => {
  assert.equal((await cli(["--bogus"])).code, 2);
  assert.equal((await cli(["--out"])).code, 2);
  for (const rounds of ["0", "-1", "1.5", "abc", ""]) {
    const r = await cli(["--rounds", rounds, "--out", join(tmpdir(), "never-written.html")]);
    assert.equal(r.code, 2, `--rounds ${JSON.stringify(rounds)}`);
    assert.match(r.stderr, /rounds must be a positive integer.*\(see --help\)/);
  }
  const dir = await mkdtemp(join(tmpdir(), "viewer-test-"));
  try {
    const out = join(dir, "x.html");
    assert.equal((await cli(["--out", out], { SWARM_ROUNDS: "1" })).code, 0);
    assert.equal(count(await readFile(out, "utf8"), /class="round"/g), 1);
    assert.equal((await cli(["--out", join(dir, "y.html")], { SWARM_ROUNDS: "zero" })).code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
