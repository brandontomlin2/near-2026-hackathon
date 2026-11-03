// Hostile strings in every field the viewer interpolates. Each test feeds
// markup and attribute breakouts and asserts the page contains only the
// escaped form and no live tag or attribute.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { GENESIS_HASH, RUN_SCHEMA, roundHash } from "./run.mjs";
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

const runWith = (agents, rounds) => ({ schema: RUN_SCHEMA, mode: "mock", model: "mock", agents, rounds });

for (const payload of HOSTILE) {
  test(`viewer escapes ${JSON.stringify(payload)} in agent name, post author, post text, role, trait key and value, mode, model`, () => {
    const name = `A${payload}`;
    const posts = [{ author: name, text: payload }];
    const run = runWith(
      [{ id: "a", name, role: payload, traits: { [payload]: payload } }],
      [{ round: 1, hash: roundHash(GENESIS_HASH, posts), posts }],
    );
    run.mode = payload;
    run.model = payload;
    const html = renderViewer(run);
    assertInert(html, payload);
    // The escaped form is what ends up in the page.
    assert.ok(html.includes(escapeHtml(payload)));
    assert.ok(html.includes(`<span class="author">${escapeHtml(name)}</span>${escapeHtml(payload)}`));
  });
}

test("an attribute breakout in a name cannot add attributes to the author span", () => {
  const name = `x" onclick="alert(1)`;
  const posts = [{ author: name, text: "hi" }];
  const html = renderViewer(runWith(
    [{ id: "a", name, role: "r" }],
    [{ round: 1, hash: roundHash(GENESIS_HASH, posts), posts }],
  ));
  assert.doesNotMatch(html, /<[^>]*\sonclick=/i);
  assert.match(html, /<span class="author">x&quot; onclick=&quot;alert\(1\)<\/span>/);
});

test("a hostile non-string trait value (nested object, array) is stringified then escaped", () => {
  const html = renderViewer(runWith(
    [{ id: "a", name: "A", role: "r", traits: { list: ["<script>"], n: 3, nul: null } }],
    [],
  ));
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /list: &lt;script&gt;/);
});

test("the CLI --input path escapes a hostile run read from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-"));
  try {
    const payload = HOSTILE[1];
    const posts = [{ author: `A${payload}`, text: payload }];
    const run = runWith(
      [{ id: "a", name: `A${payload}`, role: payload, traits: { k: payload } }],
      [{ round: 1, hash: roundHash(GENESIS_HASH, posts), posts }],
    );
    const input = join(dir, "run.json");
    const out = join(dir, "out.html");
    await writeFile(input, JSON.stringify(run));
    const env = { ...process.env, MOCK_INFERENCE: "1" };
    delete env.NEAR_AI_API_KEY;
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [CLI, "--input", input, "--out", out], { env }, (err) => (err ? reject(err) : resolve()));
    });
    assertInert(await readFile(out, "utf8"), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
