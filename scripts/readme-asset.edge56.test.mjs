import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertAssetsWritable, parseArgs, writeAssets, SHARE_NAME, SHEET_NAME } from "./readme-asset.mjs";

const SCRIPT = fileURLToPath(new URL("./readme-asset.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
const tmp = (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "readme-asset-e56-")));
  t.after(() => {
    try { fs.chmodSync(d, 0o755); } catch {}
    fs.rmSync(d, { recursive: true, force: true });
  });
  return d;
};
const noStack = (s) => assert.doesNotMatch(s, /\n\s+at |node:internal|Error:/);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("parseArgs: --help beats malformed flags, even a dangling --out", () => {
  assert.deepEqual(parseArgs(["--out", "--bogus", "--help"]), { help: true });
  assert.deepEqual(parseArgs(["--out"].concat("-h")), { help: true });
});

test("parseArgs: --out=DIR, positional words and an empty --out value are usage errors", () => {
  assert.throws(() => parseArgs(["--out=/tmp/x"]), /unknown argument --out=\/tmp\/x/);
  assert.throws(() => parseArgs(["somewhere"]), /unknown argument somewhere/);
  assert.throws(() => parseArgs(["--out", ""]), /--out needs a directory/);
  assert.throws(() => parseArgs(["--out", "--force"]), /--out needs a directory/);
});

test("parseArgs: repeated --out takes the last one; unicode and spaces survive", () => {
  assert.equal(parseArgs(["--out", "a", "--out", "b c/ünï ☃"]).dir, path.resolve("b c/ünï ☃"));
});

test("assertAssetsWritable: zero-byte and whitespace-led files are not ours, --force bypasses", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, SHARE_NAME);
  for (const body of ["", "\n<svg></svg>", "﻿<svg></svg>", "<?xml version='1.0'?><svg/>", "<svgx/>"]) {
    fs.writeFileSync(file, body);
    assert.throws(() => assertAssetsWritable(dir, false), /exists and is not an asset this tool wrote; pass --force/, JSON.stringify(body));
    assert.doesNotThrow(() => assertAssetsWritable(dir, true));
  }
  for (const body of ["<svg xmlns='x'></svg>", "<svg>"]) {
    fs.writeFileSync(file, body);
    assert.doesNotThrow(() => assertAssetsWritable(dir, false), body);
  }
});

test("assertAssetsWritable: a missing or empty dir and a nonexistent parent are fine", (t) => {
  const dir = tmp(t);
  assert.doesNotThrow(() => assertAssetsWritable(dir, false));
  assert.doesNotThrow(() => assertAssetsWritable(path.join(dir, "no", "such", "dir"), false));
});

test("assertAssetsWritable: an asset name that is a directory is a one-line read error, not a crash", (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, SHEET_NAME));
  assert.throws(() => assertAssetsWritable(dir, false), (e) => e instanceof Error && /^cannot read existing .*chaotic-sheet\.txt: /.test(e.message) && !e.message.includes("\n"));
});

test("assertAssetsWritable: a dangling symlink at the asset name counts as absent (nothing to protect)", (t) => {
  const dir = tmp(t);
  fs.symlinkSync(path.join(dir, "nowhere"), path.join(dir, SHARE_NAME));
  assert.doesNotThrow(() => assertAssetsWritable(dir, false));
});

test("assertAssetsWritable: a symlink to one of our own assets is accepted, to a foreign file refused", (t) => {
  const dir = tmp(t);
  const real = path.join(dir, "real.txt");
  fs.writeFileSync(real, "Who I am: Chaotic\n");
  fs.symlinkSync(real, path.join(dir, SHEET_NAME));
  assert.doesNotThrow(() => assertAssetsWritable(dir, false));
  fs.writeFileSync(real, "not ours");
  assert.throws(() => assertAssetsWritable(dir, false), /not an asset this tool wrote/);
});

test("assertAssetsWritable: unreadable existing asset gives a one-line 'cannot read' error", { skip: isRoot && "root ignores file modes" }, (t) => {
  const dir = tmp(t);
  const file = path.join(dir, SHEET_NAME);
  fs.writeFileSync(file, "Who I am: x\n");
  fs.chmodSync(file, 0o000);
  assert.throws(() => assertAssetsWritable(dir, false), (e) => /^cannot read existing .*chaotic-sheet\.txt: /.test(e.message) && !e.message.includes("\n"));
});

test("writeAssets: unicode and spaces in the directory name; nested dirs are created; contents are exact", (t) => {
  const base = tmp(t);
  const dir = path.join(base, "my docs", "ünï ☃", "img");
  const logs = [];
  writeAssets({ [SHARE_NAME]: "<svg>é</svg>", [SHEET_NAME]: "Who I am: ☃\n" }, dir, (m) => logs.push(m));
  assert.equal(fs.readFileSync(path.join(dir, SHARE_NAME), "utf8"), "<svg>é</svg>");
  assert.equal(fs.readFileSync(path.join(dir, SHEET_NAME), "utf8"), "Who I am: ☃\n");
  assert.deepEqual(logs, [`wrote ${path.join(dir, SHARE_NAME)}`, `wrote ${path.join(dir, SHEET_NAME)}`]);
});

test("CLI: --out into a read-only directory is one plain line, exit 1, nothing written", { skip: isRoot && "root ignores directory modes" }, (t) => {
  const base = tmp(t);
  fs.chmodSync(base, 0o555);
  const r = run("--out", path.join(base, "sub"));
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^readme-asset: cannot write .*sub: /);
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  noStack(r.stderr);
  assert.deepEqual(fs.readdirSync(base), []);
});

test("CLI: --out with a foreign chaotic-share.svg is refused before the demo runs, file untouched", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, SHARE_NAME), "");
  const r = run("--out", dir);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /chaotic-share\.svg exists and is not an asset this tool wrote; pass --force to replace it\n$/);
  noStack(r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, SHARE_NAME), "utf8"), "");
  assert.equal(fs.existsSync(path.join(dir, SHEET_NAME)), false);
});

test("CLI: --out where an asset name is a directory exits 1 with one line and no stack, writes nothing", (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, SHARE_NAME));
  const r = run("--out", dir);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.match(r.stderr, /^readme-asset: /);
  noStack(r.stderr);
  assert.deepEqual(fs.readdirSync(dir), [SHARE_NAME]);
  assert.equal(fs.statSync(path.join(dir, SHARE_NAME)).isDirectory(), true);
});

test("CLI: --out through a symlinked directory with spaces and unicode writes both assets", (t) => {
  const base = tmp(t);
  const real = path.join(base, "réal dir");
  fs.mkdirSync(real);
  const link = path.join(base, "link ☃");
  fs.symlinkSync(real, link);
  const r = run("--out", link);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(fs.readFileSync(path.join(real, SHARE_NAME), "utf8"), /^<svg[\s>]/);
  assert.match(fs.readFileSync(path.join(real, SHEET_NAME), "utf8"), /^Who I am: /);
});

test("CLI: --out at a dangling symlink is a clean one-line exit 1, no stack", (t) => {
  const base = tmp(t);
  const link = path.join(base, "dangling");
  fs.symlinkSync(path.join(base, "missing-target"), link);
  const r = run("--out", link);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  noStack(r.stderr);
});
