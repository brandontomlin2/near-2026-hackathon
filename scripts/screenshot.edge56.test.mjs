// edge56: input-validation edges of scripts/screenshot.mjs. The tool takes no URL,
// input file or size flag (it renders its own demo at a fixed size), so "bad
// sizes" and "missing input" show up as arguments that must be refused cleanly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OUT, DOCS_OUT, parseArgs, run } from "./screenshot.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./screenshot.mjs", import.meta.url));
const SKIP_WIN = process.platform === "win32";

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 30000, ...opts });
}

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "shot-edge56-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeBrowser(dir, body) {
  const p = join(dir, "fake-browser.sh");
  writeFileSync(p, `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) OUT="\${a#--screenshot=}";; esac; done\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

// Size-like tokens a user might try: the tool has no size option, so each must be
// an unknown argument (exit 2, one line, no stack), never silently ignored.
const SIZE_FLAGS = [
  ["--size", "800x600"], ["--width", "0"], ["--width", "-5"], ["--height", "abc"],
  ["--width", "1.5"], ["--height", "99999999999"], ["--window-size", "1280,2400"], ["--size", "800x"],
];

for (const args of SIZE_FLAGS) {
  test(`CLI: ${args.join(" ")} is refused as an unknown argument, exit 2, nothing written`, (t) => {
    const dir = tmpDir(t);
    const r = cli([...args, "--out", join(dir, "p.png")]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `screenshot: unknown argument ${args[0]} (see --help)\n`);
    assert.doesNotMatch(r.stderr, /\bat .*\.mjs|Error:/);
    assert.deepEqual(readdirSync(dir), []);
  });
}

test("CLI: bare size and path-like positionals (800x600, x600, 800X600, ' ', a file, a directory) exit 2 naming the token", (t) => {
  const dir = tmpDir(t);
  for (const tok of ["800x600", "x600", "800X600", " ", "-1", "0", "http://example.com", dir, join(dir, "missing.html")]) {
    const r = cli([tok]);
    assert.equal(r.status, 2, `${JSON.stringify(tok)}: ${r.stderr}`);
    assert.equal(r.stderr, `screenshot: unknown argument ${tok} (see --help)\n`);
    assert.equal(r.stderr.split("\n").length, 2);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("parseArgs: a negative number or size-like token after --out is a missing path, not a file name", () => {
  for (const v of ["-5", "-0", "--", "-x"]) assert.throws(() => parseArgs(["--out", v]), /--out needs a file path/, v);
});

test("parseArgs: --out value is kept verbatim (spaces, 800x600, a leading/trailing space) and resolved to absolute", () => {
  for (const v of ["800x600", "my shot.png", " p.png", "p.png "]) assert.equal(parseArgs(["--out", v]).out, resolve(v));
});

test("parseArgs: duplicate --out: the last one wins, and a second --out with no value still throws", () => {
  assert.equal(parseArgs(["--out", "a.png", "--out", "b.png"]).out, resolve("b.png"));
  assert.throws(() => parseArgs(["--out", "a.png", "--out"]), /--out needs a file path/);
  assert.throws(() => parseArgs(["--out", "a.png", "--out", "--force"]), /--out needs a file path/);
});

test("parseArgs: repeated --force and --update-docs are idempotent; --update-docs twice still conflicts with --out", () => {
  const a = parseArgs(["--force", "--force", "--update-docs", "--update-docs"]);
  assert.deepEqual(a, { out: DOCS_OUT, force: true });
  assert.throws(() => parseArgs(["--update-docs", "--update-docs", "--out", "x.png"]), /not both/);
  assert.throws(() => parseArgs(["--out", "x.png", "--out", "y.png", "--update-docs"]), /not both/);
});

test("parseArgs: flags are case-sensitive and exact (--OUT, --Force, -H, --out=, --force=1 are unknown)", () => {
  for (const bad of ["--OUT", "--Force", "-H", "--HELP", "--update_docs", "--force=1", "--out=p.png", "-o"]) {
    assert.throws(() => parseArgs([bad]), new RegExp(`unknown argument ${bad.replace(/[-.=]/g, "\\$&")}$`), bad);
  }
});

test("parseArgs: no arguments gives the gitignored default and force=false", () => {
  assert.deepEqual(parseArgs([]), { out: DEFAULT_OUT, force: false });
});

test("CLI: --help after valid and duplicate flags exits 0; a missing --out value is reported before a later --help", () => {
  const r = cli(["--out", "x.png", "--force", "--force", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^Usage: /);
  // A missing --out value is reported before a later --help is ever seen.
  const bad = cli(["--out", "--help"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^screenshot: --out needs a file path \(see --help\)\n$/);
});

test("CLI: duplicate --out with a missing second value exits 2 and creates no file", (t) => {
  const dir = tmpDir(t);
  const r = cli(["--out", join(dir, "a.png"), "--out"]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "screenshot: --out needs a file path (see --help)\n");
  assert.deepEqual(readdirSync(dir), []);
});

test("run: with no browser the exit is 2 even when --out is also bad (browser is checked first, nothing created)", (t) => {
  const dir = tmpDir(t);
  const errs = [];
  const code = run({ candidates: [], exists: () => false, out: dir, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(code, 2);
  assert.equal(errs.length, 1);
  assert.deepEqual(readdirSync(dir), []);
});

test("run: a directory as --out fails fast with exit 1 and a one-line message, with or without --force; the browser never runs", { skip: SKIP_WIN }, (t) => {
  const dir = tmpDir(t);
  const marker = join(dir, "ran");
  const browser = fakeBrowser(dir, `touch "${marker}"`);
  const before = readdirSync(dir).sort();
  for (const force of [false, true]) {
    const errs = [];
    const code = run({ candidates: [browser], out: dir, force, log: () => {}, err: (m) => errs.push(m) });
    assert.equal(code, 1);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].split("\n").length, 1, errs[0]);
    assert.match(errs[0], /is a directory; give a file path$/);
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(dir).sort(), before);
});

test("run: the browser gets one fixed window size and the user's --out path, whatever the --out looks like", { skip: SKIP_WIN }, (t) => {
  const dir = tmpDir(t);
  const argsFile = join(dir, "args.txt");
  const browser = fakeBrowser(dir, `printf '%s\\n' "$@" > "${argsFile}"; printf PNGDATA > "$OUT"`);
  const out = join(dir, "800x600 shot.png");
  const errs = [];
  const code = run({ candidates: [browser], out, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(code, 0, errs.join("\n"));
  const args = readFileSync(argsFile, "utf8").split("\n");
  assert.deepEqual(args.filter((a) => a.startsWith("--window-size")), ["--window-size=1280,2400"]);
  assert.ok(args.includes(`--screenshot=${out}`), args.join("\n"));
});

test("run: a browser that fails after the demo (exit 1, no image) gives exit 1 with its stderr, no stack, and no output file", { skip: SKIP_WIN }, (t) => {
  const dir = tmpDir(t);
  const browser = fakeBrowser(dir, 'echo "boom from browser" >&2; exit 1');
  const out = join(dir, "p.png");
  const errs = [];
  const code = run({ candidates: [browser], out, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /^screenshot: browser produced no image\nboom from browser/);
  assert.equal(existsSync(out), false);
});
