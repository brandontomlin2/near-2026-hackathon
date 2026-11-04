import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) => spawnSync(process.execPath, ["scripts/swarm.mjs", ...args], { encoding: "utf8" });

test("swarm: a flag with no value says it needs a value", () => {
  const r = run("--rounds");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "swarm: --rounds needs a value (see --help)");
});

test("swarm: --every greater than --rounds is rejected like demo", () => {
  const r = run("--rounds", "2", "--every", "3", "--out", "/nonexistent/never");
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "swarm: --every (3) must not exceed --rounds (2), or no character sheet is written (see --help)");
});
