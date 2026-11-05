// pathProblem on the real errors CLIs hit: symlinks, FIFOs, deep paths, unicode and trailing slashes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { pathProblem } from "./path-problem.mjs";

const root = mkdtempSync(join(tmpdir(), "edge62 pp é "));
after(() => {
  rmSync(root, { recursive: true, force: true });
});
const fail = (p) => p.then(() => assert.fail("expected the call to fail"), (e) => e);
const FILE_IN_WAY = /^a file is in the way, but --out must be a directory/;

test("mkdir -p through a symlink that points at a file is a file-in-the-way problem", async () => {
  const target = join(root, "target.txt");
  writeFileSync(target, "x");
  const link = join(root, "link-to-file");
  symlinkSync(target, link);
  const e = await fail(mkdir(join(link, "deep", "er"), { recursive: true }));
  assert.match(pathProblem(e, "--out"), FILE_IN_WAY);
});

test("a symlink to a directory used as a file path says that it is a directory", async () => {
  const dir = join(root, "real dir");
  mkdirSync(dir);
  const link = join(root, "dir-link");
  symlinkSync(dir, link);
  const e = await fail(writeFile(link, "x"));
  assert.equal(e.code, "EISDIR");
  assert.match(pathProblem(e, "--out"), /^that is a directory; --out needs a file path/);
});

test("a dangling symlink is ENOENT, not a path-shape problem", async () => {
  const link = join(root, "dangling");
  symlinkSync(join(root, "nowhere"), link);
  const e = await fail(readFile(link));
  assert.equal(e.code, "ENOENT");
  assert.equal(pathProblem(e, "--out"), null);
});

test("a symlink loop (ELOOP) is left to the caller's own message", async () => {
  const a = join(root, "loop-a");
  const b = join(root, "loop-b");
  symlinkSync(b, a);
  symlinkSync(a, b);
  const e = await fail(readFile(a));
  assert.equal(e.code, "ELOOP");
  assert.equal(pathProblem(e, "--out"), null);
});

test("a FIFO used as a parent directory is ENOTDIR and reads as a file in the way", async (t) => {
  const fifo = join(root, "pipe é");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status !== 0) return t.skip("mkfifo unavailable");
  const e = await fail(mkdir(join(fifo, "child"), { recursive: true }));
  assert.match(pathProblem(e, "--out"), FILE_IN_WAY);
});

test("unicode and spaced file names with a trailing slash give the file-in-the-way text", async () => {
  const file = join(root, "日本語 file 😀.json");
  writeFileSync(file, "{}");
  // "file/" on a regular file is ENOTDIR for reads and EEXIST/ENOTDIR for mkdir.
  const read = await fail(readFile(file + "/"));
  assert.equal(read.code, "ENOTDIR");
  assert.match(pathProblem(read, "--out"), FILE_IN_WAY);
  const made = await fail(mkdir(file + "/", { recursive: true }));
  assert.match(pathProblem(made, "--out"), FILE_IN_WAY);
});

test("a trailing slash on an existing directory path still reports a directory for writeFile", async () => {
  const dir = join(root, "plain dir");
  mkdirSync(dir);
  const e = await fail(writeFile(dir, "x"));
  assert.match(pathProblem(e, "EVIDENCE_OUT"), /^that is a directory; EVIDENCE_OUT needs a file path/);
});

test("a deep non-existent path is not a problem for mkdir -p and ENOENT for writeFile", async () => {
  const deep = join(root, "a", "b", "c", "d");
  const e = await fail(writeFile(join(deep, "out.json"), "x"));
  assert.equal(e.code, "ENOENT");
  assert.equal(pathProblem(e, "--out"), null);
  await mkdir(deep, { recursive: true });
});

test("a file in the middle of a deep path (not just the parent) is still a file-in-the-way", async () => {
  const mid = join(root, "mid");
  mkdirSync(mid);
  writeFileSync(join(mid, "blocker"), "x");
  const e = await fail(mkdir(join(mid, "blocker", "x", "y", "z"), { recursive: true }));
  assert.match(pathProblem(e, "--out"), FILE_IN_WAY);
});

test("permission-denied parents (EACCES) are not path-shape problems", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores permissions");
  const locked = join(root, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const e = await fail(mkdir(join(locked, "child"), { recursive: true }));
    assert.equal(e.code, "EACCES");
    assert.equal(pathProblem(e, "--out"), null);
    const w = await fail(writeFile(join(locked, "x.json"), "x"));
    assert.equal(pathProblem(w, "--out"), null);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("the caller's fallback pattern `pathProblem(e, flag) ?? e.message` picks the right side", async () => {
  const file = join(root, "fallback.txt");
  writeFileSync(file, "x");
  const shaped = await fail(mkdir(file));
  const other = await fail(readFile(join(root, "missing.txt")));
  assert.match(pathProblem(shaped, "--out") ?? shaped.message, FILE_IN_WAY);
  assert.equal(pathProblem(other, "--out") ?? other.message, other.message);
});
