import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./yield-live.mjs";
import { SNAPSHOT_MAX_AGE_HOURS } from "../src/yield/live-dry-run-preflight.mjs";

const EXAMPLE = new URL("../config/yield-vault.live.example.json", import.meta.url).pathname;
const REAL_SNAPSHOT = new URL("../src/yield/fixtures/ref-testnet-pools.json", import.meta.url).pathname;
const REAL_LIB = new URL("../contracts/yield-vault/src/lib.rs", import.meta.url).pathname;
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const SENTINEL = "vault-sentinel-7731.testnet";
const TAKEN = "2026-11-05T11:06:25Z";
const TAKEN_MS = Date.parse(TAKEN);
const H = 3_600_000;
const FRESH_NOW = () => TAKEN_MS + 26.3 * H;
const FULL_ENV = { NEAR_NETWORK: "testnet", YIELD_VAULT_ACCOUNT_ID: SENTINEL, YIELD_RUNNER_ACCOUNT_ID: "runner-sentinel-7731.testnet" };

async function run(args, io = {}) {
  const out = [];
  const errs = [];
  const code = await main(args, { log: (...a) => out.push(a.join(" ")), err: (s) => errs.push(s), env: {}, now: FRESH_NOW, ...io });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "ylive72-"));
}

function snapshotWith(mutate) {
  const doc = JSON.parse(readFileSync(REAL_SNAPSHOT, "utf8"));
  mutate(doc);
  const file = join(tmp(), "snap.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

function filledConfig() {
  const c = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  Object.assign(c, { placeholders: false, owner_id: "alice.testnet", vault_id: "vault.alice.testnet", runner_id: "run.alice.testnet", nft_contract_id: "nft.alice.testnet", token_id: "7" });
  c.public_keys = { vault: KEY, runner: KEY };
  const file = join(tmp(), "live.json");
  writeFileSync(file, JSON.stringify(c));
  return file;
}

const row = (stdout, label) => stdout.split("\n").find((l) => l.startsWith(label));

test("example config, empty env: heading right after the header, rows present, exit 0", async () => {
  const r = await run(["dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], "Yield vault live path on testnet: 36 steps, UNSIGNED (nothing is signed or sent)");
  assert.match(lines[1], /^owner /);
  assert.equal(lines[3], "PREFLIGHT (offline; nothing is read from .env, no value is printed)");
  assert.match(lines[4], /^check\s+status\s+detail$/);
  assert.match(row(r.stdout, "config placeholders filled"), /^config placeholders filled\s+no\s+\d+ unfilled/);
  for (const n of ["NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]) assert.match(row(r.stdout, `env ${n}`), /\s+not set\s/);
  assert.match(row(r.stdout, "snapshot age"), /fresh\s+26\.3 h old \(taken 2026-11-05T11:06:25Z, block 276332963\)/);
  assert.match(row(r.stdout, "prepaid gas"), /1120 TGas over 19 transactions; unused gas is refunded/);
  assert.match(row(r.stdout, "the one call it would send"), /step 19 execute_swap, runner\.owner\.yield-demo\.testnet -> vault\.owner\.yield-demo\.testnet, 280 TGas, deposit 0 yocto/);
  assert.match(r.stdout, /^not sent; text only: near contract call-function as-transaction .* execute_swap /m);
  assert.match(r.stdout, /^wasm, toolchain and on-chain reads: npm run yield:live:preflight$/m);
  assert.ok(r.stdout.indexOf("PREFLIGHT") < r.stdout.indexOf(" 1. [setup]"));
});

test("env set: rows say set and no value leaks to stdout, stderr or JSON", async () => {
  for (const args of [["dry-run"], ["dry-run", "--json"], ["dry-run", "--require-ready"]]) {
    const r = await run(args, { env: FULL_ENV });
    assert.ok(!r.stdout.includes("sentinel-7731"), `${args} stdout leaks`);
    assert.ok(!r.stderr.includes("sentinel-7731"), `${args} stderr leaks`);
    if (!args.includes("--json")) for (const n of ["NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]) assert.match(row(r.stdout, `env ${n}`), /\sset\s/);
  }
  const j = JSON.parse((await run(["dry-run", "--json"], { env: FULL_ENV })).stdout);
  assert.deepEqual(j.preflight.env, { NEAR_NETWORK: true, YIELD_VAULT_ACCOUNT_ID: true, YIELD_RUNNER_ACCOUNT_ID: true });
});

test("empty-string and inherited env values do not count as set", async () => {
  const env = Object.create({ NEAR_NETWORK: "testnet" });
  env.YIELD_VAULT_ACCOUNT_ID = "";
  const j = JSON.parse((await run(["dry-run", "--json"], { env })).stdout);
  assert.deepEqual(j.preflight.env, { NEAR_NETWORK: false, YIELD_VAULT_ACCOUNT_ID: false, YIELD_RUNNER_ACCOUNT_ID: false });
});

test("snapshot freshness boundary at 72 h", async () => {
  assert.equal(SNAPSHOT_MAX_AGE_HOURS, 72);
  const at = async (hours) => JSON.parse((await run(["dry-run", "--json"], { now: () => TAKEN_MS + hours * H })).stdout).preflight.snapshot;
  const exactly = await at(72);
  assert.equal(exactly.stale, false);
  assert.equal(exactly.age_hours, 72);
  const over = await at(72 + 1 / 3600);
  assert.equal(over.stale, true);
  const text = await run(["dry-run"], { now: () => TAKEN_MS + 100 * H });
  assert.match(row(text.stdout, "snapshot age"), /stale\s+100\.0 h old/);
  assert.equal(text.code, 0, "stale alone does not fail without --require-ready");
});

test("JSON preflight document", async () => {
  const r = await run(["dry-run", "--json"]);
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  const p = doc.preflight;
  assert.equal(doc.unsigned, true);
  assert.equal(p.placeholders_filled, false);
  assert.deepEqual(p.snapshot, { taken_at: TAKEN, block_height: 276332963, age_hours: 26.3, stale: false });
  assert.equal(p.gas_tgas, doc.totals.gas_tgas);
  assert.equal(p.transactions, doc.totals.transactions);
  assert.deepEqual(p.swap_call, { step: 19, signer_id: doc.runner_id, receiver_id: doc.vault_id, method_name: "execute_swap", gas_tgas: "280", deposit_yocto: "0" });
  assert.equal(doc.transactions[18].actions[0].method_name, "execute_swap");
  assert.deepEqual(p.missing_for_live, ["config placeholders", "NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]);
  const keys = [];
  JSON.stringify(p, (k, v) => (keys.push(k), v));
  assert.ok(!keys.includes("signed") && !keys.includes("sent"));
});

test("missing snapshot fixture: exit 3, clear message, nothing on stdout", async () => {
  const r = await run(["dry-run"], { snapshotPath: join(tmp(), "nope.json") });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^yield-live: prerequisite missing: pool snapshot .*nope\.json is missing or unreadable.*npm run yield:snapshot/);
  const j = await run(["dry-run", "--json"], { snapshotPath: join(tmp(), "nope.json") });
  assert.equal(j.code, 3);
  assert.equal(j.stdout, "");
});

test("bad _taken_at: exit 3", async () => {
  for (const bad of [undefined, "yesterday", 5, "2026-13-45T99:00:00Z"]) {
    const snapshotPath = snapshotWith((d) => (bad === undefined ? delete d._taken_at : (d._taken_at = bad)));
    const r = await run(["dry-run"], { snapshotPath });
    assert.equal(r.code, 3, String(bad));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /prerequisite missing: .*no valid _taken_at/);
  }
  const garbage = join(tmp(), "g.json");
  writeFileSync(garbage, "{not json");
  assert.equal((await run(["dry-run"], { snapshotPath: garbage })).code, 3);
});

test("lib.rs missing: exit 3 with a clear message", async () => {
  const r = await run(["dry-run"], { contractSource: join(tmp(), "lib.rs") });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^yield-live: prerequisite missing: contract source .*lib\.rs is missing/);
});

test("--require-ready with gaps: exit 3, plan still printed, every item named with a hint", async () => {
  const r = await run(["dry-run", "--require-ready"], { now: () => TAKEN_MS + 100 * H });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /PREFLIGHT/);
  assert.match(r.stdout, /plan valid against/);
  assert.match(r.stderr, /^yield-live: not ready for live: config placeholders, NEAR_NETWORK, YIELD_VAULT_ACCOUNT_ID, YIELD_RUNNER_ACCOUNT_ID, fresh snapshot$/m);
  for (const item of ["config placeholders", "NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID", "fresh snapshot"]) assert.match(r.stderr, new RegExp(`^  - ${item}: .+`, "m"));
  assert.match(r.stderr, /npm run yield:snapshot/);
  const oneGap = await run(["dry-run", "--require-ready", "--config", filledConfig()], { env: { ...FULL_ENV, YIELD_RUNNER_ACCOUNT_ID: "" } });
  assert.equal(oneGap.code, 3);
  assert.match(oneGap.stderr, /not ready for live: YIELD_RUNNER_ACCOUNT_ID\n/);
});

test("--require-ready with filled config, env set and a fresh clock: exit 0", async () => {
  const r = await run(["dry-run", "--require-ready", "--config", filledConfig()], { env: FULL_ENV });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.match(row(r.stdout, "config placeholders filled"), /\syes\s+0 unfilled/);
  const j = await run(["dry-run", "--json", "--require-ready", "--config", filledConfig()], { env: FULL_ENV });
  assert.equal(j.code, 0);
  assert.deepEqual(JSON.parse(j.stdout).preflight.missing_for_live, []);
});

test("without --require-ready the gaps never change the exit code", async () => {
  assert.equal((await run(["dry-run"], { now: () => TAKEN_MS + 500 * H })).code, 0);
});

test("--require-ready on preflight is accepted (exit 3 when not ready; see yield-live.preflight-ready74.test.mjs), and a signing-looking name is not used", async () => {
  const r = await run(["preflight", "--require-ready"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /not ready for live \(--require-ready\)/);
});

test("the real default fixture paths exist (defaults stay wired)", async () => {
  const r = await run(["dry-run"], { snapshotPath: REAL_SNAPSHOT, contractSource: REAL_LIB });
  assert.equal(r.code, 0, r.stderr);
});
