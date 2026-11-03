import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateAssets, parseArgs, writeAssets, ASSET_DIR, DEFAULT_OUT_DIR, SHARE_NAME, SHEET_NAME } from "./readme-asset.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./readme-asset.mjs", import.meta.url));
// A source archive (git archive, zip) has no .git; git-state checks cannot run there.
const NO_GIT = fs.existsSync(path.join(ROOT, ".git")) ? false : "needs a git work tree (no .git here: source archive); run from a git clone";
const assets = generateAssets(); // one demo run shared by the tests below

test("committed README assets match what the demo generates (refresh: npm run readme-asset -- --update-docs)", async () => {
  for (const [name, text] of Object.entries(await assets)) {
    const committed = fs.readFileSync(path.join(ASSET_DIR, name), "utf8");
    assert.equal(committed, text, `docs/img/${name} drifted; run npm run readme-asset -- --update-docs`);
  }
});

test("README embeds the committed image and quotes the committed sheet", () => {
  const readme = fs.readFileSync(path.join(ASSET_DIR, "..", "..", "README.md"), "utf8");
  assert.ok(readme.includes(`docs/img/${SHARE_NAME}`), "README must embed the share card");
  const sheet = fs.readFileSync(path.join(ASSET_DIR, SHEET_NAME), "utf8").trim();
  const quoted = readme.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ");
  assert.ok(quoted.includes(sheet), "README must quote the committed sheet text verbatim");
});

test("parseArgs: default is the gitignored out/readme-asset; --update-docs is the tracked docs/img", () => {
  assert.equal(parseArgs([]).dir, DEFAULT_OUT_DIR);
  assert.ok(path.relative(ROOT, DEFAULT_OUT_DIR).startsWith("out" + path.sep), DEFAULT_OUT_DIR);
  if (!NO_GIT) assert.equal(execFileSync("git", ["ls-files", "--", DEFAULT_OUT_DIR], { cwd: ROOT, encoding: "utf8" }).trim(), "", "default output dir must hold no tracked files");
  assert.equal(parseArgs(["--update-docs"]).dir, ASSET_DIR);
  if (!NO_GIT) assert.match(execFileSync("git", ["ls-files", "--", ASSET_DIR], { cwd: ROOT, encoding: "utf8" }), /chaotic-share\.svg/);
  assert.equal(parseArgs(["--out", "assets/x"]).dir, path.resolve("assets/x"));
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument --bogus/);
  assert.throws(() => parseArgs(["--out"]), /--out needs a directory/);
  assert.throws(() => parseArgs(["--out", "x", "--update-docs"]), /not both/);
});

test("default run writes under out/ and leaves git-tracked files unchanged", { skip: NO_GIT }, async (t) => {
  const snap = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" });
  const before = snap();
  const tracked = Object.fromEntries([SHARE_NAME, SHEET_NAME].map((n) => [n, fs.readFileSync(path.join(ASSET_DIR, n), "utf8")]));
  const existed = fs.existsSync(DEFAULT_OUT_DIR);
  t.after(() => { if (!existed) fs.rmSync(DEFAULT_OUT_DIR, { recursive: true, force: true }); });
  const logs = [];
  writeAssets(await assets, parseArgs([]).dir, (m) => logs.push(m));
  for (const [name, text] of Object.entries(await assets)) {
    assert.equal(fs.readFileSync(path.join(DEFAULT_OUT_DIR, name), "utf8"), text);
    assert.ok(logs.includes(`wrote ${path.join(DEFAULT_OUT_DIR, name)}`), logs.join("\n"));
  }
  assert.equal(snap(), before);
  for (const [name, text] of Object.entries(tracked)) assert.equal(fs.readFileSync(path.join(ASSET_DIR, name), "utf8"), text, `${name} must not change without --update-docs`);
});

test("parseArgs accepts --force", () => {
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(["--force"]).force, true);
  assert.equal(parseArgs(["--out", "x", "--force"]).dir, path.resolve("x"));
});

test("CLI: --out DIR refuses to overwrite a file this tool did not write unless --force, and writes nothing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme-asset-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stray = path.join(dir, SHEET_NAME);
  fs.writeFileSync(stray, "my own notes\n");
  const r = spawnSync(process.execPath, [SCRIPT, "--out", dir], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^readme-asset: .*chaotic-sheet\.txt exists and is not an asset this tool wrote; pass --force to replace it\n$/);
  assert.equal(r.stdout, "");
  assert.equal(fs.readFileSync(stray, "utf8"), "my own notes\n");
  assert.equal(fs.existsSync(path.join(dir, SHARE_NAME)), false, "no asset may be written when one is refused");

  const forced = spawnSync(process.execPath, [SCRIPT, "--out", dir, "--force"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.readFileSync(stray, "utf8"), (await assets)[SHEET_NAME]);

  // Its own earlier output is replaced without --force.
  const again = spawnSync(process.execPath, [SCRIPT, "--out", dir], { cwd: ROOT, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
});

test("CLI: --out DIR writes both assets there and prints where", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readme-asset-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stdout = execFileSync(process.execPath, [SCRIPT, "--out", dir], { cwd: ROOT, encoding: "utf8" });
  for (const [name, text] of Object.entries(await assets)) {
    assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), text);
    assert.ok(stdout.includes(`wrote ${path.join(dir, name)}\n`), stdout);
  }
});
