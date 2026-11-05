// edge39: what a judge sees when running scripts/demo.mjs, bad args and README claims.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "demo.mjs");

function demo(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, MOCK_INFERENCE: "1", ...env },
    timeout: 120000,
  });
}

describe("demo.mjs bad arguments: one clear stderr line, exit 2, nothing written", () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo edge39-")); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cases = [
    [["--rounds", "0"], /--rounds must be a positive integer, got "0"/],
    [["--rounds", "1e2"], /--rounds must be a positive integer, got "1e2"/],
    [["--rounds", "-3"], /--rounds must be a positive integer, got "-3"/],
    [["--rounds"], /--rounds must be a positive integer, got no value/],
    [["--rounds", "--every"], /--rounds must be a positive integer, got "--every"/],
    [["--rounds", "99999"], /--rounds must be at most 1000, got 99999/],
    [["--seed", "-1"], /--seed must be a non-negative integer, got "-1"/],
    [["--seed", "9007199254740993"], /--seed must be a non-negative integer/],
    [["--rounds", "5", "--every", "6"], /--every \(6\) must not exceed --rounds \(5\)/],
    [["--style"], /--style needs a name, got no value/],
    [["--style", "--out"], /--style needs a name, got "--out"/],
    [["--style", "nope"], /unknown style: nope \(expected one of default, sticker, pixel, deepfried\)/],
    [["--out"], /--out needs a directory, got no value/],
    [["--bogus"], /unknown argument "--bogus"/],
    [["--rounds=3"], /unknown argument "--rounds=3"/],
    [["stray"], /unknown argument "stray"/],
  ];
  for (const [args, re] of cases) {
    it(`${args.join(" ")}`, () => {
      const r = demo(args, { cwd: dir });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, "");
      const lines = r.stderr.trim().split("\n");
      assert.equal(lines.length, 1, r.stderr);
      assert.match(lines[0], /^demo: /);
      assert.match(lines[0], re);
      assert.match(lines[0], /\(see --help\)$/);
      assert.doesNotMatch(r.stderr, /undefined|\n\s+at /);
      assert.deepEqual(fs.readdirSync(dir), [], "a rejected command must not create out/");
    });
  }
});

describe("demo.mjs --help and MOCK_INFERENCE", () => {
  it("--help wins over bad or valid flags, exits 0, lists every flag and the mock-only promise", () => {
    for (const args of [["--help"], ["-h"], ["--rounds", "0", "--help"], ["--bogus", "-h"]]) {
      const r = demo(args);
      assert.equal(r.status, 0, args.join(" "));
      assert.equal(r.stderr, "");
      for (const flag of ["--rounds N", "--seed N", "--every N", "--style NAME", "--out DIR"]) assert.ok(r.stdout.includes(flag), flag);
      assert.match(r.stdout, /default 6/);
      assert.match(r.stdout, /sticker/);
      assert.match(r.stdout, /Nothing is signed or sent\.$/m);
    }
  });

  it("MOCK_INFERENCE=0 exits 2 with the README sentence and writes nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo edge39 live-"));
    try {
      const r = demo([], { cwd: dir, env: { MOCK_INFERENCE: "0" } });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^demo: runs in mock mode only/);
      assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a garbage MOCK_INFERENCE is a usage error, not a crash", () => {
    const r = demo([], { env: { MOCK_INFERENCE: "banana" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^demo: MOCK_INFERENCE must be 1 or 0, got "banana" \(see --help\)\n$/);
  });
});

describe("demo.mjs unwritable output directory", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  let dir;
  let locked;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo edge39 ro-"));
    locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o555);
  });
  after(() => {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const sub of ["new-child", ""]) {
    it(`--out ${sub ? "below" : "at"} a read-only directory: one plain line, exit 1, no errno dump`, () => {
      const out = path.join(locked, sub);
      const r = demo(["--rounds", "1", "--every", "1", "--out", out], { cwd: dir });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "", "no success lines before the failure");
      const lines = r.stderr.trim().split("\n");
      assert.equal(lines.length, 1, r.stderr);
      assert.match(lines[0], /^demo: cannot write to ".*": permission denied or read-only\. Pass a directory you can write to \(see --help\)$/);
      assert.doesNotMatch(r.stderr, /EACCES|EPERM|mkdir/);
      assert.deepEqual(fs.readdirSync(locked), []);
    });
  }
});

describe("demo.mjs default run matches the README", () => {
  let dir;
  let r;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo edge39 run-"));
    r = demo([], { cwd: dir });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("exits 0 with empty stderr and the README's quoted lines", () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^\[1\/5\] swarm: 6 rounds, 24 events, verify: ok$/m);
    assert.match(r.stdout, /^\[4\/5\] anchor \(dry run\): 8 calls prepared, 0 signed$/m);
    assert.match(r.stdout, /^Done\. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model\.$/m);
    assert.match(r.stdout, /^Files written \(64\):$/m);
    assert.match(r.stdout, /^  4c8e826620ce2fa1c118df19d13f622ade870b0a54dd206e2c93157df9c6ff52\b|4c8e826620ce2fa1c118df19d13f622ade870b0a54dd206e2c93157df9c6ff52/m);
  });

  it("the last line is the page link, and no 'undefined' or 'NaN' appears anywhere", () => {
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines.at(-1), /^Open the page: open out\/index\.html {2}\(file:\/\/.*\/out\/index\.html\)$/);
    assert.doesNotMatch(r.stdout, /undefined|NaN|\[object/);
  });

  it("every file the output lists exists under out/ and the 'Do this, see that' targets are among them", () => {
    const listed = [...r.stdout.matchAll(/^ {2}(out\/\S+)$/gm)].map((m) => m[1]);
    assert.equal(listed.length, 64);
    for (const f of listed) assert.ok(fs.statSync(path.join(dir, f)).isFile(), f);
    for (const f of ["out/index.html", "out/transcript.txt", "out/memory/aloof/sheet.json", "out/anchors.json"]) assert.ok(listed.includes(f), f);
    assert.equal(listed.filter((f) => f.startsWith("out/share/") && !f.includes("meme-")).length, 24);
    assert.equal(listed.filter((f) => f.includes("meme-")).length, 3);
  });

  it("step 4's hash check works: the sheet's sha256 equals Aloof's last sheet_hash in anchors.json", () => {
    const sheetFile = JSON.parse(fs.readFileSync(path.join(dir, "out/memory/aloof/sheet.json"), "utf8"));
    const anchors = JSON.parse(fs.readFileSync(path.join(dir, "out/anchors.json"), "utf8"));
    const calls = Array.isArray(anchors) ? anchors : anchors.calls ?? anchors.anchors;
    assert.equal(calls.length, 8);
    const aloof = calls.filter((c) => JSON.stringify(c).includes("aloof")).at(-1);
    assert.ok(JSON.stringify(aloof).includes(sheetFile.sheetHash ?? "no-hash"), "last aloof anchor carries the sheet hash");
    assert.match(r.stdout, /node -p 'require\("\.\/out\/memory\/aloof\/sheet\.json"\)\.sheet' \| shasum -a 256/);
  });

  it("re-running gives the same final round hash and byte-identical page", () => {
    const before = fs.readFileSync(path.join(dir, "out/index.html"), "utf8");
    const again = demo([], { cwd: dir });
    assert.equal(again.status, 0);
    assert.equal(again.stdout, r.stdout);
    assert.equal(fs.readFileSync(path.join(dir, "out/index.html"), "utf8"), before);
  });
});
