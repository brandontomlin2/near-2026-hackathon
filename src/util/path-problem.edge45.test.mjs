// What a user sees when an output path is wrong: real filesystem errors from temp dirs,
// mapped to one plain sentence, and null for anything that is not a path-shape problem.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pathProblem } from "./path-problem.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "edge45 path "));
const catchErr = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail");
};

test("a file where a directory is wanted explains that --out must be a directory", async () => {
  const dir = tmp();
  try {
    const file = join(dir, "a file.txt");
    writeFileSync(file, "x");
    const eexist = await catchErr(() => mkdir(file));
    const enotdir = await catchErr(() => mkdir(join(file, "child"), { recursive: true }));
    for (const e of [eexist, enotdir]) {
      const msg = pathProblem(e, "--out");
      assert.match(msg, /^a file is in the way, but --out must be a directory/);
      assert.match(msg, /--help shows usage/);
      assert.doesNotMatch(msg, /EEXIST|ENOTDIR/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory where a file is wanted says the flag needs a file path, and names the flag given", async () => {
  const dir = tmp();
  try {
    const e = await catchErr(() => readFile(dir));
    assert.equal(e.code, "EISDIR");
    assert.equal(pathProblem(e, "EVIDENCE_OUT"), "that is a directory; EVIDENCE_OUT needs a file path (--help shows usage)");
    const w = await catchErr(() => writeFile(dir, "x"));
    assert.match(pathProblem(w, "--out"), /^that is a directory; --out needs a file path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing and unwritable paths are not path-shape problems, so the caller keeps its own message", async () => {
  const dir = tmp();
  try {
    const missing = await catchErr(() => readFile(join(dir, "no such file.json")));
    assert.equal(missing.code, "ENOENT");
    assert.equal(pathProblem(missing, "--out"), null);
    const ro = join(dir, "read only");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      const denied = await catchErr(() => writeFile(join(ro, "x.json"), "x"));
      // root ignores permissions; only assert when the OS really refused.
      assert.equal(pathProblem(denied, "--out"), null);
    } catch (e) {
      if (e.message !== "expected the call to fail") throw e;
    } finally {
      chmodSync(ro, 0o700);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("null, undefined, strings, empty objects and unknown codes give null instead of throwing", () => {
  for (const bad of [null, undefined, "EEXIST", 42, {}, { code: "" }, { code: null }, { code: "eexist" }, new Error("boom"), []]) {
    assert.equal(pathProblem(bad, "--out"), null);
  }
});

test("an odd flag (empty, unicode, with spaces) is printed verbatim and the message stays one line", () => {
  for (const flag of ["", "--out dir", "--sortie-é-😀"]) {
    const a = pathProblem({ code: "EEXIST" }, flag);
    const b = pathProblem({ code: "EISDIR" }, flag);
    assert.ok(a.includes(`but ${flag} must be`));
    assert.ok(b.includes(`; ${flag} needs`));
    assert.doesNotMatch(a + b, /\n/);
  }
  assert.equal(pathProblem({ code: "EEXIST" }, "--out"), pathProblem({ code: "ENOTDIR" }, "--out"));
});
