import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeOutDir, clearOwnedFiles } from "./outdir.mjs";

test("assertSafeOutDir: the refusal quotes the path as given and names what is wrong; a child of the home dir is fine", () => {
  assert.throws(
    () => assertSafeOutDir(homedir()),
    (e) => e instanceof Error && e.message.startsWith(`refusing --out ${JSON.stringify(homedir())}: it is the filesystem root, your home directory, the repo root`),
  );
  const child = join(homedir(), "some-project-out");
  assert.equal(assertSafeOutDir(child), child);
});

test("clearOwnedFiles: a missing outDir resolves quietly and a name must match the whole pattern, not a substring, only when the pattern anchors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "outdir-gaps14-"));
  try {
    await clearOwnedFiles(join(dir, "nope"), "sheets", /\.json$/);
    mkdirSync(join(dir, "sheets"));
    for (const n of ["aloof.json", "aloof.json.bak", "notes.txt"]) writeFileSync(join(dir, "sheets", n), "x");
    await clearOwnedFiles(dir, "sheets", /^aloof\.json$/);
    assert.deepEqual(readdirSync(join(dir, "sheets")).sort(), ["aloof.json.bak", "notes.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
