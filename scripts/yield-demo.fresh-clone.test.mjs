// Fresh-clone check of the README's yield:demo subsection.
//
// Clones the repo at HEAD (`git clone --no-hardlinks file://...`), runs
// `npm ci --ignore-scripts` with a scrubbed env and a temp HOME, then follows
// the CLONE's README: runs each yield:demo step command in the clone, checks
// every quoted line, and runs the judge:run block with its judge:expect markers.
//
// It tests committed state only. It is skipped when tracked files under
// README.md, scripts/yield-demo*, scripts/readme-yield-lib.mjs, src/yield*,
// package*.json have uncommitted changes (it would test stale code).
//
// Override: YIELD_FRESH_CLONE_SRC=<path to a git repo> clones that repo instead
// (and skips the dirty check). Use it to check uncommitted work: `git clone` the
// worktree to a temp dir, copy the working-tree files over, commit there (never
// in the worktree), and point this variable at it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkSafe, commandsOf, evaluate, extractBlocks, scrubEnv } from "./fresh-clone-lib.mjs";
import { parseQuickYieldStep, parseYieldDemo, sh, trimmedLines } from "./readme-yield-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT = 120_000;
const override = process.env.YIELD_FRESH_CLONE_SRC;

function dirtyTracked() {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "README.md", "scripts/yield-demo*", "scripts/readme-yield-lib.mjs", "src/yield*", "src/inference", "src/util", "src/traits", "scripts/fresh-clone-lib.mjs", "contracts/yield-vault/tests", "package.json", "package-lock.json"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  return r.stdout.trim();
}

test("fresh clone: README yield:demo steps work after npm ci", { timeout: 600_000 }, (t) => {
  if (!override) {
    const dirty = dirtyTracked();
    if (dirty) return t.skip(`uncommitted changes to tracked yield/README files; commit first, this tests HEAD only:\n${dirty}`);
  }
  const src = override ?? root;
  const dir = mkdtempSync(join(tmpdir(), "yield-fresh-clone-"));
  try {
    const clone = join(dir, "repo");
    const home = join(dir, "home");
    const env = { ...scrubEnv(process.env), HOME: home, GIT_TERMINAL_PROMPT: "0" };
    delete env.NODE_TEST_CONTEXT;
    // scrubEnv drops GIT_CONFIG_KEY_n (it looks like a secret) but would keep GIT_CONFIG_COUNT, which makes git fail.
    for (const k of Object.keys(env)) if (k.startsWith("GIT_CONFIG_")) delete env[k];
    const c = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", `file://${src}`, clone], { env, encoding: "utf8", timeout: TIMEOUT });
    assert.equal(c.status, 0, `git clone failed: ${c.stderr}`);
    const ci = sh("mkdir -p \"$HOME\" && npm ci --ignore-scripts --no-audit --no-fund", { cwd: clone, env, timeoutMs: TIMEOUT });
    assert.equal(ci.status, 0, `npm ci failed: ${ci.stdout}${ci.stderr}`);

    const readme = readFileSync(join(clone, "README.md"), "utf8");
    const demo = parseYieldDemo(readme);
    assert.ok(demo.steps.length >= 3, "clone README has the yield:demo steps (is it committed?)");
    for (const step of demo.steps.filter((s) => s.kind === "run")) {
      const r = sh(step.command, { cwd: clone, env, timeoutMs: TIMEOUT });
      assert.equal(r.status, 0, `${step.command} exited ${r.status}: ${r.stderr}`);
      const lines = trimmedLines(r.stdout);
      for (const q of step.quotes) assert.ok(lines.includes(q.trim()), `${step.command}: README quotes a line it does not print: ${q}`);
    }
    const file = demo.steps.find((s) => s.kind === "file");
    const planLines = trimmedLines(readFileSync(join(clone, file.command), "utf8"));
    for (const q of file.quotes) assert.ok(planLines.some((l) => l.replace(/,$/, "") === q.trim()), `${file.command} has no line ${q}`);

    const quick = parseQuickYieldStep(readme);
    assert.ok(quick, "clone README quick path has a yield:demo step");
    const qr = sh(quick.command, { cwd: clone, env, timeoutMs: TIMEOUT });
    for (const q of quick.quotes) assert.ok(trimmedLines(qr.stdout).includes(q.trim()), `quick path quotes a line it does not print: ${q}`);

    // The judge:run block, exactly as scripts/fresh-clone-test.sh runs it.
    const block = extractBlocks(readme).find((b) => b.code.includes("yield:demo"));
    assert.ok(block, "README has a judge:run block for yield:demo");
    assert.equal(checkSafe(block), null);
    const br = sh(["set -eo pipefail", ...commandsOf(block.code)].join("\n"), { cwd: clone, env, timeoutMs: TIMEOUT });
    const verdict = evaluate({ status: br.status, signal: null, timedOut: br.timedOut, output: br.stdout + br.stderr }, block.expects);
    assert.equal(verdict.status, "PASS", verdict.detail);
    assert.ok(block.expects.length >= 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
