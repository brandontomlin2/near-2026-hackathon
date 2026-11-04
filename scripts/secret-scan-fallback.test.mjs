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
const REPO_ROOT = path.resolve(HERE, "..");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// Fake values are built at runtime so this file never holds a scannable secret.
const rand = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");

function tempRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-repo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const scan = (dir) => spawnSync(process.execPath, [SCRIPT, "--root", dir], { encoding: "utf8" });

test("a clean temp repo passes", (t) => {
  const dir = tempRepo(t, { "a.txt": "hello\n", ".env.example": "NEAR_ACCOUNT_ID=\n", "k.json": '{"pub":"ed25519:' + rand(B58, 44) + '"}\n' });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no findings in 3 tracked file/);
});

test("the real repo tree passes", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", REPO_ROOT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const CASES = [
  ["near-ed25519-private-key", "k.env", () => `NEAR_PRIVATE_KEY=ed25519:${rand(B58, 87)}\n`],
  ["near-secp256k1-private-key", "k.txt", () => `key = secp256k1:${rand(B58, 44)}\n`],
  ["pem-private-key", "id.pem", () => `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nabc\n`],
  ["seed-phrase", ".env", () => `SEED_PHRASE="${Array.from({ length: 12 }, () => rand("abcdefghilmnoprstu", 5)).join(" ")}"\n`],
  ["seed-phrase", "cfg.yaml", () => `mnemonic: ${Array.from({ length: 24 }, () => rand("abcdefghilmnoprstu", 6)).join(" ")}\n`],
  ["aws-access-key-id", "a.txt", () => `id ${"AKIA"}${rand("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}\n`],
  ["github-token", "a.txt", () => `t=${"ghp_"}${rand(ALNUM, 36)}\n`],
  ["openai-style-token", "a.txt", () => `k=${"s" + "k-"}${rand(ALNUM, 40)}\n`],
];

for (const [rule, file, make] of CASES) {
  test(`flags a planted fake ${rule} in ${file} without printing the value`, (t) => {
    const content = make();
    const dir = tempRepo(t, { "ok.txt": "fine\n", [file]: content });
    const r = scan(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${file.replace(".", "\\.")}:\\d+: ${rule}`));
    const secretish = content.match(/[A-Za-z0-9]{30,}/)?.[0];
    if (secretish) assert.ok(!r.stdout.includes(secretish), "the secret value must not be echoed");
  });
}

test("near-miss values do not match: public key length, 13-word list, seed text in a .md file", (t) => {
  const dir = tempRepo(t, {
    "a.txt": `ed25519:${rand(B58, 44)}\nsecp256k1:${rand(B58, 88)}\n`,
    "cfg.toml": `seed = "${Array.from({ length: 13 }, () => "word").join(" ")}"\n`,
    "notes.md": `seed: ${Array.from({ length: 12 }, () => "word").join(" ")}\n`,
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("untracked files are not scanned (git ls-files only)", (t) => {
  const dir = tempRepo(t, { "a.txt": "x\n" });
  fs.writeFileSync(path.join(dir, "untracked.txt"), `ghp_${rand(ALNUM, 36)}\n`);
  assert.equal(scan(dir).status, 0);
});

test("a non-git directory and bad arguments exit 2", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-nogit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(scan(dir).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" }).status, 2);
});

// verify.sh integration: only secret_scan is loaded; PATH holds node and git but no gitleaks.
function runVerifyStage(t, dir) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-bin-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  for (const tool of [process.execPath, execFileSync("which", ["git"], { encoding: "utf8" }).trim()]) {
    fs.symlinkSync(tool, path.join(bin, path.basename(tool)));
  }
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "secret-scan-fallback.mjs"));
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

test("verify.sh without gitleaks records a FALLBACK PASS on a clean repo (not SKIP)", (t) => {
  const dir = tempRepo(t, { "a.txt": "clean\n" });
  const r = runVerifyStage(t, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RECORD\tPASS\tsecret scan\tFALLBACK scan, no findings/m);
  assert.match(r.stdout, /^failed=0 skipped=0$/m);
});

test("verify.sh without gitleaks records a FALLBACK FAIL when a planted key is tracked", (t) => {
  const dir = tempRepo(t, { "leak.env": `K=ed25519:${rand(B58, 88)}\n` });
  const r = runVerifyStage(t, dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RECORD\tFAIL\tsecret scan\tFALLBACK scan reported findings/m);
  assert.match(r.stdout, /^failed=1 skipped=0$/m);
});
