#!/usr/bin/env node
// Owner action: ask one of your agents a question. It answers from its latest
// character sheet, remembers the exchange, rewrites the sheet and dry-runs the
// anchor_sheet call for the new hash.
//
//   npm run demo
//   npm run ask -- chaotic "what do you think of Skeptic?"
//
// Reads and writes out/memory/<agentId>/ (log.jsonl, sheet.json), written by
// npm run demo. Mock by default: offline, no keys, same bytes for the same
// memory and question. Live NEAR AI Cloud with MOCK_INFERENCE=0, which needs
// NEAR_AI_API_KEY and NEAR_AI_MODEL like npm run infer. Nothing is signed or sent.

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { InferenceError, createInferenceClient, createMockClient, parseMode } from "../src/inference/client.mjs";
import { MemoryError, createMemoryStore } from "../src/memory/summarizer.mjs";
import { sheetResponder } from "../src/memory/sheet-responder.mjs";
import { AskError, MAX_QUESTION_CHARS, askAgent, askResponder } from "../src/owner/ask.mjs";
import { AGENTS } from "../src/traits/agents.mjs";

const IDS = AGENTS.map((a) => a.id);

const USAGE = `Usage: node scripts/ask.mjs [--out DIR] <agentId> <question>
  agentId     one of ${IDS.join(", ")}
  question    what the owner asks, up to ${MAX_QUESTION_CHARS} characters
  --out DIR   the npm run demo output directory (default out)
Answers from the agent's latest sheet in DIR/memory/<agentId>/, appends the
exchange to its log, rewrites the sheet and prints the diff and the anchor_sheet
dry run. Mock by default: offline, no keys, nothing is signed or sent.
Live (MOCK_INFERENCE=0) needs NEAR_AI_API_KEY and NEAR_AI_MODEL, like npm run infer.
Only DIR/memory changes: the page, demo.json and anchors.json keep the demo's
sheets, and the next npm run demo starts the memory over.`;

function parseArgs(argv) {
  const opts = { out: "out", agentId: undefined, question: [], help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...opts, help: true }; // help wins over any other argument
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error(`--out needs a directory, got ${JSON.stringify(value)}`);
      opts.out = value;
      i++;
    } else if (opts.agentId === undefined && arg.startsWith("-")) {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    } else if (opts.agentId === undefined) {
      opts.agentId = arg.toLowerCase();
    } else {
      opts.question.push(arg); // a "-" or "--x" inside the question is part of the question
    }
  }
  if (opts.agentId === undefined) throw new Error("an agent id is required");
  if (!IDS.includes(opts.agentId)) throw new Error(`unknown agent ${JSON.stringify(opts.agentId)}; one of ${IDS.join(", ")}`);
  if (opts.question.join(" ").trim() === "") throw new Error("a question is required");
  return opts;
}

export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`ask: ${error.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const agent = AGENTS.find((a) => a.id === opts.agentId);
  const memoryDir = join(opts.out, "memory");

  // Clients first, so a live run without a key fails before anything is read or written.
  let answerClient;
  let sheetClient;
  try {
    if (parseMode(env.MOCK_INFERENCE) === "mock") {
      // The same stand-ins npm run demo used: the answer in the agent's voice, the sheet from counts.
      answerClient = createMockClient({ model: "mock-persona", responder: askResponder(agent) });
      sheetClient = createMockClient({ responder: sheetResponder });
    } else {
      answerClient = createInferenceClient({ env });
      sheetClient = answerClient;
    }
  } catch (error) {
    const hint = error instanceof InferenceError && (error.code === "missing_api_key" || error.code === "missing_model")
      ? " (set NEAR_AI_API_KEY and NEAR_AI_MODEL in the environment, or unset MOCK_INFERENCE for mock mode)"
      : "";
    console.error(`ask: ${label(error)}: ${firstLine(error)}${hint}`);
    return error instanceof InferenceError && error.code === "bad_config" ? 2 : 1;
  }
  process.stderr.write(`mode: ${answerClient.mode} model: ${answerClient.model}\n`);

  let result;
  try {
    result = await askAgent({ agent, question: opts.question.join(" "), store: createMemoryStore(memoryDir), answerClient, sheetClient });
  } catch (error) {
    if (error instanceof AskError && error.code === "no_sheet") {
      console.error(`ask: no character sheet for ${agent.id} under ${memoryDir} (expected ${join(memoryDir, agent.id, "sheet.json")}). Run npm run demo first, then ask again.`);
      return 2;
    }
    if (error instanceof AskError && error.code === "bad_question") {
      console.error(`ask: ${error.message} (see --help)`);
      return 2;
    }
    console.error(`ask: ${label(error)}: ${firstLine(error)}`);
    return 1;
  }

  const { diff, sheet, anchor } = result;
  log(`${agent.name} (${result.mode}): ${result.answer}`);
  log("");
  log(`memory: ${join(memoryDir, agent.id, "log.jsonl")} +2 events (round ${result.round}: your question, its answer)`);
  log(`sheet diff (round ${result.previous.round} -> ${result.round}, ${join(memoryDir, agent.id, "sheet.json")}):`);
  if (!diff.changed) log("  (no change)");
  for (const line of diff.removed) log(`  - ${line}`);
  for (const line of diff.added) log(`  + ${line}`);
  // Same line npm run swarm prints for each sheet it anchors.
  log(`sheet ${agent.id} round ${sheet.round} ${sheet.sheetHash} (+${diff.added.length} -${diff.removed.length}) -> ${anchor.methodName} dry-run (not sent)`);
  log(result.mode === "mock"
    ? "Nothing was signed or sent; inference was mocked: the answer and the sheet come from deterministic stand-ins, not a model."
    : `Nothing was signed or sent; the answer and the sheet come from ${result.model} on NEAR AI Cloud, the anchor is a dry run.`);
  return 0;
}

const label = (error) => {
  if (error instanceof InferenceError) return `inference error (${error.code})`;
  if (error instanceof MemoryError) return `memory error (${error.code})`;
  if (error instanceof AskError) return `error (${error.code})`;
  return "error";
};
const firstLine = (error) => String(error.message).split("\n")[0];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // main() catches everything it expects; this keeps a bug or an EPIPE on the
  // final log calls to one line and exit 1, as infer.mjs and anchor.mjs do.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`ask: ${label(error)}: ${firstLine(error)}`);
      process.exitCode = 1;
    },
  );
}
