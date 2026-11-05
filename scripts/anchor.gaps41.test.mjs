// Edge-case behaviour of scripts/anchor.mjs and the sheet hash it prints.
// The CLI takes no sheet file or JSON input: its only inputs are flags, so the
// "bad input" cases here are flags and the sheet text given to hashSheet.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { prepareAnchor } from "../src/anchor/anchor.mjs";
import { HashError, hashSheet, normalizeSheet } from "../src/anchor/hash.mjs";
import { main, mockReport, parseArgs } from "./anchor.mjs";

const SCRIPT = fileURLToPath(new URL("./anchor.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));
const cli = (args) =>
  spawnSync(process.execPath, ["--import", NO_NETWORK, SCRIPT, ...args], { encoding: "utf8", timeout: 60000 });

const BAD_FLAG_CASES = [
  ["--dry-run=true"],
  ["--dry-run", "--check=1"],
  ["--DRY-RUN"],
  ["-dry-run"],
  ["dry-run"],
  ["--dry-run", "extra"],
  ["--dry-run", "--send"],
  ["--dry-run", "--i-approve"],
  ["--dry-run", " "],
];

for (const args of BAD_FLAG_CASES) {
  test(`process: ${JSON.stringify(args)} exits 2 with one stderr line naming the argument and (see --help), nothing on stdout`, () => {
    const r = cli(args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^anchor: unknown argument ".*" \(see --help\)\n$/);
  });
}

test("process: no flags and only --check both say --dry-run is required and exit 2 (README text)", () => {
  for (const args of [[], ["--check"]]) {
    const r = cli(args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "anchor: --dry-run is required; this CLI never signs (see --help)\n");
  }
});

test("process: --help and -h exit 0 even alongside bad flags, --dry-run or --check; usage on stdout only", () => {
  const ref = cli(["--help"]);
  assert.equal(ref.status, 0);
  assert.equal(ref.stderr, "");
  assert.match(ref.stdout, /^usage: npm run anchor -- --dry-run \[--check\]/);
  for (const args of [["-h"], ["--help", "--bogus"], ["--bogus", "-h"], ["--dry-run", "--check", "--help"], ["--check", "-h"]]) {
    const r = cli(args);
    assert.equal(r.status, 0, JSON.stringify(args));
    assert.equal(r.stderr, "", JSON.stringify(args));
    assert.equal(r.stdout, ref.stdout, JSON.stringify(args));
  }
});

test("process: the usage text documents exactly the flags the parser accepts", () => {
  const { stdout } = cli(["--help"]);
  assert.match(stdout, /--dry-run\s+required/);
  assert.match(stdout, /--check\s+build the mock run twice/);
  assert.match(stdout, /never signs/);
});

test("process: duplicate flags are accepted and equal the single-flag output", () => {
  const once = cli(["--dry-run", "--check"]);
  const twice = cli(["--dry-run", "--dry-run", "--check", "--check"]);
  assert.equal(once.status, 0);
  assert.equal(twice.status, 0);
  assert.equal(twice.stdout, once.stdout);
});

test("process: --check prints the OK line first, then JSON that parses and matches plain --dry-run", () => {
  const checked = cli(["--dry-run", "--check"]);
  const plain = cli(["--dry-run"]);
  assert.equal(checked.status, 0);
  assert.equal(checked.stderr, "");
  const [first, ...rest] = checked.stdout.split("\n");
  assert.equal(first, "OK: round hashes are deterministic (3 rounds, same mock run twice)");
  assert.equal(rest.join("\n"), plain.stdout);
  assert.doesNotThrow(() => JSON.parse(plain.stdout));
});

test("process: output is identical across runs and carries no clock, key or path", () => {
  const a = cli(["--dry-run"]).stdout;
  const b = cli(["--dry-run"]).stdout;
  assert.equal(a, b);
  assert.doesNotMatch(a, /ed25519:|secp256k1:|\/Users\/|\d{4}-\d\d-\d\dT/);
});

test("report: the sheet hash is sha256 of the normalized mock sheet and equals the anchor arg; round hashes are 64 hex and distinct", async () => {
  const r = await mockReport();
  const sheet = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";
  assert.equal(r.sheetHash, createHash("sha256").update(sheet).digest("hex"));
  assert.equal(r.anchor.args.sheet_hash, r.sheetHash);
  assert.equal(r.anchor.sheetHash, r.sheetHash);
  assert.equal(r.status, "dry-run");
  assert.equal(r.transactionHash, null);
  assert.equal(r.anchor.signing, "required");
  assert.equal(r.anchor.network, "testnet");
  const hashes = r.roundHashes.map((x) => x.hash);
  for (const h of hashes) assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(new Set(hashes).size, hashes.length);
});

test("main: a mismatch between the two runs makes --check fail with exit 1 and no JSON", async () => {
  // Same pipeline, one call forced to differ: patch JSON.stringify for the comparison only.
  const real = JSON.stringify;
  let n = 0;
  JSON.stringify = function (v, ...rest) {
    if (v && typeof v === "object" && v.mode === "dry-run" && rest.length === 0) return `${real(v)}#${n++}`;
    return real(v, ...rest);
  };
  const out = [];
  const err = [];
  const origErr = console.error;
  console.error = (m) => err.push(m);
  let code;
  try {
    code = await main(["--dry-run", "--check"], (l) => out.push(l));
  } finally {
    JSON.stringify = real;
    console.error = origErr;
  }
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.deepEqual(err, ["FAIL: the same mock run gave different hashes"]);
});

test("parseArgs: argv is not mutated and an empty argv is a usage error", () => {
  const argv = ["--dry-run", "--check"];
  parseArgs(argv);
  assert.deepEqual(argv, ["--dry-run", "--check"]);
  assert.throws(() => parseArgs([]), /--dry-run is required/);
});

test("hashSheet: empty, whitespace-only and non-string sheets are refused with a HashError", () => {
  for (const bad of ["", " ", "\n\n", "\r\n \t\n", " "]) {
    assert.throws(() => hashSheet(bad), (e) => e instanceof HashError && e.code === "bad_sheet", JSON.stringify(bad));
  }
  for (const bad of [undefined, null, 5, {}, ["a"], Buffer.from("a")]) {
    assert.throws(() => hashSheet(bad), (e) => e instanceof HashError && e.code === "bad_sheet");
  }
});

test("hashSheet: line endings, trailing space, outer blank lines and NFC do not change the hash", () => {
  const base = hashSheet("a\nb\n");
  for (const v of ["a\r\nb\r\n", "a\rb", "a  \nb\t\n", "\n\na\nb\n\n\n", "a\nb", "  a\nb  "]) {
    assert.equal(hashSheet(v), base, JSON.stringify(v));
  }
  assert.equal(hashSheet("café\n"), hashSheet("café\n"));
});

test("hashSheet: inner blank lines, inner indentation and a changed word do change the hash", () => {
  const base = hashSheet("a\nb\n");
  for (const v of ["a\n\nb\n", "a\n b\n", "a\nc\n", "A\nb\n"]) assert.notEqual(hashSheet(v), base, JSON.stringify(v));
});

test("hashSheet: a sheet that is JSON text is hashed as text, not parsed; lone surrogates do not throw", () => {
  assert.equal(hashSheet('{"a":1}'), createHash("sha256").update('{"a":1}\n').digest("hex"));
  assert.match(hashSheet("not json {"), /^[0-9a-f]{64}$/);
  assert.match(hashSheet("x\ud800y"), /^[0-9a-f]{64}$/);
  assert.equal(normalizeSheet("x\n"), "x\n");
});

test("prepareAnchor: a hash mismatch input is refused (uppercase, short, padded sheetHash; both or neither of sheet/sheetHash)", () => {
  const ok = { contractId: "c.testnet", tokenId: "aloof", network: "testnet" };
  const h = hashSheet("a");
  for (const bad of [h.toUpperCase(), h.slice(1), ` ${h}`, `${h}\n`, "", 7]) {
    assert.throws(() => prepareAnchor({ ...ok, sheetHash: bad }), (e) => e.code === "bad_sheet", String(bad));
  }
  assert.throws(() => prepareAnchor({ ...ok }), (e) => e.code === "bad_sheet");
  assert.throws(() => prepareAnchor({ ...ok, sheet: "a", sheetHash: h }), (e) => e.code === "bad_sheet");
  assert.throws(() => prepareAnchor({ ...ok, sheet: "  \n" }), (e) => e.code === "bad_sheet");
  assert.equal(prepareAnchor({ ...ok, sheetHash: h }).args.sheet_hash, hashSheet("a\r\n"));
  assert.throws(() => prepareAnchor({ ...ok, sheet: "a", network: "mainnet" }), (e) => e.code === "network_refused");
});
