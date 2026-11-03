#!/usr/bin/env node
// One command for the eventual live testnet proof: deploy, mint 4, anchor_sheet.
//
//   npm run live-proof                 dry run (default): prints the three steps and
//                                      writes out/live-proof/evidence.example.json ("example": true)
//   npm run live-proof -- --send --i-approve --media-base <url>
//                                      really sends. Refused unless NEAR_ACCOUNT_ID and
//                                      NEAR_CONTRACT_ACCOUNT_ID are set AND --i-approve is given
//                                      AND --media-base names where the four SVGs are hosted
//                                      (testnet-deploy's mint --send refuses to run without it, so
//                                      the gate is here, before deploy, not after it).
//                                      Collects the transaction hashes the near CLI prints into
//                                      out/live-proof/txs.json and prints the exact
//                                      `npm run evidence` command that reads them.
//
// No key handling here. Signing is done by the near CLI with the system keychain, through
// scripts/testnet-deploy.mjs (deploy, mint) and a near-cli-rs call built below (anchor_sheet).
// The dry run never spawns anything and never touches the network.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAnchor } from "../src/anchor/anchor.mjs";
import { AGENTS, run as deployRun, shellQuote, validateAccountId, validateMediaBase, UsageError, NETWORK } from "./testnet-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Dry runs write under out/ (gitignored) so a judge's tree stays clean. The tracked
// example is rewritten only with --update-example.
export const DEFAULT_OUT = path.join(HERE, "..", "out", "live-proof", "evidence.example.json");
export const TRACKED_EXAMPLE = path.join(HERE, "..", "docs", "evidence.example.json");
export const TESTNET_DEPLOY = path.join(HERE, "testnet-deploy.mjs");
// Where --send stores the transaction hashes it collected, in the shape scripts/evidence.mjs
// reads through EVIDENCE_TX_FILE. The label is the repo-relative path (npm run executes
// from the package root), so the printed command is the same on every machine.
export const TX_FILE_LABEL = "out/live-proof/txs.json";
export const TX_FILE = path.join(HERE, "..", ...TX_FILE_LABEL.split("/"));
/** The complete owner command, as the docs quote it. mint --send needs --media-base, so it is not optional. */
export const SEND_COMMAND = "npm run live-proof -- --send --i-approve --media-base <url>";
/** The exact `npm run evidence` invocation that turns the collected hashes into out/evidence.json. */
export const evidenceCommand = (contract) => `EVIDENCE_NETWORK=${NETWORK} NEAR_ACCOUNT_ID=${contract} EVIDENCE_TX_FILE=${TX_FILE_LABEL} npm run evidence`;
// The labels evidence.mjs will show, one per transaction, in send order.
export const TX_LABELS = ["deploy", ...AGENTS.map((a) => `mint ${a.token_id}`), "anchor_sheet"];
// near-cli-rs reports a sent transaction as "Transaction ID: <hash>" and as an explorer link
// ending in /transactions/<hash>. Only those two contexts count: a bare base58 scan would also
// pick up account ids and the base64 media_hash echoed in the printed args.
const TX_HASH_RE = /(?:Transaction ID:\s*|\/transactions\/)([1-9A-HJ-NP-Za-km-z]{32,64})\b/g;

/** Unique transaction hashes in the order the near CLI printed them. Pure. */
export function extractTransactionHashes(output) {
  return [...new Set([...String(output).matchAll(TX_HASH_RE)].map((m) => m[1]))];
}
const RELATIVE_WASM = "contracts/personality-nft/target/near/personality_nft.wasm";
const SHEET = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";
const ANCHOR_TOKEN = "aloof";
const PLACEHOLDER_CONTRACT = "<NEAR_CONTRACT_ACCOUNT_ID>";
const PLACEHOLDER_OWNER = "<NEAR_ACCOUNT_ID>";

const USAGE = `Usage: node scripts/live-proof.mjs [--send --i-approve --media-base <url>] [--out <file>] [--update-example]

Default is a dry run: prints the deploy, mint (4 tokens) and anchor_sheet steps and writes
an example evidence file. Nothing is signed or sent.

  --send         really send all steps on testnet (needs NEAR_ACCOUNT_ID,
                 NEAR_CONTRACT_ACCOUNT_ID, --i-approve and --media-base); writes the
                 transaction hashes to ${TX_FILE_LABEL} and prints the npm run evidence command
  --i-approve    explicit human approval for --send
  --media-base <url>  base URL where <token_id>.svg is hosted; passed to the mint step.
                 Required with --send (mint --send refuses the placeholder); in a dry run
                 it replaces the labelled placeholder media URL
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

/** The mint arguments live-proof hands to testnet-deploy, dry run and send alike. */
const mintArgs = (mediaBase) => (mediaBase ? ["--media-base", mediaBase] : []);

/** The three steps, in order. Pure: same inputs, same plan. */
export async function buildPlan({ contract, owner, env, mediaBase = null }) {
  const capture = async (cmd, extra = []) => {
    const lines = [];
    const code = await deployRun([cmd, "--json", ...extra], env, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    if (code !== 0) throw new Error(`${cmd} dry run failed: ${lines.join("\n")}`);
    return JSON.parse(lines.join("\n")).steps;
  };
  const [deploy] = await capture("deploy", ["--wasm", RELATIVE_WASM]); // relative, so the output is the same on every machine
  const mints = await capture("mint", mintArgs(mediaBase));
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
  const opts = { send: false, approve: false, mediaBase: null, out: DEFAULT_OUT, outLabel: OUT_LABELS.default, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--send") opts.send = true;
    else if (a === "--i-approve") opts.approve = true;
    else if (a === "--update-example") opts.updateExample = true;
    else if (a === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new UsageError(`--out needs a file path, got ${JSON.stringify(value)}`);
      opts.out = value;
      opts.outLabel = OUT_LABELS.custom;
      i += 1;
      opts.outGiven = true;
    } else if (a === "--media-base") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new UsageError(`--media-base needs a value, got ${JSON.stringify(value)}`);
      opts.mediaBase = validateMediaBase(value);
      i += 1;
    } else if (a === "-h" || a === "--help") opts.help = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (opts.updateExample && opts.outGiven) throw new UsageError("--update-example and --out cannot be combined");
  if (opts.updateExample) { opts.out = TRACKED_EXAMPLE; opts.outLabel = OUT_LABELS.tracked; }
  return opts;
}

// Runs a step, streaming its stdout and stderr to the terminal as they arrive while also
// keeping a copy: near-cli-rs prints the transaction hash to either stream.
function defaultExec(bin, argv) {
  return new Promise((resolve) => {
    const chunks = [];
    const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { chunks.push(d); process.stdout.write(d); });
    child.stderr.on("data", (d) => { chunks.push(d); process.stderr.write(d); });
    child.on("error", () => resolve({ code: 127, output: Buffer.concat(chunks).toString("utf8") }));
    child.on("close", (status) => resolve({ code: status ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

// Pairs the hashes found in one stage's output with the labels that stage was expected to
// produce (deploy: 1, mint: one per agent, anchor_sheet: 1). Extra hashes keep the stage name.
function labelHashes(stage, hashes) {
  const expected = TX_LABELS.filter((l) => (stage === "mint" ? l.startsWith("mint ") : l === stage));
  return hashes.map((hash, i) => ({ label: expected[i] ?? stage, hash }));
}

function writeTxFile({ contract, owner, transactions }) {
  mkdirSync(path.dirname(TX_FILE), { recursive: true });
  writeFileSync(TX_FILE, `${JSON.stringify({ network: NETWORK, contract, owner, transactions }, null, 2)}\n`);
}

/**
 * deps.exec(bin, argv) -> { code, output } (or a promise of it). Injected in tests so nothing
 * is spawned; `output` is what the step printed, scanned for transaction hashes.
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
      // mint --send (scripts/testnet-deploy.mjs) refuses to run without --media-base. Gated here,
      // so a send never gets as far as deploying and then stopping at the mint step.
      if (!opts.mediaBase) {
        throw new UsageError("--send needs --media-base <url>: the base URL where the four <token_id>.svg files are hosted, which mint --send requires. Nothing was sent.");
      }
      const owner = validateAccountId(env.NEAR_ACCOUNT_ID, "NEAR_ACCOUNT_ID");
      const contract = validateAccountId(env.NEAR_CONTRACT_ACCOUNT_ID, "NEAR_CONTRACT_ACCOUNT_ID");
      out(`send: deploy, mint x4, anchor_sheet on ${NETWORK} as ${owner}, contract ${contract}`);
      const anchor = buildAnchorStep({ contract, owner });
      const stages = [
        ["deploy", "node", [TESTNET_DEPLOY, "deploy", "--send"]],
        ["mint", "node", [TESTNET_DEPLOY, "mint", "--send", ...mintArgs(opts.mediaBase)]],
        ["anchor_sheet", "near", anchor.argv],
      ];
      const transactions = [];
      const finish = (code) => {
        // Written even after a failed step: the earlier transactions are real and stay on chain.
        writeTxFile({ contract, owner, transactions });
        const missing = TX_LABELS.filter((l) => !transactions.some((t) => t.label === l));
        out(`wrote ${transactions.length} of ${TX_LABELS.length} transaction hashes to ${TX_FILE_LABEL}`);
        if (missing.length) {
          out(`WARN: no hash found in the near CLI output for: ${missing.join(", ")}. Add each as {"label": ..., "hash": ...} to the transactions array in ${TX_FILE_LABEL} before running evidence.`);
        }
        out(code === 0 ? "done. Next, with read-only RPC views (nothing signed):" : "Next, once every hash is in the file (read-only RPC views, nothing signed):");
        out(`  ${evidenceCommand(contract)}`);
        return code;
      };
      for (const [stage, bin, args] of stages) {
        const { code, output } = await exec(bin, args);
        transactions.push(...labelHashes(stage, extractTransactionHashes(output)));
        if (code !== 0) {
          errOut(`error: ${stage} failed with exit ${code}; stopping. Earlier transactions were not rolled back.`);
          return finish(code);
        }
      }
      return finish(0);
    }

    const owner = env.NEAR_ACCOUNT_ID ? validateAccountId(env.NEAR_ACCOUNT_ID, "NEAR_ACCOUNT_ID") : PLACEHOLDER_OWNER;
    const contract = env.NEAR_CONTRACT_ACCOUNT_ID ? validateAccountId(env.NEAR_CONTRACT_ACCOUNT_ID, "NEAR_CONTRACT_ACCOUNT_ID") : PLACEHOLDER_CONTRACT;
    const planEnv = { NEAR_ACCOUNT_ID: owner === PLACEHOLDER_OWNER ? "" : owner, NEAR_CONTRACT_ACCOUNT_ID: contract === PLACEHOLDER_CONTRACT ? "" : contract };
    const steps = await buildPlan({ contract, owner, env: planEnv, mediaBase: opts.mediaBase });
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
      errOut(`error: ${err.message} (see --help)`);
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
