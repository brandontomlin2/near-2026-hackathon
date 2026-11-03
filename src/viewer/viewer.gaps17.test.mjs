// CLI gaps for scripts/viewer.mjs (SWARM_ROUNDS handling) and scripts/readme-asset.mjs
// (which existing file at an asset name blocks a run, and nested --out). Offline: the
// mock swarm and demo only; every run happens in a fresh temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ROUNDS } from "../swarm/runner.mjs";

const VIEWER = fileURLToPath(new URL("../../scripts/viewer.mjs", import.meta.url));
const README_ASSET = fileURLToPath(new URL("../../scripts/readme-asset.mjs", import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "viewer-gaps17-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(script, dir, args, envExtra = {}) {
  const env = { ...process.env, MOCK_INFERENCE: "1", ...envExtra };
  delete env.NEAR_AI_API_KEY;
  if (!("SWARM_ROUNDS" in envExtra)) delete env.SWARM_ROUNDS;
  return spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", env });
}

const roundsIn = (page) => (page.match(/<section class="round">/g) ?? []).length;

test("viewer: an explicit --rounds wins over a SWARM_ROUNDS that would have been refused", (t) => {
  const dir = scratch(t);
  const r = run(VIEWER, dir, ["--rounds", "2", "--out", "v.html"], { SWARM_ROUNDS: "not-a-number" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(roundsIn(readFileSync(join(dir, "v.html"), "utf8")), 2);
});

test("viewer: a SWARM_ROUNDS that is empty, zero or above the cap is a usage error naming the value, and nothing is written", (t) => {
  const dir = scratch(t);
  const cases = [
    ["", /^viewer: rounds must be a positive integer, got "" \(see --help\)\n$/],
    ["0", /^viewer: rounds must be a positive integer, got "0" \(see --help\)\n$/],
    [String(MAX_ROUNDS + 1), new RegExp(`^viewer: rounds must be at most ${MAX_ROUNDS}, got ${MAX_ROUNDS + 1} \\(see --help\\)\\n$`)],
  ];
  for (const [value, pattern] of cases) {
    const r = run(VIEWER, dir, ["--out", "v.html"], { SWARM_ROUNDS: value });
    assert.equal(r.status, 2, `SWARM_ROUNDS=${JSON.stringify(value)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, pattern);
  }
  assert.equal(existsSync(join(dir, "v.html")), false);
});

test("readme-asset: a foreign share card is refused by name even when the sheet is ours, and the run writes nothing", (t) => {
  const dir = scratch(t);
  assert.equal(run(README_ASSET, dir, ["--out", join(dir, "a")]).status, 0);
  const share = join(dir, "a", "chaotic-share.svg");
  const sheet = join(dir, "a", "chaotic-sheet.txt");
  const sheetBefore = readFileSync(sheet, "utf8");
  writeFileSync(share, "not an svg\n");
  const r = run(README_ASSET, dir, ["--out", join(dir, "a")]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^readme-asset: .*chaotic-share\.svg exists and is not an asset this tool wrote; pass --force to replace it\n$/);
  assert.equal(readFileSync(share, "utf8"), "not an svg\n");
  assert.equal(readFileSync(sheet, "utf8"), sheetBefore);
});

test("readme-asset: an asset name held by a directory fails in one line, no stack, and no sibling asset is written", (t) => {
  const dir = scratch(t);
  const out = join(dir, "a");
  mkdirSync(join(out, "chaotic-share.svg"), { recursive: true });
  const r = run(README_ASSET, dir, ["--out", out]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^readme-asset: cannot read existing .*chaotic-share\.svg: .*\n$/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  assert.deepEqual(readdirSync(out), ["chaotic-share.svg"]);
});

test("readme-asset: --out several levels deep is created and both assets land there", (t) => {
  const dir = scratch(t);
  const out = join(dir, "x", "y", "z");
  const r = run(README_ASSET, dir, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), ["chaotic-share.svg", "chaotic-sheet.txt"]);
  assert.match(readFileSync(join(out, "chaotic-share.svg"), "utf8"), /^<svg[\s>]/);
});
