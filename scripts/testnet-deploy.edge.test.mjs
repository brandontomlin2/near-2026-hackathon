// Edge cases for the testnet deploy/mint script, focused on the dry-run path
// and on env/argument errors. Nothing here touches keys, .env, near-cli-rs or
// the network: exec is injected, and the CLI test uses a stub `near` that only
// records that it was called.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENTS, parseArgs, parseCount, run, shellQuote, validateAccountId } from "./testnet-deploy.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "testnet-deploy.mjs");
const OWNER = "agent-owner.testnet";

function sink() {
  const lines = [];
  const errors = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l), text: () => lines.join("\n"), errText: () => errors.join("\n") };
}
const never = () => { throw new Error("exec must not be called in a dry run"); };

async function dry(argv, env = {}) {
  const s = sink();
  const code = await run(argv, env, { exec: never, hasNear: never, out: s.out, err: s.err });
  return { code, s };
}

test("every dry-run shape exits 0 and never calls exec or probes near", async () => {
  const shapes = [
    ["deploy"], ["mint"], ["deploy", "--dry-run"], ["mint", "--dry-run", "--count", "1"],
    ["mint", "--json"], ["deploy", "--json"], ["mint", "--receiver", "bob.testnet"],
  ];
  for (const argv of shapes) {
    for (const env of [{}, { NEAR_ACCOUNT_ID: OWNER }, { NEAR_ACCOUNT_ID: OWNER, NEAR_NETWORK: "testnet" }, { NEAR_NETWORK: "" }]) {
      const { code } = await dry(argv, env);
      assert.equal(code, 0, `${argv.join(" ")} ${JSON.stringify(env)}`);
    }
  }
});

test("dry run output says nothing is signed and never contains key material", async () => {
  const { s } = await dry(["mint"], { NEAR_ACCOUNT_ID: OWNER });
  assert.match(s.text(), /nothing is signed or sent/);
  assert.doesNotMatch(s.text(), /ed25519:|secp256k1:|private|seed phrase/i);
});

test("dry run never emits sign-with-keychain without being in the printed plan only", async () => {
  const { s } = await dry(["mint", "--json"], { NEAR_ACCOUNT_ID: OWNER });
  const plan = JSON.parse(s.text());
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.steps.length, AGENTS.length);
  assert.equal(s.errors.length, 0);
});

test("--json output is pure JSON: no banner line before it", async () => {
  const { s } = await dry(["deploy", "--json"], { NEAR_ACCOUNT_ID: OWNER });
  assert.equal(s.lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(s.lines[0]));
});

test("dry run with a mistyped NEAR_ACCOUNT_ID is a clear error that does not echo the value", async () => {
  const secret = "ed25519:SUPERSECRETKEYMATERIAL";
  for (const argv of [["mint"], ["deploy"], ["mint", "--json"]]) {
    const { code, s } = await dry(argv, { NEAR_ACCOUNT_ID: secret });
    assert.equal(code, 2);
    assert.match(s.errText(), /NEAR_ACCOUNT_ID/);
    assert.ok(!s.errText().includes("SUPERSECRET"));
    assert.ok(!s.text().includes("SUPERSECRET"));
  }
});

test("dry run with a mistyped NEAR_CONTRACT_ACCOUNT_ID or --receiver is refused without echo", async () => {
  let r = await dry(["deploy"], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: "BAD VALUE!" });
  assert.equal(r.code, 2);
  assert.match(r.s.errText(), /NEAR_CONTRACT_ACCOUNT_ID/);
  assert.ok(!r.s.errText().includes("BAD VALUE"));
  r = await dry(["mint", "--receiver", "BAD VALUE!"], { NEAR_ACCOUNT_ID: OWNER });
  assert.equal(r.code, 2);
  assert.match(r.s.errText(), /--receiver/);
});

test("--send names the missing variable when env is empty, whitespace or unset", async () => {
  for (const env of [{}, { NEAR_ACCOUNT_ID: "" }, { NEAR_ACCOUNT_ID: "   " }]) {
    const s = sink();
    const code = await run(["mint", "--send"], env, { exec: never, hasNear: never, out: s.out, err: s.err });
    assert.equal(code, 2);
    assert.match(s.errText(), /NEAR_ACCOUNT_ID is unset or not a valid NEAR account id/);
  }
});

test("--send with a valid owner but a bad contract id names NEAR_CONTRACT_ACCOUNT_ID", async () => {
  const s = sink();
  const code = await run(["deploy", "--send"], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: "Bad_Id" }, { exec: never, hasNear: never, out: s.out, err: s.err });
  assert.equal(code, 2);
  assert.match(s.errText(), /NEAR_CONTRACT_ACCOUNT_ID/);
});

test("--send and --dry-run together is a usage error even with a perfect env", async () => {
  const { code, s } = await dry(["mint", "--send", "--dry-run"], { NEAR_ACCOUNT_ID: OWNER });
  assert.equal(code, 2);
  assert.match(s.errText(), /cannot be combined/);
});

test("mainnet-looking networks are refused in dry run, case and whitespace included", async () => {
  for (const net of ["mainnet", "MAINNET", "Testnet", " testnet", "testnet ", "localnet", "near"]) {
    const { code, s } = await dry(["mint"], { NEAR_NETWORK: net, NEAR_ACCOUNT_ID: OWNER });
    assert.equal(code, 2, net);
    assert.match(s.errText(), /refuses other networks/);
  }
});

test("a mainnet-looking account id still builds only testnet commands", async () => {
  const { s } = await dry(["mint", "--json"], { NEAR_ACCOUNT_ID: "someone.near" });
  const plan = JSON.parse(s.text());
  assert.equal(plan.network, "testnet");
  for (const step of plan.steps) {
    assert.equal(step.command[step.command.indexOf("network-config") + 1], "testnet");
  }
});

test("parseCount rejects odd numeric spellings", () => {
  for (const bad of ["", " ", "0x2", "1e0", "2.0000001", "-1", "NaN", "Infinity", "five", "5"]) {
    assert.throws(() => parseCount(bad), /--count/, JSON.stringify(bad));
  }
  assert.equal(parseCount("4"), 4);
});

test("parseArgs rejects a flag with a missing value, a repeated command, and unknown input", () => {
  assert.throws(() => parseArgs(["mint", "--count"]), /needs a value/);
  assert.throws(() => parseArgs(["mint", "--receiver"]), /needs a value/);
  assert.throws(() => parseArgs(["deploy", "--wasm"]), /needs a value/);
  assert.throws(() => parseArgs(["mint", "mint"]), /one command/);
  assert.throws(() => parseArgs(["mint", "deploy"]), /one command/);
  assert.throws(() => parseArgs(["--send"]), /missing command/);
  assert.throws(() => parseArgs([]), /missing command/);
  assert.throws(() => parseArgs(["mint", "--force"]), /unknown argument/);
  assert.throws(() => parseArgs(["mint", "--SEND"]), /unknown argument/);
});

test("--help wins over otherwise invalid input and exits 0 without exec", async () => {
  const { code, s } = await dry(["--help", "--send", "--dry-run"], { NEAR_NETWORK: "mainnet" });
  assert.equal(code, 0);
  assert.match(s.text(), /^Usage:/);
});

test("validateAccountId edge cases", () => {
  for (const ok of ["ab", "a.b", "a-b_c.testnet", "0".repeat(64)]) assert.equal(validateAccountId(ok, "x"), ok);
  for (const bad of ["a", "a".repeat(65), "-a", "a-", "a..b", ".a", "a.", "A.testnet", "a b", "a\nb", "ünï.testnet", "ed25519:abc", null, undefined, 5, {}]) {
    assert.throws(() => validateAccountId(bad, "x"), /not a valid NEAR account id/, String(bad));
  }
});

test("shellQuote neutralises newlines, quotes, spaces and shell metacharacters", () => {
  for (const arg of ["a b", "a;b", "$(x)", "`x`", "a\nb", "''", "a'b'c", "*", "~", "a|b", "ü"]) {
    const q = shellQuote(arg);
    assert.ok(q.startsWith("'") && q.endsWith("'"), arg);
  }
  assert.equal(shellQuote(""), "''");
});

test("dry run with a wasm path containing spaces and quotes is quoted in the printed command", async () => {
  const { s } = await dry(["deploy", "--wasm", "/tmp/my dir/it's.wasm"], { NEAR_ACCOUNT_ID: OWNER });
  assert.ok(s.text().includes(`'/tmp/my dir/it'\\''s.wasm'`));
});

test("CLI dry run never launches a `near` binary, even when one is on PATH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-edge-"));
  try {
    const marker = path.join(dir, "near-was-called");
    const stub = path.join(dir, "near");
    writeFileSync(stub, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(stub, 0o755);
    const env = { PATH: `${dir}:${process.env.PATH}`, NEAR_ACCOUNT_ID: OWNER };
    for (const args of [["mint"], ["deploy"], ["mint", "--json"], ["mint", "--dry-run"]]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --send with a missing env exits 2 and never launches the stub `near`", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-edge-"));
  try {
    const marker = path.join(dir, "near-was-called");
    const stub = path.join(dir, "near");
    writeFileSync(stub, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(stub, 0o755);
    const r = spawnSync(process.execPath, [SCRIPT, "mint", "--send"], { env: { PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /NEAR_ACCOUNT_ID/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy --send refuses to default the contract account to the owner account", async () => {
  const s = sink();
  const code = await run(["deploy", "--send"], { NEAR_ACCOUNT_ID: OWNER }, {
    exec: never, hasNear: never, out: s.out, err: s.err,
  });
  assert.equal(code, 2);
  assert.match(s.errText(), /NEAR_CONTRACT_ACCOUNT_ID must be set explicitly/);
});

test("deploy --send with an empty NEAR_CONTRACT_ACCOUNT_ID is also refused", async () => {
  const s = sink();
  const code = await run(["deploy", "--send"], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: "" }, {
    exec: never, hasNear: never, out: s.out, err: s.err,
  });
  assert.equal(code, 2);
});

test("deploy dry run still defaults the contract account to the owner (unchanged)", async () => {
  const { code, s } = await dry(["deploy"], { NEAR_ACCOUNT_ID: OWNER });
  assert.equal(code, 0);
  assert.match(s.text(), new RegExp(`contract: ${OWNER.replace(".", "\\.")}`));
});
