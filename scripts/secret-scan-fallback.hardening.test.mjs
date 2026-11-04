import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "secret-scan-fallback.mjs");
const VERIFY = path.join(HERE, "verify.sh");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Fake values are built at runtime so this file never holds a scannable secret.
const rand = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const fakeKey = () => `ed25519:${rand(B58, 87)}`;
const words = (n, w = "alpha") => Array.from({ length: n }, () => w).join(" ");

// `dirName` lets a test put spaces in the repo path.
function tempRepo(t, files, dirName = "secscan-hard-") {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), dirName));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, dirName.includes(" ") ? "repo with spaces" : "repo");
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const scan = (dir, args = ["--root", dir], cwd = dir) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });

test("an empty git repo (no files, no commits) passes and says it scanned 0 files", (t) => {
  const r = scan(tempRepo(t, {}));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no findings in 0 tracked file/);
});

test("paths with spaces: repo dir, sub dir and file name are all scanned and reported", (t) => {
  const dir = tempRepo(t, { "my dir/a b.env": `K=${fakeKey()}\n`, "ok.txt": "fine\n" }, "secscan space ");
  const r = scan(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^my dir\/a b\.env:1: near-ed25519-private-key/m);
});

test("a relative --root and the default root (cwd) both find a planted key", (t) => {
  const dir = tempRepo(t, { "leak.env": `K=${fakeKey()}\n` });
  assert.equal(scan(dir, ["--root", "."]).status, 1);
  assert.equal(scan(dir, []).status, 1);
});

test("a missing --root directory, a missing --root value and a stray argument exit 2 without a stack trace", (t) => {
  const dir = tempRepo(t, {});
  for (const args of [["--root", path.join(dir, "nope")], ["--root"], ["extra"]]) {
    const r = scan(dir, args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^secret-scan-fallback: /m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  }
});

test("CRLF files are scanned like LF files", (t) => {
  const dir = tempRepo(t, { "a.env": `K=${fakeKey()}\r\n`, "b.yaml": `seed: ${words(12)}\r\n` });
  const r = scan(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^a\.env:1: near-ed25519-private-key/m);
  assert.match(r.stdout, /^b\.yaml:1: seed-phrase/m);
});

test("the report names file and line of a secret on a later line, once per occurrence", (t) => {
  const dir = tempRepo(t, { "a.json": `{\n  "a": 1,\n  "k": "${fakeKey()}",\n  "k2": "${fakeKey()}"\n}\n` });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^a\.json:3: /m);
  assert.match(r.stdout, /^a\.json:4: /m);
  assert.match(r.stdout, /2 finding\(s\)/);
});

test("a secret that exists only in the working tree (staged clean, modified after) is still caught", (t) => {
  const dir = tempRepo(t, { "k.txt": "clean\n" });
  fs.writeFileSync(path.join(dir, "k.txt"), `${fakeKey()}\n`);
  assert.equal(scan(dir).status, 1);
});

test("a tracked file deleted from the working tree, and a tracked symlink, do not crash the scan", (t) => {
  const dir = tempRepo(t, { "gone.txt": "x\n", "ok.txt": "y\n" });
  fs.symlinkSync("/etc/hosts", path.join(dir, "link"));
  execFileSync("git", ["add", "-A"], { cwd: dir });
  fs.rmSync(path.join(dir, "gone.txt"));
  const r = scan(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("near misses stay quiet: 89-char key, 13 words, a 12-word value in .md, a 24-hex string", (t) => {
  const dir = tempRepo(t, {
    "a.txt": `ed25519:${rand(B58, 89)}\n`,
    "b.toml": `seed = "${words(13)}"\n`,
    "c.md": `seed: ${words(12)}\n`,
    "d.txt": `${"0123456789abcdef".repeat(2)}\n`,
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// verify.sh integration through the real secret_scan() function, gitleaks absent.
function runVerifyStage(t, dir, tools, { copyScript = true } = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-bin-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const tool of tools) fs.symlinkSync(tool, path.join(bin, path.basename(tool)));
  if (copyScript) {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "secret-scan-fallback.mjs"));
  }
  const script = [
    "set -euo pipefail",
    'eval "$(sed -n "/^secret_scan()/,/^}$/p" "$1")"',
    'record() { printf "RECORD\\t%s\\t%s\\t%s\\n" "$1" "$2" "$3"; }',
    "failed=0",
    "secret_scan_skipped=0",
    'export PATH="$2"',
    "secret_scan",
    'printf "failed=%s skipped=%s\\n" "$failed" "$secret_scan_skipped"',
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script, "bash", VERIFY, bin], { cwd: dir, encoding: "utf8" });
}
const git = () => execFileSync("which", ["git"], { encoding: "utf8" }).trim();

test("the script itself runs (and finds a key) when its own path contains spaces or other URL-escaped characters", (t) => {
  const dir = tempRepo(t, { "leak.env": `K=${fakeKey()}\n` });
  const odd = fs.mkdtempSync(path.join(os.tmpdir(), "scan copy #%20 "));
  t.after(() => fs.rmSync(odd, { recursive: true, force: true }));
  const copy = path.join(odd, "secret-scan-fallback.mjs");
  fs.copyFileSync(SCRIPT, copy);
  const r = spawnSync(process.execPath, [copy, "--root", dir], { encoding: "utf8" });
  assert.equal(r.status, 1, `silent no-op? stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`);
  assert.match(r.stdout, /leak\.env:1: near-ed25519-private-key/);
});

test("verify.sh fallback works in a clone path with spaces", (t) => {
  const clean = runVerifyStage(t, tempRepo(t, { "a.txt": "ok\n" }, "secscan space "), [process.execPath, git()]);
  assert.match(clean.stdout, /^RECORD\tPASS\tsecret scan\tFALLBACK/m, clean.stdout + clean.stderr);
  const leaky = runVerifyStage(t, tempRepo(t, { "x.env": `K=${fakeKey()}\n` }, "secscan space "), [process.execPath, git()]);
  assert.match(leaky.stdout, /^RECORD\tFAIL\tsecret scan\tFALLBACK/m, leaky.stdout + leaky.stderr);
  assert.match(leaky.stdout, /^failed=1 /m);
  assert.doesNotMatch(leaky.stdout, /ed25519:[1-9A-HJ-NP-Za-km-z]{20}/, "the key value must not be echoed");
});

test("a seed phrase followed by a trailing comment is still flagged", (t) => {
  const dir = tempRepo(t, { ".env": `SEED_PHRASE="${words(12)}" # my wallet\n`, "b.yaml": `mnemonic: ${words(12)} # note\n` });
  const r = scan(dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^\.env:1: seed-phrase/m);
  assert.match(r.stdout, /^b\.yaml:1: seed-phrase/m);
});

test("a key glued to an identifier with an underscore (near_ed25519:...) is still flagged", (t) => {
  const r = scan(tempRepo(t, { "a.txt": `near_${fakeKey()}\n` }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test("an unreadable tracked file fails closed with a message that does not blame git ls-files", (t) => {
  if (process.getuid?.() === 0) return t.skip("root can read everything");
  const dir = tempRepo(t, { "a.txt": "x\n", "ok.txt": "y\n" });
  fs.chmodSync(path.join(dir, "a.txt"), 0);
  const r = scan(dir);
  fs.chmodSync(path.join(dir, "a.txt"), 0o644); // so the temp dir cleanup can remove it
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /a\.txt/);
  assert.doesNotMatch(r.stderr, /could not list/);
});

test("verify.sh with neither gitleaks nor node records a loud SKIP, never a PASS", (t) => {
  const r = runVerifyStage(t, tempRepo(t, { "a.txt": "ok\n" }), [git()]);
  assert.match(r.stdout, /^RECORD\tSKIP\tsecret scan\t/m, r.stdout + r.stderr);
  assert.match(r.stdout, /^failed=0 skipped=1$/m);
  assert.match(r.stdout, /WARN: secret scan did NOT run/);
});

test("verify.sh with the fallback script missing from the clone records a SKIP, not a crash", (t) => {
  const r = runVerifyStage(t, tempRepo(t, { "a.txt": "ok\n" }), [process.execPath, git()], { copyScript: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RECORD\tSKIP\tsecret scan\t/m, r.stdout);
  assert.match(r.stdout, /^failed=0 skipped=1$/m);
});
