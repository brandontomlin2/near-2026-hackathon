// vercel.json must serve the yield:demo output as a static site and nothing more.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const cfg = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("vercel.json builds with yield:demo and serves its default out dir", () => {
  assert.equal(cfg.buildCommand, "npm run yield:demo");
  assert.equal(pkg.scripts["yield:demo"], "node scripts/yield-demo.mjs");
  const src = readFileSync(join(root, "scripts/yield-demo.mjs"), "utf8");
  assert.match(src, new RegExp(`const DEFAULT_OUT = "${cfg.outputDirectory}";`));
});

test("vercel.json is static only: no functions, rewrites, env or analytics", () => {
  for (const k of ["functions", "rewrites", "redirects", "env", "build", "crons", "routes"]) {
    assert.equal(k in cfg, false, `unexpected key ${k}`);
  }
  assert.equal(JSON.stringify(cfg).toLowerCase().includes("analytics"), false);
  assert.equal(cfg.framework, null);
});

test("the output dir contains index.html after a fresh yield:demo run", () => {
  const work = mkdtempSync(join(tmpdir(), "vercel-cfg-"));
  try {
    const r = spawnSync(process.execPath, [join(root, "scripts/yield-demo.mjs")], { cwd: work, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(resolve(work, cfg.outputDirectory, "index.html")));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
