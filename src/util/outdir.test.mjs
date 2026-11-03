import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeOutDir, clearOwnedFiles } from "./outdir.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fsRoot = path.parse(process.cwd()).root;
const relToRepo = path.relative(process.cwd(), repoRoot) || ".";

const temps = [];
const mkTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outdir-test-"));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const refused = (arg) => (error) =>
  error instanceof Error && error.message.includes("refusing --out") && error.message.includes(JSON.stringify(arg));

describe("assertSafeOutDir rejects", () => {
  it("the filesystem root", () => {
    for (const arg of ["/", fsRoot]) assert.throws(() => assertSafeOutDir(arg), refused(arg));
  });

  it("the home directory", () => {
    const home = os.homedir();
    assert.throws(() => assertSafeOutDir(home), refused(home));
  });

  it("the repo root", () => {
    assert.throws(() => assertSafeOutDir(repoRoot), refused(repoRoot));
  });

  it("every ancestor of the repo root", () => {
    let dir = path.dirname(repoRoot);
    let seen = 0;
    for (;;) {
      assert.throws(() => assertSafeOutDir(dir), refused(dir));
      seen += 1;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    assert.ok(seen >= 1);
  });

  it("relative forms that resolve to the repo root or its parents", () => {
    for (const arg of [relToRepo, `${relToRepo}${path.sep}`, path.join(relToRepo, "out", ".."), path.join(relToRepo, "..")]) {
      assert.throws(() => assertSafeOutDir(arg), refused(arg));
    }
  });

  it("a trailing-slash or dotted spelling of the root", () => {
    for (const arg of ["/.", "//", `${repoRoot}${path.sep}.`]) {
      assert.throws(() => assertSafeOutDir(arg), refused(arg));
    }
  });
});

describe("assertSafeOutDir accepts", () => {
  it("a fresh temp dir and returns its resolved path", () => {
    const dir = mkTemp();
    assert.equal(assertSafeOutDir(dir), path.resolve(dir));
  });

  it("a non-existent path under tmp without creating it", () => {
    const dir = path.join(mkTemp(), "not", "yet");
    assert.equal(assertSafeOutDir(dir), dir);
    assert.equal(fs.existsSync(dir), false);
  });

  it("subdirs of the repo root, relative and absolute", () => {
    for (const sub of ["out", path.join("out", "nested")]) {
      const abs = path.join(repoRoot, sub);
      assert.equal(assertSafeOutDir(abs), abs);
      const rel = path.join(relToRepo, sub);
      assert.equal(assertSafeOutDir(rel), path.resolve(rel));
      assert.equal(path.resolve(rel), abs);
    }
  });

  it("a path that only shares a name prefix with the repo root", () => {
    const sibling = `${repoRoot}xyz`;
    assert.equal(assertSafeOutDir(sibling), sibling);
  });

  it("returns an absolute, normalised path for a messy input", () => {
    const base = mkTemp();
    const messy = path.join(base, "a", "..", "b");
    assert.equal(assertSafeOutDir(messy), path.join(base, "b"));
  });
});

describe("clearOwnedFiles", () => {
  let root;
  before(() => {
    root = mkTemp();
  });

  const fresh = () => fs.mkdtempSync(path.join(root, "case-"));
  const write = (...parts) => {
    const file = path.join(...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    return file;
  };
  const names = (dir) => fs.readdirSync(dir).sort();

  it("resolves and creates nothing when the sub dir is missing", async () => {
    const out = fresh();
    await assert.doesNotReject(clearOwnedFiles(out, "missing", /.*/));
    assert.deepEqual(names(out), []);
  });

  it("resolves and leaves the file when sub is a regular file", async () => {
    const out = fresh();
    const file = write(out, "sub");
    await assert.doesNotReject(clearOwnedFiles(out, "sub", /.*/));
    assert.equal(fs.readFileSync(file, "utf8"), "x");
  });

  it("removes only matching regular files", async () => {
    const out = fresh();
    write(out, "sub", "a.svg");
    write(out, "sub", "b.svg");
    write(out, "sub", "keep.txt");
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(path.join(out, "sub")), ["keep.txt"]);
  });

  it("leaves a subdirectory even when its name matches", async () => {
    const out = fresh();
    write(out, "sub", "dir.svg", "inner.svg");
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(path.join(out, "sub")), ["dir.svg"]);
    assert.deepEqual(names(path.join(out, "sub", "dir.svg")), ["inner.svg"]);
  });

  it("touches direct children only, not nested files", async () => {
    const out = fresh();
    write(out, "sub", "top.svg");
    write(out, "sub", "nested", "deep.svg");
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(path.join(out, "sub")), ["nested"]);
    assert.deepEqual(names(path.join(out, "sub", "nested")), ["deep.svg"]);
  });

  it("removes a matching symlink but not its target", async () => {
    const out = fresh();
    const target = write(out, "elsewhere", "target.txt");
    fs.mkdirSync(path.join(out, "sub"));
    fs.symlinkSync(target, path.join(out, "sub", "link.svg"));
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(path.join(out, "sub")), []);
    assert.equal(fs.readFileSync(target, "utf8"), "x");
  });

  it("removes a dangling matching symlink", async () => {
    const out = fresh();
    fs.mkdirSync(path.join(out, "sub"));
    fs.symlinkSync(path.join(out, "nowhere"), path.join(out, "sub", "dead.svg"));
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(path.join(out, "sub")), []);
  });

  it("matches the pattern against the bare file name", async () => {
    const out = fresh();
    const pattern = new RegExp("^(aloof|chaotic)(\\.[a-z0-9-]+)?\\.svg$");
    for (const n of ["aloof.svg", "aloof.hype.svg", "chaotic.mint.svg", "aloof.svg.bak", "social.svg", "aloofx.svg"]) {
      write(out, "sub", n);
    }
    await clearOwnedFiles(out, "sub", pattern);
    assert.deepEqual(names(path.join(out, "sub")), ["aloof.svg.bak", "aloofx.svg", "social.svg"]);
  });

  it("does not touch a sibling dir with matching names", async () => {
    const out = fresh();
    write(out, "sub", "a.svg");
    write(out, "other", "a.svg");
    write(out, "a.svg");
    await clearOwnedFiles(out, "sub", /\.svg$/);
    assert.deepEqual(names(out), ["a.svg", "other", "sub"]);
    assert.deepEqual(names(path.join(out, "other")), ["a.svg"]);
  });

  it("treats an empty sub as outDir itself", async () => {
    const out = fresh();
    write(out, "a.svg");
    write(out, "b.txt");
    write(out, "sub", "c.svg");
    await clearOwnedFiles(out, "", /\.svg$/);
    assert.deepEqual(names(out), ["b.txt", "sub"]);
    assert.deepEqual(names(path.join(out, "sub")), ["c.svg"]);
  });

  it("propagates errors other than ENOENT and ENOTDIR", async () => {
    await assert.rejects(clearOwnedFiles("bad\u0000dir", "sub", /.*/), (error) => error instanceof Error && error.code !== "ENOENT" && error.code !== "ENOTDIR");
  });
});
