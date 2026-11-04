import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "readme-asset.mjs");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

for (const flag of ["--help", "-h"]) {
  test(`readme-asset ${flag} prints usage to stdout and exits 0`, () => {
    const r = run(flag);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^Usage: node scripts\/readme-asset\.mjs /);
    assert.match(r.stdout, /--update-docs/);
    assert.doesNotMatch(r.stdout, /^wrote /m);
  });
}

test("readme-asset usage errors exit 2 and end with (see --help)", () => {
  for (const [args, msg] of [[["--bogus"], "unknown argument --bogus"], [["--out"], /^--out needs/], [["--out", "x", "--update-docs"], "use --out or --update-docs, not both"]]) {
    const r = run(...args);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^readme-asset: .+ \(see --help\)\n$/);
    assert.equal(r.stderr.split("\n").length, 2, "one line, no usage dump");
    if (typeof msg === "string") assert.ok(r.stderr.includes(msg));
    else assert.match(r.stderr.slice("readme-asset: ".length), msg);
  }
});
