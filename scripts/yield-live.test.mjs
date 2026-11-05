import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("./yield-live.mjs", import.meta.url).pathname;
const LIB = new URL("../src/yield/live-plan.mjs", import.meta.url).pathname;
const EXAMPLE = new URL("../config/yield-vault.live.example.json", import.meta.url).pathname;
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A complete (non-placeholder) config in a temp dir; returns {file, dir, config}. */
function filledConfig(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "ylive-"));
  const c = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  Object.assign(c, { placeholders: false, owner_id: "alice.testnet", vault_id: "vault.alice.testnet", runner_id: "run.alice.testnet", nft_contract_id: "nft.alice.testnet", token_id: "7" });
  c.public_keys = { vault: KEY, runner: KEY };
  mutate(c, dir);
  const file = join(dir, "live.json");
  writeFileSync(file, JSON.stringify(c));
  return { file, dir, config: c };
}

test("dry-run --json: unsigned, ordered steps, exit 0", () => {
  const r = run(["dry-run", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.unsigned, true);
  assert.equal(doc.network, "testnet");
  assert.deepEqual(doc.problems, []);
  assert.ok(doc.warnings.length > 0, "the example's placeholders are warnings");
  const ids = doc.transactions.map((t) => t.id);
  assert.ok(ids.indexOf("deploy-init") < ids.indexOf("register-on-ref"));
  assert.ok(ids.indexOf("register-on-ref") < ids.indexOf("execute-swap"));
  assert.ok(ids.indexOf("execute-swap") < ids.indexOf("withdraw-out"));
  assert.ok(ids.indexOf("withdraw-out") < ids.indexOf("delete-vault"));
  assert.equal(doc.totals.transactions + doc.totals.views, doc.transactions.length);
  assert.match(doc.totals.deposit_yocto, /^\d+$/);
  assert.equal(doc.totals.deposit_near, "8.525");
});

test("dry-run text lists steps, totals and commands; --out writes the JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "ylive-"));
  const out = join(dir, "plan.json");
  const r = run(["dry-run", "--out", out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /UNSIGNED \(nothing is signed or sent\)/);
  assert.match(r.stdout, /^ 1\. \[setup\]/m);
  assert.match(r.stdout, /near-cli-rs \(text only\): near contract call-function as-transaction .* execute_swap/);
  assert.match(r.stdout, /totals: \d+ transactions, \d+ views, deposits 8\.525 NEAR \+ \d+ yocto \(1-yocto security deposits\), owner outflow 8\.525 NEAR \+ \d+ yocto/);
  assert.match(r.stdout, /warning: placeholder not filled in: owner_id/);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).unsigned, true);
});

test("dry-run exits 1 when the plan has problems", () => {
  const { file } = filledConfig((c) => (c.limits.max_total_near = "2"));
  const r = run(["dry-run", "--config", file]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /PLAN INVALID/);
  assert.match(r.stdout, /max_total_near/);
  const bad = filledConfig((c) => (c.vault_id = "vault.bob.testnet"));
  assert.equal(run(["dry-run", "--config", bad.file]).code, 1);
});

for (const flag of ["--send", "--sign-with-keychain", "--i-approve", "--private-key", "--live", "--broadcast"]) {
  test(`${flag} is refused with exit 2 and no plan`, () => {
    const r = run(["dry-run", flag]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refused: this tool never signs or sends/);
    assert.equal(r.stdout, "");
  });
}

test("refusal comes before the config is read, and also for arguments containing sign or private", () => {
  const r = run(["dry-run", "--config", "/nonexistent/design.json"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /refused/);
  assert.equal(run(["preflight", "--my-private-thing"]).code, 2);
});

test("unknown flags and commands exit 2", () => {
  assert.equal(run(["dry-run", "--frobnicate"]).code, 2);
  assert.equal(run(["bogus"]).code, 2);
  assert.equal(run([]).code, 2);
  assert.equal(run(["dry-run", "--build"]).code, 2, "--build is preflight only");
});

test("NEAR_NETWORK=mainnet is refused", () => {
  for (const cmd of ["dry-run", "preflight"]) {
    const r = run([cmd], { NEAR_NETWORK: "mainnet" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refused: NEAR_NETWORK=mainnet/);
    assert.equal(r.stdout, "");
  }
});

test("a .near id or a key-looking field in the config is refused with exit 2", () => {
  const near = filledConfig((c) => (c.owner_id = "alice.near"));
  const r = run(["dry-run", "--config", near.file]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\.near/);
  assert.equal(r.stdout, "");
  const key = filledConfig((c) => (c.public_keys.vault = `ed25519:${"1".repeat(64)}`));
  const r2 = run(["preflight", "--config", key.file]);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /private key/);
  assert.equal(r2.stdout, "");
});

test("--help for both commands exits 0 and documents exit codes", () => {
  for (const args of [["--help"], ["dry-run", "--help"], ["preflight", "-h"]]) {
    const r = run(args);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Exit 0/);
    assert.match(r.stdout, /preflight/);
  }
});

test("preflight on the example: placeholders MISSING, READY FOR LIVE: no", () => {
  const r = run(["preflight"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^MISSING config complete \(no placeholders\)/m);
  assert.match(r.stdout, /^PASS\s+plan valid against lib\.rs/m);
  assert.match(r.stdout, /^MANUAL\s+keys for owner/m);
  assert.match(r.stdout, /Missing for live:/);
  assert.match(r.stdout, /READY FOR LIVE: no/);
});

test("preflight reports size and sha256 of a present wasm, and is READY when all is complete", () => {
  const { file, dir } = filledConfig();
  const wasm = join(dir, "fake.wasm");
  const bytes = Buffer.alloc(150_000, 7);
  writeFileSync(wasm, bytes);
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.wasm_path = wasm;
  writeFileSync(file, JSON.stringify(c));
  const r = run(["preflight", "--config", file, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  const wasmCheck = doc.checks.find((x) => x.name === "wasm present");
  assert.equal(wasmCheck.status, "PASS");
  assert.match(wasmCheck.detail, /150000 bytes/);
  assert.ok(wasmCheck.detail.includes(createHash("sha256").update(bytes).digest("hex")));
  const est = doc.checks.find((x) => x.name === "wasm storage cost estimate");
  assert.match(est.detail, /^1\.5 NEAR for 150000 bytes/);
  assert.equal(doc.checks.find((x) => x.name === "config complete (no placeholders)").status, "PASS");
  assert.equal(doc.checks.find((x) => x.name === "wasm newer than src/lib.rs").status, "PASS");
  const toolchain = doc.checks.filter((x) => x.name.startsWith("toolchain"));
  assert.equal(doc.ready_for_live, toolchain.every((x) => x.status === "PASS"));
});

test("preflight warns when vault funding is below the wasm storage cost", () => {
  const { file, dir } = filledConfig();
  const wasm = join(dir, "big.wasm");
  writeFileSync(wasm, Buffer.alloc(700_000, 1)); // 7 NEAR of storage > 6 NEAR funding
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.wasm_path = wasm;
  writeFileSync(file, JSON.stringify(c));
  const doc = JSON.parse(run(["preflight", "--config", file, "--json"]).stdout);
  assert.equal(doc.checks.find((x) => x.name === "vault funding covers wasm storage").status, "WARN");
});

test("preflight with a missing wasm reports MISSING wasm", () => {
  const { file, dir } = filledConfig();
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.wasm_path = join(dir, "nope.wasm");
  writeFileSync(file, JSON.stringify(c));
  const r = run(["preflight", "--config", file]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^MISSING wasm present: .*nope\.wasm not found/m);
  assert.match(r.stdout, /READY FOR LIVE: no/);
});

test("preflight exits 1 when the config does not validate", () => {
  const { file } = filledConfig((c) => (c.runner_id = c.vault_id));
  const r = run(["preflight", "--config", file]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL\s+config fields and ids/m);
  assert.match(r.stdout, /READY FOR LIVE: no/);
});

test("the tool never spawns near-cli-rs: the only spawn commands are cargo", () => {
  for (const path of [SCRIPT, LIB]) {
    const src = readFileSync(path, "utf8");
    const spawns = [...src.matchAll(/(?<![.\w])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    for (const cmd of spawns) assert.match(cmd, /^["']cargo["']$/, `unexpected spawn command ${cmd} in ${path}`);
    assert.doesNotMatch(src, /["']near["']\s*,\s*(argv|args|\[)/, "no near invocation");
  }
  assert.doesNotMatch(readFileSync(LIB, "utf8"), /child_process/);
});
