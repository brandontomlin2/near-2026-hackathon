import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("site: an unwritable directory says cannot write, exit 1", () => {
  const r = spawnSync(process.execPath, ["scripts/site.mjs", "/etc/x/y"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^site: cannot write \/etc\/x\/y: [^\n]+$/);
});
