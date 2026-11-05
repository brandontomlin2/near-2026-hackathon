// edge43: user-visible edge paths of scripts/screenshot.mjs and
// scripts/secret-scan-fallback.mjs. Temp dirs only; fake secrets are built at
// runtime so the real secret scan does not flag this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = join(ROOT, "scripts", "screenshot.mjs");
const SCAN = join(ROOT, "scripts", "secret-scan-fallback.mjs");

function tmp(t, prefix = "edge43-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const node = (script, args, opts = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 120000, ...opts });

function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}
function repo(t, files, name = "repo") {
  const dir = join(tmp(t), name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  for (const [f, content] of Object.entries(files)) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "x");
  return dir;
}

// Fake secrets, assembled at runtime. None starts with "sk-".
const fakeGithub = () => "gh" + "p_" + "A1b2C3d4E5".repeat(4);
const fakeAws = () => "AK" + "IA" + "ABCDEFGHIJKLMNOP";
const fakeEd = () => "ed" + "25519:" + "A".repeat(87);

// ---------------- screenshot ----------------

test("screenshot --help prints the usage text with every flag and the exit codes, exit 0", () => {
  const r = node(SHOT, ["--help"]);
  assert.equal(r.status, 0);
  for (const s of ["Usage: node scripts/screenshot.mjs", "--out FILE", "--update-docs", "--force", "Exit 0", "2: usage error, or no browser found"]) {
    assert.ok(r.stdout.includes(s), `help lacks ${s}`);
  }
  assert.equal(r.stderr, "");
});

test("screenshot --help wins over a bad flag that comes after it", () => {
  const r = node(SHOT, ["--help", "--bogus"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("screenshot: unknown flag names the flag, ends with (see --help), exit 2, no stack", () => {
  const r = node(SHOT, ["--nope"]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "screenshot: unknown argument --nope (see --help)");
});

test("screenshot: --out=FILE (equals form) is rejected as an unknown argument, exit 2", () => {
  const r = node(SHOT, ["--out=x.png"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --out=x\.png \(see --help\)/);
});

test("screenshot: --out with no value, or with a flag as its value, exits 2 with the same message", () => {
  for (const argv of [["--out"], ["--out", "--force"], ["--out", "-h"]]) {
    const r = node(SHOT, argv);
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(r.stderr.trim(), "screenshot: --out needs a file path (see --help)");
  }
});

test("screenshot: --out and --update-docs together exit 2 and name both flags", () => {
  const r = node(SHOT, ["--out", "x.png", "--update-docs"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /use --out or --update-docs, not both \(see --help\)/);
});

test("screenshot: a bare positional argument is rejected, exit 2", () => {
  const r = node(SHOT, ["page.png"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument page\.png/);
});

test("screenshot: --out pointing at a directory is refused with exit 1 (or 2 without a browser), leaving the directory alone", (t) => {
  const d = tmp(t);
  const r = node(SHOT, ["--out", d]);
  assert.ok(r.status === 1 || r.status === 2, `status ${r.status}`);
  if (r.status === 1) assert.match(r.stderr, /is a directory; give a file path/);
  else assert.match(r.stderr, /no headless Chrome\/Chromium found/);
  assert.ok(existsSync(d));
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("screenshot: --out inside a read-only directory is one plain line, exit 1, no stack trace", { skip: process.platform === "win32" || process.getuid?.() === 0 }, (t) => {
  const d = tmp(t);
  const ro = join(d, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  t.after(() => { try { chmodSync(ro, 0o700); } catch {} });
  const r = node(SHOT, ["--out", join(ro, "sub", "page.png")]);
  assert.ok(r.status === 1 || r.status === 2, `status ${r.status}`);
  if (r.status === 1) {
    assert.match(r.stderr, /^screenshot: cannot write /);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
  assert.ok(!existsSync(join(ro, "sub")));
});

test("screenshot: an existing non-PNG --out is left byte-for-byte alone without --force", (t) => {
  const d = tmp(t);
  const f = join(d, "notes.txt");
  writeFileSync(f, "precious");
  const r = node(SHOT, ["--out", f]);
  assert.ok(r.status === 1 || r.status === 2);
  if (r.status === 1) assert.match(r.stderr, /exists and is not a PNG image this tool wrote; pass --force to replace it/);
  assert.equal(spawnSync("cat", [f], { encoding: "utf8" }).stdout, "precious");
});

test("screenshot: an empty --out string is treated as the current directory and refused", (t) => {
  const d = tmp(t);
  const r = node(SHOT, ["--out", ""], { cwd: d });
  assert.ok(r.status === 1 || r.status === 2);
  assert.doesNotMatch(r.stderr, /undefined|\n\s+at /);
});

// ---------------- secret scan ----------------

test("scan: --help prints usage to stdout, exit 0", () => {
  const r = node(SCAN, ["--help"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "usage: node scripts/secret-scan-fallback.mjs [--root <dir>]");
});

test("scan: a clean tree passes and says how many files it scanned", (t) => {
  const dir = repo(t, { "a.txt": "hello\n", "b/c.md": "# hi\n" });
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "secret-scan-fallback: no findings in 2 tracked file(s)");
});

test("scan: planted fake secrets are caught with file:line and rule, and the value is never printed", (t) => {
  const gh = fakeGithub(), aws = fakeAws(), ed = fakeEd();
  const dir = repo(t, { "src/a.js": `// ok\nconst t = "${gh}";\n`, "cfg.txt": `\n\nid=${aws}\n`, "k.txt": `key ${ed}\n` });
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^src\/a\.js:2: github-token \(value not shown\)$/m);
  assert.match(r.stdout, /^cfg\.txt:3: aws-access-key-id \(value not shown\)$/m);
  assert.match(r.stdout, /^k\.txt:1: near-ed25519-private-key \(value not shown\)$/m);
  assert.match(r.stdout, /3 finding\(s\) in 3 tracked file\(s\)/);
  for (const v of [gh, aws, ed]) assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v));
});

test("scan: a planted openai-style token (built at runtime) is caught", (t) => {
  const tok = "s" + "k-" + "Z9y8X7w6V5".repeat(3);
  const dir = repo(t, { "x.txt": `T=${tok}\n` });
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /x\.txt:1: openai-style-token/);
});

test("scan: binary files (NUL bytes) and a >2MB file neither crash the scan nor count as scanned", (t) => {
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 255, 254]), Buffer.from(fakeGithub())]);
  const dir = repo(t, { "ok.txt": "fine\n", "blob.bin": bin, "huge.txt": "x".repeat(3 * 1024 * 1024) });
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no findings in 1 tracked file\(s\)/);
});

test("scan: invalid UTF-8 text does not crash and a secret next to it is still found", (t) => {
  const buf = Buffer.concat([Buffer.from([0xc3, 0x28, 0xff, 0x0a]), Buffer.from(fakeGithub() + "\n")]);
  const dir = repo(t, { "latin.txt": buf });
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /latin\.txt:2: github-token/);
});

test("scan: a ~1.5MB single-line config file finishes quickly (no catastrophic regex backtracking)", (t) => {
  const dir = repo(t, { "data.json": "secret".repeat(250000) });
  const t0 = Date.now();
  const r = node(SCAN, ["--root", dir], { timeout: 60000 });
  assert.equal(r.status, 0, `status ${r.status} signal ${r.signal}`);
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0}ms`);
});

test("scan: a path with spaces in both directory and file name is reported intact", (t) => {
  const dir = repo(t, { "my dir/key file.txt": `${fakeGithub()}\n` }, "my repo");
  const r = node(SCAN, ["--root", dir]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^my dir\/key file\.txt:1: github-token/m);
});

test("scan: unknown flag and missing --root value exit 2 with the usage line, no stack", () => {
  for (const argv of [["--bogus"], ["--root"], ["extra"]]) {
    const r = node(SCAN, argv);
    assert.equal(r.status, 2, argv.join(" "));
    assert.match(r.stderr, /^secret-scan-fallback: unknown argument "/);
    assert.match(r.stderr, /usage: node scripts\/secret-scan-fallback\.mjs \[--root <dir>\]/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test("scan: --root that is not a git repo or does not exist exits 2 with one error line", (t) => {
  const d = tmp(t);
  for (const root of [d, join(d, "missing")]) {
    const r = node(SCAN, ["--root", root]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^secret-scan-fallback: could not scan git-tracked files in /);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.equal(r.stderr.trim().split("\n").filter((l) => /^fatal:/.test(l)).length <= 1, true);
    assert.doesNotMatch(r.stderr, /Command failed/);
  }
});

test("scan: --help after a bad flag still reports the bad flag (exit 2)", () => {
  const r = node(SCAN, ["--bogus", "--help"]);
  assert.equal(r.status, 2);
});
