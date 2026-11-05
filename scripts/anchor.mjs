#!/usr/bin/env node
// Dry-run anchor CLI: prints the round hashes and the anchor_sheet payload
// for a fixed mock run. It never signs, never reads keys, never uses the
// network. --check builds the mock run twice and fails if any hash differs.
//
//   npm run anchor -- --dry-run [--check]

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAnchor, submitAnchor } from "../src/anchor/anchor.mjs";
import { hashSheet } from "../src/anchor/hash.mjs";
import { plural } from "../src/util/plural.mjs";
import { runSwarm, verifyRounds } from "../src/swarm/runner.mjs";

const MOCK_SHEET = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";

const USAGE = `usage: npm run anchor -- --dry-run [--check]  (dry run only; this CLI never signs)
  --dry-run   required: build the fixed mock run and print its round hashes and the anchor_sheet payload
  --check     build the mock run twice and fail if any hash differs
Offline: no keys, no network, nothing signed or sent.`;

/** A user mistake on the command line. Reported as one line with "(see --help)" and exit 2. */
export class UsageError extends Error {}

/** Returns { help } or { help: false, check }. Throws UsageError on anything unexpected. */
export function parseArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true };
  const known = new Set(["--dry-run", "--check"]);
  const bad = argv.find((a) => !known.has(a));
  if (bad !== undefined) throw new UsageError(`unknown argument ${JSON.stringify(bad)}`);
  if (!argv.includes("--dry-run")) throw new UsageError("--dry-run is required; this CLI never signs");
  return { help: false, check: argv.includes("--check") };
}

/** A fixed offline swarm run (persona mocks, fixed seed). No clock, no randomness. */
export function buildMockRun() {
  return runSwarm({ rounds: 3, seed: 1 });
}

/** Round hashes (the swarm's hash chain) per round, plus the sheet anchor payload. */
export async function mockReport() {
  const run = await buildMockRun();
  if (!verifyRounds(run)) throw new Error("swarm hash chain does not verify");
  const prepared = prepareAnchor({
    contractId: "mock-contract.testnet",
    tokenId: "aloof",
    sheet: MOCK_SHEET,
    network: "testnet",
  });
  const { status, transactionHash } = await submitAnchor(prepared); // dry run: no send
  return {
    mode: "dry-run",
    status,
    transactionHash,
    roundHashes: run.roundHashes.map((hash, i) => ({ round: i + 1, hash })),
    sheetHash: hashSheet(MOCK_SHEET),
    anchor: prepared,
  };
}

export async function main(argv = process.argv.slice(2), out = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`anchor: ${err.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const first = await mockReport();
  if (opts.check) {
    const second = await mockReport();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      console.error("FAIL: the same mock run gave different hashes");
      return 1;
    }
    out(`OK: round hashes are deterministic (${plural(first.roundHashes.length, "round")}, same mock run twice)`);
  }
  out(JSON.stringify(first, null, 2));
  return 0;
}

// import.meta.url is a realpath; argv[1] is not when the script is run through a symlink.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntryPoint()) {
  main().then((code) => process.exit(code), (err) => {
    console.error(`anchor: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
