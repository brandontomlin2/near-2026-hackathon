// Run the swarm and write out/swarm/transcript.txt and out/swarm/events.json, then run
// the memory loop (dry run only): out/swarm/sheets/<token>.json and out/swarm/memory-loop.json.
// (npm run demo owns out/ itself, so the two never overwrite each other.)
// Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--every N] [--out DIR]
// A sheet is written every N rounds (default 3, like npm run demo; or set
// SUMMARY_EVERY_N_ROUNDS) and at the final round. --every beats the env var.
// Mock inference by default: offline, deterministic, in-character lines, no
// keys. Live NEAR AI Cloud only with MOCK_INFERENCE=0 (reads NEAR_AI_API_KEY).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ROUNDS, runSwarm, verifyRounds } from "../src/swarm/runner.mjs";
import { createInferenceClient, parseMode } from "../src/inference/client.mjs";
import { DEFAULT_LOOP_EVERY, runMemoryLoop } from "../src/memory/loop.mjs";
import { parseSummaryEvery } from "../src/memory/summarizer.mjs";
import { AGENTS } from "../src/traits/agents.mjs";
import { assertSafeOutDir, clearOwnedFiles } from "../src/util/outdir.mjs";

const USAGE = `Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--every N] [--out DIR]
  --rounds N  swarm rounds, 1 to ${MAX_ROUNDS} (default 5)
  --seed N    swarm seed, a non-negative integer (default 1)
  --every N   write a sheet every N rounds, 1 to ${MAX_ROUNDS} (default ${DEFAULT_LOOP_EVERY}, or SUMMARY_EVERY_N_ROUNDS)
  --out DIR   output directory (default out/swarm)
Mock inference by default: offline, nothing is signed or sent.`;

function parseArgs(argv) {
  const opts = { rounds: 5, seed: 1, every: undefined, out: "out/swarm", help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...opts, help: true }; // help wins over any other argument
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--rounds" || flag === "--seed" || flag === "--every") {
      // A seed may be 0 (same rule as scripts/demo.mjs); rounds and every must be at least 1.
      const pattern = flag === "--seed" ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
      if (value === undefined || !pattern.test(value) || !Number.isSafeInteger(Number(value))) {
        const kind = flag === "--seed" ? "a non-negative integer" : "a positive integer";
        throw new Error(`${flag} must be ${kind}, got ${JSON.stringify(value)}`);
      }
      if (flag !== "--seed" && Number(value) > MAX_ROUNDS) throw new Error(`${flag} must be at most ${MAX_ROUNDS}, got ${value}`);
      opts[flag.slice(2)] = Number(value);
      i++;
    } else if (flag === "--out") {
      if (!value || value.startsWith("-")) throw new Error(`--out needs a directory, got ${JSON.stringify(value)}`);
      opts.out = value;
      i++;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
    // parseSummaryEvery throws on a bad SUMMARY_EVERY_N_ROUNDS; unset gives its own default (5), so only read it when set.
    opts.every ??= env.SUMMARY_EVERY_N_ROUNDS?.trim() ? parseSummaryEvery(env.SUMMARY_EVERY_N_ROUNDS) : DEFAULT_LOOP_EVERY;
  } catch (error) {
    console.error(`swarm: ${error.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  try {
    assertSafeOutDir(opts.out);
  } catch (error) {
    console.error(`swarm: ${error.message}`);
    return 2;
  }
  let result;
  let memory;
  try {
    // Mock (the default): each agent speaks its own persona lines and the sheets come from
    // the counting stand-in, as in npm run demo. Live: one shared client for both.
    const client = parseMode(env.MOCK_INFERENCE) === "live" ? createInferenceClient({ env }) : undefined;
    result = await runSwarm({ rounds: opts.rounds, seed: opts.seed, client });
    if (!verifyRounds(result)) throw new Error("round hashes do not verify");
    memory = await runMemoryLoop({ swarm: result, client, every: opts.every });
  } catch (error) {
    console.error(`swarm: ${error.message}`);
    return 1;
  }
  const finalHash = result.roundHashes.at(-1);
  try {
    await mkdir(opts.out, { recursive: true });
    // This run owns its sheets: drop the previous run's <token>.json and <token>.round-N.json.
    await clearOwnedFiles(opts.out, "sheets", new RegExp(`^(${AGENTS.map((a) => a.id).join("|")})(\\.round-\\d+)?\\.json$`));
    await writeFile(join(opts.out, "transcript.txt"), result.transcript);
    await writeFile(join(opts.out, "events.json"), `${JSON.stringify(result, null, 2)}\n`);
    await mkdir(join(opts.out, "sheets"), { recursive: true });
    for (const token of memory.tokens) {
      // The latest sheet is <token>.json; every sheet is <token>.round-<N>.json.
      await writeFile(join(opts.out, "sheets", `${token.tokenId}.json`), `${JSON.stringify(token.sheet, null, 2)}\n`);
      for (const entry of token.sheets) {
        await writeFile(join(opts.out, "sheets", `${token.tokenId}.round-${entry.round}.json`), `${JSON.stringify(entry.sheet, null, 2)}\n`);
      }
    }
    await writeFile(join(opts.out, "memory-loop.json"), `${JSON.stringify(memory, null, 2)}\n`);
  } catch (error) {
    console.error(`swarm: cannot write to ${JSON.stringify(opts.out)}: ${error.message}`);
    return 1;
  }
  log(result.transcript.trimEnd());
  log(`\nfinal round hash: ${finalHash}`);
  log(`verify: ok (${opts.rounds} ${opts.rounds === 1 ? "round" : "rounds"})`);
  for (const token of memory.tokens) {
    for (const { round, sheet, diff } of token.sheets) {
      log(`sheet ${token.tokenId} round ${round} ${sheet.sheetHash} (+${diff.added.length} -${diff.removed.length}) -> anchor_sheet dry-run (not sent)`);
    }
  }
  const label = parseMode(env.MOCK_INFERENCE) === "live" ? "live inference, dry-run anchors" : "MOCK";
  log(`final round hash ${finalHash} linked to ${memory.tokens.reduce((n, t) => n + t.sheets.length, 0)} anchor dry-runs (${label}, not on-chain)`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
