#!/usr/bin/env node
// Write a static HTML page for a swarm run.
//
//   node scripts/viewer.mjs                      # demo run, 5 rounds, mock
//   node scripts/viewer.mjs --rounds 3 --out out/viewer/three.html
//   node scripts/viewer.mjs --input out/swarm.json
//
// Without --input, builds a demo run through the inference client. That is
// mock by default (MOCK_INFERENCE unset or 1). Never prints keys. The output
// is self-contained HTML with no scripts or network calls.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { InferenceError, createInferenceClient } from "../src/inference/client.mjs";
import { buildDemoRun } from "../src/viewer/run.mjs";
import { renderViewer } from "../src/viewer/render.mjs";

const DEFAULT_OUT = "out/viewer/index.html";
const DEFAULT_ROUNDS = 5;

const USAGE = `usage: node scripts/viewer.mjs [--input RUN.json] [--rounds N] [--out FILE]

  --input FILE   render an existing run document instead of a demo
  --rounds N     demo rounds (default ${DEFAULT_ROUNDS}, or SWARM_ROUNDS)
  --out FILE     output HTML (default ${DEFAULT_OUT})
`;

function parseArgs(argv) {
  const options = { input: undefined, rounds: undefined, out: DEFAULT_OUT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--input") options.input = value();
    else if (arg === "--rounds") options.rounds = value();
    else if (arg === "--out") options.out = value();
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function roundsFrom(options) {
  const raw = options.rounds ?? process.env.SWARM_ROUNDS ?? String(DEFAULT_ROUNDS);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`rounds must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
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

  let run;
  if (options.input !== undefined) {
    run = JSON.parse(await readFile(options.input, "utf8"));
  } else {
    const client = createInferenceClient();
    process.stderr.write(`mode: ${client.mode} model: ${client.model}\n`);
    run = await buildDemoRun({ rounds: roundsFrom(options), client });
  }

  const html = renderViewer(run);
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const label = err instanceof InferenceError ? `inference error (${err.code})` : "error";
    process.stderr.write(`${label}: ${err.message}\n`);
    process.exit(1);
  },
);
