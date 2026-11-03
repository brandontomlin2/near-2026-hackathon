// One-command offline demo: swarm, memory, art, anchor (dry run), HTML page.
// Usage: node scripts/demo.mjs [--rounds N] [--seed N] [--every N] [--out DIR]
// Mock mode only: no keys, no network, nothing signed.

import { fileURLToPath } from "node:url";
import { parseMode } from "../src/inference/client.mjs";
import { DEMO_DEFAULTS, runDemo } from "../src/demo/pipeline.mjs";

const USAGE = `Usage: node scripts/demo.mjs [--rounds N] [--seed N] [--every N] [--out DIR]
  --rounds N  swarm rounds (default ${DEMO_DEFAULTS.rounds})
  --seed N    swarm seed (default ${DEMO_DEFAULTS.seed})
  --every N   summarize every N rounds (default ${DEMO_DEFAULTS.every})
  --out DIR   output directory (default out)
Runs offline in mock mode. Nothing is signed or sent.`;

function parseArgs(argv) {
  const opts = { rounds: DEMO_DEFAULTS.rounds, seed: DEMO_DEFAULTS.seed, every: DEMO_DEFAULTS.every, out: "out", help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") {
      opts.help = true;
    } else if (flag === "--rounds" || flag === "--seed" || flag === "--every") {
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
  if (opts.every > opts.rounds) {
    throw new Error(`--every (${opts.every}) must not exceed --rounds (${opts.rounds}), or no character sheet is written`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`demo: ${error.message}`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  if (parseMode(env.MOCK_INFERENCE) === "live") {
    console.error("demo: runs in mock mode only; unset MOCK_INFERENCE or set it to 1");
    return 2;
  }
  const out = opts.out.replace(/\/+$/, "") || ".";
  const at = (p) => (out === "." ? p : `${out}/${p}`);
  try {
    const run = await runDemo({ outDir: opts.out, rounds: opts.rounds, seed: opts.seed, every: opts.every });
    const { manifest } = run;
    const sheetCount = manifest.agents.reduce((n, a) => n + a.sheets.length, 0);
    const eventCount = manifest.roundHashes.length * manifest.agents.length;
    const callCount = sheetCount;
    log(`[1/5] swarm: ${manifest.rounds} rounds, ${eventCount} events, verify: ok`);
    log(`[2/5] memory: ${sheetCount} sheets (a summary every ${manifest.every} rounds, ${manifest.agents.length} agents)`);
    log(`[3/5] art: ${manifest.agents.length * 2} svgs (at mint and now)`);
    log(`[4/5] anchor (dry run): ${callCount} calls prepared, 0 signed`);
    log(`[5/5] viewer: ${at("index.html")}`);
    log("");
    log("Done. Nothing was signed or sent; inference was mocked.");
    log("");
    log("Do this, see that:");
    log(`  1. Open ${at("index.html")} in a browser. See four agents, their art at mint and now, their character sheets, the channel and the dry-run anchor table.`);
    log(`  2. Open ${at("transcript.txt")}. See the swarm conversation, round by round, with replies marked.`);
    log(`  3. Open ${at("memory/aloof/sheet.json")}. See Aloof's latest character sheet and its sha256 hash.`);
    log(`     Check the hash: node -p 'require("./${at("memory/aloof/sheet.json")}").sheet' | shasum -a 256`);
    log(`  4. Open ${at("anchors.json")}. See ${callCount} anchor_sheet calls for testnet, each "dry-run" with a null transaction hash; Aloof's last sheet_hash is the hash from step 3.`);
    log(`  5. Run the same command again. See the same final round hash (same --rounds, --seed and --every): ${run.finalRoundHash}.`);
    log("");
    log(`Files written (${run.files.length}):`);
    for (const f of run.files) log(`  ${at(f)}`);
  } catch (error) {
    console.error(`demo: ${error.message}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
