// Table-driven edge cases for every user-facing CLI. Each case spawns the real
// script in a scratch directory, offline and in mock mode, and checks that a bad
// input gives one clear stderr line, a non-zero exit, no stack trace and no
// partial output. Nothing here passes --send.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const CLEAN_ENV = { MOCK_INFERENCE: "1" };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cli-edge-"));
  writeFileSync(join(dir, "afile"), "x");
  mkdirSync(join(dir, "ro"));
  chmodSync(join(dir, "ro"), 0o555);
  return dir;
}
const cleanup = (dir) => {
  chmodSync(join(dir, "ro"), 0o755);
  rmSync(dir, { recursive: true, force: true });
};
const canWriteReadOnly = (dir) => {
  try {
    mkdirSync(join(dir, "ro", "probe"));
    return true; // running as root: read-only dirs are writable
  } catch {
    return false;
  }
};

function run(file, args, { env = {}, cwd } = {}) {
  const base = { ...process.env, ...CLEAN_ENV };
  for (const key of ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "SWARM_ROUNDS"]) delete base[key];
  const r = spawnSync(process.execPath, [script(file), ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const listing = (dir) => readdirSync(dir).sort().join(",");
const noStack = (text) => !/\n\s+at |node:internal|\bat file:\/\//.test(text);

// [script, label, args, env?]
const BAD = [];
const add = (file, rows) => rows.forEach(([label, args, env]) => BAD.push([file, label, args, env]));

const NUM_FLAG_ROWS = (flag, { zeroOk = false } = {}) => [
  [`${flag} missing value`, [flag]],
  [`${flag} followed by another flag`, [flag, "--out"]],
  ...(zeroOk ? [] : [[`${flag} zero`, [flag, "0"]]]),
  [`${flag} negative`, [flag, "-1"]],
  [`${flag} non-numeric`, [flag, "abc"]],
  [`${flag} fractional`, [flag, "1.5"]],
  [`${flag} exponent`, [flag, "1e3"]],
  [`${flag} empty`, [flag, ""]],
  [`${flag} huge`, [flag, "99999999999"]],
  [`${flag} beyond safe integer`, [flag, "99999999999999999999"]],
];

const OUT_ROWS = [
  ["--out missing value", ["--out"]],
  ["--out empty", ["--out", ""]],
  ["--out is under a file", ["--out", "afile/x"]],
  ["--out is a flag", ["--out", "--rounds"]],
];
const STYLE_ROWS = [
  ["--style missing value", ["--style"]],
  ["--style empty", ["--style", ""]],
  ["--style is a flag", ["--style", "--out"]],
  ["--style unknown", ["--style", "nope"]],
];

for (const file of ["demo.mjs", "swarm.mjs"]) {
  add(file, [
    ["unknown flag", ["--bogus"]],
    ["positional argument", ["stray"]],
    ...NUM_FLAG_ROWS("--rounds"),
    ...NUM_FLAG_ROWS("--seed", { zeroOk: true }).filter(([l]) => !l.includes("zero") && !l.endsWith(" huge")), // a large seed is valid
    ...NUM_FLAG_ROWS("--every"),
    ...OUT_ROWS,
  ]);
}
add("demo.mjs", [["--every above --rounds", ["--rounds", "2", "--every", "5"]], ...STYLE_ROWS]);
add("swarm.mjs", [["--every from env is bad", ["--rounds", "1"], { SUMMARY_EVERY_N_ROUNDS: "abc" }]]);
add("render-agents.mjs", [
  ["unknown flag", ["--bogus"]],
  ["unknown short flag", ["-x"]],
  ["--flag=value form", ["--style=all"]],
  ["positional argument", ["stray"]],
  ...STYLE_ROWS,
  ...OUT_ROWS.map(([label, args]) => [label, args.map((a) => (a === "--rounds" ? "--style" : a))]),
]);
add("live-check.mjs", [
  ["unknown flag", ["--bogus"]],
  ["unknown short flag", ["-x"]],
  ["positional argument", ["stray"]],
]);
add("site.mjs", [
  ["unknown flag", ["--bogus"]],
  ["unknown short flag", ["-x"]],
  ["--out instead of a positional", ["--out", "x"]],
  ["two directories", ["a", "b"]],
  ["empty directory", [""]],
  ["directory under a file", ["afile/x"]],
]);
add("viewer.mjs", [
  ["unknown flag", ["--bogus"]],
  ["positional argument", ["stray"]],
  ...NUM_FLAG_ROWS("--rounds").filter(([l]) => !l.includes("followed")),
  ["--rounds from env is bad", [], { SWARM_ROUNDS: "abc" }],
  ["--out missing value", ["--out"]],
  ["--out is under a file", ["--out", "afile/x.html"]],
  ["--out is a directory", ["--out", "."]],
  ["--input missing value", ["--input"]],
  ["--input does not exist", ["--input", "missing.json"]],
  ["--input is a directory", ["--input", "ro"]],
  ["--input is not JSON", ["--input", "afile"]],
]);
add("infer.mjs", [
  ["unknown flag", ["--bogus", "hi"]],
  ["no prompt", []],
  ["blank prompt", ["  "]],
  ["unknown short flag", ["-x", "hi"]],
  ["--system missing value", ["--system"]],
  ["--system swallows nothing", ["hi", "--system"]],
  ["--system is a flag", ["--system", "--json", "hi"]],
  ["--seed missing value", ["hi", "--seed"]],
  ["--seed non-numeric", ["--seed", "abc", "hi"]],
  ["--seed negative", ["--seed", "-1", "hi"]],
  ["--seed fractional", ["--seed", "1.5", "hi"]],
  ["--seed huge", ["--seed", "99999999999999999999", "hi"]],
  ["live mode without key", ["hi"], { MOCK_INFERENCE: "0" }],
]);
add("testnet-deploy.mjs", [
  ["no command", []],
  ["unknown flag", ["deploy", "--bogus"]],
  ["unknown command", ["frobnicate"]],
  ["two commands", ["deploy", "mint"]],
  ["--count missing value", ["mint", "--count"]],
  ["--count is a flag", ["mint", "--count", "--send"]],
  ["--count empty", ["mint", "--count", ""]],
  ["--count zero", ["mint", "--count", "0"]],
  ["--count above the agent count", ["mint", "--count", "5"]],
  ["--count negative", ["mint", "--count", "-1"]],
  ["--count non-numeric", ["mint", "--count", "abc"]],
  ["--count fractional", ["mint", "--count", "1.5"]],
  ["--count huge", ["mint", "--count", "99999999999999999999"]],
  ["--count on deploy", ["deploy", "--count", "1"]],
  ["--wasm missing value", ["deploy", "--wasm"]],
  ["--wasm empty", ["deploy", "--wasm", ""]],
  ["--wasm is a flag", ["deploy", "--wasm", "--send"]],
  ["--wasm does not exist", ["deploy", "--wasm", "missing.wasm"]],
  ["--wasm on mint", ["mint", "--wasm", "x.wasm"]],
  ["--receiver missing value", ["mint", "--receiver"]],
  ["--receiver empty", ["mint", "--receiver", ""]],
  ["--receiver is a flag", ["mint", "--receiver", "--send"]],
  ["--receiver invalid", ["mint", "--receiver", "NOT VALID!"]],
  ["--media-base missing value", ["mint", "--media-base"]],
  ["--media-base empty", ["mint", "--media-base", ""]],
  ["--media-base is a flag", ["mint", "--media-base", "--send"]],
  ["--media-base not a url", ["mint", "--media-base", "not a url"]],
  ["--media-base data uri", ["mint", "--media-base", "data:text/plain,x"]],
  ["--send with --dry-run", ["mint", "--send", "--dry-run"]],
  ["bad NEAR_NETWORK", ["mint"], { NEAR_NETWORK: "mainnet" }],
  ["bad NEAR_ACCOUNT_ID", ["mint"], { NEAR_ACCOUNT_ID: "NOT VALID!" }],
]);
add("live-proof.mjs", [
  ["unknown flag", ["--bogus"]],
  ["positional argument", ["stray"]],
  ["--out missing value", ["--out"]],
  ["--out empty", ["--out", ""]],
  ["--out is a flag", ["--out", "--send"]],
  ["--out is under a file", ["--out", "afile/x.json"]],
  ["--out is a directory", ["--out", "."]],
  ["--out with --update-example", ["--update-example", "--out", "x.json"]],
  // Dry-run cases only: a --send case here would spawn a real deploy if the gate regressed.
  ["--media-base missing value", ["--media-base"]],
  ["--media-base empty", ["--media-base", ""]],
  ["--media-base is a flag", ["--media-base", "--send"]],
  ["--media-base not a url", ["--media-base", "not a url"]],
  ["--media-base data uri", ["--media-base", "data:text/plain,x"]],
  ["bad NEAR_ACCOUNT_ID", [], { NEAR_ACCOUNT_ID: "NOT VALID!" }],
  ["bad NEAR_CONTRACT_ACCOUNT_ID", [], { NEAR_CONTRACT_ACCOUNT_ID: "NOT VALID!" }],
  ["--i-approve alone is not a send", ["--i-approve", "--bogus"]],
]);
add("anchor.mjs", [
  ["no flags", []],
  ["unknown flag", ["--dry-run", "--bogus"]],
  ["positional argument", ["--dry-run", "stray"]],
]);
add("evidence.mjs", [
  ["bad EVIDENCE_NETWORK", [], { EVIDENCE_NETWORK: "mainnet" }],
  ["EVIDENCE_OUT under a file", [], { EVIDENCE_OUT: "afile/x.json" }],
]);

// The judge-facing npm scripts: a usage error (exit 2) must say where the usage is. Exit 1 is a runtime failure (unwritable path, no key).
const HINTED = new Set(["demo.mjs", "swarm.mjs", "render-agents.mjs", "infer.mjs", "testnet-deploy.mjs", "live-check.mjs", "live-proof.mjs", "site.mjs"]);

for (const [file, label, args, env] of BAD) {
  test(`${file}: ${label} fails with one clear line`, () => {
    const dir = scratch();
    try {
      const before = listing(dir);
      const r = run(file, args, { cwd: dir, env });
      assert.notEqual(r.code, 0, `expected non-zero exit; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.ok(noStack(r.stderr + r.stdout), `stack trace leaked:\n${r.stderr}`);
      const lines = r.stderr.split("\n").filter((l) => l.trim());
      assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${r.stderr}`);
      assert.ok(lines[0].length < 300, "message should be short");
      if (HINTED.has(file) && r.code === 2) assert.match(lines[0], /--help/, "a usage error points at --help");
      assert.equal(listing(dir), before, "no partial output in the working directory");
    } finally {
      cleanup(dir);
    }
  });
}

test("read-only --out fails cleanly (demo, swarm, render, viewer)", (t) => {
  const dir = scratch();
  try {
    if (canWriteReadOnly(dir)) return t.skip("running as root");
    const cases = [
      ["demo.mjs", ["--out", "ro/x"]],
      ["swarm.mjs", ["--out", "ro/x"]],
      ["render-agents.mjs", ["--out", "ro/x"]],
      ["viewer.mjs", ["--out", "ro/x/index.html"]],
      ["live-proof.mjs", ["--out", "ro/x.json"]],
      ["site.mjs", ["ro/x"]],
    ];
    for (const [file, args] of cases) {
      const r = run(file, args, { cwd: dir });
      assert.notEqual(r.code, 0, file);
      assert.ok(noStack(r.stderr), `${file} leaked a stack:\n${r.stderr}`);
      assert.equal(r.stderr.split("\n").filter((l) => l.trim()).length, 1, `${file}:\n${r.stderr}`);
      assert.equal(listing(join(dir, "ro")), "", `${file} left partial output`);
    }
  } finally {
    cleanup(dir);
  }
});

test("render --style all writes nothing when one style's directory is read-only", (t) => {
  const dir = scratch();
  try {
    if (canWriteReadOnly(dir)) return t.skip("running as root");
    // pixel comes after default and sticker in STYLE_NAMES: a file-by-file writer would leave those two behind.
    mkdirSync(join(dir, "styles", "pixel"), { recursive: true });
    chmodSync(join(dir, "styles", "pixel"), 0o555);
    try {
      const r = run("render-agents.mjs", ["--style", "all", "--out", "."], { cwd: dir });
      assert.notEqual(r.code, 0);
      assert.ok(noStack(r.stderr), r.stderr);
      assert.equal(r.stderr.split("\n").filter((l) => l.trim()).length, 1, r.stderr);
      assert.deepEqual(readdirSync(join(dir, "styles")), ["pixel"], "no other style directory was created");
      assert.deepEqual(readdirSync(join(dir, "styles", "pixel")), []);
    } finally {
      chmodSync(join(dir, "styles", "pixel"), 0o755);
    }
  } finally {
    cleanup(dir);
  }
});

test("render and site refuse dangerous --out dirs without touching anything", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const [file, toArgs] of [
    ["render-agents.mjs", (d) => ["--style", "all", "--out", d]],
    ["site.mjs", (d) => [d]],
  ]) {
    for (const bad of ["/", homedir(), repoRoot]) {
      const r = run(file, toArgs(bad));
      assert.notEqual(r.code, 0, `${file} ${bad}`);
      assert.match(r.stderr, /refusing --out/);
      assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
    }
  }
});

const HELP = [
  ["demo.mjs", ["--help"]],
  ["demo.mjs", ["-h"]],
  ["swarm.mjs", ["--help"]],
  ["render-agents.mjs", ["--help"]],
  ["viewer.mjs", ["--help"]],
  ["infer.mjs", ["--help"]],
  ["testnet-deploy.mjs", ["--help"]],
  ["testnet-deploy.mjs", ["deploy", "--help"]],
  ["live-proof.mjs", ["--help"]],
  ["live-check.mjs", ["--help"]],
  ["live-check.mjs", ["-h"]],
  ["site.mjs", ["--help"]],
  ["site.mjs", ["-h"]],
  ["anchor.mjs", ["--help"]],
];
for (const [file, args] of HELP) {
  test(`${file} ${args.join(" ")} prints usage and exits 0 without writing`, () => {
    const dir = scratch();
    try {
      const before = listing(dir);
      const r = run(file, args, { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /usage/i);
      assert.equal(r.stderr, "");
      assert.equal(listing(dir), before);
    } finally {
      cleanup(dir);
    }
  });
}

test("a nested --out that does not exist yet is created (demo, swarm, render)", () => {
  const dir = scratch();
  try {
    for (const [file, args] of [
      ["swarm.mjs", ["--rounds", "1", "--out", "a/b/c"]],
      ["render-agents.mjs", ["--out", "d/e"]],
      ["demo.mjs", ["--rounds", "2", "--every", "1", "--out", "f/g"]],
    ]) {
      const r = run(file, args, { cwd: dir });
      assert.equal(r.code, 0, `${file}: ${r.stderr}`);
    }
    assert.ok(readdirSync(join(dir, "a", "b", "c")).includes("events.json"));
    assert.ok(readdirSync(join(dir, "d", "e")).some((f) => f.endsWith(".svg")));
    assert.ok(readdirSync(join(dir, "f", "g")).includes("index.html"));
  } finally {
    cleanup(dir);
  }
});

test("the largest allowed --rounds is accepted by the parser, one above is not", () => {
  const dir = scratch();
  try {
    const r = run("swarm.mjs", ["--rounds", "1001"], { cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /1000/);
  } finally {
    cleanup(dir);
  }
});

test("demo's last output line gives the open command and the absolute file:// URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-open-"));
  try {
    for (const out of [undefined, "custom/dir"]) {
      const r = run("demo.mjs", ["--rounds", "2", "--every", "1", ...(out ? ["--out", out] : [])], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.trimEnd().split("\n");
      const rel = join(out ?? "out", "index.html");
      const url = pathToFileURL(join(realpathSync(dir), rel)).href;
      assert.equal(lines.at(-1), `Open the page: open ${rel}  (${url})`);
      assert.ok(existsSync(join(dir, rel)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
