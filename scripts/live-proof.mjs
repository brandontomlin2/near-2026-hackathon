#!/usr/bin/env node
// One command for the eventual live testnet proof: deploy, mint 4, anchor_sheet.
//
//   npm run live-proof                 dry run (default): prints the three steps and
//                                      writes out/live-proof/evidence.example.json ("example": true)
//   npm run live-proof -- --send --i-approve
//                                      really sends. Refused unless NEAR_ACCOUNT_ID and
//                                      NEAR_CONTRACT_ACCOUNT_ID are set AND --i-approve is given.
//
// No key handling here. Signing is done by the near CLI with the system keychain, through
// scripts/testnet-deploy.mjs (deploy, mint) and a near-cli-rs call built below (anchor_sheet).
// The dry run never spawns anything and never touches the network.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAnchor } from "../src/anchor/anchor.mjs";
import { run as deployRun, shellQuote, validateAccountId, UsageError, NETWORK } from "./testnet-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Dry runs write under out/ (gitignored) so a judge's tree stays clean. The tracked
// example is rewritten only with --update-example.
export const DEFAULT_OUT = path.join(HERE, "..", "out", "live-proof", "evidence.example.json");
export const TRACKED_EXAMPLE = path.join(HERE, "..", "docs", "evidence.example.json");
export const TESTNET_DEPLOY = path.join(HERE, "testnet-deploy.mjs");
const RELATIVE_WASM = "contracts/personality-nft/target/near/personality_nft.wasm";
const SHEET = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";
const ANCHOR_TOKEN = "aloof";
const PLACEHOLDER_CONTRACT = "<NEAR_CONTRACT_ACCOUNT_ID>";
const PLACEHOLDER_OWNER = "<NEAR_ACCOUNT_ID>";

const USAGE = `Usage: node scripts/live-proof.mjs [--send --i-approve] [--out <file>] [--update-example]

Default is a dry run: prints the deploy, mint (4 tokens) and anchor_sheet steps and writes
an example evidence file. Nothing is signed or sent.

  --send         really send all steps on testnet (needs NEAR_ACCOUNT_ID,
                 NEAR_CONTRACT_ACCOUNT_ID and --i-approve)
  --i-approve    explicit human approval for --send
  --out <file>   where the dry run writes the example (default out/live-proof/evidence.example.json)
  --update-example  write the tracked docs/evidence.example.json instead (maintainers only)
`;

/** Near CLI argv for the anchor_sheet call, built from the existing anchor payload. */
export function buildAnchorStep({ contract, owner }) {
  const p = prepareAnchor({ contractId: contract === PLACEHOLDER_CONTRACT ? "placeholder.testnet" : contract, tokenId: ANCHOR_TOKEN, sheet: SHEET, network: NETWORK });
  const gasTgas = `${Number(BigInt(p.gas) / 10n ** 12n)} Tgas`;
  const deposit = "0.01 NEAR";
  const argv = [
    "--quiet", "contract", "call-function", "as-transaction", contract, p.methodName,
    "json-args", JSON.stringify(p.args),
    "prepaid-gas", gasTgas,
    "attached-deposit", deposit,
    "sign-as", owner,
    "network-config", NETWORK,
    "sign-with-keychain", "send",
  ];
  return { name: "anchor_sheet", signer: owner, receiver_id: contract, method: p.methodName, args: p.args, deposit, gas: gasTgas, sheetHash: p.sheetHash, argv };
}

/** The three steps, in order. Pure: same inputs, same plan. */
export async function buildPlan({ contract, owner, env }) {
  const capture = async (cmd, extra = []) => {
    const lines = [];
    const code = await deployRun([cmd, "--json", ...extra], env, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    if (code !== 0) throw new Error(`${cmd} dry run failed: ${lines.join("\n")}`);
    return JSON.parse(lines.join("\n")).steps;
  };
  const [deploy] = await capture("deploy", ["--wasm", RELATIVE_WASM]); // relative, so the output is the same on every machine
  const mints = await capture("mint");
  return [deploy, ...mints, buildAnchorStep({ contract, owner })];
}

const nearLine = (step) => `near ${(step.argv ?? [...(step.command ?? []).slice(1)]).map(shellQuote).join(" ")}`;

function formatPlan(steps) {
  const lines = [];
  steps.forEach((s, i) => {
    lines.push(`[${i + 1}/${steps.length}] ${s.name}`);
    lines.push(`  call     ${s.receiver_id}.${s.method}`);
    lines.push(`  args     ${JSON.stringify(s.args)}`);
    lines.push(`  deposit  ${s.deposit}   gas ${s.gas}`);
    lines.push(`  command  ${s.argv ? nearLine(s) : (s.command ?? []).map(shellQuote).join(" ")}`);
    lines.push("");
  });
  return lines.join("\n");
}

/** Evidence in the shape a live run would produce (see scripts/evidence.mjs). Clearly an example. */
export function exampleEvidence({ contract, owner, steps }) {
  const anchor = steps.at(-1);
  const mints = steps.filter((s) => s.name.startsWith("mint "));
  const tokens = mints.map((m) => ({
    token_id: m.args.token_id,
    owner_id: owner,
    metadata: { title: m.args.token_metadata.title, description: m.args.token_metadata.description, extra: m.args.token_metadata.extra },
  }));
  return {
    example: true,
    mock: true,
    network: NETWORK,
    note: "EXAMPLE ONLY. Shape of a live run's evidence. No chain was queried and no transaction was sent. Hashes are placeholders.",
    contract,
    transactions: [
      { label: "deploy", hash: "EXAMPLE-deploy-tx-hash", explorer: `https://explorer.testnet.near.org/transactions/EXAMPLE-deploy-tx-hash` },
      ...mints.map((m) => ({ label: m.name, hash: `EXAMPLE-${m.name.replace(/\s+/g, "-")}-tx-hash`, explorer: `https://explorer.testnet.near.org/transactions/EXAMPLE-${m.name.replace(/\s+/g, "-")}-tx-hash` })),
      { label: "anchor_sheet", hash: "EXAMPLE-anchor_sheet-tx-hash", explorer: "https://explorer.testnet.near.org/transactions/EXAMPLE-anchor_sheet-tx-hash" },
    ],
    views: [
      { method: "nft_total_supply", args: {}, result: String(mints.length) },
      { method: "nft_token", args: { token_id: tokens[0].token_id }, result: { ...tokens[0] } },
      { method: "sheet_anchor", args: { token_id: anchor.args.token_id }, result: { sheet_hash: anchor.sheetHash, memory_depth: 2, updated_at: "EXAMPLE-timestamp" } },
    ],
  };
}

// How the dry run names its destination on stdout. Only the role of the file is printed,
// never a cwd- or TMPDIR-dependent path, so the output is identical on every machine and
// in every checkout (the stability tests compare two runs byte for byte).
const OUT_LABELS = { default: "out/live-proof/evidence.example.json", tracked: "docs/evidence.example.json", custom: "the --out file" };

function parseArgs(argv) {
  const opts = { send: false, approve: false, out: DEFAULT_OUT, outLabel: OUT_LABELS.default, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--send") opts.send = true;
    else if (a === "--i-approve") opts.approve = true;
    else if (a === "--update-example") { opts.out = TRACKED_EXAMPLE; opts.outLabel = OUT_LABELS.tracked; }
    else if (a === "--out") {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("-")) throw new UsageError("--out needs a file path");
      opts.out = argv[(i += 1)];
      opts.outLabel = OUT_LABELS.custom;
    } else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}

function defaultExec(bin, argv) {
  const r = spawnSync(bin, argv, { stdio: ["ignore", "inherit", "inherit"] });
  return r.error ? 127 : (r.status ?? 1);
}

/**
 * deps.exec(bin, argv) -> exit code. Injected in tests so nothing is spawned.
 */
export async function run(argv, env = process.env, deps = {}) {
  const out = deps.out ?? ((l) => process.stdout.write(`${l}\n`));
  const errOut = deps.err ?? ((l) => process.stderr.write(`${l}\n`));
  const exec = deps.exec ?? defaultExec;
  try {
    const opts = parseArgs(argv);
    if (opts.help) { out(USAGE); return 0; }

    if (opts.send) {
      // Every gate runs before the first spawn.
      if (!opts.approve) throw new UsageError("--send needs --i-approve (explicit human approval). Nothing was sent.");
      const owner = validateAccountId(env.NEAR_ACCOUNT_ID, "NEAR_ACCOUNT_ID");
      const contract = validateAccountId(env.NEAR_CONTRACT_ACCOUNT_ID, "NEAR_CONTRACT_ACCOUNT_ID");
      out(`send: deploy, mint x4, anchor_sheet on ${NETWORK} as ${owner}, contract ${contract}`);
      const anchor = buildAnchorStep({ contract, owner });
      const stages = [
        ["node", [TESTNET_DEPLOY, "deploy", "--send"]],
        ["node", [TESTNET_DEPLOY, "mint", "--send"]],
        ["near", anchor.argv],
      ];
      for (const [bin, args] of stages) {
        const code = exec(bin, args);
        if (code !== 0) {
          errOut(`error: step failed with exit ${code}; stopping. Earlier transactions were not rolled back.`);
          return code;
        }
      }
      out("done. Collect the tx hashes above into a file, then:");
      out(`  EVIDENCE_NETWORK=testnet NEAR_ACCOUNT_ID=${contract} EVIDENCE_TX_FILE=<txs.json> npm run evidence`);
      return 0;
    }

    const owner = env.NEAR_ACCOUNT_ID ? validateAccountId(env.NEAR_ACCOUNT_ID, "NEAR_ACCOUNT_ID") : PLACEHOLDER_OWNER;
    const contract = env.NEAR_CONTRACT_ACCOUNT_ID ? validateAccountId(env.NEAR_CONTRACT_ACCOUNT_ID, "NEAR_CONTRACT_ACCOUNT_ID") : PLACEHOLDER_CONTRACT;
    const planEnv = { NEAR_ACCOUNT_ID: owner === PLACEHOLDER_OWNER ? "" : owner, NEAR_CONTRACT_ACCOUNT_ID: contract === PLACEHOLDER_CONTRACT ? "" : contract };
    const steps = await buildPlan({ contract, owner, env: planEnv });
    out(`dry-run: nothing is signed or sent. Add --send --i-approve to broadcast on ${NETWORK}.`);
    out(`network: ${NETWORK}   owner: ${owner}   contract: ${contract}`);
    out("");
    out(formatPlan(steps));
    const evidence = exampleEvidence({ contract, owner, steps });
    mkdirSync(path.dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(evidence, null, 2)}\n`);
    out(`wrote example evidence (example: true) to ${opts.outLabel}`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      errOut(`error: ${err.message}`);
      return 2;
    }
    // Filesystem failures on --out and the like: one line, no stack.
    errOut(`error: ${String(err?.message ?? err).split("\n")[0]}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
