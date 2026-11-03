// Hostile strings in every field the unified viewer interpolates (agent name,
// personality, trait key and value, event text, seed, reply target name). Each test feeds
// markup and attribute breakouts and asserts the page contains only the
// escaped form and no live tag or attribute.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GENESIS_HASH, hashRound } from "../swarm/runner.mjs";
import { escapeHtml, renderViewer } from "./render.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "viewer.mjs");

const HOSTILE = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)`,
  `&lt;b&gt; & &amp; &#60;`,
  `</td></tr></table><svg onload=alert(1)>`,
  `</style><script>x</script>`,
];

// No hostile payload may produce a live element or event-handler attribute.
function assertInert(html, payload) {
  assert.ok(!html.includes(payload), `raw payload leaked: ${payload}`);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img|<svg|<b>/i);
  assert.doesNotMatch(html, /<[^>]*\son\w+=/i);
}

/** Canonical swarm output with correct hashes: agent `a` posts, agent `b` replies. */
function runWith(events, seed = 1) {
  const full = events.map((e, i) => ({
    id: i + 1, round: 1, turn: i + 1, agentId: "a", kind: "post", replyTo: null, ...e,
  }));
  return { seed, rounds: 1, events: full, roundHashes: [hashRound(GENESIS_HASH, full)] };
}

const agentsWith = (name, personality, traits) => [
  { id: "a", name, personality, traits },
  { id: "b", name: "Bee", personality: "calm", traits: {} },
];

for (const payload of HOSTILE) {
  test(`viewer escapes ${JSON.stringify(payload)} in agent name, personality, trait key and value, event text, seed`, () => {
    const name = `A${payload}`;
    const agents = agentsWith(name, payload, { [payload]: payload });
    const run = runWith([{ text: payload }], payload);
    const html = renderViewer(run, agents);
    assertInert(html, payload);
    // The escaped form is what ends up in the page.
    assert.ok(html.includes(escapeHtml(payload)));
    assert.ok(html.includes(`<span class="author">${escapeHtml(name)}</span> ${escapeHtml(payload)}`));
    assert.ok(html.includes(`seed: ${escapeHtml(payload)} `));
  });

  test(`viewer escapes ${JSON.stringify(payload)} in a reply target name`, () => {
    const agents = agentsWith(`A${payload}`, "p", {});
    const run = runWith([
      { text: "first" },
      { agentId: "b", kind: "reply", replyTo: 1, text: "answer" },
    ]);
    const html = renderViewer(run, agents);
    assertInert(html, payload);
    assert.ok(html.includes(`&rarr; ${escapeHtml(`A${payload}`)}</span>`));
  });
}

test("an attribute breakout in a name cannot add attributes to the author span", () => {
  const name = `x" onclick="alert(1)`;
  const html = renderViewer(runWith([{ text: "hi" }]), agentsWith(name, "p", {}));
  assert.doesNotMatch(html, /<[^>]*\sonclick=/i);
  assert.match(html, /<span class="author">x&quot; onclick=&quot;alert\(1\)<\/span>/);
});

test("a hostile non-string trait value (nested array) is stringified then escaped", () => {
  const html = renderViewer(runWith([{ text: "hi" }]), agentsWith("A", "p", { list: ["<script>"], n: 3 }));
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /list: &lt;script&gt;/);
});

test("the CLI --input path escapes hostile event text and seed read from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-"));
  try {
    const payload = HOSTILE[1];
    // CLI renders with the canonical agents, so use a real agent id.
    const { AGENTS } = await import("../traits/agents.mjs");
    const run = runWith([{ agentId: AGENTS[0].id, text: payload }], payload);
    const input = join(dir, "run.json");
    const out = join(dir, "out.html");
    await writeFile(input, JSON.stringify(run));
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CLI, "--input", input, "--out", out], { env }, (err) => (err ? reject(err) : resolve()));
    });
    const html = await readFile(out, "utf8");
    assertInert(html, payload);
    assert.ok(html.includes(escapeHtml(payload)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
