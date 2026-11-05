import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { parseContractMethods } from "../src/yield/live-plan.mjs";
import { main } from "./yield-live.mjs";
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

/** A small hand-built NEAR ABI in cargo-near's shape, derived from the methods parsed from lib.rs. */
function abiFixture(mutate = () => {}) {
  const src = parseContractMethods(readFileSync(new URL("../contracts/yield-vault/src/lib.rs", import.meta.url), "utf8"));
  const functions = [...src.values()].map((m) => ({
    name: m.name,
    kind: m.view ? "view" : "call",
    ...(m.payable || m.private || m.init ? { modifiers: [m.payable && "payable", m.private && "private", m.init && "init"].filter(Boolean) } : {}),
    params: { serialization_type: "json", args: m.args.filter((a) => !(m.private && a === "out")).map((a) => ({ name: a, type_schema: m.optional.includes(a) ? { type: ["string", "null"] } : { type: "string" } })) },
  }));
  functions.push({ name: "contract_source_metadata", kind: "view" });
  const abi = { schema_version: "0.4.0", body: { functions } };
  mutate(abi);
  return abi;
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
  writeFileSync(join(dir, "fake_abi.json"), JSON.stringify(abiFixture()));
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

function configWithAbi(abi) {
  const { file, dir } = filledConfig();
  const wasm = join(dir, "v.wasm");
  writeFileSync(wasm, Buffer.alloc(1000, 3));
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.wasm_path = wasm;
  writeFileSync(file, JSON.stringify(c));
  if (abi) writeFileSync(join(dir, "v_abi.json"), JSON.stringify(abi));
  return file;
}
const checkOf = (doc, name) => doc.checks.find((c) => c.name === name);

test("preflight: no built ABI is MISSING", () => {
  const doc = JSON.parse(run(["preflight", "--config", configWithAbi(null), "--json"]).stdout);
  assert.equal(checkOf(doc, "plan valid against built ABI").status, "MISSING");
  assert.equal(doc.ready_for_live, false);
});

test("preflight: a matching ABI passes both ABI checks", () => {
  const r = run(["preflight", "--config", configWithAbi(abiFixture()), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(checkOf(doc, "lib.rs parse agrees with built ABI").status, "PASS");
  assert.equal(checkOf(doc, "plan valid against built ABI").status, "PASS");
});

test("preflight: ABI/lib.rs disagreement on payable, args or a missing method is a FAIL", () => {
  const cases = [
    [(a) => (a.body.functions.find((f) => f.name === "withdraw").modifiers = []), /withdraw: #\[payable\] differs/],
    [(a) => a.body.functions.find((f) => f.name === "withdraw").params.args.pop(), /withdraw: args differ/],
    [(a) => (a.body.functions = a.body.functions.filter((f) => f.name !== "execute_swap")), /execute_swap: in lib\.rs but not in the ABI/],
    [(a) => a.body.functions.push({ name: "surprise", kind: "call" }), /surprise: in the ABI but not parsed from lib\.rs/],
  ];
  for (const [mutate, re] of cases) {
    const r = run(["preflight", "--config", configWithAbi(abiFixture(mutate)), "--json"]);
    assert.equal(r.code, 1);
    assert.match(checkOf(JSON.parse(r.stdout), "lib.rs parse agrees with built ABI").detail, re);
  }
});

test("preflight: the plan is checked against the ABI's own view of a method", () => {
  // The ABI says get_state is a call: lib.rs disagrees AND the plan's view of it is wrong.
  const doc = JSON.parse(run(["preflight", "--config", configWithAbi(abiFixture((a) => (a.body.functions.find((f) => f.name === "get_state").kind = "call"))), "--json"]).stdout);
  assert.equal(checkOf(doc, "plan valid against built ABI").status, "FAIL");
  assert.match(checkOf(doc, "plan valid against built ABI").detail, /get_state is not a view/);
});

test("dry-run --json carries the wasm sha256 when the wasm exists, null otherwise", () => {
  const { file, dir } = filledConfig();
  const wasm = join(dir, "w.wasm");
  const bytes = Buffer.from("not really wasm");
  writeFileSync(wasm, bytes);
  const c = JSON.parse(readFileSync(file, "utf8"));
  c.wasm_path = wasm;
  writeFileSync(file, JSON.stringify(c));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const doc = JSON.parse(run(["dry-run", "--config", file, "--json"]).stdout);
  assert.deepEqual(doc.wasm, { path: wasm, bytes: bytes.length, sha256: sha });
  assert.equal(doc.transactions.find((t) => t.id === "deploy-init").actions[0].wasm_sha256, sha);
  c.wasm_path = join(dir, "absent.wasm");
  writeFileSync(file, JSON.stringify(c));
  const none = JSON.parse(run(["dry-run", "--config", file, "--json"]).stdout);
  assert.equal(none.wasm.sha256, null);
  assert.equal(none.transactions.find((t) => t.id === "deploy-init").actions[0].wasm_sha256, undefined);
});

/** main() in-process with an injected fetch: no network. */
async function online(argv, fetch) {
  const out = [];
  const errs = [];
  const code = await main(argv, { env: {}, log: (...a) => out.push(a.join(" ")), err: (s) => errs.push(String(s)), fetch });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

function fakeRpc(seen) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body });
    if (body.params.request_type === "view_account") return { ok: true, status: 200, json: async () => ({ result: { code_hash: "5Uk3VqDvSyGkS5pE8eWqjR9zVfXk2QxJf8cYhFZ9pQd1", amount: "1" } }) };
    const answers = {
      storage_balance_bounds: { min: "1020000000000000000000" },
      get_whitelisted_tokens: ["wrap.testnet", "rft.tokenfactory.testnet"],
      get_pool: { token_account_ids: ["wrap.testnet", "rft.tokenfactory.testnet"], amounts: ["1000000000000000000000000000", "5000000000000"] },
      ft_metadata: { decimals: 24 },
    };
    return { ok: true, status: 200, json: async () => ({ result: { result: [...Buffer.from(JSON.stringify(answers[body.params.method_name]))] } }) };
  };
}

test("preflight --online uses only the injected fetch, with read-only bodies", async () => {
  const seen = [];
  const r = await online(["preflight", "--online", "--json"], fakeRpc(seen));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seen.length > 5 && seen.length <= 20);
  for (const s of seen) {
    assert.equal(s.url, "https://test.rpc.fastnear.com/");
    assert.equal(s.body.method, "query");
    assert.ok(["call_function", "view_account"].includes(s.body.params.request_type));
    assert.equal(s.body.params.finality, "final");
  }
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.checks.find((c) => c.name === "online: Ref exchange has code").status, "PASS");
  assert.match(doc.checks.find((c) => c.name === "online requests").detail, /^\d+ read-only RPC requests to https:\/\/test\.rpc\.fastnear\.com/);
});

test("preflight --online prints only the RPC origin, never a credential in the URL", async () => {
  const sentinel = "apikeyVLIVE64sentinel";
  const seen = [];
  const url = `https://user:${sentinel}@rpc.example.test/v1/${sentinel}?token=${sentinel}`;
  const r = await online(["preflight", "--online", "--rpc", url], fakeRpc(seen));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seen.length > 0);
  assert.ok(!r.stdout.includes(sentinel) && !r.stderr.includes(sentinel), "credential leaked into output");
  assert.match(r.stdout, /read-only RPC requests to https:\/\/rpc\.example\.test\b/);
});

test("preflight without --online never calls fetch", async () => {
  const r = await online(["preflight", "--json"], async () => {
    throw new Error("network used");
  });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!JSON.parse(r.stdout).checks.some((c) => c.name.startsWith("online")));
});

test("--rpc must be https and not mainnet (exit 2); --rpc without --online is a usage error", () => {
  for (const url of ["http://test.rpc.fastnear.com", "https://rpc.mainnet.near.org"]) {
    const r = run(["preflight", "--online", "--rpc", url]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refused/);
    assert.equal(r.stdout, "");
  }
  assert.equal(run(["preflight", "--rpc", "https://x.example"]).code, 2);
  assert.equal(run(["dry-run", "--online"]).code, 2);
});

test("--help documents --online and --rpc", () => {
  const r = run(["--help"]);
  assert.match(r.stdout, /--online/);
  assert.match(r.stdout, /--rpc URL/);
  assert.match(r.stdout, /https:\/\/test\.rpc\.fastnear\.com/);
});
