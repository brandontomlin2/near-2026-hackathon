import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafeOutDir, clearOwnedFiles, describeWriteFailure } from "./outdir.mjs";

const withTmp = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "outdir52-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("describeWriteFailure: common fs codes become 'cannot write <dir>: <reason>' with the syscall tail removed", () => {
  const cases = [
    ["ENOENT", "ENOENT: no such file or directory, mkdir '/x/y'", "no such file or directory"],
    ["EACCES", "EACCES: permission denied, open '/x/a.json'", "permission denied"],
    ["EEXIST", "EEXIST: file already exists, mkdir '/x'", "file already exists"],
    ["ENOTDIR", "ENOTDIR: not a directory, scandir '/x/f'", "not a directory"],
    ["EISDIR", "EISDIR: illegal operation on a directory, read", "illegal operation on a directory, read"],
    ["EMFILE", "EMFILE: too many open files, open '/x/q'", "too many open files"],
    ["ENOSPC", "ENOSPC: no space left on device, write", "no space left on device, write"],
  ];
  for (const [code, message, reason] of cases) {
    assert.equal(describeWriteFailure("/x", { code, message }), `cannot write /x: ${reason}`, code);
  }
});

test("describeWriteFailure: only the first line of the message is used", () => {
  const out = describeWriteFailure("/x", { code: "EACCES", message: "EACCES: permission denied, open '/x/a'\n    at stack\nmore" });
  assert.equal(out, "cannot write /x: permission denied");
  assert.ok(!out.includes("\n"));
});

test("describeWriteFailure: the code must be an uppercase E-code string, else null", () => {
  for (const code of ["enoent", "E", "E1", "ENO ENT", "XENOENT", "ENOENT\n", " ENOENT", "ÉNOENT", 2, null, undefined, ["ENOENT"], {}]) {
    assert.equal(describeWriteFailure("/x", { code, message: "m" }), null, JSON.stringify(code));
  }
});

test("describeWriteFailure: non-objects and objects without a code give null, never a throw", () => {
  for (const bad of [null, undefined, "ENOENT", 5, true, [], {}, new Error("plain"), NaN]) {
    assert.equal(describeWriteFailure("/x", bad), null);
  }
});

test("describeWriteFailure: the dir is printed verbatim, including emoji, ZWJ, spaces and a long path", () => {
  const error = { code: "EACCES", message: "EACCES: permission denied, mkdir '/p'" };
  for (const dir of ["", "my dir/📁", "👨‍👩‍👧/é", "/" + "d/".repeat(5000), "constructor", "__proto__"]) {
    assert.equal(describeWriteFailure(dir, error), `cannot write ${dir}: permission denied`);
  }
});

test("describeWriteFailure: a non-string dir is interpolated as its text", () => {
  const error = { code: "EACCES", message: "EACCES: permission denied" };
  assert.equal(describeWriteFailure(undefined, error), "cannot write undefined: permission denied");
  assert.equal(describeWriteFailure(null, error), "cannot write null: permission denied");
  assert.equal(describeWriteFailure(42, error), "cannot write 42: permission denied");
});

test("describeWriteFailure: a code with a non-string message still describes without throwing", () => {
  assert.equal(describeWriteFailure("/x", { code: "EACCES", message: 5 }), "cannot write /x: 5");
  assert.equal(describeWriteFailure("/x", { code: "EACCES", message: "" }), "cannot write /x: ");
});

test("describeWriteFailure: works on a real Node error from a missing directory", async () => {
  await withTmp(async (dir) => {
    const missing = join(dir, "no", "such");
    const error = await readdir(missing).catch((e) => e);
    assert.equal(error.code, "ENOENT");
    const text = describeWriteFailure(missing, error);
    assert.equal(text, `cannot write ${missing}: no such file or directory`);
    assert.ok(!text.includes("scandir"));
  });
});

test("describeWriteFailure: works on a real ENOTDIR from writing beneath a file", async () => {
  await withTmp(async (dir) => {
    const file = join(dir, "f");
    await writeFile(file, "x");
    const error = await writeFile(join(file, "child"), "y").catch((e) => e);
    assert.equal(error.code, "ENOTDIR");
    assert.equal(describeWriteFailure(file, error), `cannot write ${file}: not a directory`);
  });
});

test("assertSafeOutDir: an empty string is judged as the cwd, same as '.'", () => {
  const verdict = (p) => {
    try {
      return assertSafeOutDir(p);
    } catch (e) {
      return e.message.replace(JSON.stringify(p), "<p>");
    }
  };
  assert.equal(verdict(""), verdict("."));
});

test("assertSafeOutDir: non-string input throws a TypeError rather than being coerced", () => {
  for (const bad of [null, undefined, 5, {}, ["/tmp/x"]]) {
    assert.throws(() => assertSafeOutDir(bad), TypeError);
  }
});

test("assertSafeOutDir: emoji, ZWJ, combining marks and very long names under tmp are accepted verbatim", () => {
  for (const name of ["📁", "👨‍👩‍👧", "é", "x".repeat(300), "constructor", "__proto__", "hasOwnProperty"]) {
    const dir = join(tmpdir(), "outdir52-never-created", name);
    assert.equal(assertSafeOutDir(dir), resolve(dir));
  }
});

test("assertSafeOutDir: the refusal for the root quotes odd spellings with JSON escaping", () => {
  assert.throws(() => assertSafeOutDir("/\u0007/.."), (e) => e instanceof Error && e.message.includes('"/\\u0007/.."'));
});

test("clearOwnedFiles: emoji, combining-mark and prototype-key file names are matched and removed", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, "s"));
    const names = ["📄.md", "é.md", "👨‍👩‍👧.md", "constructor.md", "__proto__.md", "toString.md"];
    for (const n of [...names, "keep.txt"]) await writeFile(join(dir, "s", n), "x");
    await clearOwnedFiles(dir, "s", /\.md$/);
    assert.deepEqual(await readdir(join(dir, "s")), ["keep.txt"]);
  });
});

test("clearOwnedFiles: a sub with emoji or prototype-key names works the same", async () => {
  await withTmp(async (dir) => {
    for (const sub of ["📁", "__proto__", "constructor"]) {
      await mkdir(join(dir, sub));
      await writeFile(join(dir, sub, "a.md"), "x");
      await clearOwnedFiles(dir, sub, /\.md$/);
      assert.deepEqual(await readdir(join(dir, sub)), [], sub);
    }
  });
});

test("clearOwnedFiles: an empty directory and a pattern that matches nothing both resolve and change nothing", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, "s"));
    await clearOwnedFiles(dir, "s", /.*/);
    assert.deepEqual(await readdir(join(dir, "s")), []);
    await writeFile(join(dir, "s", "a"), "x");
    await clearOwnedFiles(dir, "s", /^never$/);
    assert.deepEqual(await readdir(join(dir, "s")), ["a"]);
  });
});

test("clearOwnedFiles: a symlink to a directory matching the pattern is unlinked and its target survives", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, "s"));
    await mkdir(join(dir, "target"));
    await writeFile(join(dir, "target", "inner.md"), "x");
    await symlink(join(dir, "target"), join(dir, "s", "link.md"));
    await clearOwnedFiles(dir, "s", /\.md$/);
    assert.deepEqual(await readdir(join(dir, "s")), []);
    assert.deepEqual(await readdir(join(dir, "target")), ["inner.md"]);
  });
});

test("clearOwnedFiles: a pattern that throws is propagated to the caller", async () => {
  await withTmp(async (dir) => {
    await mkdir(join(dir, "s"));
    await writeFile(join(dir, "s", "a"), "x");
    const hostile = { test: () => { throw new Error("bad pattern"); } };
    await assert.rejects(() => clearOwnedFiles(dir, "s", hostile), /bad pattern/);
    assert.deepEqual(await readdir(join(dir, "s")), ["a"]);
  });
});
