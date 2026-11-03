// Behavior tests for the three remaining judge-facing entry points: anchor,
// evidence and viewer. Each case spawns the real script in a scratch directory,
// offline and in mock mode. A user mistake (unknown argument, bad value, bad
// environment value) gives exactly one stderr line of the form
// "<script>: <what went wrong> (see --help)", exit 2, no stack trace and no
// output file. --help prints usage and exits 0. The good path is unchanged.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_ROUNDS } from "../src/swarm/runner.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const DROP = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "EVIDENCE_TX_FILE", "NEAR_RPC_URL", "SWARM_ROUNDS"];

// realpath: the child's process.cwd() is the resolved path, and the scripts print it.
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-rest-")));
  writeFileSync(join(dir, "afile"), "x");
  writeFileSync(join(dir, "empty.json"), "{}");
  writeFileSync(join(dir, "txs-bad.json"), JSON.stringify(["not-a-hash"]));
  mkdirSync(join(dir, "adir"));
  return dir;
}

function run(file, args, { env = {}, cwd } = {}) {
  const base = { ...process.env, MOCK_INFERENCE: "1" };
  for (const key of DROP) delete base[key];
  const r = spawnSync(process.execPath, [script(file), ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const listing = (dir) => readdirSync(dir).sort().join(",");
const noStack = (text) => !/\n\s+at |node:internal|\bat file:\/\//.test(text);
const name = (file) => file.replace(/\.mjs$/, "");

// [script, label, args, expected stderr pattern, env?]
const USAGE_ERRORS = [
  ["anchor.mjs", "no flags", [], /--dry-run is required/],
  ["anchor.mjs", "unknown flag alone", ["--bogus"], /unknown argument "--bogus"/],
  ["anchor.mjs", "unknown flag with --dry-run", ["--dry-run", "--bogus"], /unknown argument "--bogus"/],
  ["anchor.mjs", "positional argument", ["--dry-run", "stray"], /unknown argument "stray"/],
  ["anchor.mjs", "--check without --dry-run", ["--check"], /--dry-run is required/],

  ["evidence.mjs", "unknown flag", ["--bogus"], /unknown argument "--bogus".*takes no options/],
  ["evidence.mjs", "positional argument", ["stray"], /unknown argument "stray".*takes no options/],
  ["evidence.mjs", "bad EVIDENCE_NETWORK", [], /EVIDENCE_NETWORK must be mock or testnet, got mainnet/, { EVIDENCE_NETWORK: "mainnet" }],
  ["evidence.mjs", "testnet without a contract account", [], /NEAR_CONTRACT_ACCOUNT_ID \(or NEAR_ACCOUNT_ID\) is required/, { EVIDENCE_NETWORK: "testnet" }],
  ["evidence.mjs", "testnet with a mainnet contract account", [], /NEAR_CONTRACT_ACCOUNT_ID must be a named \.testnet account/, { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.near" }],
  ["evidence.mjs", "testnet with a mainnet account", [], /mainnet/, { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "alice.near" }],
  ["evidence.mjs", "bad EVIDENCE_TX_FILE content", [], /invalid transaction hash/, { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "alice.testnet", EVIDENCE_TX_FILE: "txs-bad.json" }],
  ["evidence.mjs", "missing EVIDENCE_TX_FILE", [], /cannot read tx file/, { EVIDENCE_NETWORK: "testnet", NEAR_ACCOUNT_ID: "alice.testnet", EVIDENCE_TX_FILE: "nope.json" }],

  ["viewer.mjs", "unknown flag", ["--bogus"], /unknown argument "--bogus"/],
  ["viewer.mjs", "positional argument", ["stray"], /unknown argument "stray"/],
  ["viewer.mjs", "--rounds missing value", ["--rounds"], /--rounds needs a value/],
  ["viewer.mjs", "--rounds followed by a flag", ["--rounds", "--out"], /--rounds needs a value/],
  ["viewer.mjs", "--rounds non-numeric", ["--rounds", "abc"], /rounds must be a positive integer, got "abc"/],
  ["viewer.mjs", "--rounds zero", ["--rounds", "0"], /rounds must be a positive integer/],
  ["viewer.mjs", "--rounds negative", ["--rounds", "-1"], /rounds must be a positive integer/],
  ["viewer.mjs", "--rounds fractional", ["--rounds", "1.5"], /rounds must be a positive integer/],
  ["viewer.mjs", "--rounds too large", ["--rounds", String(MAX_ROUNDS + 1)], new RegExp(`rounds must be at most ${MAX_ROUNDS}`)],
  ["viewer.mjs", "SWARM_ROUNDS bad", [], /rounds must be a positive integer, got "abc"/, { SWARM_ROUNDS: "abc" }],
  ["viewer.mjs", "--rounds together with --input", ["--rounds", "2", "--input", "empty.json"], /--rounds cannot be combined with --input/],
  ["viewer.mjs", "--input missing value", ["--input"], /--input needs a value/],
  ["viewer.mjs", "--input does not exist", ["--input", "missing.json"], /cannot read --input missing\.json/],
  ["viewer.mjs", "--input is a directory", ["--input", "adir"], /cannot read --input adir/],
  ["viewer.mjs", "--input is not JSON", ["--input", "afile"], /--input afile is not JSON/],
  ["viewer.mjs", "--input is not a swarm result", ["--input", "empty.json"], /--input empty\.json: invalid swarm result/],
  ["viewer.mjs", "--out missing value", ["--out"], /--out needs a value/],
  ["viewer.mjs", "--out is empty", ["--out", ""], /--out must not be empty/],
  ["viewer.mjs", "--out is a directory", ["--out", "adir"], /--out adir is a directory/],
];

for (const [file, label, args, pattern, env] of USAGE_ERRORS) {
  test(`${file}: ${label} -> one "${name(file)}: ... (see --help)" line, exit 2, nothing written`, () => {
    const dir = scratch();
    try {
      const before = listing(dir);
      const r = run(file, args, { cwd: dir, env });
      assert.equal(r.code, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
      assert.equal(r.stdout, "", "nothing on stdout");
      assert.ok(noStack(r.stderr), `stack trace leaked:\n${r.stderr}`);
      const lines = r.stderr.split("\n").filter((l) => l.trim());
      assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${r.stderr}`);
      assert.match(lines[0], new RegExp(`^${name(file)}: .* \\(see --help\\)$`));
      assert.match(lines[0], pattern);
      assert.ok(lines[0].length < 300, "message should be short");
      assert.equal(listing(dir), before, "no output file in the working directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("evidence.mjs: unwritable EVIDENCE_OUT is a runtime failure: one line naming the path, exit 1, no stack", () => {
  const dir = scratch();
  try {
    const r = run("evidence.mjs", [], { cwd: dir, env: { EVIDENCE_OUT: "afile/evidence.json" } });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(noStack(r.stderr), r.stderr);
    const lines = r.stderr.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^evidence: cannot write .*afile\/evidence\.json/);
    assert.doesNotMatch(lines[0], /see --help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("viewer.mjs: unwritable --out is a runtime failure: one line naming the path, exit 1, no stack", () => {
  const dir = scratch();
  try {
    const r = run("viewer.mjs", ["--rounds", "1", "--out", "afile/index.html"], { cwd: dir });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(noStack(r.stderr), r.stderr);
    const lines = r.stderr.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /^viewer: cannot write afile\/index\.html/);
    assert.doesNotMatch(lines[0], /see --help/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const HELP = [
  ["anchor.mjs", ["--dry-run", "--check"]],
  ["evidence.mjs", ["EVIDENCE_NETWORK", "NEAR_ACCOUNT_ID", "EVIDENCE_TX_FILE", "EVIDENCE_OUT"]],
  ["viewer.mjs", ["--input", "--rounds", "--out", "--force", "SWARM_ROUNDS"]],
];
for (const [file, mentions] of HELP) {
  for (const flag of ["--help", "-h"]) {
    test(`${file} ${flag} prints usage naming every option, exits 0, writes nothing`, () => {
      const dir = scratch();
      try {
        const before = listing(dir);
        const r = run(file, [flag], { cwd: dir });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stderr, "");
        assert.match(r.stdout, /usage/i);
        for (const m of mentions) assert.ok(r.stdout.includes(m), `help must mention ${m}:\n${r.stdout}`);
        assert.equal(listing(dir), before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  test(`${file}: --help wins over other arguments`, () => {
    const dir = scratch();
    try {
      const r = run(file, ["--bogus", "--help"], { cwd: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
      assert.match(r.stdout, /usage/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("good path is unchanged: anchor --dry-run --check prints the OK line then the JSON payload", () => {
  const dir = scratch();
  try {
    const r = run("anchor.mjs", ["--dry-run", "--check"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const [first, ...rest] = r.stdout.split("\n");
    assert.equal(first, "OK: round hashes are deterministic (3 rounds, same mock run twice)");
    const payload = JSON.parse(rest.join("\n"));
    assert.equal(payload.mode, "dry-run");
    assert.equal(rest.join("\n"), `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("good path is unchanged: evidence prints the MOCK banner and one 'wrote <abs path> (mock)' line", () => {
  const dir = scratch();
  try {
    const r = run("evidence.mjs", [], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const banner = [
      "#".repeat(64),
      "# MOCK EVIDENCE - NOT ON-CHAIN PROOF".padEnd(63) + "#",
      "# dry-run only: nothing signed, nothing sent, no chain queried".padEnd(63) + "#",
      "#".repeat(64),
    ].join("\n");
    assert.equal(r.stdout, `${banner}\nwrote ${resolve(dir, "out/evidence.json")} (mock)\n`);
    assert.equal(JSON.parse(readFileSync(join(dir, "out/evidence.json"), "utf8")).mock, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("good path is unchanged: viewer prints exactly 'wrote <abs path>'", () => {
  const dir = scratch();
  try {
    const r = run("viewer.mjs", ["--rounds", "1", "--out", "v/index.html"], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, `wrote ${resolve(dir, "v/index.html")}\n`);
    assert.match(readFileSync(join(dir, "v/index.html"), "utf8"), /<html/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Audit L-5: --out used to overwrite any existing file. Now it only replaces a page this
// tool wrote earlier (so re-running is fine); anything else needs --force.
test("viewer.mjs: --out that holds someone else's file is refused with exit 2 and left untouched; --force replaces it; own output is replaced freely", () => {
  const dir = scratch();
  try {
    const target = join(dir, "afile");
    const refused = run("viewer.mjs", ["--rounds", "1", "--out", "afile"], { cwd: dir });
    assert.equal(refused.code, 2, refused.stderr);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /^viewer: --out afile exists and is not a page this tool wrote; pass --force to replace it \(see --help\)\n$/);
    assert.equal(readFileSync(target, "utf8"), "x", "the foreign file is untouched");

    const forced = run("viewer.mjs", ["--rounds", "1", "--out", "afile", "--force"], { cwd: dir });
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(forced.stdout, `wrote ${target}\n`);
    const page = readFileSync(target, "utf8");
    assert.match(page, /<title>Swarm viewer<\/title>/);

    // The page is now ours: a plain re-run overwrites it without --force.
    const again = run("viewer.mjs", ["--rounds", "2", "--out", "afile"], { cwd: dir });
    assert.equal(again.code, 0, again.stderr);
    assert.notEqual(readFileSync(target, "utf8"), page, "the page was rewritten with two rounds");

    // A file that merely mentions the title in the middle is not ours.
    writeFileSync(target, `notes\n<title>Swarm viewer</title>\n`);
    const notOurs = run("viewer.mjs", ["--rounds", "1", "--out", "afile"], { cwd: dir });
    assert.equal(notOurs.code, 2, notOurs.stderr);
    assert.equal(readFileSync(target, "utf8"), `notes\n<title>Swarm viewer</title>\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
