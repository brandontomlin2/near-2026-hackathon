import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../src/traits/agents.mjs";
import { STYLE_NAMES } from "../src/art/styles/index.mjs";
import { main } from "./render-agents.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "render-agents.mjs");

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "render-edge57-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file under dir, relative, sorted. */
function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]))
    .sort();
}

const oneLine = (s) => s.endsWith("\n") && !s.slice(0, -1).includes("\n");

test("--style=sticker (equals form) is an unknown argument, exit 2, nothing written", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style=sticker", "--out", "o"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, 'render: unknown argument "--style=sticker" (see --help)\n');
  assert.ok(!existsSync(join(cwd, "o")));
});

test("--out=dir (equals form) is an unknown argument and creates nothing", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--out=o"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'render: unknown argument "--out=o" (see --help)\n');
  assert.deepEqual(readdirSync(cwd), []);
});

test("empty-string values are rejected as missing, with the empty string quoted", (t) => {
  const cwd = scratch(t);
  for (const flag of ["--style", "--out"]) {
    const r = run(cwd, [flag, ""]);
    assert.equal(r.code, 2, flag);
    assert.equal(r.stdout, "");
    assert.ok(oneLine(r.stderr), r.stderr);
    assert.match(r.stderr, new RegExp(`^render: ${flag} needs a (name|directory), got "" \\(see --help\\)\\n$`));
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test("a value that looks like a flag is not consumed as the value", (t) => {
  const cwd = scratch(t);
  const a = run(cwd, ["--style", "--out", "o"]);
  assert.equal(a.code, 2);
  assert.equal(a.stderr, 'render: --style needs a name, got "--out" (see --help)\n');
  const b = run(cwd, ["--out", "--style", "sticker"]);
  assert.equal(b.code, 2);
  assert.equal(b.stderr, 'render: --out needs a directory, got "--style" (see --help)\n');
  const c = run(cwd, ["--out", "-"]);
  assert.equal(c.code, 2);
  assert.match(c.stderr, /^render: --out needs a directory, got "-" /);
  assert.deepEqual(readdirSync(cwd), []);
});

test("positional junk is an unknown argument; the first offender is named", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["sticker", "extra"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'render: unknown argument "sticker" (see --help)\n');
  const r2 = run(cwd, ["--style", "pixel", "stray", "--out", "o"]);
  assert.equal(r2.code, 2);
  assert.equal(r2.stderr, 'render: unknown argument "stray" (see --help)\n');
  assert.deepEqual(readdirSync(cwd), []);
});

test("--help beats bad arguments: exit 0, usage on stdout, empty stderr, nothing written", (t) => {
  const cwd = scratch(t);
  for (const args of [["--style", "nope", "--help"], ["--bogus", "-h"], ["--help", "--out"], ["--out", "--help"], ["junk", "--help", "--style"]]) {
    const r = run(cwd, args);
    assert.equal(r.code, 0, args.join(" "));
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^Usage: /);
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test("prototype-chain keys as style names are a clean unknown-style usage error", (t) => {
  const cwd = scratch(t);
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype", "ALL", "All", " all", "all ", "Sticker", "sticker/", "../sticker"]) {
    const r = run(cwd, ["--style", name, "--out", "o"]);
    assert.equal(r.code, 2, name);
    assert.equal(r.stdout, "", name);
    assert.ok(oneLine(r.stderr), `${name}: ${r.stderr}`);
    assert.equal(r.stderr, `render: unknown style: ${name} (expected one of ${STYLE_NAMES.join(", ")}) (see --help)\n`, name);
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test("main() throws unknown style for prototype keys and writes nothing", (t) => {
  const dir = scratch(t);
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => main(["--style", name, "--out", dir]), /unknown style/, name);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("a repeated --style: an invalid earlier value still fails even if a later one is valid", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "nope", "--style", "pixel", "--out", "o"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^render: unknown style: nope /);
  assert.ok(!existsSync(join(cwd, "o")));
});

test("a repeated --style a --style b renders only the last one", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "pixel", "--style", "sticker", "--out", "o"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(join(cwd, "o", "styles")), ["sticker"]);
});

// A non-directory --out is reported as a bad argument (exit 2, "see --help"), as
// pinned by scripts/cli-behaviour.test.mjs; these cases extend that to repeats and nesting.
test("repeated --out under a file: the message names the last --out, not the first", (t) => {
  const cwd = scratch(t);
  writeFileSync(join(cwd, "blocker"), "x");
  const r = run(cwd, ["--out", "good", "--out", "blocker/sub"]);
  assert.equal(r.code, 2, r.stderr);
  assert.ok(oneLine(r.stderr), r.stderr);
  assert.ok(r.stderr.includes("blocker"), r.stderr);
  assert.ok(!existsSync(join(cwd, "good")), "the earlier --out is not created");
  const r2 = run(cwd, ["--out", "blocker/sub", "--out", "good"]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(readdirSync(join(cwd, "good")).length, AGENTS.length);
});

test("--out under a file fails with one line and no partial output, for every style mode", (t) => {
  const cwd = scratch(t);
  writeFileSync(join(cwd, "afile"), "keep");
  for (const args of [[], ["--style", "sticker"], ["--style", "all"]]) {
    const r = run(cwd, [...args, "--out", "afile/deeper"]);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(oneLine(r.stderr), r.stderr);
    assert.match(r.stderr, /^render: cannot create afile\/deeper: .* is not a directory \(see --help\)\n$/);
  }
  assert.deepEqual(readdirSync(cwd), ["afile"]);
  assert.equal(readFileSync(join(cwd, "afile"), "utf8"), "keep");
});

test("a file where out/styles should be: no partial output, exit 2", (t) => {
  const cwd = scratch(t);
  const out = join(cwd, "o");
  assert.equal(run(cwd, ["--out", "o"]).code, 0);
  const before = walk(out);
  writeFileSync(join(out, "styles"), "blocker");
  const r = run(cwd, ["--style", "sticker", "--out", "o"]);
  assert.equal(r.code, 2, r.stderr);
  assert.deepEqual(walk(out), [...before, "styles"].sort());
  assert.equal(readFileSync(join(out, "styles"), "utf8"), "blocker");
});

test("main() with --out under a file throws and creates nothing", (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "f"), "x");
  assert.throws(() => main(["--out", join(dir, "f", "x")]));
  assert.throws(() => main(["--style", "all", "--out", join(dir, "f")]));
  assert.deepEqual(readdirSync(dir), ["f"]);
});

test("--out refuses the repo root, filesystem root and home directory, exit 2, nothing written", (t) => {
  const cwd = scratch(t);
  for (const bad of ["/", resolve(dirname(SCRIPT), ".."), process.env.HOME ?? "/"]) {
    const r = run(cwd, ["--out", bad]);
    assert.equal(r.code, 2, bad);
    assert.ok(oneLine(r.stderr), r.stderr);
    assert.match(r.stderr, /^render: refusing --out /);
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test("written file names are exactly the AGENTS ids and every path stays inside --out", (t) => {
  const dir = scratch(t);
  const paths = main(["--out", dir]);
  assert.deepEqual(paths, AGENTS.map((a) => join(dir, `${a.id}.svg`)));
  assert.deepEqual(walk(dir), AGENTS.map((a) => `${a.id}.svg`).sort());
  const all = main(["--style", "all", "--out", dir]);
  for (const p of all) assert.ok(p.startsWith(dir + "/"), p);
  for (const p of all) assert.ok(existsSync(p), p);
  const ids = new Set(AGENTS.map((a) => a.id));
  for (const rel of walk(join(dir, "styles"))) {
    const file = rel.split("/").pop();
    if (file === "sheet.svg") continue;
    assert.ok(ids.has(file.replace(/-[a-z]+\.svg$/, "")), file);
  }
});

test("a relative --out containing .. stays resolvable and writes only there", (t) => {
  const cwd = scratch(t);
  const r = run(join(cwd), ["--out", "a/../b"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(cwd), ["b"]);
});

test("determinism: two runs into separate dirs produce byte-identical trees for every mode", (t) => {
  const cwd = scratch(t);
  for (const args of [[], ["--style", "default"], ["--style", "all"]]) {
    assert.equal(run(cwd, [...args, "--out", "one"]).code, 0);
    assert.equal(run(cwd, [...args, "--out", "two"]).code, 0);
    const a = walk(join(cwd, "one"));
    assert.deepEqual(a, walk(join(cwd, "two")));
    for (const f of a) assert.deepEqual(readFileSync(join(cwd, "one", f)), readFileSync(join(cwd, "two", f)), f);
    rmSync(join(cwd, "one"), { recursive: true });
    rmSync(join(cwd, "two"), { recursive: true });
  }
});

test("stdout lists exactly the written paths, one per line", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "pixel", "--out", "o"]);
  assert.equal(r.code, 0, r.stderr);
  const listed = r.stdout.trim().split("\n").sort();
  assert.deepEqual(listed, walk(join(cwd, "o")).map((f) => join("o", f)).sort());
});
