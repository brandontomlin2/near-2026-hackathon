#!/usr/bin/env node
// The one entry for the approved live testnet run: deploy the yield vault, mint the one
// personality NFT it belongs to, and make one small Ref (Rhea) testnet swap.
//
//   npm run yield:live:once -- --config out/yield-vault.live.json --media-base <url>
//
// What it does, all offline:
//   1. runs `yield-live preflight --require-ready` (config, plan against lib.rs, wasm, ABI, cargo);
//   2. checks the live environment: near-cli-rs on PATH (by scanning PATH; `near` is never run),
//      NEAR_NETWORK=testnet, the NFT wasm, --media-base, and that a near-cli-rs credential file
//      exists for each signer (existence only: no key file is opened, read or printed);
//   3. if anything is missing: prints what, sends nothing, exits 3;
//   4. if ready: prints the exact ordered near-cli-rs commands (NFT deploy, one nft_mint, vault
//      steps through execute_swap and the read-back after it) and STOPS. That list holds setup only:
//      no withdraw, pause, revoke or delete. With --teardown (same checks) it prints instead the
//      separate list that runs after the swap has been reviewed: withdraw, then rollback.
//
// It never signs, never sends and never spawns near. Every printed command is text for a human,
// to run by hand, one at a time, each after the owner's explicit yes. --send, --i-approve and any
// flag containing "sign" or "private" are refused with exit 2 before anything is read.
// Exit 0 ready (commands printed), 1 preflight FAIL, 2 refused or usage error, 3 not ready.

import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLivePlan, findPlaceholders, loadLiveConfig, validateLiveConfig } from "../src/yield/live-plan.mjs";
import { findSwapStep } from "../src/yield/live-dry-run-preflight.mjs";
import { RefusalError, assertNotMainnet, isMainnetAccountId } from "../src/yield/send.mjs";
import { AGENTS, MEDIA_PLACEHOLDER_BASE, buildDeployStep, buildMintStep, shellQuote, validateMediaBase } from "./testnet-deploy.mjs";
import { main as yieldLiveMain } from "./yield-live.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = resolve(ROOT, "config/yield-vault.live.example.json");
export const NFT_WASM = "contracts/personality-nft/target/near/personality_nft.wasm";
export const CREDENTIALS_DIR = ".near-credentials/testnet";
const REFUSED_FLAGS = ["--send", "--i-approve", "--live", "--broadcast", "--execute", "--yes", "--online", "--rpc", "--network"];

const USAGE = `Usage: npm run yield:live:once -- [--config FILE] [--media-base URL] [--keys-in-os-keychain] [--teardown]
  The one entry for the approved live testnet run (vault deploy, one personality NFT mint, one
  small Ref testnet swap). Offline: runs yield-live preflight --require-ready, then checks
  near-cli-rs on PATH (PATH scan; near is never run), NEAR_NETWORK=testnet, the NFT wasm,
  --media-base, and a credential entry per signer under ~/${CREDENTIALS_DIR}/ (existence only;
  no key file is opened or printed). Ready: prints the exact ordered commands and stops.
  --config FILE          live config (default config/yield-vault.live.example.json, never ready)
  --media-base URL       where <token_id>.svg is hosted (the nft_mint media URL)
  --keys-in-os-keychain  the signer keys are in the OS keychain, not ~/${CREDENTIALS_DIR}/;
                         a missing credential file becomes a MANUAL line instead of not ready
  --teardown             print the separate after-the-swap list (withdraw, then rollback) instead
                         of the setup-through-swap list; same checks, same exit codes
  -h, --help             print this help and exit 0
  Exit 0 ready (commands printed, nothing run), 1 preflight FAIL, 2 refused or usage error,
  3 not ready. This tool never signs, sends or runs near; --send, --i-approve and flags
  containing "sign" or "private" are refused with exit 2.`;

class UsageError extends Error {}

function refuseSends(argv) {
  for (const a of argv) {
    if (!a.startsWith("-")) continue;
    const l = a.toLowerCase().split("=")[0];
    if (REFUSED_FLAGS.includes(l) || l.includes("sign") || l.includes("private") || l.includes("seed")) {
      throw new RefusalError("refused: yield:live:once never signs, sends or runs near, and only reads offline. Run the printed commands yourself, by hand, after the owner's explicit yes.", 2);
    }
  }
}

function parseArgs(argv) {
  const o = { config: DEFAULT_CONFIG, mediaBase: null, osKeychain: false, teardown: false, help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...o, help: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === "--config") o.config = resolve(value());
    else if (a === "--media-base") o.mediaBase = value();
    else if (a === "--keys-in-os-keychain") o.osKeychain = true;
    else if (a === "--teardown") o.teardown = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a.slice(0, 40))}`);
  }
  return o;
}

/** Is an executable called `name` on this PATH? Scans directories only; never runs anything. */
export function onPath(name, pathValue = "") {
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** The environment checks. Each row: {status: ok|missing|manual, name, detail}. Never holds a value from env or a key file. */
export function environmentChecks({ config, opts, env, home, root }) {
  const rows = [];
  const add = (status, name, detail) => rows.push({ status, name, detail });
  add(onPath("near", env.PATH ?? "") ? "ok" : "missing", "near-cli-rs on PATH", onPath("near", env.PATH ?? "") ? "found (not run)" : "install near-cli-rs v0.14+ and put `near` on PATH");
  add(env.NEAR_NETWORK === "testnet" ? "ok" : "missing", "NEAR_NETWORK=testnet", env.NEAR_NETWORK === "testnet" ? "set" : "export NEAR_NETWORK=testnet (value not shown)");
  for (const [name, field] of [["NEAR_ACCOUNT_ID", "owner_id"], ["NEAR_CONTRACT_ACCOUNT_ID", "nft_contract_id"]]) {
    if (env[name] === undefined || env[name] === "") add("ok", `${name} agrees with config ${field}`, "not set (the config is used)");
    else if (env[name] === config[field]) add("ok", `${name} agrees with config ${field}`, "set and equal (value not shown)");
    else add("missing", `${name} agrees with config ${field}`, `set but differs from config ${field}; unset it or make them equal (value not shown)`);
  }
  const agent = AGENTS.find((a) => a.token_id === config.token_id);
  if (!agent) add("missing", "config token_id is a personality NFT", `token_id must be one of ${AGENTS.map((a) => a.token_id).join(", ")}`);
  else if (config.agent !== undefined && config.agent !== config.token_id) add("missing", "config token_id is a personality NFT", `token_id ${config.token_id} differs from agent ${config.agent}; the vault belongs to one agent`);
  else add("ok", "config token_id is a personality NFT", config.token_id);
  let media = "ok";
  let mediaDetail = "set";
  try {
    if (!opts.mediaBase || opts.mediaBase === MEDIA_PLACEHOLDER_BASE) throw new Error("pass --media-base <url>, the folder serving the uploaded <token_id>.svg (npm run render)");
    validateMediaBase(opts.mediaBase);
  } catch (e) {
    media = "missing";
    mediaDetail = e.message;
  }
  add(media, "--media-base", mediaDetail);
  add(existsSync(join(root, NFT_WASM)) ? "ok" : "missing", "personality NFT wasm", existsSync(join(root, NFT_WASM)) ? NFT_WASM : `${NFT_WASM} not found; npm run build:wasm`);
  const signers = [["owner", config.owner_id], ["nft contract", config.nft_contract_id], ["vault", config.vault_id], ["runner", config.runner_id]];
  for (const [role, id] of signers) {
    // Existence only. Nothing is opened: an unreadable file still counts as present. The legacy
    // keychain keeps a key as <id>.json, or as <id>/<public key>.json (only names are listed).
    // The printed commands use sign-with-keychain, which near-cli-rs falls back to this legacy
    // store for when the OS keychain has no key (src/transaction_signature_options/sign_with_keychain).
    const safe = typeof id === "string" && /^[a-z0-9._-]+$/.test(id) && !id.includes("..");
    const found = safe && (existsSync(join(home, CREDENTIALS_DIR, `${id}.json`)) || hasJsonEntry(join(home, CREDENTIALS_DIR, id)));
    if (found) add("ok", `credential file: ${role}`, "present (not opened)");
    else if (opts.osKeychain) add("manual", `credential file: ${role}`, "not in ~/" + CREDENTIALS_DIR + "/; confirm the key is in the OS keychain (near account list-keys) by hand");
    else add("missing", `credential file: ${role}`, `account ${safe ? id : String(id)}: no ~/${CREDENTIALS_DIR}/${safe ? id : "<id>"}.json (or ${safe ? id : "<id>"}/); put its key in the near-cli-rs keychain (~/${CREDENTIALS_DIR}/, see .agents/skills/near-cli-rs) or pass --keys-in-os-keychain`);
  }
  return rows;
}

function hasJsonEntry(dir) {
  try {
    return readdirSync(dir).some((n) => n.endsWith(".json"));
  } catch {
    return false;
  }
}

const nearLine = (argv) => `near ${argv.map(shellQuote).join(" ")}`;

/** The ordered commands: NFT deploy, one mint, vault steps through the swap and its read-back. */
export function orderedCommands(config, mediaBase) {
  const agent = AGENTS.find((a) => a.token_id === config.token_id);
  const contract = config.nft_contract_id;
  const owner = config.owner_id;
  const nft = [
    { title: `deploy the personality NFT contract on ${contract} (new_default_meta)`, signer: contract, cost: "0 NEAR + gas", command: nearLine(buildDeployStep({ contract, owner, wasm: NFT_WASM }).argv) },
    { title: `mint the one personality NFT ${agent.token_id} to ${owner}`, signer: owner, cost: "0.05 NEAR + gas", command: nearLine(buildMintStep({ contract, owner, receiver: owner, agent, mediaBase }).argv) },
  ];
  const plan = buildLivePlan(config);
  const swapAt = findSwapStep(plan).step - 1; // findSwapStep numbers steps from 1
  const vault = plan.steps.slice(0, swapAt + 2).map((s, i) => ({ title: `plan step ${i + 1} [${s.phase}] ${s.title}`, signer: s.view ? null : s.signer_id, cost: `${s.cost_near} NEAR${s.view ? "" : " + gas"}`, command: s.near_cli, expect: s.expect }));
  const first = swapAt + 2; // plan steps before this index are setup through the swap and its read-back
  const teardown = plan.steps.slice(first).map((s, i) => ({ title: `plan step ${first + i + 1} [${s.phase}] ${s.title}`, signer: s.view ? null : s.signer_id, cost: `${s.cost_near} NEAR${s.view ? "" : " + gas"}`, command: s.near_cli, expect: s.expect }));
  return { nft, vault, teardown, rest: plan.steps.length - first, total: plan.steps.length, swapNumber: swapAt + 1 };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? ((...a) => console.log(...a));
  const err = io.err ?? ((s) => s !== "" && console.error(s));
  const env = io.env ?? process.env;
  const home = io.home ?? homedir();
  const root = io.root ?? ROOT;
  const preflight = io.preflight ?? yieldLiveMain;
  try {
    refuseSends(argv);
    assertNotMainnet(env);
    if (env.NEAR_NETWORK !== undefined && env.NEAR_NETWORK !== "" && env.NEAR_NETWORK !== "testnet") throw new RefusalError("refused: NEAR_NETWORK must be unset or testnet (value not shown). This tool only ever targets testnet.", 2);
    for (const name of ["NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID"]) {
      if (isMainnetAccountId(env[name])) throw new RefusalError(`refused: ${name} ends in .near (mainnet). This tool only ever targets testnet.`, 2);
    }
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const config = loadLiveConfig(opts.config);
    log("yield:live:once: offline readiness for the approved live testnet run (nothing is signed or sent; near is never run)");
    log("");
    log("== 1. npm run yield:live:preflight -- --require-ready ==");
    const pfCode = await preflight(["preflight", "--config", opts.config, "--require-ready"], { log, err, env });
    if (pfCode !== 0 && pfCode !== 3) {
      err(`yield:live:once: preflight exited ${pfCode}; fix its FAIL items first. Nothing was signed or sent.`);
      return pfCode === 2 ? 2 : 1;
    }
    log("");
    log("== 2. live environment (offline; near is not run, no key file is opened, no env value is printed) ==");
    const rows = environmentChecks({ config, opts, env, home, root });
    for (const r of rows) log(`${r.status.toUpperCase().padEnd(7)} ${r.name}: ${r.detail}`);
    const missing = rows.filter((r) => r.status === "missing").map((r) => r.name);
    if (pfCode === 3) missing.unshift("yield:live:preflight --require-ready (see its Missing for live list above)");
    if (validateLiveConfig(config, { allowPlaceholders: false }).length || findPlaceholders(config).length) missing.push("config filled in (no placeholders)");
    log("");
    if (missing.length) {
      const accounts = [...new Set([config.owner_id, config.nft_contract_id, config.vault_id, config.runner_id])].join(", ");
      log("NOT READY FOR LIVE. Nothing was signed or sent; near was not run.");
      log("Approved run (the only one): deploy the yield vault, mint ONE personality NFT, make ONE small Rhea (Ref) testnet swap.");
      log("Faucet test NEAR only, testnet only. Nothing is signed or sent until READY FOR LIVE is yes and the owner runs the printed commands by hand.");
      log(`Testnet accounts that need keys: ${accounts}.`);
      log(`Put the keys in the near-cli-rs keychain: ~/${CREDENTIALS_DIR}/<account>.json (or <account>/<public key>.json), or the OS keychain with --keys-in-os-keychain. Put no key in the repo or the config; the config holds public keys only.`);
      err(`yield:live:once: not ready for live: ${[...new Set(missing)].join("; ")}`);
      return 3;
    }
    const { nft, vault, teardown, rest, total, swapNumber } = orderedCommands(config, opts.mediaBase);
    const printSteps = (list, n) => {
      for (const c of list) {
        n += 1;
        log(`${String(n).padStart(2)}. ${c.title}  [${c.signer ? `signer ${c.signer}` : "read-only"}; ${c.cost}]`);
        log(`    ${c.command}`);
        log(`    expect: ${c.expect}`);
      }
    };
    const manualNotes = () => {
      for (const r of rows.filter((x) => x.status === "manual")) log(`manual: ${r.name}: ${r.detail}`);
      log("manual: confirm the MANUAL items of the preflight above (owner funds, keychain keys, Ref storage bound)");
    };
    if (opts.teardown) {
      log(`READY FOR LIVE (offline checks). TEARDOWN list: plan steps ${vault.length + 1}-${total} (${rest} steps), for after the swap`);
      log("has run and its result was reviewed. Nothing below has been run. Before each command: get the owner's explicit yes,");
      log("run it by hand, and check its result before the next. Testnet only.");
      manualNotes();
      log("");
      log(`== teardown: plan steps ${vault.length + 1}-${total} of ${total} (withdraw, then rollback) ==`);
      for (const c of teardown) {
        log(`${c.title}  [${c.signer ? `signer ${c.signer}` : "read-only"}; ${c.cost}]`);
        log(`    ${c.command}`);
        log(`    expect: ${c.expect}`);
      }
      log("");
      log("STOP. Record every transaction hash. Nothing was signed or sent; near was not run.");
      return 0;
    }
    log("READY FOR LIVE (offline checks). Nothing below has been run. Before each command: get the owner's explicit yes,");
    log("run it by hand, and check its result before the next. Testnet only. This list is setup through the swap only.");
    manualNotes();
    log(`manual: the NFT contract account ${config.nft_contract_id} must already exist on testnet, funded for its wasm storage, with its key in the keychain; nothing below creates it (docs/live-runbook.md, Preconditions)`);
    log("");
    log("== 3. personality NFT (contracts/personality-nft) ==");
    printSteps(nft, 0);
    log("");
    log(`== 4. yield vault: plan steps 1-${vault.length} of ${total} (deploy, fund, one swap on Ref testnet, read-back) ==`);
    printSteps(vault, nft.length);
    log("");
    log(`STOP. The swap is plan step ${swapNumber}. Plan steps ${vault.length + 1}-${total} (${rest} more: withdraw and rollback) are deferred until AFTER the agent send; do not sign them before it. Print them then with`);
    log(`  npm run yield:live:once -- --config ${shellQuote(opts.config)} --media-base ${shellQuote(opts.mediaBase)} --teardown`);
    log(`or: npm run yield:live:dry-run -- --config ${shellQuote(opts.config)} --rollback`);
    log("and docs/yield-vault-live-runbook.md (Plan steps, Rollback). Record every transaction hash.");
    log("Nothing was signed or sent; near was not run. The owner-gated senders (--send --i-approve) are not run by this script.");
    return 0;
  } catch (e) {
    if (e instanceof RefusalError) {
      err(e.message);
      return 2;
    }
    if (e instanceof UsageError) {
      err(`yield:live:once: ${e.message}\n${USAGE}`);
      return 2;
    }
    err(`yield:live:once: ${e.code === "ENOENT" ? "config file not found" : e.message}. Nothing was signed or sent.`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
