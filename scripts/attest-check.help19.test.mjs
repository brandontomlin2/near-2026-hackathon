import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "attest-check.mjs");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

for (const flag of ["--help", "-h"]) {
  test(`attest-check ${flag} prints usage to stdout and exits 0`, () => {
    const r = run(flag);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^usage: node scripts\/attest-check\.mjs/);
    assert.match(r.stdout, /--unreadable-quote/);
    assert.doesNotMatch(r.stdout, /NOT VERIFIED/);
  });
}

test("attest-check --help wins over an unknown flag", () => {
  const r = run("--bogus", "--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: /);
});

test("attest-check rejects --tamper with --unreadable-quote: usage error, exit 2", () => {
  for (const args of [["--tamper", "--unreadable-quote"], ["--unreadable-quote", "--tamper"]]) {
    const r = run(...args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^attest-check: --tamper and --unreadable-quote cannot be combined \(usage: /);
  }
});

test("attest-check --unreadable-quote alone still exits 2 after the fixture check", () => {
  const r = run("--unreadable-quote");
  assert.equal(r.status, 2);
  assert.match(r.stdout, /CONSISTENT, NOT VERIFIED/);
});
