import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS } from "../src/traits/agents.mjs";

const run = (...args) => spawnSync(process.execPath, ["scripts/render-agents.mjs", ...args], { encoding: "utf8" });

test("render: an unwritable --out is an I/O failure, exit 1, no (see --help)", () => {
  // A directory named like the first expected SVG makes the write fail with EISDIR for any user, root included.
  const out = mkdtempSync(join(tmpdir(), "render-errors19-"));
  try {
    mkdirSync(join(out, `${AGENTS[0].id}.svg`));
    const r = run("--out", out);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr.trim(), /^render: cannot write .+: [^\n]+$/);
    assert.ok(r.stderr.includes(out));
    assert.doesNotMatch(r.stderr, /see --help/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("render: a real usage error still exits 2", () => {
  assert.equal(run("--style", "nope").status, 2);
});
