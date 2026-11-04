import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const run = (...args) => spawnSync(process.execPath, ["scripts/ask.mjs", ...args], { encoding: "utf8", env: { ...process.env, MOCK_INFERENCE: "1" } });

test("ask: --out with no value says it needs a value", () => {
  const r = run("chaotic", "hi", "--out");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "ask: --out needs a value (see --help)");
});

test("ask: no mode line when the sheet is missing", () => {
  const r = run("--out", mkdtempSync(join(tmpdir(), "ask19-")), "chaotic", "hi");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /mode:/);
  assert.match(r.stderr, /no character sheet/);
});

test("ask: no mode line on a bad agent", () => {
  const r = run("nobody", "hi");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /mode:/);
});
