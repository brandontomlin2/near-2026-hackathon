#!/usr/bin/env node
// Deploy the personality NFT contract to NEAR testnet and mint the agent tokens.
//
// Dry run is the default. It prints every near-cli-rs command and contract call it
// would make, and signs nothing.
//
// --send is the only switch that signs and broadcasts. It also requires:
//   - NEAR_ACCOUNT_ID (a valid testnet account id),
//   - NEAR_NETWORK unset or "testnet",
//   - a key for each signing account in the near-cli-rs keychain. This script only
//     asks near-cli-rs for the public key (`account get-public-key from-keychain`);
//     it never reads, prints, or creates key material, and it never creates accounts.
//
// Never targets mainnet.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const NETWORK = "testnet";
export const INIT_METHOD = "new_default_meta";
export const MINT_METHOD = "nft_mint";
export const GAS = "100 Tgas";
export const ZERO_DEPOSIT = "0 NEAR";
// The contract refunds whatever part of this the token does not use.
export const MINT_DEPOSIT = "0.05 NEAR";
export const DEFAULT_WASM = fileURLToPath(
  new URL("../contracts/personality-nft/target/near/personality_nft.wasm", import.meta.url),
);

// The four agents from PRODUCT.md. Trait keys match the contract's `extra` example.
export const AGENTS = [
  { token_id: "aloof", title: "Aloof", traits: { temperament: "cool", role: "observer", risk: "low", voice: "dry" } },
  { token_id: "chaotic", title: "Chaotic", traits: { temperament: "neon", role: "trickster", risk: "high", voice: "loud" } },
  { token_id: "social", title: "Social", traits: { temperament: "warm", role: "connector", risk: "mid", voice: "open" } },
  { token_id: "skeptic", title: "Skeptic", traits: { temperament: "muted", role: "auditor", risk: "wary", voice: "flat" } },
];

const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export class UsageError extends Error {}

// The value is not echoed: a mistyped secret must not end up in logs.
export function validateAccountId(value, label) {
  if (typeof value !== "string" || !ACCOUNT_RE.test(value)) {
    throw new UsageError(`${label} is unset or not a valid NEAR account id (value not shown)`);
  }
  return value;
}

export function parseCount(value) {
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > AGENTS.length) {
    throw new UsageError(`--count must be an integer from 1 to ${AGENTS.length}`);
  }
  return n;
}

export function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

export function tokenMetadata(agent) {
  return {
    title: agent.title,
    description: `${agent.title} agent. Role: ${agent.traits.role}.`,
    extra: JSON.stringify(agent.traits),
  };
}

export function buildDeployStep({ contract, owner, wasm }) {
  const args = { owner_id: owner };
  const argv = [
    "--quiet", "contract", "deploy", contract,
    "use-file", wasm,
    "with-init-call", INIT_METHOD,
    "json-args", JSON.stringify(args),
    "prepaid-gas", GAS,
    "attached-deposit", ZERO_DEPOSIT,
    "network-config", NETWORK,
    "sign-with-keychain", "send",
  ];
  return {
    name: "deploy",
    signer: contract,
    receiver_id: contract,
    method: INIT_METHOD,
    args,
    deposit: ZERO_DEPOSIT,
    gas: GAS,
    argv,
  };
}

export function buildMintStep({ contract, owner, receiver, agent }) {
  const args = {
    token_id: agent.token_id,
    receiver_id: receiver,
    token_metadata: tokenMetadata(agent),
  };
  const argv = [
    "--quiet", "contract", "call-function", "as-transaction", contract, MINT_METHOD,
    "json-args", JSON.stringify(args),
    "prepaid-gas", GAS,
    "attached-deposit", MINT_DEPOSIT,
    "sign-as", owner,
    "network-config", NETWORK,
    "sign-with-keychain", "send",
  ];
  return {
    name: `mint ${agent.token_id}`,
    signer: owner,
    receiver_id: contract,
    method: MINT_METHOD,
    args,
    deposit: MINT_DEPOSIT,
    gas: GAS,
    argv,
  };
}

// Pure: same inputs, same steps.
export function buildPlan({ command, contract, owner, receiver, count = AGENTS.length, wasm = DEFAULT_WASM }) {
  if (command === "deploy") {
    return [buildDeployStep({ contract, owner, wasm })];
  }
  if (command === "mint") {
    return AGENTS.slice(0, count).map((agent) =>
      buildMintStep({ contract, owner, receiver, agent }),
    );
  }
  throw new UsageError(`unknown command: ${command}`);
}

const USAGE = `Usage: node scripts/testnet-deploy.mjs <deploy|mint> [options]

Dry run is the default: prints the near-cli-rs commands and contract calls, signs nothing.

Commands:
  deploy   deploy the contract and run ${INIT_METHOD}(owner_id)
  mint     mint agent tokens (default: all ${AGENTS.length}) with ${MINT_METHOD}

Options:
  --dry-run           print the plan (default)
  --send              sign and broadcast on testnet (needs NEAR_ACCOUNT_ID and a keychain key)
  --json              print the plan as JSON (dry run)
  --count <1-${AGENTS.length}>     mint: how many agents, in the order ${AGENTS.map((a) => a.token_id).join(", ")}
  --receiver <acct>   mint: token receiver (default NEAR_ACCOUNT_ID)
  --wasm <path>       deploy: wasm to deploy (default ${path.relative(process.cwd(), DEFAULT_WASM) || DEFAULT_WASM})
  -h, --help          show this help

Environment:
  NEAR_ACCOUNT_ID           owner and signer (required with --send)
  NEAR_CONTRACT_ACCOUNT_ID  account the contract lives on (default NEAR_ACCOUNT_ID)
  NEAR_NETWORK              unset or testnet; anything else is refused
`;

export function parseArgs(argv) {
  const opts = {
    command: null, send: false, dryRunFlag: false, json: false, help: false,
    count: AGENTS.length, receiver: null, wasm: DEFAULT_WASM,
    countGiven: false, receiverGiven: false, wasmGiven: false,
  };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "deploy":
      case "mint":
        if (opts.command) throw new UsageError("give one command: deploy or mint");
        opts.command = arg;
        break;
      case "--send": opts.send = true; break;
      case "--dry-run": opts.dryRunFlag = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      case "--count": opts.count = parseCount(need(i, arg)); opts.countGiven = true; i += 1; break;
      case "--receiver": opts.receiver = need(i, arg); opts.receiverGiven = true; i += 1; break;
      case "--wasm": opts.wasm = need(i, arg); opts.wasmGiven = true; i += 1; break;
      default: throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  if (opts.help) return opts;
  if (!opts.command) throw new UsageError("missing command: deploy or mint");
  if (opts.send && opts.dryRunFlag) throw new UsageError("--send and --dry-run cannot be combined");
  if (opts.command === "deploy" && (opts.countGiven || opts.receiverGiven)) {
    throw new UsageError("--count and --receiver apply to mint only");
  }
  if (opts.command === "mint" && opts.wasmGiven) throw new UsageError("--wasm applies to deploy only");
  return opts;
}

function defaultExec(bin, argv, { quiet = false } = {}) {
  const result = spawnSync(bin, argv, {
    stdio: quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
  });
  if (result.error) return 127;
  return result.status ?? 1;
}

function formatStep(step, index, total) {
  return [
    `[${index + 1}/${total}] ${step.name}`,
    `  signer   ${step.signer}`,
    `  call     ${step.receiver_id}.${step.method}`,
    `  args     ${JSON.stringify(step.args)}`,
    `  deposit  ${step.deposit}   gas ${step.gas}`,
    `  command  near ${step.argv.map(shellQuote).join(" ")}`,
  ].join("\n");
}

export async function run(argv, env = process.env, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const errOut = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  const hasNear = deps.hasNear ?? (() => exec("near", ["--version"], { quiet: true }) === 0);

  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      out(USAGE);
      return 0;
    }
    if (env.NEAR_NETWORK !== undefined && env.NEAR_NETWORK !== "" && env.NEAR_NETWORK !== NETWORK) {
      throw new UsageError(`NEAR_NETWORK must be unset or ${NETWORK}; this script refuses other networks`);
    }

    const ownerRaw = env.NEAR_ACCOUNT_ID || "";
    const contractRaw = env.NEAR_CONTRACT_ACCOUNT_ID || ownerRaw;
    // A value that is set must be valid in both modes, so a mistyped secret is
    // refused (never echoed) instead of being printed into a dry-run plan.
    // An unset value is only an error with --send; a dry run uses placeholders.
    const checked = (value, label) => (value || opts.send ? validateAccountId(value, label) : null);
    const owner = checked(ownerRaw, "NEAR_ACCOUNT_ID") ?? "<NEAR_ACCOUNT_ID>";
    const contract = checked(contractRaw, "NEAR_CONTRACT_ACCOUNT_ID (or NEAR_ACCOUNT_ID)") ?? "<NEAR_CONTRACT_ACCOUNT_ID>";
    const receiver = (opts.receiver ? validateAccountId(opts.receiver, "--receiver") : null) ?? owner;

    const steps = buildPlan({
      command: opts.command, contract, owner, receiver, count: opts.count, wasm: opts.wasm,
    });

    if (!opts.send) {
      if (opts.json) {
        out(JSON.stringify({
          mode: "dry-run",
          network: NETWORK,
          steps: steps.map(({ argv, ...rest }) => ({ ...rest, command: ["near", ...argv] })),
        }, null, 2));
      } else {
        out(`dry-run: nothing is signed or sent. Add --send to broadcast on ${NETWORK}.`);
        out(`network: ${NETWORK}   owner: ${owner}   contract: ${contract}`);
        out("");
        steps.forEach((step, i) => out(`${formatStep(step, i, steps.length)}\n`));
        if (opts.command === "deploy" && !existsSync(opts.wasm)) {
          out(`warning: wasm not found at ${opts.wasm}. Run npm run build:contract before --send.`);
        }
      }
      return 0;
    }

    // Real mode: every check runs before the first signed transaction.
    if (!hasNear()) {
      errOut("error: near-cli-rs (the `near` command) is not on PATH. Install it first; see README 'Deploy to testnet'.");
      return 1;
    }
    if (opts.command === "deploy" && !existsSync(opts.wasm)) {
      errOut(`error: wasm not found at ${opts.wasm}. Run npm run build:contract first.`);
      return 1;
    }
    const signers = [...new Set(steps.map((step) => step.signer))];
    for (const account of signers) {
      const status = exec("near", ["--quiet", "account", "get-public-key", "from-keychain", account, "network-config", NETWORK], { quiet: true });
      if (status !== 0) {
        errOut(`error: no ${NETWORK} key for ${account} in the near-cli-rs keychain. Add it with near-cli-rs (for example near login); this script never reads or creates keys.`);
        return 1;
      }
    }

    out(`send: ${steps.length} transaction(s) on ${NETWORK} as ${signers.join(", ")}`);
    for (const [i, step] of steps.entries()) {
      out(`[${i + 1}/${steps.length}] ${step.name}`);
      const status = exec("near", step.argv);
      if (status !== 0) {
        errOut(`error: ${step.name} failed with exit ${status}; stopping. Earlier transactions were not rolled back.`);
        return status;
      }
    }
    out("done");
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      errOut(`error: ${err.message}`);
      errOut("");
      errOut(USAGE);
      return 2;
    }
    throw err;
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
