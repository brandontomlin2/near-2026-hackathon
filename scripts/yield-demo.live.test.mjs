// `npm run yield:demo` is the one judge-facing command. These tests pin its dry-run default and its
// live-path gates: the demo never signs or sends, whatever the config and env say. Every run is a
// child process with cwd in a temp dir and a PATH whose `near` is a recorder that fails the test
// if it is ever started. No test touches the network or a key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ARM_ENV, DEFAULT_LIVE_CONFIG, isRefusedDemoFlag, liveStatus } from "../src/yield/demo-live.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-demo.mjs", import.meta.url));
const YIELD = fileURLToPath(new URL("./yield.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../config/yield-vault.live.example.json", import.meta.url));
const TIMEOUT_MS = 60_000;

// Two dummy 32-byte ed25519 PUBLIC keys (bytes all 7 and all 9). Not anyone's key; no private half exists here.
const PK_VAULT = "ed25519:US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";
const PK_RUNNER = "ed25519:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN";

/** The example config with every placeholder filled in, as the runbook asks. */
function filledConfig(overrides = {}) {
  const c = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  return {
    ...c,
    placeholders: false,
    owner_id: "owner-e2e.testnet",
    vault_id: "vault.owner-e2e.testnet",
    runner_id: "runner.owner-e2e.testnet",
    nft_contract_id: "personality-nft.owner-e2e.testnet",
    token_id: "1",
    public_keys: { vault: PK_VAULT, runner: PK_RUNNER },
    ...overrides,
  };
}

let work;
let bin;
let nearLog;
before(() => {
  work = mkdtempSync(join(tmpdir(), "yield-demo-live-test-"));
  bin = join(work, "bin");
  nearLog = join(work, "near-was-called");
  mkdirSync(bin);
  // A `near` that records it was started. Any test run that reaches it fails the "near never ran" check.
  writeFileSync(join(bin, "near"), `#!/bin/sh\necho "$@" >> '${nearLog}'\nexit 0\n`);
  chmodSync(join(bin, "near"), 0o755);
});
after(() => rmSync(work, { recursive: true, force: true }));

const ARMED_ENV = { [ARM_ENV]: "1", NEAR_NETWORK: "testnet" };

/** Run yield:demo in its own cwd (so out/yield-vault.live.json is per test) with the recorder `near` first on PATH. */
function run(args, { env = {}, config } = {}) {
  const cwd = mkdtempSync(join(work, "cwd-"));
  if (config !== undefined) {
    mkdirSync(join(cwd, "out"), { recursive: true });
    writeFileSync(join(cwd, DEFAULT_LIVE_CONFIG), typeof config === "string" ? config : JSON.stringify(config, null, 2));
  }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.equal(r.error, undefined, `spawn failed or timed out: ${r.error?.message}`);
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, cwd };
}

const planOf = (cwd) => JSON.parse(readFileSync(join(cwd, "out/yield-demo/plan.json"), "utf8"));
const callsOf = (cwd) => JSON.parse(readFileSync(join(cwd, "out/yield-demo/calls.json"), "utf8"));

function assertNothingSigned(r) {
  assert.equal(existsSync(nearLog), false, "near was started");
  const plan = planOf(r.cwd);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.signed, false);
  assert.equal(plan.sent, false);
  assert.equal(plan.calls_signed, 0);
  assert.equal(plan.calls_sent, 0);
  for (const c of callsOf(r.cwd).calls) {
    assert.equal(c.signed, false);
    assert.equal(c.sent, false);
  }
  assert.match(r.stdout, /^YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent$/m);
  assert.match(r.stdout, /^1 unsigned execute_swap call planned, 0 signed, 0 sent$/m);
}

describe("yield:demo dry-run default (fresh clone: no live config, no env)", () => {
  it("plans one call, signs and sends nothing, and says the live path is not configured", () => {
    const r = run([]);
    assert.equal(r.code, 0, r.stderr);
    assertNothingSigned(r);
    assert.match(r.stdout, /^live path: not configured \(no out\/yield-vault\.live\.json\)\. Default is this dry run; see docs\/yield-vault-live-runbook\.md\.$/m);
    assert.doesNotMatch(r.stdout, /ARMED/);
  });

  it("ignores the arming env when there is no config", () => {
    const r = run([], { env: ARMED_ENV });
    assert.equal(r.code, 0, r.stderr);
    assertNothingSigned(r);
    assert.match(r.stdout, /^live path: not configured/m);
  });
});

describe("yield:demo live-path status", () => {
  it("the tracked example config (placeholders true) is not armed, even with the env armed", () => {
    const r = run([], { env: ARMED_ENV, config: readFileSync(EXAMPLE, "utf8") });
    assert.equal(r.code, 0, r.stderr);
    assertNothingSigned(r);
    assert.match(r.stdout, /^live path: not armed \(out\/yield-vault\.live\.json: placeholder not filled in: placeholders \(flag is true\)/m);
  });

  it("a filled config without placeholders:false is not armed", () => {
    const c = filledConfig();
    delete c.placeholders;
    const r = run([], { env: ARMED_ENV, config: c });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^live path: not armed \(out\/yield-vault\.live\.json: "placeholders" must be false\)/m);
  });

  it("a valid config is not armed without YIELD_LIVE_ARMED=1 and NEAR_NETWORK=testnet", () => {
    for (const [env, why] of [
      [{}, "YIELD_LIVE_ARMED=1 is not set, NEAR_NETWORK=testnet is not set"],
      [{ [ARM_ENV]: "1" }, "NEAR_NETWORK=testnet is not set"],
      [{ [ARM_ENV]: "true", NEAR_NETWORK: "testnet" }, "YIELD_LIVE_ARMED=1 is not set"],
      [{ [ARM_ENV]: " 1", NEAR_NETWORK: "testnet" }, "YIELD_LIVE_ARMED=1 is not set"],
      [{ [ARM_ENV]: "1", NEAR_NETWORK: "Testnet" }, "NEAR_NETWORK=testnet is not set"],
    ]) {
      const r = run([], { env, config: filledConfig() });
      assert.equal(r.code, 0, r.stderr);
      assertNothingSigned(r);
      assert.ok(r.stdout.includes(`live path: not armed (out/yield-vault.live.json is valid; ${why}).`), r.stdout);
    }
  });

  it("invalid JSON is reported, not thrown", () => {
    const r = run([], { env: ARMED_ENV, config: "{ not json" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^live path: not armed \(out\/yield-vault\.live\.json: the file is not valid JSON\)/m);
  });

  it("an env vault id that disagrees with the config is not armed and the value is not shown", () => {
    const r = run([], { env: { ...ARMED_ENV, YIELD_VAULT_ACCOUNT_ID: "other-vault.testnet" }, config: filledConfig() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /YIELD_VAULT_ACCOUNT_ID is set but is not the config's vault_id \(value not shown\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /other-vault/);
  });

  it("armed: prints the exact gated live commands, still signs and sends nothing, near never runs", () => {
    const r = run([], { env: ARMED_ENV, config: filledConfig() });
    assert.equal(r.code, 0, r.stderr);
    assertNothingSigned(r);
    const out = r.stdout;
    assert.match(out, /^live path: ARMED \(out\/yield-vault\.live\.json valid, placeholders false, YIELD_LIVE_ARMED=1, NEAR_NETWORK=testnet\)\. This run still signed and sent nothing\.$/m);
    assert.ok(out.includes("  1. npm run yield:live:preflight -- --config out/yield-vault.live.json --online\n"), out);
    assert.ok(out.includes("  2. npm run yield:live:dry-run -- --config out/yield-vault.live.json\n"), out);
    assert.ok(
      out.includes("  3. NEAR_NETWORK=testnet YIELD_VAULT_ACCOUNT_ID=vault.owner-e2e.testnet YIELD_RUNNER_ACCOUNT_ID=runner.owner-e2e.testnet npm run yield -- --agent chaotic --send --i-approve --vault-state out/yield-vault.state.json\n"),
      out,
    );
    assert.match(out, /The live config swaps on pool 0 \(wrap\.testnet -> rft\.tokenfactory\.testnet\)/);
    // The armed block is in the summary, before the details.
    assert.ok(out.indexOf("live path: ARMED") < out.indexOf("== details =="));
  });

  it("a --live-config path with spaces or shell metacharacters is single-quoted in the printed commands", () => {
    const cfg = join(mkdtempSync(join(work, "q-")), "my live $(x).json");
    writeFileSync(cfg, JSON.stringify(filledConfig()));
    const r = run(["--live-config", cfg], { env: ARMED_ENV });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`  2. npm run yield:live:dry-run -- --config '${cfg}'\n`), r.stdout);
  });

  it("--live-config FILE is read instead of the default; a missing explicit file is refused", () => {
    const cfg = join(work, "elsewhere.json");
    writeFileSync(cfg, JSON.stringify(filledConfig()));
    const ok = run(["--live-config", cfg], { env: ARMED_ENV });
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(ok.stdout.includes(`live path: ARMED (${cfg} valid`), ok.stdout);
    const missing = run(["--live-config", join(work, "nope.json")], { env: ARMED_ENV });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--live-config .*nope\.json does not exist or is not a file\. Nothing was signed or sent\./);
  });
});

describe("yield:demo hard refusals", () => {
  const REFUSAL = /^yield:demo: refused: yield:demo never signs or sends .* Nothing was signed or sent\.$/m;

  for (const args of [["--send"], ["--i-approve"], ["--send", "--i-approve"], ["--sign-with-keychain"], ["--live"], ["--broadcast"], ["--private-key", "x"], ["--SEND"], ["--calls", "--send", "--i-approve"], ["--help", "--send"]]) {
    it(`${args.join(" ")} exits 2 before anything is written, even fully armed`, () => {
      const r = run(args, { env: ARMED_ENV, config: filledConfig() });
      assert.equal(r.code, 2, r.stdout + r.stderr);
      assert.match(r.stderr, REFUSAL);
      assert.equal(r.stdout, "");
      assert.equal(existsSync(join(r.cwd, "out/yield-demo")), false, "files were written");
      assert.equal(existsSync(nearLog), false, "near was started");
    });
  }

  it("a config holding something that looks like a private key is refused (exit 2) and the value is not echoed", () => {
    const secret = `ed25519:${"5".repeat(88)}`;
    const r = run([], { env: ARMED_ENV, config: filledConfig({ public_keys: { vault: secret, runner: PK_RUNNER } }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refused: config field \$\.public_keys\.vault holds a key longer than a public key/);
    assert.ok(!(r.stdout + r.stderr).includes(secret));
    assert.equal(existsSync(nearLog), false);
  });

  it("a bare (unprefixed) key pasted into a non-key field is not echoed in the not-armed line", () => {
    const bare = "5".repeat(30) + "abcdefghijkmnopqrstuvwxyz";
    const r = run([], { env: ARMED_ENV, config: filledConfig({ funding: { vault_initial_near: bare, runner_initial_near: "2" } }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^live path: not armed \(out\/yield-vault\.live\.json: .*<value not shown>/m);
    assert.ok(!(r.stdout + r.stderr).includes(bare), "the pasted value was printed");
    assert.equal(existsSync(nearLog), false);
  });

  it("an explicit missing --live-config is refused in --calls and --json mode too", () => {
    for (const mode of ["--calls", "--json"]) {
      const r = run([mode, "--live-config", join(work, "nope.json")], { env: ARMED_ENV });
      assert.equal(r.code, 2, mode);
      assert.equal(r.stdout, "");
    }
  });

  it("--calls and --json print no live-path line, even armed", () => {
    for (const mode of ["--calls", "--json"]) {
      const r = run([mode], { env: ARMED_ENV, config: filledConfig() });
      assert.equal(r.code, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /live path:/);
      assert.equal(existsSync(nearLog), false);
    }
  });

  it("a config of an odd shape is reported as not armed, not a stack trace", () => {
    const r = run([], { env: ARMED_ENV, config: filledConfig({ swap: null, limits: [] }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^live path: not armed \(out\/yield-vault\.live\.json: /m);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
  });

  it("a config naming a .near (mainnet) account is refused (exit 2)", () => {
    const r = run([], { env: ARMED_ENV, config: filledConfig({ owner_id: "owner.near" }) });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /mainnet/);
  });

  it("NEAR_NETWORK=mainnet is refused", () => {
    const r = run([], { env: { [ARM_ENV]: "1", NEAR_NETWORK: "mainnet" }, config: filledConfig() });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refused: NEAR_NETWORK=mainnet/);
  });

  it("a flag VALUE containing 'sign' is not a refused flag (e.g. --snapshot design.json); any FLAG containing it is", () => {
    assert.equal(isRefusedDemoFlag("design.json"), false);
    assert.equal(isRefusedDemoFlag("--design"), true); // deliberately broad: exit 2 either way
    assert.equal(isRefusedDemoFlag("--Sign"), true);
    assert.equal(isRefusedDemoFlag("--send=yes"), true);
  });
});

describe("the live send gate the armed block points at (scripts/yield.mjs) refuses without --send --i-approve", () => {
  function runYield(args, env) {
    const r = spawnSync(process.execPath, [YIELD, ...args], {
      cwd: mkdtempSync(join(work, "yield-")),
      env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(r.error, undefined, `spawn failed or timed out: ${r.error?.message}`);
    return r;
  }
  const env = { NEAR_NETWORK: "testnet", YIELD_VAULT_ACCOUNT_ID: "vault.owner-e2e.testnet", YIELD_RUNNER_ACCOUNT_ID: "runner.owner-e2e.testnet" };

  it("--send without --i-approve exits 2 and near never runs", () => {
    const r = runYield(["--agent", "chaotic", "--send"], env);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--send needs --i-approve \(explicit human approval\)\. Nothing was sent\./);
    assert.equal(existsSync(nearLog), false);
  });

  it("--i-approve without --send is a usage error", () => {
    const r = runYield(["--agent", "chaotic", "--i-approve"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--i-approve only applies together with --send/);
  });

  it("--send --i-approve without --vault-state sends nothing (exit 1) and near never runs a send", () => {
    const r = runYield(["--agent", "chaotic", "--send", "--i-approve"], env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--send needs --vault-state FILE .* Nothing was sent\./);
    assert.equal(existsSync(nearLog), false);
  });
});

describe("liveStatus (unit)", () => {
  it("never reports armed when the file is absent, whatever the env", () => {
    const s = liveStatus({ env: ARMED_ENV, configPath: join(work, "absent.json") });
    assert.equal(s.state, "not-configured");
  });
});
