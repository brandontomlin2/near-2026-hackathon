// Edge cases for the scripts/anchor.mjs CLI that the other anchor tests do not cover:
// how it is launched (symlink, other cwd, hostile environment), what it leaves behind,
// and what it does when its stdout goes away. Every child runs offline with no `near` on PATH.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./anchor.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge54-anchor-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A PATH holding only the node binary's directory would still expose a `near` there, so use an empty dir.
function run(script, args, { cwd, env = {} } = {}) {
  const emptyBin = path.join(tmp, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  return spawnSync(process.execPath, ["--import", NO_NETWORK, script, ...args], {
    encoding: "utf8",
    timeout: 30000,
    cwd,
    env: { PATH: emptyBin, HOME: tmp, ...env },
  });
}

describe("regression: running the CLI through a symlink", () => {
  // Bug: the entry-point check compared argv[1] (the symlink) to import.meta.url (the realpath),
  // so a symlinked launch did nothing: exit 0, no output, even for a bad flag.
  test("a symlinked script prints the dry-run report exactly like the real path", () => {
    const link = path.join(tmp, "linked-anchor.mjs");
    fs.symlinkSync(SCRIPT, link);
    const real = run(SCRIPT, ["--dry-run"]);
    const viaLink = run(link, ["--dry-run"]);
    assert.equal(viaLink.status, 0);
    assert.ok(viaLink.stdout.length > 0, "symlinked run printed nothing");
    assert.equal(viaLink.stdout, real.stdout);
    assert.equal(JSON.parse(viaLink.stdout).status, "dry-run");
  });

  test("a symlinked script still rejects a bad flag with exit 2, not a silent exit 0", () => {
    const link = path.join(tmp, "linked-anchor-bad.mjs");
    fs.symlinkSync(SCRIPT, link);
    const r = run(link, ["--send"]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'anchor: unknown argument "--send" (see --help)\n');
  });

  test("a symlinked directory in front of the script works too", () => {
    const dirLink = path.join(tmp, "scripts-link");
    fs.symlinkSync(path.dirname(SCRIPT), dirLink);
    const r = run(path.join(dirLink, "anchor.mjs"), ["--dry-run", "--check"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^OK: round hashes are deterministic \(3 rounds/);
  });
});

describe("launch environment", () => {
  test("the report is the same from any cwd, and nothing is written there", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
    const here = run(SCRIPT, ["--dry-run"]);
    const there = run(SCRIPT, ["--dry-run"], { cwd });
    assert.equal(there.status, 0);
    assert.equal(there.stdout, here.stdout);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  test("--help works from another cwd with no stderr", () => {
    const r = run(SCRIPT, ["--help"], { cwd: tmp });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  });

  test("keys, network and account variables in the environment never reach the output or change the network", () => {
    const env = {
      NEAR_ENV: "mainnet",
      NEAR_NETWORK: "mainnet",
      NEAR_ACCOUNT_ID: "someone.near",
      NEAR_PRIVATE_KEY: "ed25519:FAKEFAKEFAKEFAKEFAKEFAKE",
      PRIVATE_KEY: "fakeprivatekeyvalue0123456789",
      NEAR_API_KEY: "fakeapikey0123456789abcdef",
      CONTRACT_ID: "other.mainnet",
    };
    const r = run(SCRIPT, ["--dry-run"], { env });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    for (const v of Object.values(env)) assert.ok(!r.stdout.includes(v), `leaked ${v}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.anchor.network, "testnet");
    assert.equal(report.anchor.contractId, "mock-contract.testnet");
    assert.equal(report.anchor.signing, "required");
    assert.equal(report.transactionHash, null);
    assert.equal(report.status, "dry-run");
    assert.equal(run(SCRIPT, ["--dry-run"]).stdout, r.stdout);
  });

  test("stdin closed or at EOF does not matter: the CLI never reads it", () => {
    const r = spawnSync(process.execPath, ["--import", NO_NETWORK, SCRIPT, "--dry-run"], {
      encoding: "utf8",
      timeout: 30000,
      input: "",
      env: { PATH: path.join(tmp, "empty-bin"), HOME: tmp },
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).mode, "dry-run");
  });
});

describe("output shape of the dry-run payload", () => {
  test("stdout is pretty JSON with two-space indent and one trailing newline; stderr is empty", () => {
    const r = run(SCRIPT, ["--dry-run"]);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, `${JSON.stringify(JSON.parse(r.stdout), null, 2)}\n`);
  });

  test("the payload's deposit and gas are decimal strings that fit what the contract call allows", () => {
    const { anchor } = JSON.parse(run(SCRIPT, ["--dry-run"]).stdout);
    assert.match(anchor.depositYocto, /^[1-9]\d*$/);
    assert.match(anchor.gas, /^[1-9]\d*$/);
    assert.equal(anchor.methodName, "anchor_sheet");
    assert.deepEqual(Object.keys(anchor.args).sort(), ["sheet_hash", "token_id"]);
    assert.equal(anchor.firstAnchor, true);
    // The mock sheet text itself is never part of the payload, only its hash.
    assert.ok(!run(SCRIPT, ["--dry-run"]).stdout.includes("Aloof"));
  });

  test("the argument -- (what npm passes through) is refused by name, and nothing is printed", () => {
    const r = run(SCRIPT, ["--", "--dry-run"]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, 'anchor: unknown argument "--" (see --help)\n');
  });

  test("an argument with a newline or quote is reported as one escaped JSON string on one line", () => {
    const r = run(SCRIPT, ["--dry-run", 'a"b\nc']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'anchor: unknown argument "a\\"b\\nc" (see --help)\n');
  });

  test("an empty-string argument is an unknown argument, not ignored", () => {
    const r = run(SCRIPT, ["--dry-run", ""]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'anchor: unknown argument "" (see --help)\n');
  });
});

describe("stdout going away", () => {
  test("closing stdout before the report is written ends the process without a stack trace", async () => {
    const child = spawn(process.execPath, ["--import", NO_NETWORK, SCRIPT, "--dry-run"], {
      env: { PATH: path.join(tmp, "empty-bin"), HOME: tmp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    clearTimeout(timer);
    assert.doesNotMatch(stderr, /\n\s+at .*\.m?js/, `stack trace on stderr: ${stderr}`);
    assert.notEqual(code, null, "killed by the timeout");
  });
});
