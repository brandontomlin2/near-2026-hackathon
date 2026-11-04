#!/usr/bin/env node
// Write a static HTML page for a swarm run.
//
//   node scripts/viewer.mjs                      # canonical swarm, 5 rounds, mock
//   node scripts/viewer.mjs --rounds 3 --out out/viewer/three.html
//   node scripts/viewer.mjs --input out/swarm/events.json   # npm run swarm (npm run demo: out/events.json)
//
// Renders canonical swarm output (src/swarm/runner.mjs, the events.json that
// npm run swarm and npm run demo write). Without --input it runs that same
// swarm offline with the persona mocks: no keys, no network. The output is
// self-contained HTML with no scripts or network calls.
//
// Exit codes: 0 wrote the page; 2 a user mistake (unknown argument, bad value,
// unreadable or invalid --input, an --out that holds something other than an
// earlier viewer page), reported as one line ending "(see --help)"; 1 a runtime
// failure such as an unwritable --out.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { MAX_ROUNDS, runSwarm } from "../src/swarm/runner.mjs";
import { PAGE_TITLE, renderViewer } from "../src/viewer/render.mjs";
import { pathProblem } from "../src/util/path-problem.mjs";

const DEFAULT_OUT = "out/viewer/index.html";
const DEFAULT_ROUNDS = 5;

const USAGE = `usage: node scripts/viewer.mjs [--input RUN.json] [--rounds N] [--out FILE] [--force]

  --input FILE   render an existing events.json instead of running the swarm
  --rounds N     swarm rounds, 1 to ${MAX_ROUNDS} (default ${DEFAULT_ROUNDS}, or SWARM_ROUNDS)
  --out FILE     output HTML (default ${DEFAULT_OUT})
  --force        replace an existing --out that is not a page this tool wrote
`;

/** A user mistake: reported as one line with "(see --help)" and exit 2. */
class UsageError extends Error {}

function parseArgs(argv) {
  const options = { input: undefined, rounds: undefined, out: DEFAULT_OUT, force: false, help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...options, help: true }; // help wins over any other argument
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      if (next.startsWith("--")) throw new UsageError(`${arg} needs a value, got ${JSON.stringify(next)}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--input") options.input = value();
    else if (arg === "--rounds") options.rounds = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--force") options.force = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
  }
  if (options.input !== undefined && options.rounds !== undefined) {
    throw new UsageError("--rounds cannot be combined with --input (the file already holds its rounds)");
  }
  if (options.out === "") throw new UsageError('--out must not be empty, got ""');
  return options;
}

function roundsFrom(options) {
  const raw = options.rounds ?? process.env.SWARM_ROUNDS ?? String(DEFAULT_ROUNDS);
  if (!/^[1-9][0-9]*$/.test(raw)) throw new UsageError(`rounds must be a positive integer, got ${JSON.stringify(raw)}`);
  if (Number(raw) > MAX_ROUNDS) throw new UsageError(`rounds must be at most ${MAX_ROUNDS}, got ${raw}`);
  return Number(raw);
}

/** An earlier page from this tool: our doctype first and our title. Anything else is someone's file. */
function isViewerPage(text) {
  return text.startsWith("<!doctype html>") && text.includes(`<title>${PAGE_TITLE}</title>`);
}

/**
 * Refuse an --out that is an existing directory, or an existing file that is not an
 * earlier page from this tool (unless --force), before any work is done. A missing path is fine.
 */
async function assertOutIsWritable(out, force) {
  let info;
  try {
    info = await stat(out);
  } catch {
    return;
  }
  if (info.isDirectory()) throw new UsageError(`--out ${out} is a directory; give a file path`);
  if (force) return;
  let text;
  try {
    text = await readFile(out, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read existing --out ${out}: ${err.message}`);
  }
  if (!isViewerPage(text)) {
    throw new UsageError(`--out ${out} exists and is not a page this tool wrote; pass --force to replace it`);
  }
}

/** Read and parse --input. Every failure names the flag and the file. */
async function loadInput(input) {
  let text;
  try {
    text = await readFile(input, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read --input ${input}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`--input ${input} is not JSON: ${err.message}`);
  }
}

/** Render the page from --input or a fresh offline swarm. An invalid --input is the user's mistake; an invalid fresh run is a bug. */
async function renderPage({ input, rounds }) {
  if (input !== undefined) {
    const run = await loadInput(input);
    try {
      return renderViewer(run);
    } catch (err) {
      throw new UsageError(`--input ${input}: ${err.message}`);
    }
  }
  return renderViewer(await runSwarm({ rounds }));
}

function report(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof UsageError) {
    process.stderr.write(`viewer: ${message} (see --help)\n`);
    return 2;
  }
  process.stderr.write(`viewer: ${message}\n`);
  return 1;
}

async function main() {
  // Everything before the write fails with one line; the page is rendered before any file is touched.
  let options;
  let html;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    // Validate --rounds / SWARM_ROUNDS and --out before running anything.
    const rounds = options.input === undefined ? roundsFrom(options) : undefined;
    await assertOutIsWritable(options.out, options.force);
    html = await renderPage({ input: options.input, rounds });
  } catch (err) {
    return report(err);
  }
  const out = resolve(options.out);
  try {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, html, "utf8");
  } catch (err) {
    return report(new Error(`cannot write ${options.out}: ${pathProblem(err, "--out") ?? err.message}`));
  }
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => process.exit(report(err)),
);
