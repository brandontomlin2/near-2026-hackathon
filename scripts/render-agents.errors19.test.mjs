import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) => spawnSync(process.execPath, ["scripts/render-agents.mjs", ...args], { encoding: "utf8" });

test("render: an unwritable --out is an I/O failure, exit 1, no (see --help)", () => {
  const r = run("--out", "/nonexistent/a");
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^render: cannot write \/nonexistent\/a: [^\n]+$/);
  assert.doesNotMatch(r.stderr, /see --help/);
});

test("render: a real usage error still exits 2", () => {
  assert.equal(run("--style", "nope").status, 2);
});
