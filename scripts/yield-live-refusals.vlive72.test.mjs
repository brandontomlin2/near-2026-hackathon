// Safety net for the Nov 6 go/no-go: every live-capable yield command refuses to send unless the
// explicit opt-in flags are given, and even then nothing reaches the network unless every gate holds.
// Nothing here runs the real near CLI: spawners are recording fakes and child processes get a PATH
// whose first entry is a shim that only writes a marker file. Temp files live under os.tmpdir().

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { initialState } from "../src/yield/ledger.mjs";
import { yieldMockResponder } from "../src/yield/mock.mjs";
import { defaultVaultConfig } from "../src/yield/strategies.mjs";
import { createRpc, assertReadOnlyRequest } from "../src/yield/live-rpc.mjs";
import { assertAllowedRequest, ALLOWED_RPCS } from "./yield-snapshot.mjs";
import { main } from "./yield.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = join(ROOT, "scripts");
const YIELD = join(SCRIPTS, "yield.mjs");
const YIELD_LIVE = join(SCRIPTS, "yield-live.mjs");
const SHADE_DRY = join(SCRIPTS, "yield-shade-dry-run.mjs");
const NOW_MS = Date.UTC(2026, 10, 3);
const TIMEOUT = 20_000;

// ------------------------------------------------------------------ 1. inventory

/**
 * Every package.json script whose name starts with "yield", reviewed. A new one that is not listed
 * here fails the test, so a future live command cannot slip in unreviewed. `sends: true` means the
 * command can really send, and only behind --send --i-approve (the script itself never bakes them in).
 */
const REVIEWED_YIELD_SCRIPTS = {
  "yield": { command: "node scripts/yield.mjs", sends: true },
  "yield:snapshot": { command: "node scripts/yield-snapshot.mjs", sends: false },
  "yield:demo": { command: "node scripts/yield-demo.mjs", sends: false },
  "yield:demo:check": { command: "node scripts/yield-demo-check.mjs", sends: false },
  "yield:shade:dry-run": { command: "node scripts/yield-shade-dry-run.mjs", sends: false },
  "yield:shade:check": { command: "node scripts/yield-shade-check.mjs", sends: false },
  "yield:live:check": { command: "node scripts/yield-live-check.mjs", sends: false },
  "yield:live:dry-run": { command: "node scripts/yield-live.mjs dry-run", sends: false },
  "yield:live:preflight": { command: "node scripts/yield-live.mjs preflight", sends: false },
};

describe("package.json yield scripts inventory", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const yieldScripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith("yield"));

  test("every yield* script is classified, and no classified script vanished silently", () => {
    const actual = Object.fromEntries(yieldScripts.map(([n, c]) => [n, c]));
    const unreviewed = Object.keys(actual).filter((n) => !(n in REVIEWED_YIELD_SCRIPTS));
    assert.deepEqual(unreviewed, [], `unreviewed yield script(s) ${unreviewed.join(", ")}: classify them in REVIEWED_YIELD_SCRIPTS (does it send? is it behind --send --i-approve?)`);
    const missing = Object.keys(REVIEWED_YIELD_SCRIPTS).filter((n) => !(n in actual));
    assert.deepEqual(missing, [], `reviewed script(s) ${missing.join(", ")} no longer in package.json: update the inventory`);
    for (const [name, { command }] of Object.entries(REVIEWED_YIELD_SCRIPTS)) {
      assert.equal(actual[name], command, `${name}: command changed since review`);
    }
  });

  test("only `yield` can send, no script bakes in the opt-in flags, and no other script runs yield.mjs", () => {
    const senders = Object.entries(REVIEWED_YIELD_SCRIPTS).filter(([, v]) => v.sends).map(([n]) => n);
    assert.deepEqual(senders, ["yield"]);
    for (const [name, command] of Object.entries(pkg.scripts)) {
      assert.doesNotMatch(command, /--send|--i-approve|--broadcast|--sign|\bnear\s+(contract|tokens|account|transaction)/, `${name} bakes in a send flag`);
      if (name !== "yield") assert.doesNotMatch(command, /scripts\/yield\.mjs/, `${name} runs the only sending script`);
    }
  });

  test("every non-sending yield script targets an existing file that is not the sending script", () => {
    for (const [name, { command, sends }] of Object.entries(REVIEWED_YIELD_SCRIPTS)) {
      const m = /^node (scripts\/[\w.-]+\.mjs)( [\w:-]+)?$/.exec(command);
      assert.ok(m, `${name}: not a plain node script`);
      assert.ok(existsSync(join(ROOT, m[1])), `${name}: ${m[1]} missing`);
      if (!sends) assert.notEqual(m[1], "scripts/yield.mjs", name);
    }
  });
});

// ------------------------------------------------------------------ 2. static scan

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".mjs") && !/\.test\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).split("\\").join("/");
/** Source with line comments and block comment lines blanked, so prose cannot trigger or hide a hit. */
const code = (p) => readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const ALL = [...walk(SCRIPTS), ...walk(join(ROOT, "src"))];
const isYieldScope = (f) => /(^|\/)(yield[\w.-]*|readme-yield-lib)\.mjs$/.test(rel(f)) || rel(f).startsWith("src/yield/") || rel(f).startsWith("src/yield-optimizer/");
const YIELD_FILES = ALL.filter(isYieldScope);
const SPAWN_RE = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\(\s*([^,)]+?)\s*[,)]/g;

describe("static scan of what can start a process or reach the network", () => {
  test("the yield scope is non-trivial (the scan is not vacuous)", () => {
    assert.ok(YIELD_FILES.length >= 25, `only ${YIELD_FILES.length} yield files found`);
    assert.ok(YIELD_FILES.some((f) => rel(f) === "scripts/yield.mjs"));
    assert.ok(YIELD_FILES.some((f) => rel(f) === "src/yield/live-rpc.mjs"));
  });

  test("the process-spawning calls in yield code are exactly the reviewed set, and only yield.mjs can spawn near", () => {
    const found = {};
    for (const f of YIELD_FILES) {
      const src = code(f);
      if (!/child_process/.test(src)) continue;
      found[rel(f)] = [...src.matchAll(SPAWN_RE)].map((m) => m[2]).sort();
    }
    assert.deepEqual(found, {
      "scripts/readme-yield-lib.mjs": ['"bash"'],
      "scripts/yield-demo-check.mjs": ["process.execPath"],
      "scripts/yield-live.mjs": ['"cargo"', '"cargo"'],
      "scripts/yield-shade-check-guard.mjs": [], // names child_process only to block it
      "scripts/yield-shade-check.mjs": ["process.execPath"],
      "scripts/yield-snapshot.mjs": ['"curl"'],
      "scripts/yield.mjs": ["bin"],
    });
    // The one non-literal binary: yield.mjs's defaultSpawner(bin, ...). Every call site passes "near".
    const y = code(YIELD);
    const sites = [...y.matchAll(/\bspawner\(\s*([^,)]+?)\s*,/g)].map((m) => m[1]);
    assert.deepEqual(sites, ['"near"', '"near"']);
    // ...and it is the only yield file with a near binary at a spawn-like call site.
    const nearSpawners = YIELD_FILES.filter((f) => /\b(spawner|spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["']near/.test(code(f))).map(rel);
    assert.deepEqual(nearSpawners, ["scripts/yield.mjs"]);
  });

  test("outside the yield scope the near spawners are the known deploy tooling, none of it a yield command", () => {
    const nearCallers = ALL.filter((f) => /\b(spawner|spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["']near["']/.test(code(f))).map(rel).sort();
    assert.deepEqual(nearCallers, ["scripts/testnet-deploy.mjs", "scripts/yield.mjs"]);
  });

  test("yield code never names a broadcasting RPC method", () => {
    for (const f of YIELD_FILES) {
      assert.doesNotMatch(code(f), /broadcast_tx_async|broadcast_tx_commit|broadcast_tx|\bsend_tx\b/, `${rel(f)} names a broadcast RPC method`);
    }
  });

  test("the only network clients in yield code are the read-only RPC module and the snapshot's allowlisted curl", () => {
    const withFetch = YIELD_FILES.filter((f) => /\bfetch\b\s*\(|fetchFn\s*\(|globalThis\.fetch|node:https?|node:net|\bcurl\b/.test(code(f))).map(rel).sort();
    // yield-shade-check-guard.mjs only replaces fetch/http with throwing stubs (it is a blocker, not a client).
    assert.deepEqual(withFetch, ["scripts/yield-shade-check-guard.mjs", "scripts/yield-snapshot.mjs", "src/yield/live-rpc.mjs"]);
  });

  test("live-rpc.mjs refuses every non-query method before fetch is called (fake fetch records nothing)", async () => {
    const seen = [];
    const rpc = createRpc({ url: "https://test.rpc.fastnear.com", fetch: async (url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: "x", result: { result: [...Buffer.from("{}")] } }) };
    } });
    await rpc.view("vault.x.testnet", "get_config");
    await rpc.account("vault.x.testnet");
    assert.ok(seen.length >= 2);
    for (const body of seen) assert.equal(body.method, "query");
    for (const method of ["broadcast_tx_async", "broadcast_tx_commit", "send_tx", "tx", "block"]) {
      assert.throws(() => assertReadOnlyRequest({ method, params: { request_type: "view_account", finality: "final", account_id: "a.testnet" } }), /not a read-only RPC request/, method);
    }
    assert.throws(() => assertReadOnlyRequest({ method: "query", params: { request_type: "call_function", finality: "final", account_id: "a.testnet", method_name: "execute_swap", args_base64: "e30=", extra: "1" } }), /unexpected param/);
    assert.throws(() => assertReadOnlyRequest({ method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: "a.testnet" } }), /request_type/);
  });

  test("yield-snapshot's allowlist refuses broadcast methods, non-view contract calls and unlisted hosts", () => {
    const rpc = ALLOWED_RPCS[0];
    for (const method of ["broadcast_tx_async", "broadcast_tx_commit", "send_tx"]) {
      assert.throws(() => assertAllowedRequest(rpc, { method, params: {} }), /not allowlisted/, method);
    }
    assert.throws(() => assertAllowedRequest(rpc, { method: "query", params: { request_type: "call_function", method_name: "execute_swap" } }), /not allowlisted/);
    assert.throws(() => assertAllowedRequest("https://rpc.mainnet.near.org", { method: "block", params: {} }), /not allowlisted/);
  });
});

// ------------------------------------------------------------------ 3. yield.mjs gate matrix

const TESTNET_ENV = Object.freeze({
  NEAR_NETWORK: "testnet",
  YIELD_VAULT_ACCOUNT_ID: "vault.x.testnet",
  YIELD_RUNNER_ACCOUNT_ID: "runner.x.testnet",
});
const TMP_DIRS = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
process.on("exit", () => TMP_DIRS.forEach((d) => rmSync(d, { recursive: true, force: true })));

function vaultStateFile(overrides = {}, agent = "chaotic") {
  const doc = { config: defaultVaultConfig(agent, { runner: "runner.x.testnet" }), state: initialState(), vault_id: "vault.x.testnet", fetched_at: new Date(NOW_MS - 60_000).toISOString(), block_height: 123456, ...overrides };
  const file = join(tmp("yield-refusal-vs-"), "vault.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

/** Same stub model as yield.test.mjs: chaotic answers with the mock's modest round 2 proposal, which passes every rule. */
const chaoticModest = (request) => {
  const facts = JSON.parse(request.messages.at(-1).content);
  if (facts.agent === "chaotic" && facts.task === "propose") facts.round = 2;
  return yieldMockResponder({ ...request, messages: [{ role: "user", content: JSON.stringify(facts) }] });
};

/** main() in process: recording spawner (every call, whatever the binary), hasNear stub, fake clock, temp out dir. */
async function run(argv, env, { spawnStatus = 0, hasNear = () => true } = {}) {
  const out = tmp("yield-refusal-out-");
  assertSafeOutDir(out);
  const stdout = [];
  const stderr = [];
  const calls = [];
  const io = {
    env,
    log: (...a) => stdout.push(a.join(" ")),
    err: (s) => stderr.push(String(s)),
    spawner: (bin, args) => {
      calls.push({ bin, args });
      return spawnStatus;
    },
    now: () => NOW_MS,
    responder: chaoticModest,
  };
  if (hasNear) io.hasNear = hasNear;
  const code = await main([...argv, "--out", out], io);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}
const sendCalls = (calls) => calls.filter((c) => c.bin === "near" && c.args.includes("call-function"));
const FULL = () => ["--send", "--i-approve", "--agent", "chaotic", "--vault-state", vaultStateFile()];

describe("scripts/yield.mjs: positive control (the gate is the only thing between flags and a send)", () => {
  test("every gate satisfied: the spawner receives exactly one testnet execute_swap, signed by keychain, sent", async () => {
    const r = await run(FULL(), TESTNET_ENV);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    const [{ bin, args }] = r.calls;
    assert.equal(bin, "near");
    const at = (k) => args[args.indexOf(k) + 1];
    assert.deepEqual(args.slice(0, 3), ["contract", "call-function", "as-transaction"]);
    assert.equal(args[3], "vault.x.testnet");
    assert.equal(args[4], "execute_swap");
    assert.equal(at("sign-as"), "runner.x.testnet");
    assert.equal(at("network-config"), "testnet");
    assert.deepEqual(args.slice(-2), ["sign-with-keychain", "send"]);
    assert.equal(at("attached-deposit"), "0 NEAR");
    assert.ok(!args.some((a) => /mainnet/i.test(a)));
  });

  test("the hasNear default probes `near --version` through the spawner only after every gate passed, and sends nothing if it fails", async () => {
    const r = await run(FULL(), TESTNET_ENV, { spawnStatus: 127, hasNear: null });
    assert.equal(r.code, 1);
    assert.deepEqual(r.calls, [{ bin: "near", args: ["--version"] }]);
    assert.match(r.stderr, /near-cli-rs .* is not on PATH\. Nothing was sent\./);
    const gated = await run(["--send", "--i-approve", "--agent", "chaotic"], TESTNET_ENV, { spawnStatus: 127, hasNear: null });
    assert.equal(gated.calls.length, 0, "a failed gate never even probes near");
  });

  test("a failing near stops the run with exit 1 (no retry, no second send)", async () => {
    const r = await run(FULL(), TESTNET_ENV, { spawnStatus: 1 });
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 1);
    assert.match(r.stderr, /near exited with status 1/);
  });
});

describe("scripts/yield.mjs: every missing gate refuses and spawns nothing", () => {
  test("no --send: a dry run, exit 0, zero spawns of any binary", async () => {
    for (const argv of [[], ["--agent", "chaotic"], ["--json"], ["--agent", "chaotic", "--rounds", "3"]]) {
      const r = await run(argv, TESTNET_ENV);
      assert.equal(r.code, 0, `${argv.join(" ")}: ${r.stderr}`);
      assert.deepEqual(r.calls, [], argv.join(" "));
      assert.match(r.stdout + r.stderr, /DRY RUN, not sent|"dry_run": true/);
    }
  });

  const CASES = [
    // [name, argv builder, env, expected exit, stderr pattern]
    ["--send without --i-approve", () => ["--send", "--agent", "chaotic", "--vault-state", vaultStateFile()], TESTNET_ENV, 2, /--send needs --i-approve.*Nothing was sent\./],
    ["--i-approve without --send", () => ["--i-approve", "--agent", "chaotic"], TESTNET_ENV, 2, /--i-approve only applies together with --send/],
    ["--send --i-approve without --agent", () => ["--send", "--i-approve", "--vault-state", vaultStateFile()], TESTNET_ENV, 2, /--send needs --agent.*Nothing was sent\./],
    ["no NEAR_NETWORK", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: undefined }, 1, /NEAR_NETWORK=testnet set explicitly.*Nothing was sent\./],
    ["NEAR_NETWORK empty", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: "" }, 1, /NEAR_NETWORK=testnet set explicitly.*Nothing was sent\./],
    ["NEAR_NETWORK=Testnet (not exact)", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: "Testnet" }, 1, /NEAR_NETWORK=testnet set explicitly/],
    ["NEAR_NETWORK=mainnet", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: "mainnet" }, 1, /refused: NEAR_NETWORK=mainnet/],
    ["NEAR_NETWORK= MAINNET with spaces", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: " MAINNET " }, 1, /refused: NEAR_NETWORK=mainnet/],
    ["NEAR_NETWORK=localnet", () => FULL(), { ...TESTNET_ENV, NEAR_NETWORK: "localnet" }, 1, /NEAR_NETWORK=testnet set explicitly/],
    ["vault id missing", () => FULL(), { ...TESTNET_ENV, YIELD_VAULT_ACCOUNT_ID: undefined }, 1, /YIELD_VAULT_ACCOUNT_ID.*Nothing was sent\./],
    ["runner id missing", () => FULL(), { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: undefined }, 1, /YIELD_RUNNER_ACCOUNT_ID.*Nothing was sent\./],
    ["vault id is an implicit/unnamed account", () => FULL(), { ...TESTNET_ENV, YIELD_VAULT_ACCOUNT_ID: "a".repeat(64) }, 1, /YIELD_VAULT_ACCOUNT_ID.*Nothing was sent\./],
    ["vault id under .near", () => FULL(), { ...TESTNET_ENV, YIELD_VAULT_ACCOUNT_ID: "vault.x.near" }, 1, /YIELD_VAULT_ACCOUNT_ID ends in \.near/],
    ["runner id under .NEAR", () => FULL(), { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: "runner.x.NEAR" }, 1, /YIELD_RUNNER_ACCOUNT_ID ends in \.near/],
    ["vault and runner are the same account", () => FULL(), { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: "vault.x.testnet" }, 1, /different accounts.*Nothing was sent\./],
    ["missing --vault-state", () => ["--send", "--i-approve", "--agent", "chaotic"], TESTNET_ENV, 1, /--send needs --vault-state FILE.*Nothing was sent\./],
    ["unreadable --vault-state", () => ["--send", "--i-approve", "--agent", "chaotic", "--vault-state", join(tmp("yield-refusal-none-"), "absent.json")], TESTNET_ENV, 1, /cannot read --vault-state.*Nothing was sent\./],
    ["--vault-state for another vault", () => ["--send", "--i-approve", "--agent", "chaotic", "--vault-state", vaultStateFile({ vault_id: "other.x.testnet" })], TESTNET_ENV, 1, /not the target vault.*Nothing was sent\./],
    ["--vault-state for another agent", () => ["--send", "--i-approve", "--agent", "skeptic", "--vault-state", vaultStateFile()], TESTNET_ENV, 1, /is not --agent skeptic.*Nothing was sent\./],
    ["stale --vault-state", () => ["--send", "--i-approve", "--agent", "chaotic", "--vault-state", vaultStateFile({ fetched_at: new Date(NOW_MS - 11 * 60_000).toISOString() })], TESTNET_ENV, 1, /stale.*Nothing was sent\./],
    ["--rounds 2 with --send", () => [...FULL(), "--rounds", "2"], TESTNET_ENV, 2, /--rounds greater than 1 cannot be combined with --send/],
    ["--rounds 50 with --send", () => [...FULL(), "--rounds", "50"], TESTNET_ENV, 2, /--rounds greater than 1 cannot be combined with --send/],
    ["unknown agent", () => ["--send", "--i-approve", "--agent", "nobody", "--vault-state", vaultStateFile()], TESTNET_ENV, 2, /unknown agent/],
    ["--vault-state without --send", () => ["--vault-state", vaultStateFile()], TESTNET_ENV, 2, /only applies together with --send/],
  ];
  for (const [name, argv, env, exit, pattern] of CASES) {
    test(`${name}: exit ${exit}, no near call, stdout carries no send`, async () => {
      const r = await run(argv(), env);
      assert.equal(r.code, exit, r.stderr);
      assert.deepEqual(r.calls, [], "the spawner must never be reached");
      assert.deepEqual(sendCalls(r.calls), []);
      assert.match(r.stderr, pattern);
      assert.doesNotMatch(r.stdout, /SENDING to testnet/);
    });
  }

  test("a mainnet env refuses even a dry run (before any other work), and never prints account ids from the env", async () => {
    for (const env of [{ NEAR_NETWORK: "mainnet" }, { YIELD_VAULT_ACCOUNT_ID: "secretvault.near" }, { YIELD_RUNNER_ACCOUNT_ID: "secretrunner.near" }]) {
      const r = await run([], env);
      assert.equal(r.code, 1);
      assert.deepEqual(r.calls, []);
      assert.equal(r.stdout, "");
    }
    const noEcho = await run(FULL(), { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: "vault.x.testnet" });
    assert.doesNotMatch(noEcho.stderr, /vault\.x\.testnet/, "a same-account refusal does not echo the id value");
  });

  test("leave-one-out: dropping any single gate from the working send makes the previously sent call disappear", async () => {
    const full = await run(FULL(), TESTNET_ENV);
    assert.equal(full.calls.length, 1, "control");
    const dropFlag = (flag, hasValue) => {
      const a = FULL();
      const i = a.indexOf(flag);
      a.splice(i, hasValue ? 2 : 1);
      return a;
    };
    const variants = [
      ["--send", dropFlag("--send"), TESTNET_ENV],
      ["--i-approve", dropFlag("--i-approve"), TESTNET_ENV],
      ["--agent", dropFlag("--agent", true), TESTNET_ENV],
      ["--vault-state", dropFlag("--vault-state", true), TESTNET_ENV],
      ["NEAR_NETWORK", FULL(), { ...TESTNET_ENV, NEAR_NETWORK: undefined }],
      ["YIELD_VAULT_ACCOUNT_ID", FULL(), { ...TESTNET_ENV, YIELD_VAULT_ACCOUNT_ID: undefined }],
      ["YIELD_RUNNER_ACCOUNT_ID", FULL(), { ...TESTNET_ENV, YIELD_RUNNER_ACCOUNT_ID: undefined }],
    ];
    for (const [gate, argv, env] of variants) {
      const r = await run(argv, env);
      assert.notEqual(r.code, 0, gate);
      assert.deepEqual(r.calls, [], gate);
    }
  });
});

// ------------------------------------------------------------------ 4. child-process refusals

/** A temp dir whose `near` (and look-alike) shims only append to a marker file. Never the real CLI. */
function shimEnv(extra = {}) {
  const dir = tmp("yield-refusal-shim-");
  const marker = join(dir, "NEAR_WAS_CALLED");
  for (const name of ["near", "near-cli", "near-cli-rs", "curl", "cargo"]) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 97\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const home = tmp("yield-refusal-home-");
  const env = { PATH: `${dir}${delimiter}${process.env.PATH}`, HOME: home, ...extra };
  return { env, marker };
}
function child(script, args, extraEnv = {}) {
  const { env, marker } = shimEnv(extraEnv);
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: TIMEOUT, env, cwd: tmp("yield-refusal-cwd-") });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, marker, called: existsSync(marker), signal: r.signal, error: r.error };
}

describe("the shim itself works (so an absent marker means something)", () => {
  test("running `near` through the shim PATH writes the marker", () => {
    const { env, marker } = shimEnv();
    const r = spawnSync("near", ["--version"], { env, timeout: TIMEOUT, encoding: "utf8" });
    assert.equal(r.status, 97);
    assert.match(readFileSync(marker, "utf8"), /^near --version$/m);
  });
});

describe("scripts/yield-live.mjs refuses signing and sending flags with exit 2", () => {
  const FLAGS = [
    "--send", "--sign", "--i-approve", "--sign-with-keychain", "--sign-with-plaintext-private-key", "--private-key", "--seed-phrase",
    "--live", "--broadcast",
    "--SEND", "--I-Approve", "--Live", "--BROADCAST", "--Sign-With-Ledger", "--PRIVATE-KEY", "--sign-transaction", "--my-private-thing", "--designated",
    "--send=1", "--send=true", "--SIGN=yes", "--i-approve=yes", "--live=1", "--broadcast=1", "--private-key=ed25519:AAAA", "--seed-phrase=one two three", "--sign-with-keychain=1",
  ];
  for (const sub of ["dry-run", "preflight"]) {
    for (const flag of FLAGS) {
      test(`${sub} ${flag}`, () => {
        const r = child(YIELD_LIVE, [sub, flag]);
        assert.equal(r.error, undefined);
        assert.equal(r.code, 2, r.stderr);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /never signs or sends/);
        assert.equal(r.called, false, "near (or any shim) was invoked");
      });
    }
  }
  test("a refused flag after other valid flags, or before the subcommand, is still refused", () => {
    for (const args of [["dry-run", "--json", "--send"], ["--live", "dry-run"], ["preflight", "--online", "--i-approve"], ["dry-run", "--rpc", "https://test.rpc.fastnear.com", "--broadcast"]]) {
      const r = child(YIELD_LIVE, args);
      assert.equal(r.code, 2, args.join(" "));
      assert.equal(r.stdout, "", args.join(" "));
      assert.equal(r.called, false);
    }
  });
  test("NEAR_NETWORK=mainnet and .near ids are refused with exit 2", () => {
    for (const env of [{ NEAR_NETWORK: "mainnet" }, { NEAR_NETWORK: " Mainnet" }, { YIELD_VAULT_ACCOUNT_ID: "vault.near" }, { YIELD_RUNNER_ACCOUNT_ID: "runner.NEAR" }]) {
      for (const sub of ["dry-run", "preflight"]) {
        const r = child(YIELD_LIVE, [sub], env);
        assert.equal(r.code, 2, `${sub} ${JSON.stringify(env)}: ${r.stderr}`);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, /refused/);
        assert.equal(r.called, false);
      }
    }
  });
  test("a legitimate offline dry-run never touches near either (control: it runs, the marker stays absent)", () => {
    const r = child(YIELD_LIVE, ["dry-run", "--json"]);
    assert.ok([0, 1].includes(r.code), r.stderr);
    assert.ok(r.stdout.length > 0);
    assert.equal(r.called, false);
    assert.equal(JSON.parse(r.stdout).unsigned, true);
  });
});

describe("scripts/yield-shade-dry-run.mjs refuses signing, sending and mainnet", () => {
  for (const flag of ["--sign", "--send", "--broadcast", "--i-approve", "--mainnet", "--send=1", "--sign=1", "--broadcast=1", "--i-approve=1", "--mainnet=1"]) {
    test(`${flag}: exit 1, empty stdout, near never called`, () => {
      const r = child(SHADE_DRY, [flag]);
      assert.equal(r.code, 1, r.stderr);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /refused/);
      assert.equal(r.called, false);
    });
  }
  test("the refused flag wins when mixed with valid ones", () => {
    for (const args of [["--json", "--send"], ["--network", "testnet", "--sign"], ["--path", "p", "--i-approve"]]) {
      const r = child(SHADE_DRY, args);
      assert.equal(r.code, 1, args.join(" "));
      assert.equal(r.stdout, "");
      assert.equal(r.called, false);
    }
  });
  test("uppercase variants are not recognised flags: they exit 2 (unknown argument), print nothing and call nothing", () => {
    for (const flag of ["--SEND", "--Sign", "--I-APPROVE", "--MAINNET", "--BROADCAST"]) {
      const r = child(SHADE_DRY, [flag]);
      assert.equal(r.code, 2, flag);
      assert.equal(r.stdout, "", flag);
      assert.equal(r.called, false);
    }
  });
  test("other signing-looking flags are unknown arguments (exit 2), never accepted", () => {
    for (const flag of ["--private-key", "--seed-phrase=x", "--sign-with-keychain", "--live", "--rpc=https://x.test"]) {
      const r = child(SHADE_DRY, [flag]);
      assert.equal(r.code, 2, flag);
      assert.equal(r.stdout, "", flag);
      assert.equal(r.called, false);
    }
  });
  test("non-testnet --network and mainnet env/.near ids are refused with exit 1", () => {
    for (const [args, env] of [
      [["--network", "mainnet"], {}], [["--network=mainnet"], {}], [["--network", "localnet"], {}],
      [[], { NEAR_NETWORK: "mainnet" }], [[], { NEAR_NETWORK: "MAINNET" }],
      [[], { YIELD_VAULT_ACCOUNT_ID: "v.near" }], [[], { YIELD_RUNNER_ACCOUNT_ID: "r.near" }],
      [["--agent-contract=agent.near"], {}],
    ]) {
      const r = child(SHADE_DRY, args, env);
      assert.equal(r.code, 1, `${args.join(" ")} ${JSON.stringify(env)}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /refused/);
      assert.equal(r.called, false);
    }
  });
  test("control: the plain dry run succeeds, says it signed and sent nothing, and never calls near", () => {
    const r = child(SHADE_DRY, ["--json"]);
    assert.equal(r.code, 0, r.stderr);
    const plan = JSON.parse(r.stdout);
    assert.equal(plan.dry_run, true);
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
    assert.equal(r.called, false);
  });
});

describe("scripts/yield.mjs as a real child process: gates fail before anything spawns", () => {
  const CASES = [
    ["no flags (dry run)", [], TESTNET_ENV, 0],
    ["--send alone", ["--send"], TESTNET_ENV, 2],
    ["--i-approve alone", ["--i-approve"], TESTNET_ENV, 2],
    ["--send --i-approve without --agent", ["--send", "--i-approve"], TESTNET_ENV, 2],
    ["--send --i-approve --agent, no vault-state", ["--send", "--i-approve", "--agent", "chaotic"], TESTNET_ENV, 1],
    ["--send --i-approve --agent under mainnet env", ["--send", "--i-approve", "--agent", "chaotic"], { ...TESTNET_ENV, NEAR_NETWORK: "mainnet" }, 1],
    ["--send --i-approve --agent without NEAR_NETWORK", ["--send", "--i-approve", "--agent", "chaotic"], { ...TESTNET_ENV, NEAR_NETWORK: undefined }, 1],
  ];
  for (const [name, args, env, exit] of CASES) {
    test(`${name}: exit ${exit}, near shim never called`, () => {
      const cleanEnv = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
      const out = tmp("yield-refusal-childout-");
      const r = child(YIELD, [...args, "--out", out], cleanEnv);
      assert.equal(r.code, exit, r.stderr);
      assert.equal(r.called, false);
      if (exit !== 0) assert.doesNotMatch(r.stdout, /SENDING to testnet/);
    });
  }
});
