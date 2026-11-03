// Run the swarm and write out/transcript.txt and out/events.json.
// Usage: node scripts/swarm.mjs [--rounds N] [--seed N] [--out DIR]
// Mock inference by default; live only with MOCK_INFERENCE=0.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSwarm } from "../src/swarm/runner.mjs";
import { createInferenceClient } from "../src/inference/client.mjs";

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
    const client = createInferenceClient({ env });
    result = await runSwarm({ rounds: opts.rounds, seed: opts.seed, client });
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
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
