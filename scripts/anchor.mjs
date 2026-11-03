#!/usr/bin/env node
// Dry-run anchor CLI: prints the round hashes and the anchor_sheet payload
// for a fixed mock run. It never signs, never reads keys, never uses the
// network. --check builds the mock run twice and fails if any hash differs.
//
//   npm run anchor -- --dry-run [--check]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAnchor, submitAnchor } from "../src/anchor/anchor.mjs";
import { hashSheet } from "../src/anchor/hash.mjs";
import { runSwarm, verifyRounds } from "../src/swarm/runner.mjs";

const MOCK_SHEET = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";

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
  if (argv.includes("--help") || argv.includes("-h")) {
    out("usage: npm run anchor -- --dry-run [--check]  (dry run only; this CLI never signs)");
    return 0;
  }
  const known = new Set(["--dry-run", "--check"]);
  const bad = argv.filter((a) => !known.has(a));
  if (bad.length > 0 || !argv.includes("--dry-run")) {
    console.error("usage: npm run anchor -- --dry-run [--check]  (dry run only; this CLI never signs)");
    return 2;
  }
  const first = await mockReport();
  if (argv.includes("--check")) {
    const second = await mockReport();
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      console.error("FAIL: the same mock run gave different hashes");
      return 1;
    }
    out(`OK: round hashes are deterministic (${first.roundHashes.length} rounds, same mock run twice)`);
  }
  out(JSON.stringify(first, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.message);
    process.exit(1);
  });
}
