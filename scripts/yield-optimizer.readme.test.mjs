// The README "Try it" step for the Yield Optimizer quotes real output.
// Run the command it shows and check every quoted output line appears.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("README step for node scripts/yield-optimizer.mjs quotes real DRY RUN output", () => {
  const step = readme.split("\n").find((l) => /^\d+\. Run `node scripts\/yield-optimizer\.mjs`/.test(l));
  assert.ok(step, "README has a numbered step running node scripts/yield-optimizer.mjs");
  const run = spawnSync(process.execPath, ["scripts/yield-optimizer.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const quoted = [...step.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  // Output lines are the quotes that are not commands, flags, paths, branch or identifier names.
  const notOutput = /^(node |--|src\/|claude\/|check_rules$|execute_swap$|args\.proposal$|SwapProposal$)/;
  const lines = quoted.filter((q) => !notOutput.test(q));
  assert.ok(lines.length >= 7, `step quotes output lines, got ${JSON.stringify(lines)}`);
  for (const line of lines) assert.ok(run.stdout.includes(line), `output lacks ${JSON.stringify(line)}`);
  assert.ok(run.stdout.startsWith("DRY RUN"));
});
