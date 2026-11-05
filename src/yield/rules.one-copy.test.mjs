// The vault rules have one JavaScript copy, src/yield/rules.mjs, and the pool quote has one,
// src/yield/pools.mjs. These checks scan every tracked non-test module, so a second copy
// (for example a planner or demo re-implementing check_rules) fails here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const modules = execFileSync("git", ["ls-files", "*.mjs"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.endsWith(".test.mjs"));
const source = (f) => readFileSync(join(root, f), "utf8");
const filesMatching = (re) => modules.filter((f) => re.test(source(f)));

test("the scan sees the yield modules (it is not vacuous)", () => {
  for (const f of ["src/yield/rules.mjs", "src/yield/pools.mjs", "src/yield-optimizer/plan.mjs", "src/yield/demo.mjs"]) {
    assert.ok(modules.includes(f), f);
  }
});

test("only src/yield/rules.mjs builds the contract's rule messages", () => {
  // Each pattern is the message text check_rules returns for one rule.
  for (const re of [/exceeds max_trade/, /exceeds daily_cap/, /below floor/, /ERR_POOL_NOT_ALLOWED"/, /ERR_INSUFFICIENT_BALANCE"/]) {
    assert.deepEqual(filesMatching(re), ["src/yield/rules.mjs"], String(re));
  }
});

test("only src/yield/rules.mjs defines checkProposal, and every caller imports it from there", () => {
  assert.deepEqual(filesMatching(/function checkProposal\s*\(/), ["src/yield/rules.mjs"]);
  const callers = filesMatching(/\bcheckProposal\s*\(/).filter((f) => f !== "src/yield/rules.mjs");
  assert.ok(callers.length >= 3, `callers: ${callers.join(", ")}`);
  for (const f of callers) assert.match(source(f), /import \{[^}]*\bcheckProposal\b[^}]*\} from "[./]*(yield\/)?rules\.mjs"/, f);
});

test("only src/yield/pools.mjs defines quoteOut", () => {
  assert.deepEqual(filesMatching(/function quoteOut\s*\(/), ["src/yield/pools.mjs"]);
});
