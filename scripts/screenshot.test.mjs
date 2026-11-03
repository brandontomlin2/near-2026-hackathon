import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OUT, DOCS_OUT, findBrowser, parseArgs, run } from "./screenshot.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./screenshot.mjs", import.meta.url));
// A source archive (git archive, zip) has no .git; git-state checks cannot run there.
const NO_GIT = existsSync(join(ROOT, ".git")) ? false : "needs a git work tree (no .git here: source archive); run from a git clone";

test("findBrowser returns null when no candidate exists", () => {
  assert.equal(findBrowser(["/nope/a", "/nope/b"], () => false), null);
});

test("run exits 2 with a clear message and writes nothing when no browser is found", () => {
  const errs = [];
  const code = run({ candidates: ["/nope/a"], exists: () => false, out: "/nonexistent/page.png", err: (m) => errs.push(m) });
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /no headless Chrome\/Chromium found/);
});

test("parseArgs: default is the gitignored out/page.png; --update-docs is the tracked docs/img/page.png", () => {
  assert.equal(parseArgs([]).out, DEFAULT_OUT);
  assert.ok(relative(ROOT, DEFAULT_OUT).startsWith("out" + sep), DEFAULT_OUT);
  if (!NO_GIT) assert.equal(execFileSync("git", ["ls-files", "--", DEFAULT_OUT], { cwd: ROOT, encoding: "utf8" }).trim(), "", "default output must not be tracked");
  assert.equal(parseArgs(["--update-docs"]).out, DOCS_OUT);
  if (!NO_GIT) assert.equal(execFileSync("git", ["ls-files", "--", DOCS_OUT], { cwd: ROOT, encoding: "utf8" }).trim(), "docs/img/page.png");
  assert.equal(parseArgs(["--out", "shots/x.png"]).out, resolve("shots/x.png"));
});

test("parseArgs rejects unknown flags, a missing --out value, and --out with --update-docs", () => {
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument --bogus/);
  assert.throws(() => parseArgs(["--out"]), /--out needs a file path/);
  assert.throws(() => parseArgs(["--out", "--update-docs"]), /--out needs a file path/);
  assert.throws(() => parseArgs(["--out", "x.png", "--update-docs"]), /not both/);
});

test("CLI: a bad flag exits 1 with a one-line error plus usage, before looking for a browser", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^screenshot: unknown argument --bogus\nUsage: /);
  assert.doesNotMatch(r.stderr, /Chrome/);
});

const SKIP_WIN = process.platform === "win32";

function fakeBrowser(dir, body) {
  const p = join(dir, "fake-browser.sh");
  writeFileSync(p, `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) OUT="\${a#--screenshot=}";; esac; done\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function shotCase(t, body, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "nested", "deeper", "page.png");
  const logs = [];
  const errs = [];
  const code = run({
    candidates: [fakeBrowser(dir, body)], out,
    log: (m) => logs.push(m), err: (m) => errs.push(m),
    ...opts,
  });
  return { code, out, logs, errs };
}

test("run writes the image, creates the parent dir, and logs the result", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, 'printf "PNGDATA" > "$OUT"');
  assert.equal(r.code, 0, r.errs.join("\n"));
  assert.ok(statSync(r.out).size > 0);
  assert.ok(r.logs.some((l) => /^wrote .* \(\d+ bytes\) using /.test(l)), r.logs.join("\n"));
});

test("run with no --out writes out/page.png and leaves git-tracked files unchanged", { skip: SKIP_WIN || NO_GIT }, async (t) => {
  const snap = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf8" });
  const before = snap();
  const tracked = readFileSync(DOCS_OUT);
  const had = existsSync(DEFAULT_OUT) ? readFileSync(DEFAULT_OUT) : null;
  t.after(() => { if (had) writeFileSync(DEFAULT_OUT, had); else rmSync(DEFAULT_OUT, { force: true }); });
  const r = await shotCase(t, 'printf "PNGDATA" > "$OUT"', { out: undefined });
  assert.equal(r.code, 0, r.errs.join("\n"));
  assert.equal(readFileSync(DEFAULT_OUT, "utf8"), "PNGDATA");
  assert.ok(r.logs.some((l) => l.startsWith(`wrote ${DEFAULT_OUT} (`)), r.logs.join("\n"));
  assert.equal(snap(), before);
  assert.deepEqual(readFileSync(DOCS_OUT), tracked, "docs/img/page.png must not change without --update-docs");
});

test("parseArgs accepts --force", () => {
  assert.equal(parseArgs([]).force, false);
  assert.equal(parseArgs(["--force"]).force, true);
  assert.equal(parseArgs(["--out", "x.png", "--force"]).out, resolve("x.png"));
});

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("run refuses to overwrite an existing --out that is not a PNG, before the browser runs; --force replaces it", { skip: SKIP_WIN }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "notes.txt");
  writeFileSync(out, "someone's notes\n");
  const marker = join(dir, "browser-ran");
  const browser = fakeBrowser(dir, `touch "${marker}"; printf "PNGDATA" > "$OUT"`);
  const errs = [];
  const code = run({ candidates: [browser], out, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^screenshot: --out .*notes\.txt exists and is not a PNG image this tool wrote; pass --force to replace it$/);
  assert.equal(readFileSync(out, "utf8"), "someone's notes\n");
  assert.equal(existsSync(marker), false, "the browser must not run");

  const forced = run({ candidates: [browser], out, force: true, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(forced, 0, errs.join("\n"));
  assert.equal(readFileSync(out, "utf8"), "PNGDATA");

  const asDir = run({ candidates: [browser], out: dir, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(asDir, 1);
  assert.match(errs.at(-1), /^screenshot: --out .* is a directory; give a file path$/);
});

test("run replaces an existing PNG (an earlier screenshot) without --force", { skip: SKIP_WIN }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "page.png");
  writeFileSync(out, PNG_HEADER);
  const errs = [];
  const code = run({ candidates: [fakeBrowser(dir, 'printf "PNGDATA" > "$OUT"')], out, log: () => {}, err: (m) => errs.push(m) });
  assert.equal(code, 0, errs.join("\n"));
  assert.equal(readFileSync(out, "utf8"), "PNGDATA");
});

test("run returns 1 when the browser exits 0 but writes nothing", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, "exit 0");
  assert.equal(r.code, 1);
  assert.match(r.errs.join("\n"), /browser produced no image/);
  assert.equal(existsSync(r.out), false);
});

test("run returns 1 when the browser writes a zero-byte file", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, ': > "$OUT"');
  assert.equal(r.code, 1);
  assert.match(r.errs.join("\n"), /browser produced no image/);
});
