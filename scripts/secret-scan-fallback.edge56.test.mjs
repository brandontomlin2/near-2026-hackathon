// Edge cases for scripts/secret-scan-fallback.mjs not pinned by the other secret-scan-fallback
// test files or screenshot-secretscan.edge43.test.mjs. Fake secrets are built at runtime from
// fragments so this file never holds a scannable literal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanText } from "./secret-scan-fallback.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "secret-scan-fallback.mjs");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const rand = (alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
const edKey = () => `ed25519:${rand(B58, 87)}`;
const words = (n) => Array.from({ length: n }, () => "alpha").join(" ");
const DASHES = "-".repeat(5);
const rules = (file, text) => scanText(file, text).map((f) => f.rule);

function tempRepo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-e56-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}
const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });

test("every rule fires on its own fixture, and the CLI output never contains any matched value", (t) => {
  const fixtures = {
    "pem.txt": [`${DASHES}BEGIN OPENSSH PRIVATE KEY${DASHES}`, "pem-private-key"],
    "aws.txt": [`AKIA${rand("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`, "aws-access-key-id"],
    "gh.txt": [`ghp_${rand(ALNUM, 36)}`, "github-token"],
    "ghpat.txt": [`github_pat_${rand(ALNUM, 30)}`, "github-token"],
    "slack.txt": [`xox${"b"}-${rand(ALNUM, 24)}`, "slack-token"],
    "sec.txt": [`secp256k1:${rand(B58, 44)}`, "near-secp256k1-private-key"],
    "oa.txt": [`s${"k"}-${rand(ALNUM, 40)}`, "openai-style-token"],
  };
  const dir = tempRepo(t, Object.fromEntries(Object.entries(fixtures).map(([f, [v]]) => [f, `${v}\n`])));
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const [file, [value, rule]] of Object.entries(fixtures)) {
    assert.match(r.stdout, new RegExp(`^${file.replace(".", "\\.")}:1: ${rule} \\(value not shown\\)$`, "m"));
    assert.ok(!r.stdout.includes(value) && !r.stderr.includes(value), `${file} value echoed`);
  }
  assert.match(r.stdout, /7 finding\(s\) in 7 tracked file\(s\)/);
});

test("boundary lengths: AWS id with 17 tail chars, 35-char GitHub token, 19-char sk- body and 9-char slack body do not match", () => {
  const up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  assert.deepEqual(rules("a.txt", `AKIA${rand(up, 17)}\n`), []);
  assert.deepEqual(rules("a.txt", `ghp_${rand(ALNUM, 35)}\n`), []);
  assert.deepEqual(rules("a.txt", `s${"k"}-${rand(ALNUM, 19)}\n`), []);
  assert.deepEqual(rules("a.txt", `xox${"p"}-${rand(ALNUM, 9)}\n`), []);
  assert.deepEqual(rules("a.txt", `secp256k1:${rand(B58, 45)}\n`), []);
  assert.deepEqual(rules("a.txt", `ASIA${rand(up, 16)}\n`), ["aws-access-key-id"]);
});

test("PEM headers: private-key variants match, public-key and certificate headers do not", () => {
  for (const kind of ["", "RSA ", "EC ", "DSA ", "ENCRYPTED ", "OPENSSH "]) {
    assert.deepEqual(rules("k.txt", `-----BEGIN ${kind}PRIVATE KEY-----\n`), ["pem-private-key"], kind);
  }
  assert.deepEqual(rules("k.txt", `${DASHES}BEGIN PGP PRIVATE KEY BLOCK${DASHES}\n`), ["pem-private-key"]);
  assert.deepEqual(rules("k.txt", "-----BEGIN PUBLIC KEY-----\n-----BEGIN CERTIFICATE-----\n-----END PRIVATE KEY-----\n"), []);
});

test("two different secrets on one line produce two findings with the same line number", () => {
  const f = scanText("a.txt", `x=${edKey()} y=ghp_${rand(ALNUM, 36)}\n`);
  assert.deepEqual(f.map((x) => [x.line, x.rule]), [[1, "near-ed25519-private-key"], [1, "github-token"]]);
});

test("seed-phrase is scoped to config files: .env variants, .json, .yml and nested paths count; .envrc, .txt and .env-like dirs do not", () => {
  const line = `mnemonic=${words(12)}\n`;
  for (const file of [".env", ".env.local", ".env.production", "deep/dir/.env", "x.env", "c.json", "c.yml", "c.yaml", "c.toml", "c.ini", "c.conf", "c.cfg", "c.properties", "C.JSON"]) {
    assert.deepEqual(rules(file, line), ["seed-phrase"], file);
  }
  for (const file of [".envrc", "notes.txt", "run.sh", "README.md", "dir.env/readme", "env"]) {
    assert.deepEqual(rules(file, line), [], file);
  }
});

test("seed-phrase value forms: JSON quoted pair, single quotes, 24 words and a mixed-case keyword flag; 11, 14 and 25 words do not", () => {
  assert.deepEqual(rules("c.json", `{"seed_phrase": "${words(12)}"}\n`), ["seed-phrase"]);
  assert.deepEqual(rules("c.yaml", `recovery: '${words(24)}'\n`), ["seed-phrase"]);
  assert.deepEqual(rules("c.env", `WALLET_SECRET = ${words(12)}\n`), ["seed-phrase"]);
  assert.deepEqual(rules("c.env", `Mnemonic=${words(12).toUpperCase()}\n`), ["seed-phrase"]);
  for (const n of [11, 14, 23, 25]) assert.deepEqual(rules("c.env", `seed=${words(n)}\n`), [], `${n} words`);
  assert.deepEqual(rules("c.env", `username=${words(12)}\n`), [], "key name without a seed keyword");
});

test("a 24-word seed is reported once, not once per 12-word prefix", () => {
  assert.equal(scanText(".env", `seed=${words(24)}\n`).length, 1);
});

test("a file with a UTF-8 BOM, or a lone CR as its only line break, is still scanned and the finding is on line 1", (t) => {
  const dir = tempRepo(t, {
    "bom.env": `﻿K=${edKey()}\n`,
    "cr.env": `A=1\rK=${edKey()}\r`,
  });
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^bom\.env:1: near-ed25519-private-key/m);
  assert.match(r.stdout, /^cr\.env:1: near-ed25519-private-key/m);
});

test("a NUL byte after the first 8 KiB does not make a file binary: a key before it is found, and an empty file counts as scanned", (t) => {
  const dir = tempRepo(t, {
    "late-nul.dat": Buffer.concat([Buffer.from(`${edKey()}\n`), Buffer.alloc(9000, 0x61), Buffer.from([0])]),
    "empty.txt": "",
  });
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^late-nul\.dat:1: near-ed25519-private-key/m);
  assert.match(r.stdout, /in 2 tracked file/);
});

test("a key inside a file with a NUL in its first 8 KiB is skipped (binary), and the file is not counted", (t) => {
  const dir = tempRepo(t, { "bin.dat": Buffer.concat([Buffer.from([0]), Buffer.from(`${edKey()}\n`)]), "ok.txt": "fine\n" });
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no findings in 1 tracked file/);
});

test("the size cap is inclusive: a file of exactly 2 MiB is scanned, one byte more is skipped", (t) => {
  const MAX = 2 * 1024 * 1024;
  const key = `${edKey()}\n`;
  const pad = (n) => Buffer.from("a".repeat(n - key.length));
  const dir = tempRepo(t, {
    "exact.txt": Buffer.concat([Buffer.from(key), pad(MAX)]).subarray(0, MAX),
    "over.txt": Buffer.concat([Buffer.from(key), pad(MAX + 1)]).subarray(0, MAX + 1),
  });
  assert.equal(fs.statSync(path.join(dir, "exact.txt")).size, MAX);
  assert.equal(fs.statSync(path.join(dir, "over.txt")).size, MAX + 1);
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^exact\.txt:1: /m);
  assert.doesNotMatch(r.stdout, /over\.txt/);
  assert.match(r.stdout, /in 1 tracked file/);
});

test("a tracked file that was replaced by a directory in the working tree is skipped, not a crash", (t) => {
  const dir = tempRepo(t, { "swap": "x\n", "ok.txt": "y\n" });
  fs.rmSync(path.join(dir, "swap"));
  fs.mkdirSync(path.join(dir, "swap"));
  fs.writeFileSync(path.join(dir, "swap", "inner.txt"), `${edKey()}\n`); // untracked, must not be scanned
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no findings in 1 tracked file/);
});

test("a tracked file later added to .gitignore is still scanned, an ignored untracked one is not", (t) => {
  const dir = tempRepo(t, { "tracked.env": "A=1\n" });
  fs.writeFileSync(path.join(dir, ".gitignore"), "tracked.env\nignored.env\n");
  fs.writeFileSync(path.join(dir, "tracked.env"), `K=${edKey()}\n`);
  fs.writeFileSync(path.join(dir, "ignored.env"), `K=${edKey()}\n`);
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^tracked\.env:1: /m);
  assert.doesNotMatch(r.stdout, /ignored\.env/);
});

test("non-ASCII and newline-containing file names are reported with their real names", (t) => {
  const dir = tempRepo(t, { "café/中文.env": `K=${edKey()}\n`, "line\nbreak.env": `K=${edKey()}\n` });
  const r = run(["--root", dir], dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("café/中文.env:1: near-ed25519-private-key"), r.stdout);
  assert.ok(r.stdout.includes("line\nbreak.env:1: near-ed25519-private-key"), r.stdout);
});

test("--root pointing at a subdirectory scans only that subtree, with paths relative to it", (t) => {
  const dir = tempRepo(t, { "sub/a.env": `K=${edKey()}\n`, "top.env": `K=${edKey()}\n` });
  const r = run(["--root", path.join(dir, "sub")], os.tmpdir());
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^a\.env:1: /m);
  assert.doesNotMatch(r.stdout, /top\.env/);
  assert.match(r.stdout, /in 1 tracked file/);
});

test("--root pointing at a regular file exits 2 with one plain error line", (t) => {
  const dir = tempRepo(t, { "a.txt": "x\n" });
  const r = run(["--root", path.join(dir, "a.txt")], dir);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^secret-scan-fallback: could not scan git-tracked files in /);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("run from a non-git cwd with no --root exits 2 (no scan, no stack trace), and an empty --root value is an unknown argument", (t) => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "secscan-e56-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const r = run([], plain);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^secret-scan-fallback: could not scan git-tracked files in /);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  const empty = run(["--root", ""], plain);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /unknown argument "--root"/);
});

test("the last --root wins when it is given twice", (t) => {
  const leaky = tempRepo(t, { "k.env": `K=${edKey()}\n` });
  const clean = tempRepo(t, { "a.txt": "ok\n" });
  assert.equal(run(["--root", leaky, "--root", clean], leaky).status, 0);
  assert.equal(run(["--root", clean, "--root", leaky], clean).status, 1);
});
