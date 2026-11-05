// Edge tests for scripts/site.mjs: output-directory handling, bad arguments, and
// link integrity of the generated pages. Child processes run in mock mode in a
// scratch cwd; nothing touches the network.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, DEFAULT_SITE_DIR } from "./site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "site.mjs");

function run(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: "utf8", timeout: 120_000,
    env: { PATH: process.env.PATH, MOCK_INFERENCE: "1", ...env },
  });
  assert.equal(res.error, undefined, String(res.error));
  return { status: res.status, out: res.stdout, err: res.stderr };
}

/** All files under dir, as sorted relative paths with "/" separators. */
function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

describe("parseArgs edge cases", () => {
  it("returns the default dir for no arguments", () => {
    assert.deepEqual(parseArgs([]), { dir: DEFAULT_SITE_DIR });
  });

  it("help wins even with an empty or extra directory argument", () => {
    assert.deepEqual(parseArgs(["", "-h"]), { help: true });
    assert.deepEqual(parseArgs(["a", "b", "c", "--help"]), { help: true });
  });

  it("treats lone dashes and dash-led names as flags, but accepts them behind ./", () => {
    for (const bad of ["-", "--", "-x", "--out"]) {
      assert.throws(() => parseArgs([bad]), /unknown argument/, bad);
    }
    assert.deepEqual(parseArgs(["./-x"]), { dir: "./-x" });
  });

  it("an unknown flag next to a directory is still an error, not a build", () => {
    assert.throws(() => parseArgs(["dir", "--bogus"]), /unknown argument "--bogus"/);
    assert.throws(() => parseArgs(["--", "dir"]), /unknown argument "--"/);
  });

  it("keeps the directory string untouched (no trimming, no normalising)", () => {
    for (const d of ["  lead", "trail  ", "a//b", "../up", "ü ñ/x y/"]) {
      assert.deepEqual(parseArgs([d]), { dir: d });
    }
  });
});

describe("site CLI: directory handling", () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-edge57-")); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fresh = () => fs.mkdtempSync(path.join(tmp, "case-"));

  let abs; // shared build: absolute, nested, unicode + spaces, trailing slash
  let absRun;
  let absCwd;
  before(() => {
    absCwd = fresh();
    abs = path.join(fresh(), "deep", "né w", "site ü");
    absRun = run([abs + "/"], { cwd: absCwd });
  });

  it("an absolute, nested, non-existent, unicode dir is created and the cwd stays clean", () => {
    assert.equal(absRun.status, 0, absRun.err);
    assert.ok(fs.statSync(path.join(abs, "index.html")).isFile());
    assert.deepEqual(fs.readdirSync(absCwd), []);
  });

  it("a trailing slash gives a normal ready line with no doubled slash", () => {
    const last = absRun.out.trimEnd().split("\n").at(-1);
    assert.ok(last.startsWith(`Site ready: ${abs}/index.html `), last);
    assert.doesNotMatch(last, /\/\/index\.html/);
  });

  it("the printed Site ready path is the real index.html", () => {
    const m = absRun.out.match(/^Site ready: (.+?\/index\.html) \(/m);
    assert.ok(m, absRun.out);
    assert.equal(fs.realpathSync(m[1]), fs.realpathSync(path.join(abs, "index.html")));
  });

  it("every file the run lists as written exists, and nothing else was written", () => {
    const listed = [...absRun.out.matchAll(/^ {2}(\S.*)$/gm)]
      .map((m) => m[1])
      .filter((p) => p.startsWith(abs));
    const rel = listed.map((p) => path.relative(abs, p).split(path.sep).join("/")).sort();
    assert.ok(rel.includes("index.html"));
    assert.deepEqual(rel, listFiles(abs));
  });

  it("a relative dir behind ./ and a dash-led name builds in the cwd", () => {
    const cwd = fresh();
    const r = run(["./-dash"], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.statSync(path.join(cwd, "-dash", "index.html")).isFile());
    assert.match(r.out, /\nSite ready: \.\/-dash\/index\.html /);
  });

  it("DIR '.' builds straight into the cwd", () => {
    const cwd = fresh();
    const r = run(["."], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.statSync(path.join(cwd, "index.html")).isFile());
    assert.ok(fs.statSync(path.join(cwd, "art")).isDirectory());
  });

  it("an existing empty directory is reused", () => {
    const cwd = fresh();
    fs.mkdirSync(path.join(cwd, "empty"));
    const r = run(["empty"], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.statSync(path.join(cwd, "empty", "index.html")).isFile());
  });

  it("rebuilding keeps unrelated files, rewrites a tampered page, and yields byte-identical output", () => {
    const cwd = fresh();
    const dir = path.join(cwd, "s");
    assert.equal(run([dir], { cwd }).status, 0);
    const files = listFiles(dir);
    const snapshot = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f))]));
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    fs.writeFileSync(path.join(dir, "index.html"), "tampered");
    const r = run([dir], { cwd });
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "mine");
    assert.deepEqual(listFiles(dir), [...files, "notes.txt"].sort());
    for (const f of files) assert.ok(fs.readFileSync(path.join(dir, f)).equals(snapshot[f]), f);
  });

  it("a dir whose parent chain contains a file exits 1, names the dir, and leaves the file alone", () => {
    const cwd = fresh();
    fs.writeFileSync(path.join(cwd, "blocker"), "keep");
    const r = run(["blocker/inner/site"], { cwd });
    assert.equal(r.status, 1);
    assert.match(r.err, /^site: cannot write to "blocker\/inner\/site"/);
    assert.doesNotMatch(r.out, /Site ready/);
    assert.equal(fs.readFileSync(path.join(cwd, "blocker"), "utf8"), "keep");
    assert.deepEqual(fs.readdirSync(cwd), ["blocker"]);
  });

  it("-h mixed with a directory and a bad flag prints usage, exits 0, writes nothing", () => {
    const cwd = fresh();
    const r = run(["somedir", "--bogus", "-h"], { cwd });
    assert.equal(r.status, 0);
    assert.match(r.out, /^Usage: node scripts\/site\.mjs \[DIR\]/);
    assert.equal(r.err, "");
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it("bad args exit 2 with empty stdout and write nothing, even with a valid dir present", () => {
    for (const args of [["good", "--rounds", "3"], ["good", "good2"], ["--out", "good"], ["good", ""]]) {
      const cwd = fresh();
      const r = run(args, { cwd });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.err, /^site: /);
      assert.match(r.err, /see --help/);
      assert.equal(r.out, "");
      assert.deepEqual(fs.readdirSync(cwd), [], args.join(" "));
    }
  });

  it("MOCK_INFERENCE with a junk value exits 2 and writes nothing", () => {
    const cwd = fresh();
    const r = run(["s"], { cwd, env: { MOCK_INFERENCE: "banana" } });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.out, /Site ready/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });
});

describe("generated site: link integrity", () => {
  let dir;
  let pages;
  before(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "site-edge57-links-")), "my site");
    const r = run([dir], { cwd: os.tmpdir() });
    assert.equal(r.status, 0, r.err);
    // .html pages plus the standalone .svg cards, which also carry links.
    pages = listFiles(dir).filter((f) => /\.(html?|svg)$/i.test(f));
  });
  after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  const refsOf = (text) => [...text.matchAll(/\b(?:xlink:)?(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]);

  it("has index.html and at least one other page that links onward", () => {
    assert.ok(pages.includes("index.html"));
    assert.ok(pages.length > 5);
  });

  it("every local href/src in every page resolves to a real file inside the folder", () => {
    const real = fs.realpathSync(dir);
    let checked = 0;
    for (const page of pages) {
      const text = fs.readFileSync(path.join(dir, page), "utf8");
      for (const ref of refsOf(text)) {
        if (ref.startsWith("#") || /^https?:\/\//i.test(ref)) continue;
        assert.ok(ref !== "", `${page}: empty reference`);
        assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(ref), `${page}: scheme in ${ref}`);
        assert.ok(!ref.startsWith("/") && !ref.startsWith("\\"), `${page}: absolute ${ref}`);
        assert.ok(!ref.includes(real) && !ref.includes(dir), `${page}: leaks the build path ${ref}`);
        const bare = decodeURIComponent(ref.split(/[?#]/)[0]);
        assert.ok(!bare.split("/").includes(".."), `${page}: parent segment in ${ref}`);
        const target = path.resolve(path.dirname(path.join(dir, page)), bare);
        assert.ok(target.startsWith(dir + path.sep), `${page}: escapes folder ${ref}`);
        assert.ok(fs.statSync(target).isFile(), `${page}: missing ${ref}`);
        checked++;
      }
    }
    assert.ok(checked > 10, `only ${checked} local references checked`);
  });

  it("no page embeds a file: URL or the machine's build directory", () => {
    for (const f of listFiles(dir)) {
      if (!/\.(html?|svg|json|txt)$/i.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.doesNotMatch(text, /file:\/\//i, f);
      assert.ok(!text.includes(pathToFileURL(dir).href), f);
      assert.ok(!text.includes(path.dirname(dir)), `${f} leaks ${path.dirname(dir)}`);
    }
  });

  it("every remote link is a plain http(s) anchor, never a fetched resource", () => {
    for (const page of pages) {
      const text = fs.readFileSync(path.join(dir, page), "utf8");
      for (const m of text.matchAll(/<(\w+)\b[^>]*\b(?:xlink:)?(?:href|src)\s*=\s*"(https?:[^"]*)"/gi)) {
        assert.equal(m[1].toLowerCase(), "a", `${page}: <${m[1]}> fetches ${m[2]}`);
      }
    }
  });
});
