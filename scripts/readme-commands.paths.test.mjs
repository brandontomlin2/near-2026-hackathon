import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A judge copies these commands, so every file they name must exist in the repo.
test("every `node|bash <repo path>` file the README tells a judge to run exists", () => {
  const paths = [...new Set([...readme.matchAll(/\b(?:node|bash)\s+((?:scripts|src|contracts|site|tools)\/[\w./-]+)/g)].map((m) => m[1]))];
  assert.ok(paths.length > 0, "README names at least one script path");
  const missing = paths.filter((p) => !existsSync(new URL(`../${p}`, import.meta.url)));
  assert.deepEqual(missing, []);
});

test("every npm script the README runs maps to a file that exists", () => {
  const names = [...new Set([...readme.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]))];
  const missing = [];
  for (const name of names) {
    const target = pkg.scripts[name]?.match(/\b(?:node|bash)\s+((?:scripts|src)\/[\w./-]+)/)?.[1];
    if (target && !existsSync(new URL(`../${target}`, import.meta.url))) missing.push(`${name} -> ${target}`);
  }
  assert.deepEqual(missing, []);
});
