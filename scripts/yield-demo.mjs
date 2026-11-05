#!/usr/bin/env node
// Yield demo: one command that shows the whole yield flow, offline and unsigned.
//
//   npm run yield:demo
//   npm run yield:demo -- --calls
//
// The four personality agents propose one swap each (mock inference over the committed Ref
// pool fixture) and the Yield Optimizer planner is the fifth (committed Rhea snapshot).
// Every proposal is checked with the one JS copy of the vault rules (src/yield/rules.mjs),
// and the unsigned execute_swap calls are printed and written to plan.json / calls.json.
// Always mock: no key is read, no network is used, nothing is signed or sent.

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeOutDir, describeWriteFailure } from "../src/util/outdir.mjs";
import { renderCalls, renderDetails, renderSummary, runDemo } from "../src/yield/demo.mjs";
import { RefusalError, assertNotMainnet } from "../src/yield/send.mjs";
import { SnapshotError, loadSnapshot } from "../src/yield-optimizer/snapshot.mjs";
import { DEFAULT_SNAPSHOT } from "./yield-optimizer.mjs";

const DEFAULT_OUT = "out/yield-demo";
const DEFAULT_SNAPSHOT_LABEL = "src/yield-optimizer/fixtures/rhea-testnet-snapshot.json";

const USAGE = `Usage: node scripts/yield-demo.mjs [--out DIR] [--snapshot FILE] [--calls | --json]
  (no flag)      one-screen summary, then per-agent detail; writes DIR/plan.json and DIR/calls.json
  --out DIR      where plan.json and calls.json go (default ${DEFAULT_OUT}; rewritten each run)
  --snapshot FILE  use this Rhea snapshot for the planner instead of the committed fixture
  --calls        print ONLY the unsigned execute_swap calls (receiver, method, signer, args, gas,
                 deposit, signed: false, sent: false); writes no files
  --json         print the plan JSON only (same content as plan.json); writes no files
  -h, --help     print this help and exit 0
Always a DRY RUN with mock inference: offline, no keys, nothing signed or sent. The same bytes
every run. MOCK_INFERENCE and NEAR_AI_* are ignored. NEAR_NETWORK=mainnet is refused.
Exit 0 ok, 1 refused or failed, 2 usage error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { out: DEFAULT_OUT, snapshot: undefined, calls: false, json: false, help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...o, help: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === "--out") o.out = value();
    else if (a === "--snapshot") o.snapshot = value();
    else if (a === "--calls") o.calls = true;
    else if (a === "--json") o.json = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (o.calls && o.json) throw new UsageError("--calls and --json cannot be combined");
  return o;
}

/** Path for display: relative to cwd when inside it, absolute otherwise. */
function display(path) {
  const rel = relative(process.cwd(), path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/**
 * @param {string[]} argv
 * @param {{ env?: object, log?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const { env = process.env, log = console.log, err = (s) => console.error(s) } = io;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`yield:demo: ${e.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  try {
    assertNotMainnet(env); // before anything else
  } catch (e) {
    if (!(e instanceof RefusalError)) throw e;
    err(`yield:demo: ${e.message}`);
    return e.exitCode;
  }
  const mockEnv = (env.MOCK_INFERENCE ?? "").trim().toLowerCase();
  if (mockEnv === "0" || mockEnv === "false") err("yield:demo: MOCK_INFERENCE=0 ignored: this demo is always offline mock");

  let outDir;
  try {
    outDir = assertSafeOutDir(opts.out);
    if (statSync(outDir, { throwIfNoEntry: false })?.isDirectory() === false) throw new Error(`--out ${JSON.stringify(opts.out)} exists and is not a directory`);
  } catch (e) {
    err(`yield:demo: ${e.message}`);
    return 2;
  }

  let rhea;
  const snapshotFile = opts.snapshot ?? DEFAULT_SNAPSHOT;
  try {
    rhea = loadSnapshot(snapshotFile);
  } catch (e) {
    if (!(e instanceof SnapshotError)) throw e;
    const msg = e.message.includes(snapshotFile) ? e.message : `snapshot ${snapshotFile} rejected: ${e.message}`;
    err(`yield:demo: ${msg}. Nothing was written.`);
    return 1;
  }

  const result = await runDemo({ rhea, rheaSource: opts.snapshot ?? DEFAULT_SNAPSHOT_LABEL });
  const planText = `${JSON.stringify(result.doc, null, 2)}\n`;
  if (opts.json) {
    log(planText.trimEnd());
    return 0;
  }
  if (opts.calls) {
    log(renderCalls(result.calls.calls));
    return 0;
  }

  const planFile = join(outDir, "plan.json");
  const callsFile = join(outDir, "calls.json");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(planFile, planText);
    writeFileSync(callsFile, `${JSON.stringify(result.calls, null, 2)}\n`);
  } catch (e) {
    const msg = describeWriteFailure(display(outDir), e);
    if (!msg) throw e;
    err(`yield:demo: ${msg}`);
    return 1;
  }
  log(renderSummary(result, [display(planFile), display(callsFile)]));
  log("");
  log(renderDetails(result));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
