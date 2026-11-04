// A count of 1 reads as a singular noun in the demo CLI and its page ("1 round", never "1 rounds").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plural } from "../src/util/plural.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("plural: 1 is singular, everything else plural, irregular plural on request", () => {
  assert.equal(plural(1, "round"), "1 round");
  assert.equal(plural(0, "round"), "0 rounds");
  assert.equal(plural(2, "round"), "2 rounds");
  assert.equal(plural(1, "summary", "summaries"), "1 summary");
  assert.equal(plural(3, "summary", "summaries"), "3 summaries");
  assert.equal(plural("1", "word"), "1 word");
});

test("demo --rounds 1 --every 1: stdout and page use singular wording", (t) => {
  const out = mkdtempSync(join(tmpdir(), "plural-demo-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ["scripts/demo.mjs", "--out", out, "--rounds", "1", "--every", "1"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[1\/5\] swarm: 1 round, \d+ events, verify: ok/);
  assert.match(r.stdout, /a summary every 1 round, 4 agents\)/);
  assert.doesNotMatch(r.stdout, /\b1 (rounds|sheets|events|agents|calls|svgs)\b/);
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.match(html, /1 round, seed .*, a sheet every 1 round, art style/);
  assert.match(html, /<li>Every round each agent rewrites/);
  assert.doesNotMatch(html, /\b1 (rounds|words)\b|Every 1 rounds/);
});

test("demo --rounds 4 --every 2 keeps plural wording", (t) => {
  const out = mkdtempSync(join(tmpdir(), "plural-demo-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ["scripts/demo.mjs", "--out", out, "--rounds", "4", "--every", "2"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /swarm: 4 rounds,/);
  assert.match(r.stdout, /a summary every 2 rounds,/);
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /<li>Every 2 rounds each agent rewrites/);
});
