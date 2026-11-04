import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = (script, args) => {
  const env = { ...process.env, MOCK_INFERENCE: "1" };
  delete env.NEAR_AI_API_KEY;
  return spawnSync(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args], { env, encoding: "utf8" });
};

const CASES = [
  ["ask.mjs", ["--out"]],
  ["demo.mjs", ["--out"]],
  ["demo.mjs", ["--style"]],
  ["demo.mjs", ["--seed"]],
  ["swarm.mjs", ["--out"]],
  ["swarm.mjs", ["--rounds"]],
  ["render-agents.mjs", ["--out"]],
  ["render-agents.mjs", ["--style"]],
  ["live-proof.mjs", ["--out"]],
  ["live-proof.mjs", ["--media-base"]],
  ["infer.mjs", ["--system"]],
  ["infer.mjs", ["--seed"]],
];

for (const [script, args] of CASES) {
  test(`${script} ${args.join(" ")} with no value: one-line error, exit 2, no "undefined"`, () => {
    const r = run(script, args);
    assert.equal(r.status, 2, r.stderr);
    assert.doesNotMatch(r.stderr, /undefined/);
    assert.match(r.stderr, /--help/);
    assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  });
}

test("secret-scan-fallback --help prints usage and exits 0", () => {
  for (const flag of ["--help", "-h"]) {
    const r = run("secret-scan-fallback.mjs", [flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: node scripts\/secret-scan-fallback\.mjs/);
    assert.equal(r.stderr, "");
  }
});
