import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("infer: --system with no value says it needs a value", () => {
  const r = spawnSync(process.execPath, ["scripts/infer.mjs", "--system"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "infer: --system needs a value (see --help)");
});
