// The generated pages carry a strict CSP <meta> and a no-referrer policy, and they use
// nothing the policy blocks: no script, no on* attributes, no remote or inline-image
// fetches, and the one <style> block matches the policy's hash.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSwarm } from "../swarm/runner.mjs";
import { renderViewer } from "../viewer/render.mjs";
import { runDemo } from "./pipeline.mjs";

const cspOf = (html) => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  assert.ok(m, "CSP meta tag present");
  return Object.fromEntries(m[1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
};

function assertPageMatchesPolicy(html, label) {
  const csp = cspOf(html);
  assert.deepEqual(csp["default-src"], ["'none'"], label);
  assert.deepEqual(csp["base-uri"], ["'none'"], label);
  assert.deepEqual(csp["form-action"], ["'none'"], label);
  assert.deepEqual(csp["img-src"], ["'self'"], label);
  assert.equal(csp["script-src"], undefined, `${label}: no script allowance`);
  assert.doesNotMatch(JSON.stringify(csp), /unsafe-|\*|https?:|data:/, label);
  assert.match(html, /<meta name="referrer" content="no-referrer">/, label);
  // The CSP must come before any element that could load something.
  assert.ok(html.indexOf("Content-Security-Policy") < html.search(/<(title|style|img|link|a)\b/), `${label}: CSP first`);

  // Nothing the policy blocks is used.
  assert.doesNotMatch(html, /<(script|iframe|object|embed|link|base|form|video|audio|source|svg)\b/i, `${label}: blocked element`);
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, `${label}: inline handler`);
  assert.doesNotMatch(html, /<[^>]*\sstyle\s*=/i, `${label}: style attribute needs unsafe-inline`);
  assert.doesNotMatch(html, /https?:\/\/|\/\/[a-z0-9.-]+\.[a-z]|data:|javascript:/i, `${label}: remote or data URL`);
  for (const [, src] of html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/g)) assert.match(src, /^[\w][\w./-]*$/, `${label}: img src ${src}`);

  // Exactly one style block, allowed by hash, with no fetches inside.
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(styles.length, 1, `${label}: one style block`);
  assert.doesNotMatch(styles[0][1], /url\(|@import|@font-face/i, `${label}: css fetch`);
  const hash = createHash("sha256").update(styles[0][1], "utf8").digest("base64");
  assert.deepEqual(csp["style-src"], [`'sha256-${hash}'`], `${label}: style hash`);
}

test("viewer page: CSP meta, referrer policy, and nothing the policy blocks", async () => {
  assertPageMatchesPolicy(renderViewer(await runSwarm({ rounds: 3, seed: 7 })), "viewer");
});

test("demo/site page: CSP meta, referrer policy, and nothing the policy blocks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "csp-"));
  try {
    await runDemo({ outDir: dir, rounds: 3, seed: 1, every: 3 });
    const html = await readFile(join(dir, "index.html"), "utf8");
    assert.ok((html.match(/<img /g) ?? []).length >= 4);
    assertPageMatchesPolicy(html, "demo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
