// Run the swarm and write out/swarm/transcript.txt and out/swarm/events.json, then run
// the memory loop (dry run only): out/swarm/sheets/<token>.json and out/swarm/memory-loop.json.
// (npm run demo owns out/ itself, so the two never overwrite each other.)
// Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--out DIR]
// Mock inference by default: offline, deterministic, in-character lines, no
// keys. Live NEAR AI Cloud only with MOCK_INFERENCE=0 (reads NEAR_AI_API_KEY).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ROUNDS, runSwarm, verifyRounds } from "../src/swarm/runner.mjs";
import { createInferenceClient, parseMode } from "../src/inference/client.mjs";
import { runMemoryLoop } from "../src/memory/loop.mjs";

const USAGE = `Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--out DIR]
  --rounds N  swarm rounds, 1 to ${MAX_ROUNDS} (default 5)
  --seed N    swarm seed, a positive integer (default 1)
  --out DIR   output directory (default out/swarm)
Mock inference by default: offline, nothing is signed or sent.`;

function parseArgs(argv) {
  const opts = { rounds: 5, seed: 1, out: "out/swarm", help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") {
      opts.help = true;
    } else if (flag === "--rounds" || flag === "--seed") {
      if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
      }
      if (flag === "--rounds" && Number(value) > MAX_ROUNDS) throw new Error(`--rounds must be at most ${MAX_ROUNDS}, got ${value}`);
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
  } catch (error) {
    console.error(`swarm: ${error.message}`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  let result;
  let memory;
  try {
    // Mock (the default): each agent speaks its own persona lines. Live: one shared client.
    const client = parseMode(env.MOCK_INFERENCE) === "live" ? createInferenceClient({ env }) : undefined;
    result = await runSwarm({ rounds: opts.rounds, seed: opts.seed, client });
    if (!verifyRounds(result)) throw new Error("round hashes do not verify");
    memory = await runMemoryLoop({ swarm: result, client: createInferenceClient({ env }) });
  } catch (error) {
    console.error(`swarm: ${error.message}`);
    return 1;
  }
  const finalHash = result.roundHashes.at(-1);
  try {
    await mkdir(opts.out, { recursive: true });
    await writeFile(join(opts.out, "transcript.txt"), result.transcript);
    await writeFile(join(opts.out, "events.json"), `${JSON.stringify(result, null, 2)}\n`);
    await mkdir(join(opts.out, "sheets"), { recursive: true });
    for (const token of memory.tokens) {
      await writeFile(join(opts.out, "sheets", `${token.tokenId}.json`), `${JSON.stringify(token.sheet, null, 2)}\n`);
    }
    await writeFile(join(opts.out, "memory-loop.json"), `${JSON.stringify(memory, null, 2)}\n`);
  } catch (error) {
    console.error(`swarm: cannot write to ${JSON.stringify(opts.out)}: ${error.message}`);
    return 1;
  }
  log(result.transcript.trimEnd());
  log(`\nfinal round hash: ${finalHash}`);
  log(`verify: ok (${opts.rounds} rounds)`);
  for (const token of memory.tokens) {
    log(`sheet ${token.tokenId} ${token.sheet.sheetHash} -> anchor_sheet dry-run (not sent)`);
  }
  const label = parseMode(env.MOCK_INFERENCE) === "live" ? "live inference, dry-run anchors" : "MOCK";
  log(`final round hash ${finalHash} linked to ${memory.tokens.length} anchor dry-runs (${label}, not on-chain)`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
