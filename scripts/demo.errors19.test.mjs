import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (...args) => spawnSync(process.execPath, ["scripts/demo.mjs", ...args], { encoding: "utf8" });

test("demo: a flag with no value says it needs a value", () => {
  for (const flag of ["--out", "--rounds", "--style"]) {
    const r = run(flag);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), `demo: ${flag} needs a value (see --help)`);
  }
});

test("demo: an unwritable --out is an I/O failure with one message shape", () => {
  const r = run("--out", "/nonexistent/x/y");
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^demo: cannot write \/nonexistent\/x\/y: no such file or directory$/);
});
