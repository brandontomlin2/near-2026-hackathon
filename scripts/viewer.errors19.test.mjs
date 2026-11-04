import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("viewer: --input with no value says it needs a value", () => {
  const r = spawnSync(process.execPath, ["scripts/viewer.mjs", "--input"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "viewer: --input needs a value (see --help)");
});
