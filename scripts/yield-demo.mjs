#!/usr/bin/env node
// Yield demo: one command that shows the whole yield flow, offline and unsigned.
//
//   npm run yield:demo
//   npm run yield:demo -- --calls
//
// The four personality agents propose one swap each (mock inference over the committed Ref
// pool fixture) and the Yield Optimizer planner is the fifth, on that same Ref snapshot.
// Every proposal is checked with the one JS copy of the vault rules (src/yield/rules.mjs),
// and the unsigned execute_swap calls are printed and written to plan.json / calls.json;
// index.html is the same dry run as one static page (no script, no external asset).
// Always mock: no key is read, no network is used, nothing is signed or sent.

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeOutDir, describeWriteFailure } from "../src/util/outdir.mjs";
import { renderDemoPage } from "../src/yield/demo-page.mjs";
import { DEFAULT_LIVE_CONFIG, DEMO_SEND_REFUSAL, isRefusedDemoFlag, liveStatus } from "../src/yield/demo-live.mjs";
import { PLANNER_ID, renderCalls, renderDetails, renderSummary, runDemo } from "../src/yield/demo.mjs";
import { RefusalError, assertNotMainnet } from "../src/yield/send.mjs";
import { SnapshotError, loadSnapshot } from "../src/yield-optimizer/snapshot.mjs";

const DEFAULT_OUT = "out/yield-demo";

const USAGE = `Usage: node scripts/yield-demo.mjs [--out DIR] [--snapshot FILE] [--live-config FILE] [--calls | --json]
  (no flag)      one-screen summary, then per-agent detail; writes DIR/plan.json, DIR/calls.json
                 and DIR/index.html (the same dry run as a static page)
  --out DIR      where plan.json, calls.json and index.html go (default ${DEFAULT_OUT}; rewritten each run)
  --snapshot FILE  plan on this market + vault file instead of the shared Ref snapshot (Ref-shaped pools and tokens
                 plus a "vault" section and taken_at or now_ms; see src/yield-optimizer/fixtures/scenario.hand-built.json);
                 the four agents still use the committed Ref snapshot
  --live-config FILE  the gitignored live config the "live path:" line reads (default ${DEFAULT_LIVE_CONFIG};
                 a missing default file just means "not configured"). The line says ARMED, and prints the
                 exact live commands for a human, only when the config is valid with "placeholders": false
                 AND YIELD_LIVE_ARMED=1 AND NEAR_NETWORK=testnet. The demo still runs none of them.
  --calls        print ONLY the unsigned execute_swap calls (receiver, method, signer, args, gas,
                 deposit, signed: false, sent: false); writes no files
  --json         print the plan JSON only (same content as plan.json); writes no files
  -h, --help     print this help and exit 0
Always a DRY RUN with mock inference: offline, no keys, nothing signed or sent. The same bytes
every run. MOCK_INFERENCE and NEAR_AI_* are ignored. NEAR_NETWORK=mainnet and a --snapshot naming a .near
vault or runner are refused. --send, --i-approve and any flag containing "sign" or "private" are refused
(exit 2) before anything is read: this demo never signs or sends, armed or not.
Exit 0 ok, 1 refused or failed, 2 usage error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { out: DEFAULT_OUT, snapshot: undefined, liveConfig: undefined, calls: false, json: false, help: false };
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
    else if (a === "--live-config") o.liveConfig = value();
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
  // Hard refusal first, even before --help: the demo has no send path to arm.
  if (argv.some(isRefusedDemoFlag)) {
    err(`yield:demo: ${DEMO_SEND_REFUSAL}`);
    return 2;
  }
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

  let snapshot;
  try {
    snapshot = loadSnapshot(opts.snapshot ?? null);
  } catch (e) {
    if (!(e instanceof SnapshotError)) throw e;
    const msg = opts.snapshot === undefined || e.message.includes(opts.snapshot) ? e.message : `snapshot ${opts.snapshot} rejected: ${e.message}`;
    err(`yield:demo: ${msg}. Nothing was written.`);
    return 1;
  }

  const result = await runDemo({ snapshot, snapshotFile: opts.snapshot ?? null });

  let live;
  try {
    live = liveStatus({ env, configPath: opts.liveConfig ?? DEFAULT_LIVE_CONFIG, explicit: opts.liveConfig !== undefined, demoProposal: result.calls.calls.find((c) => c.agent === PLANNER_ID)?.args.proposal });
  } catch (e) {
    if (!(e instanceof RefusalError)) throw e;
    err(`yield:demo: ${e.message}`);
    return e.exitCode;
  }

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
  const indexFile = join(outDir, "index.html");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(planFile, planText);
    writeFileSync(callsFile, `${JSON.stringify(result.calls, null, 2)}\n`);
    writeFileSync(indexFile, renderDemoPage(result));
  } catch (e) {
    const msg = describeWriteFailure(display(outDir), e);
    if (!msg) throw e;
    err(`yield:demo: ${msg}`);
    return 1;
  }
  log(renderSummary(result, [display(planFile), display(callsFile), display(indexFile)]));
  log(live.lines.join("\n"));
  log("");
  log(renderDetails(result));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
