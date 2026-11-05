import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathProblem } from "./path-problem.mjs";

test("real fs errors: a file used as a parent dir (ENOTDIR) and mkdir over a file (EEXIST) both get the file-in-the-way text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pp52-"));
  try {
    const file = join(dir, "f.txt");
    await writeFile(file, "x");
    const notDir = await writeFile(join(file, "child"), "y").catch((e) => e);
    const exists = await mkdir(file).catch((e) => e);
    assert.match(String(pathProblem(notDir, "--out")), /^a file is in the way, but --out must be a directory/);
    assert.match(String(pathProblem(exists, "--out")), /^a file is in the way, but --out must be a directory/);
    const isDir = await readFile(dir).catch((e) => e);
    assert.match(String(pathProblem(isDir, "--out")), /^that is a directory; --out needs a file path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a code is matched exactly: lowercase, padded, numeric or nested codes are not path problems", () => {
  for (const code of ["eexist", "EEXIST ", " EISDIR", "ENOTDIR\n", 17, ["EEXIST"], { toString: () => "EEXIST" }, "", null, undefined]) {
    assert.equal(pathProblem({ code }, "--out"), null, JSON.stringify(code));
  }
});

test("only the code decides: a plain object, a non-Error and a wrong-typed message with a good code still match", () => {
  assert.match(pathProblem({ code: "EISDIR", message: 5 }, "--out"), /^that is a directory/);
  assert.match(pathProblem({ code: "EEXIST" }, "--out"), /^a file is in the way/);
  assert.equal(pathProblem({ message: "EEXIST: file already exists" }, "--out"), null);
  assert.equal(pathProblem(new Error("EISDIR: illegal operation on a directory"), "--out"), null);
});

test("an array, number, boolean or function as the error gives null without throwing", () => {
  for (const bad of [[], ["EEXIST"], 0, NaN, true, () => {}, 17n]) {
    assert.equal(pathProblem(bad, "--out"), null);
  }
});

test("prototype-chain codes are read: an inherited code property still counts", () => {
  const inherited = Object.create({ code: "EISDIR" });
  assert.match(pathProblem(inherited, "--out"), /^that is a directory/);
  assert.equal(pathProblem(JSON.parse('{"__proto__":{"code":"EISDIR"}}'), "--out"), null);
});

test("a throwing getter is not swallowed: the caller sees the error", () => {
  const hostile = {
    get code() {
      throw new Error("boom");
    },
  };
  assert.throws(() => pathProblem(hostile, "--out"), /boom/);
});

test("flags that are missing or not strings are interpolated as their text", () => {
  assert.match(pathProblem({ code: "EEXIST" }), /but undefined must be a directory/);
  assert.match(pathProblem({ code: "EISDIR" }, null), /^that is a directory; null needs a file path/);
  assert.match(pathProblem({ code: "EISDIR" }, 42), /; 42 needs a file path/);
  assert.match(pathProblem({ code: "EEXIST" }, ["--out", "-o"]), /but --out,-o must be a directory/);
});

test("a flag with emoji, ZWJ, a combining mark or a very long name is printed whole", () => {
  const flags = ["👨‍👩‍👧", "é", "𝒳", "--" + "o".repeat(50_000)];
  for (const flag of flags) {
    assert.ok(pathProblem({ code: "EEXIST" }, flag).includes(`but ${flag} must be`));
    assert.ok(pathProblem({ code: "EISDIR" }, flag).includes(`; ${flag} needs a file path`));
  }
});

test("a flag named like a prototype key is just text", () => {
  for (const flag of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.ok(pathProblem({ code: "EISDIR" }, flag).includes(`; ${flag} needs`));
  }
});

test("both messages are one line and never leak the raw Node code", () => {
  for (const code of ["EEXIST", "ENOTDIR", "EISDIR"]) {
    const text = pathProblem({ code, message: `${code}: raw\nmore`, path: "/secret/path" }, "--out");
    assert.ok(!text.includes("\n"));
    assert.ok(!text.includes(code));
    assert.ok(!text.includes("/secret/path"));
  }
});
