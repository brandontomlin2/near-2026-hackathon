import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSite } from "./site.mjs";

describe("npm run site output", () => {
  let dir;
  let html;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "site-test-"));
    assert.equal(await buildSite(dir, { env: {}, log: () => {} }), 0);
    html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("has index.html", () => assert.ok(fs.statSync(path.join(dir, "index.html")).isFile()));

  it("every local href/src resolves to a file in the folder, by relative path", () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const ref of refs) {
      if (/^https?:\/\//.test(ref) || ref.startsWith("#")) continue;
      assert.ok(!ref.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(ref), `not relative: ${ref}`);
      const target = path.resolve(dir, decodeURIComponent(ref.split(/[?#]/)[0]));
      assert.ok(target.startsWith(dir + path.sep), `escapes folder: ${ref}`);
      assert.ok(fs.statSync(target).isFile(), `missing: ${ref}`);
    }
  });

  it("fetches nothing remote: http(s) appears only in plain <a href> links", () => {
    const stripped = html.replace(/<a\s[^>]*href="https?:\/\/[^"]*"[^>]*>/gi, "");
    // The SVG xmlns namespace is an identifier, not a fetch.
    const rest = stripped.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
    assert.doesNotMatch(rest, /https?:\/\//);
    assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b[^>]*(?:src|href)="https?:/i);
    assert.doesNotMatch(html, /url\(\s*['"]?https?:|@import/i);
  });
});

test("CLI entry builds the site into the given dir and prints the ready line", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-cli-"));
  try {
    const target = path.join(tmp, "site");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const res = spawnSync(process.execPath, ["scripts/site.mjs", target], {
      cwd: root, encoding: "utf8", env: { ...process.env, MOCK_INFERENCE: "1" },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(fs.statSync(path.join(target, "index.html")).isFile());
    const last = res.stdout.trimEnd().split("\n").at(-1);
    assert.ok(last.startsWith(`Site ready: ${target}/index.html`), last);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
