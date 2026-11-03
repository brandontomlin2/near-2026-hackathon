#!/usr/bin/env node
// Sim mode: N deterministic rounds of the four-agent swarm, offline.
//
//   npm run swarm -- --rounds 5
//   npm run swarm -- --rounds 5 --json
//
// Always mock inference. This never reads API keys and never uses the
// network, so MOCK_INFERENCE and NEAR_AI_* are ignored here.

import {
  MAX_ROUNDS,
  SimError,
  formatTranscript,
  parseRounds,
  runSwarm,
  verifyRounds,
} from "../src/sim/swarm.mjs";

const USAGE = `usage: node scripts/swarm.mjs [--rounds N] [--json]

Runs N rounds (default 5, or SWARM_ROUNDS) of the four-agent swarm in sim mode:
offline, deterministic, mock inference only. N is at most ${MAX_ROUNDS}.
`;

function parseArgs(argv) {
  const options = { rounds: process.env.SWARM_ROUNDS ?? "5", json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--rounds") {
      if (argv[i + 1] === undefined) throw new Error("--rounds needs a value");
      options.rounds = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  let rounds;
  try {
    rounds = parseRounds(options.rounds);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }

  process.stderr.write(`mode: sim (mock inference, offline) rounds: ${rounds}\n`);
  const result = await runSwarm({ rounds });
  const check = verifyRounds(result);
  if (!check.ok) {
    process.stderr.write(`error: round hashes do not verify (round ${check.round ?? "head"})\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTranscript(result)}\n`);
    process.stdout.write(`head ${result.headHash}\n`);
    process.stdout.write(`verify: ok (${rounds} rounds)\n`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const label = err instanceof SimError ? `sim error (${err.code})` : "error";
    process.stderr.write(`${label}: ${err.message}\n`);
    process.exitCode = 1;
  },
);
