// Mint CLI: what a user sees for receiver/env/flag mistakes and for a good dry run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = (args, extraEnv = {}) => {
  const env = { ...process.env };
  delete env.NEAR_ACCOUNT_ID; delete env.NEAR_CONTRACT_ACCOUNT_ID; delete env.NEAR_NETWORK;
  return spawnSync(process.execPath, ["scripts/testnet-deploy.mjs", ...args], { cwd: ROOT, encoding: "utf8", env: { ...env, ...extraEnv } });
};
const oneErrorLine = (r, re) => {
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr.trimEnd(), re);
  assert.equal(r.stderr.trimEnd().split("\n").length, 1);
};

test("mint --receiver with no value is refused with the flag name, exit 2", () => {
  oneErrorLine(cli(["mint", "--receiver"]), /^error: --receiver needs a value, got undefined \(see --help\)$/);
});

test("mint --receiver followed by another flag does not swallow the flag", () => {
  oneErrorLine(cli(["mint", "--receiver", "--json"]), /^error: --receiver needs a value, got "--json" \(see --help\)$/);
});

test("mint --receiver with an invalid id is refused and the bad value is not echoed", () => {
  const r = cli(["mint", "--receiver", "NOT A VALID ID!!"]);
  oneErrorLine(r, /^error: --receiver is unset or not a valid NEAR account id \(value not shown\) \(see --help\)$/);
  assert.ok(!r.stderr.includes("NOT A VALID"));
});

test("a mistyped NEAR_ACCOUNT_ID is refused in a dry run too, and never printed", () => {
  const r = cli(["mint"], { NEAR_ACCOUNT_ID: "Bad Account!!" });
  oneErrorLine(r, /^error: NEAR_ACCOUNT_ID is unset or not a valid NEAR account id \(value not shown\)/);
  assert.ok(!r.stderr.includes("Bad Account"));
});

test("dry run with no env prints placeholder accounts and the receiver defaults to the owner placeholder", () => {
  const r = cli(["mint", "--count", "1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dry-run: nothing is signed or sent\./);
  assert.match(r.stdout, /owner: <NEAR_ACCOUNT_ID>   contract: <NEAR_CONTRACT_ACCOUNT_ID>/);
  assert.match(r.stdout, /\[1\/1\] mint aloof/);
  assert.doesNotMatch(r.stdout, /\[2\/1\]/);
  assert.match(r.stdout, /receiver_id":"<NEAR_ACCOUNT_ID>"/);
});

test("dry run with --receiver sends the token to that receiver, not the owner", () => {
  const r = cli(["mint", "--json", "--count", "1", "--receiver", "bob.demo.testnet"], { NEAR_ACCOUNT_ID: "alice.demo.testnet" });
  assert.equal(r.status, 0, r.stderr);
  const step = JSON.parse(r.stdout).steps[0];
  assert.equal(step.args.receiver_id, "bob.demo.testnet");
  assert.equal(step.signer, "alice.demo.testnet");
});

test("--send alone, --send with --dry-run, and a second command are refused with exit 2 and nothing on stdout", () => {
  oneErrorLine(cli(["mint", "--send"]), /^error: --send needs --i-approve .*Nothing was sent\. \(see --help\)$/);
  oneErrorLine(cli(["mint", "--send", "--i-approve", "--dry-run"]), /^error: --send and --dry-run cannot be combined \(see --help\)$/);
  oneErrorLine(cli(["mint", "deploy"]), /^error: give one command: deploy or mint \(see --help\)$/);
});

test("no command, an unknown argument and a wrong-command option each get one clear error", () => {
  oneErrorLine(cli([]), /^error: missing command: deploy or mint \(see --help\)$/);
  oneErrorLine(cli(["mint", "--frobnicate"]), /^error: unknown argument: --frobnicate \(see --help\)$/);
  oneErrorLine(cli(["mint", "--wasm", "x.wasm"]), /^error: --wasm applies to deploy only \(see --help\)$/);
});

test("NEAR_NETWORK=mainnet is refused for a dry run too", () => {
  oneErrorLine(cli(["mint"], { NEAR_NETWORK: "mainnet" }), /^error: NEAR_NETWORK must be unset or testnet; this script refuses other networks \(see --help\)$/);
});

test("--help prints usage on stdout, exits 0 and wins over otherwise invalid flags", () => {
  const r = cli(["mint", "--count", "99", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: node scripts\/testnet-deploy\.mjs <deploy\|mint>/);
  assert.equal(r.stderr, "");
});
