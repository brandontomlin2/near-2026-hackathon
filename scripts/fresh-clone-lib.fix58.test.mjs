import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fresh-clone-lib.mjs", import.meta.url));

test("--pre pointing at a directory exits nonzero with a one-line error and no stack trace", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-fix58-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, "<!-- judge:run -->\n```sh\necho ok\n```\n");
  const preDir = path.join(dir, "pre-dir");
  fs.mkdirSync(preDir);

  const r = spawnSync(
    process.execPath,
    [SCRIPT, "run", "--readme", readme, "--cwd", dir, "--pre", preDir],
    { cwd: dir, encoding: "utf8" },
  );

  assert.notEqual(r.status, 0);
  assert.equal(r.signal, null);
  const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1, `expected one stderr line, got:\n${r.stderr}`);
  assert.match(lines[0], /--pre/);
  assert.match(lines[0], /directory/);
  assert.ok(lines[0].includes(preDir), lines[0]);
  assert.ok(!/\n\s+at /.test(r.stderr), "stack trace on stderr");
  assert.ok(!r.stderr.includes("EISDIR"), "raw Node error on stderr");
});
