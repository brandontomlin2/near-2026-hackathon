#!/usr/bin/env node
// One chat turn through the inference client. Mock by default; live when
// MOCK_INFERENCE=0 and NEAR_AI_API_KEY and NEAR_AI_MODEL are set.
//
//   npm run infer -- "What do you make of the treasury proposal?"
//   npm run infer -- --system "You are Aloof." --json "Say hello."
//
// Prints the reply, or with --json the whole response object. Never prints
// the key.

import { InferenceError, createInferenceClient } from "../src/inference/client.mjs";

const USAGE = `usage: node scripts/infer.mjs [--system TEXT] [--seed N] [--json] <prompt>

Mock by default (MOCK_INFERENCE unset or 1). For a live NEAR AI Cloud call set
MOCK_INFERENCE=0, NEAR_AI_API_KEY and NEAR_AI_MODEL in the environment.
`;

function parseArgs(argv) {
  const options = { system: undefined, seed: undefined, json: false, prompt: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--system") {
      options.system = argv[i + 1];
      i += 1;
    } else if (arg === "--seed") {
      const raw = argv[i + 1];
      const n = Number(raw);
      options.seed = Number.isFinite(n) ? n : raw;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      options.prompt.push(arg);
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
  const prompt = options.prompt.join(" ").trim();
  if (!prompt) {
    process.stderr.write(`error: a prompt is required\n${USAGE}`);
    return 2;
  }

  const client = createInferenceClient();
  process.stderr.write(`mode: ${client.mode} model: ${client.model}\n`);
  const reply = await client.chat({
    system: options.system,
    messages: [{ role: "user", content: prompt }],
    seed: options.seed,
  });
  process.stdout.write(options.json ? `${JSON.stringify(reply, null, 2)}\n` : `${reply.content}\n`);
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
