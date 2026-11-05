#!/usr/bin/env node
// Yield vault live path planner. Turns config/yield-vault.live.example.json (or --config FILE) into
// the ordered list of UNSIGNED testnet transactions, validates it against the contract source,
// and checks offline what is missing before anyone goes live.
//
//   npm run yield:live:dry-run
//   npm run yield:live:preflight
//
// This tool never signs, never sends and never runs near-cli-rs. The near-cli-rs commands it prints
// are text for a human. The only child processes are preflight's `cargo --version` /
// `cargo near --version` detection and, with --build, `cargo near build non-reproducible-wasm`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_SOURCE_URL, YOCTO_PER_BYTE, abiPathFor, compareMethods, parseAbiMethods, buildLivePlan, findPlaceholders, formatNear, formatSplit, loadContractSpec, loadLiveConfig,
  parseNear, planTotals, validateLiveConfig, validatePlan,
} from "../src/yield/live-plan.mjs";
import { DEFAULT_RPC, assertRpcUrl, createRpc, onlineChecks } from "../src/yield/live-rpc.mjs";
import { RefusalError, assertNotMainnet } from "../src/yield/send.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = resolve(ROOT, "config/yield-vault.live.example.json");
const CONTRACT_DIR = resolve(ROOT, "contracts/yield-vault");
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const REFUSED_FLAGS = ["--send", "--sign", "--i-approve", "--sign-with-keychain", "--sign-with-plaintext-private-key", "--private-key", "--seed-phrase", "--live", "--broadcast"];

const USAGE = () => `Usage: node scripts/yield-live.mjs <dry-run|preflight> [options]
  dry-run [--config FILE] [--json] [--out FILE]
      Build the full ordered list of unsigned testnet transactions for the vault's live path,
      validate it against contracts/yield-vault/src/lib.rs and print it. Placeholders in the
      config are allowed here and listed as warnings.
      --json     print one JSON document {network, unsigned:true, transactions, problems, totals}
      --out FILE write that JSON document to FILE as well
      Exit 0 plan valid, 1 plan has problems, 2 refused or usage error.
  preflight [--config FILE] [--json] [--build] [--online [--rpc URL]]
      Offline checklist (PASS / FAIL / MISSING / WARN / MANUAL): config complete, ids testnet,
      plan valid against lib.rs, limits, wasm present (size, sha256, storage cost estimate), wasm
      newer than src/lib.rs, cargo and cargo-near on PATH. Ends with "READY FOR LIVE: yes|no".
      --online   also run read-only JSON-RPC views against testnet (default RPC ${DEFAULT_RPC}): Ref and token
                 contracts exist and match the config, storage bounds, pool tokens and reserves, owner funded,
                 vault/runner not yet created. Only query/call_function and view_account with finality final; no keys.
      --rpc URL  RPC endpoint for --online; must be https and must not contain "mainnet" (else exit 2)
      --build    first run \`cargo near build non-reproducible-wasm\` in contracts/yield-vault (10 min timeout)
      Exit 0 no FAIL (MISSING and MANUAL items do not fail; they make READY FOR LIVE no),
      1 at least one FAIL, 2 refused or usage error.
  -h, --help   print this help and exit 0
Default config: config/yield-vault.live.example.json. Public keys only; a field that looks like a
private key or seed is refused. Mainnet (NEAR_NETWORK=mainnet or any .near id) is refused.
This tool never signs or sends; --send, --sign*, --i-approve, --live, --broadcast and any
argument containing "sign" or "private" are refused with exit 2 before the config is read.`;

class UsageError extends Error {}

function refuseSigning(argv) {
  for (const a of argv) {
    const l = a.toLowerCase();
    if (REFUSED_FLAGS.includes(l) || l.includes("sign") || l.includes("private")) {
      throw new RefusalError("refused: this tool never signs or sends; it only prints unsigned plans and offline checks. Run the printed near-cli-rs commands yourself, by hand, after review.", 2);
    }
  }
}

function parseArgs(argv) {
  const o = { cmd: undefined, config: DEFAULT_CONFIG, json: false, out: undefined, build: false, online: false, rpc: DEFAULT_RPC, help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...o, help: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    if (!a.startsWith("-") && o.cmd === undefined) {
      if (!["dry-run", "preflight"].includes(a)) throw new UsageError(`unknown command ${JSON.stringify(a)}; one of dry-run, preflight`);
      o.cmd = a;
    } else if (a === "--config") o.config = resolve(value());
    else if (a === "--json") o.json = true;
    else if (a === "--out" && o.cmd === "dry-run") o.out = resolve(value());
    else if (a === "--build" && o.cmd === "preflight") o.build = true;
    else if (a === "--online" && o.cmd === "preflight") o.online = true;
    else if (a === "--rpc" && o.cmd === "preflight") o.rpc = value();
    else throw new UsageError(`unknown argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  if (!o.cmd) throw new UsageError("a command is required: dry-run or preflight");
  if (o.rpc !== DEFAULT_RPC && !o.online) throw new UsageError("--rpc only applies together with --online");
  if (o.online) {
    try {
      assertRpcUrl(o.rpc);
    } catch (e) {
      throw new RefusalError(`refused: ${e.message}. --online only reads testnet over https.`, 2);
    }
  }
  return o;
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function detectCargo(args) {
  const r = spawnSync("cargo", args, { encoding: "utf8", timeout: 15_000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split("\n")[0];
}

function renderStep(s, i) {
  const lines = [];
  const who = s.view ? `view -> ${s.receiver_id}` : `${s.signer_id} -> ${s.receiver_id}`;
  lines.push(`${String(i + 1).padStart(2)}. [${s.phase}] ${s.title}`);
  lines.push(`    ${who}`);
  for (const a of s.actions) {
    if (a.type === "FunctionCall") lines.push(`    call ${a.method_name} ${JSON.stringify(a.args)} deposit ${formatNear(a.deposit_yocto)} NEAR (${a.deposit_yocto} yocto) gas ${BigInt(a.gas) / 10n ** 12n} TGas`);
    else if (a.type === "ViewCall") lines.push(`    view ${a.method_name} ${JSON.stringify(a.args)}`);
    else if (a.type === "Transfer") lines.push(`    transfer ${formatNear(a.deposit_yocto)} NEAR`);
    else if (a.type === "AddKey") lines.push(`    add key ${a.public_key} (${a.access})`);
    else if (a.type === "DeployContract") lines.push(`    deploy ${a.wasm_path}`);
    else if (a.type === "DeleteAccount") lines.push(`    delete account, beneficiary ${a.beneficiary_id}`);
    else lines.push(`    ${a.type}`);
  }
  lines.push(`    cost: ${s.cost_near} NEAR | expect: ${s.expect}`);
  lines.push(`    near-cli-rs (text only): ${s.near_cli}`);
  return lines.join("\n");
}

function buildAndValidate(config) {
  const plan = buildLivePlan(config);
  const spec = loadContractSpec();
  const problems = validatePlan(plan, spec.methods, { minGas: spec.minGas });
  return { plan, problems };
}

function dryRun(opts, { log }) {
  const config = loadLiveConfig(opts.config);
  const configProblems = validateLiveConfig(config, { allowPlaceholders: true });
  if (configProblems.length) {
    if (opts.json) log(JSON.stringify({ network: "testnet", unsigned: true, transactions: [], problems: configProblems, warnings: [], totals: null }, null, 2));
    else log(`config problems:\n${configProblems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  const { plan, problems } = buildAndValidate(config);
  const warnings = findPlaceholders(config).map((p) => `placeholder not filled in: ${p}`);
  const totals = planTotals(plan);
  const wasmFile = isAbsolute(config.wasm_path) ? config.wasm_path : resolve(ROOT, config.wasm_path);
  const wasm = existsSync(wasmFile) ? { path: config.wasm_path, bytes: statSync(wasmFile).size, sha256: sha256File(wasmFile) } : { path: config.wasm_path, bytes: null, sha256: null };
  const transactions = plan.steps.map((s) => ({ ...s, actions: s.actions.map((a) => (a.type === "DeployContract" && wasm.sha256 ? { ...a, wasm_sha256: wasm.sha256 } : a)) }));
  const doc = { network: plan.network, unsigned: true, owner_id: plan.owner_id, vault_id: plan.vault_id, runner_id: plan.runner_id, wasm, transactions, problems, warnings, manual: plan.manual, totals };
  if (opts.out) writeFileSync(opts.out, `${JSON.stringify(doc, null, 2)}\n`);
  if (opts.json) {
    log(JSON.stringify(doc, null, 2));
    return problems.length ? 1 : 0;
  }
  log(`Yield vault live path on ${plan.network}: ${plan.steps.length} steps, UNSIGNED (nothing is signed or sent)`);
  log(`owner ${plan.owner_id} | vault ${plan.vault_id} | runner ${plan.runner_id}`);
  log("");
  plan.steps.forEach((s, i) => log(renderStep(s, i)));
  log("");
  log(`totals: ${totals.transactions} transactions, ${totals.views} views, deposits ${formatSplit(totals.deposit_near, totals.deposit_security_yocto)}, owner outflow ${formatSplit(totals.owner_outflow_near, totals.owner_outflow_security_yocto)}, prepaid gas ${totals.gas_tgas} TGas`);
  for (const w of warnings) log(`warning: ${w}`);
  for (const m of plan.manual) log(`manual: ${m}`);
  if (problems.length) {
    log("PLAN INVALID:");
    for (const p of problems) log(`  - ${p}`);
  } else log("plan valid against contracts/yield-vault/src/lib.rs");
  return problems.length ? 1 : 0;
}

async function preflight(opts, { log, fetch: fetchFn }) {
  const checks = [];
  const add = (status, name, detail = "") => checks.push({ status, name, detail });

  if (opts.build) {
    log("building: cargo near build non-reproducible-wasm (contracts/yield-vault)");
    const r = spawnSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: CONTRACT_DIR, encoding: "utf8", timeout: BUILD_TIMEOUT_MS });
    if (r.error || r.status !== 0) add("FAIL", "wasm build", (r.error?.message ?? r.stderr ?? "").trim().split("\n").slice(-3).join(" | "));
    else add("PASS", "wasm build", "cargo near build non-reproducible-wasm succeeded");
  }

  const config = loadLiveConfig(opts.config);
  const configProblems = validateLiveConfig(config, { allowPlaceholders: true });
  const placeholders = findPlaceholders(config);
  if (placeholders.length) add("MISSING", "config complete (no placeholders)", `${placeholders.length} unfilled: ${placeholders.join(", ")}`);
  else add("PASS", "config complete (no placeholders)");
  if (configProblems.length) add("FAIL", "config fields and ids (testnet, well-formed)", configProblems.join("; "));
  else add("PASS", "config fields and ids (testnet, well-formed)");

  let plan = null;
  if (!configProblems.length) {
    const built = buildAndValidate(config);
    plan = built.plan;
    if (built.problems.length) add("FAIL", "plan valid against lib.rs, gas and deposits within limits", built.problems.join("; "));
    else {
      const t = planTotals(plan);
      add("PASS", "plan valid against lib.rs, gas and deposits within limits", `${t.transactions} transactions, owner outflow ${formatSplit(t.owner_outflow_near, t.owner_outflow_security_yocto)}`);
    }
  }

  const wasmPath = isAbsolute(config.wasm_path ?? "") ? config.wasm_path : resolve(ROOT, config.wasm_path ?? "");
  if (!config.wasm_path || !existsSync(wasmPath)) {
    add("MISSING", "wasm present", `${config.wasm_path} not found; build it: cargo near build non-reproducible-wasm (or preflight --build)`);
  } else {
    const size = statSync(wasmPath).size;
    const need = BigInt(size) * YOCTO_PER_BYTE;
    add("PASS", "wasm present", `${config.wasm_path}: ${size} bytes, sha256 ${sha256File(wasmPath)}`);
    add("PASS", "wasm storage cost estimate", `${formatNear(need)} NEAR for ${size} bytes (1 NEAR per 100 KB), plus contract state and a margin`);
    let funded = null;
    try {
      funded = parseNear(config.funding?.vault_initial_near);
    } catch { /* reported by the config check */ }
    if (funded !== null && funded < need + parseNear("1")) add("WARN", "vault funding covers wasm storage", `funding.vault_initial_near ${formatNear(funded)} NEAR is below the wasm storage cost ${formatNear(need)} NEAR plus 1 NEAR margin`);
    const lib = resolve(fileURLToPath(CONTRACT_SOURCE_URL));
    if (statSync(wasmPath).mtimeMs < statSync(lib).mtimeMs) add("MISSING", "wasm newer than src/lib.rs", "stale, rebuild (the wasm is older than contracts/yield-vault/src/lib.rs)");
    else add("PASS", "wasm newer than src/lib.rs");
  }

  const abiFile = config.wasm_path ? abiPathFor(wasmPath) : null;
  if (!abiFile || !existsSync(abiFile)) {
    add("MISSING", "plan valid against built ABI", `${abiFile ?? "(no wasm_path)"} not found; cargo near build writes it next to the wasm`);
  } else {
    try {
      const spec = loadContractSpec();
      const abiMethods = parseAbiMethods(JSON.parse(readFileSync(abiFile, "utf8")), spec.methods);
      const disagree = compareMethods(spec.methods, abiMethods);
      if (disagree.length) add("FAIL", "lib.rs parse agrees with built ABI", disagree.join("; "));
      else add("PASS", "lib.rs parse agrees with built ABI", `${abiMethods.size} functions`);
      if (plan) {
        const abiProblems = validatePlan(plan, abiMethods, { minGas: spec.minGas });
        if (abiProblems.length) add("FAIL", "plan valid against built ABI", abiProblems.join("; "));
        else add("PASS", "plan valid against built ABI", "every vault call matches the built wasm's method, kind, payable/private flags and argument names");
      }
    } catch (e) {
      add("FAIL", "plan valid against built ABI", `cannot read ${abiFile}: ${e.message}`);
    }
  }

  const cargo = detectCargo(["--version"]);
  const cargoNear = cargo ? detectCargo(["near", "--version"]) : null;
  add(cargo ? "PASS" : "MISSING", "toolchain: cargo", cargo ?? "cargo not found on PATH");
  add(cargoNear ? "PASS" : "MISSING", "toolchain: cargo-near", cargoNear ?? "cargo-near not found on PATH (cargo install cargo-near)");

  const manual = [];
  if (opts.online) {
    if (!plan) add("FAIL", "online checks", "skipped: the config does not validate");
    else {
      const rpc = createRpc({ url: opts.rpc, fetch: fetchFn });
      const online = await onlineChecks(config, plan, rpc);
      for (const c of online) add(c.status, c.name, c.detail);
      // Origin only: a provider URL may carry an API key in its path, query or userinfo.
      add("PASS", "online requests", `${rpc.requests} read-only RPC requests to ${new URL(opts.rpc).origin}`);
    }
  }
  if (plan) {
    const t = planTotals(plan);
    manual.push(`owner ${plan.owner_id} exists on testnet and holds at least ${formatSplit(t.owner_outflow_near, t.owner_outflow_security_yocto)} plus gas for its transactions`);
    manual.push(`keys for owner, vault ${plan.vault_id} and runner ${plan.runner_id} are in the near-cli-rs keychain (the vault and runner public keys in the config match them)`);
    manual.push(`${config.nft_contract_id} exists and token ${config.token_id} is minted (the vault records them; the contract does not verify them)`);
    if (!opts.online) manual.push("Ref's storage_balance_bounds min is below ref_storage_deposit_near (read it with the view step, or run preflight --online)");
    manual.push(...plan.manual);
  } else manual.push("fix the FAIL items above first");
  for (const m of manual) add("MANUAL", m);

  const failed = checks.some((c) => c.status === "FAIL");
  const missing = checks.filter((c) => c.status === "MISSING");
  const ready = !failed && missing.length === 0;
  if (opts.json) {
    log(JSON.stringify({ network: "testnet", unsigned: true, checks, ready_for_live: ready, missing: missing.map((c) => c.name) }, null, 2));
    return failed ? 1 : 0;
  }
  log(`Yield vault live preflight (${opts.online ? "online read-only" : "offline"}, ${opts.config === DEFAULT_CONFIG ? "config/yield-vault.live.example.json" : "custom config"})`);
  for (const c of checks) log(`${c.status.padEnd(7)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  log("");
  log("Missing for live:");
  const todo = checks.filter((c) => c.status === "MISSING" || c.status === "MANUAL" || c.status === "FAIL");
  if (todo.length === 0) log("  nothing");
  for (const c of todo) log(`  - [${c.status}] ${c.name}${c.status === "MISSING" ? `: ${c.detail}` : ""}`);
  log(`READY FOR LIVE: ${ready ? `yes (${opts.online ? "online read-only" : "offline"} checks only; confirm the MANUAL items by hand, then get the human's explicit yes)` : "no"}`);
  return failed ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((...a) => console.log(...a));
  const err = io.err ?? ((s) => s !== "" && console.error(s));
  const env = io.env ?? process.env;
  try {
    refuseSigning(argv);
    assertNotMainnet(env);
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE());
      return 0;
    }
    return opts.cmd === "dry-run" ? dryRun(opts, { log }) : await preflight(opts, { log, fetch: io.fetch });
  } catch (e) {
    if (e instanceof RefusalError) {
      err(e.message);
      return 2;
    }
    if (e instanceof UsageError) {
      err(`yield-live: ${e.message}\n${USAGE()}`);
      return 2;
    }
    err(`yield-live: ${e.code === "ENOENT" ? "config file not found" : e.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
