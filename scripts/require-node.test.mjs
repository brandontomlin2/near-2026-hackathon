import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkNode, minMajorFromPackage } from "./require-node.mjs";

const script = new URL("./require-node.mjs", import.meta.url).pathname;

test("Node 20 gets a message naming the required and found versions", () => {
  const msg = checkNode("v20.11.1", 22);
  assert.equal(
    msg,
    "npm test needs Node 22 or later (found v20.11.1). Install Node 22+ and retry.",
  );
});

test("Node 22 and newer pass", () => {
  assert.equal(checkNode("v22.0.0", 22), null);
  assert.equal(checkNode("v24.1.0", 22), null);
});

test("the minimum is read from package.json engines", () => {
  const range = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).engines.node;
  assert.equal(range, ">=" + minMajorFromPackage());
});

test("script exits 0 silently on the current Node", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});
