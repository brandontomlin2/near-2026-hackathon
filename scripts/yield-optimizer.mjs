#!/usr/bin/env node
// Yield Optimizer (fifth personality), DRY RUN ONLY. Reads a pool/price
// snapshot, applies the yield-vault contract's rules, and prints a readable
// plan plus a JSON plan whose call args match `execute_swap(proposal)`.
// It never signs, never sends, never reads keys and never uses the network.
//
//   node scripts/yield-optimizer.mjs [--snapshot <file>] [--slippage-bps N] [--min-edge-bps N] [--json]

import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlan, DEFAULTS, renderPlan } from "../src/yield-optimizer/plan.mjs";
import { loadSnapshot, SnapshotError } from "../src/yield-optimizer/snapshot.mjs";

export const DEFAULT_SNAPSHOT = fileURLToPath(
  new URL("../src/yield-optimizer/fixtures/rhea-testnet-snapshot.json", import.meta.url),
);

const USAGE = `usage: node scripts/yield-optimizer.mjs [--snapshot <file>] [--slippage-bps N] [--min-edge-bps N] [--json]
  --snapshot <file>    pool/price snapshot JSON (default: the committed Rhea testnet-style fixture)
  --slippage-bps N     slippage tolerance for min_amount_out, integer 0..9999 (default ${DEFAULTS.slippage_bps})
  --min-edge-bps N     minimum edge over the reference price to trade, integer 0..10000 (default ${DEFAULTS.min_edge_bps})
  --json               print only the JSON plan
DRY RUN only: no keys, no network, nothing signed or sent.`;

/** A user mistake on the command line: one line, "(see --help)", exit 2. */
export class UsageError extends Error {}

function intOpt(name, value, max) {
  if (value === undefined || !/^\d+$/.test(value)) throw new UsageError(`${name} needs an integer value`);
  const n = Number(value);
  if (n > max) throw new UsageError(`${name} must be 0..${max}, got ${value}`);
  return n;
}

/** Returns { help } or { help: false, snapshot, json, opts }. Throws UsageError. */
export function parseArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true };
  const out = { help: false, snapshot: DEFAULT_SNAPSHOT, json: false, opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--json") out.json = true;
    else if (a === "--snapshot") out.snapshot = value();
    else if (a === "--slippage-bps") out.opts.slippage_bps = intOpt(a, value(), 9_999);
    else if (a === "--min-edge-bps") out.opts.min_edge_bps = intOpt(a, value(), 10_000);
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  return out;
}

/** Runs the CLI. Returns the exit code; writes through the given streams. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr.write(`yield-optimizer (DRY RUN): ${e.message} (see --help)\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  let snap;
  try {
    snap = loadSnapshot(args.snapshot);
  } catch (e) {
    if (!(e instanceof SnapshotError)) throw e;
    stderr.write(`DRY RUN: snapshot rejected, no plan made. ${e.message}\n`);
    return 1;
  }
  const plan = buildPlan(snap, args.opts);
  const json = JSON.stringify(plan.json, null, 2);
  stdout.write(args.json ? `${json}\n` : `${renderPlan(snap, plan)}\n\nJSON plan (DRY RUN, not sent):\n${json}\n`);
  return 0;
}

// Resolve symlinks: import.meta.url is a realpath, argv[1] may not be.
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
