// Run the swarm and write out/transcript.txt and out/events.json.
// Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--out DIR]
// Mock inference by default: offline, deterministic, in-character lines, no
// keys. Live NEAR AI Cloud only with MOCK_INFERENCE=0 (reads NEAR_AI_API_KEY).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSwarm, verifyRounds } from "../src/swarm/runner.mjs";
import { createInferenceClient, parseMode } from "../src/inference/client.mjs";

function parseArgs(argv) {
  const opts = { rounds: 5, seed: 1, out: "out" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--rounds" || flag === "--seed") {
      if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(value)}`);
      }
      opts[flag.slice(2)] = Number(value);
      i++;
    } else if (flag === "--out") {
      if (!value) throw new Error("--out needs a directory");
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
  let result;
  try {
    // Mock (the default): each agent speaks its own persona lines. Live: one shared client.
    const client = parseMode(env.MOCK_INFERENCE) === "live" ? createInferenceClient({ env }) : undefined;
    result = await runSwarm({ rounds: opts.rounds, seed: opts.seed, client });
    if (!verifyRounds(result)) throw new Error("round hashes do not verify");
  } catch (error) {
    console.error(`swarm: ${error.message}`);
    return 1;
  }
  const finalHash = result.roundHashes.at(-1);
  await mkdir(opts.out, { recursive: true });
  await writeFile(join(opts.out, "transcript.txt"), result.transcript);
  await writeFile(join(opts.out, "events.json"), `${JSON.stringify(result, null, 2)}\n`);
  log(result.transcript.trimEnd());
  log(`\nfinal round hash: ${finalHash}`);
  log(`verify: ok (${opts.rounds} rounds)`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
