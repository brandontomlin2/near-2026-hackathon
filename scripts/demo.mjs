// One-command offline demo: swarm, memory, art, anchor (dry run), HTML page.
// Usage: node scripts/demo.mjs [--rounds N] [--seed N] [--every N] [--style NAME] [--out DIR]
// Mock mode only: no keys, no network, nothing signed.

import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseMode } from "../src/inference/client.mjs";
import { getStyle, STYLE_NAMES } from "../src/art/styles/index.mjs";
import { MAX_ROUNDS } from "../src/swarm/runner.mjs";
import { DEMO_DEFAULTS, runDemo } from "../src/demo/pipeline.mjs";
import { memoryDiffLine } from "../src/demo/memory-diff.mjs";
import { plural } from "../src/util/plural.mjs";

const USAGE = `Usage: node scripts/demo.mjs [--rounds N] [--seed N] [--every N] [--style NAME] [--out DIR]
  --rounds N  swarm rounds (default ${DEMO_DEFAULTS.rounds})
  --seed N    swarm seed, a non-negative integer (default ${DEMO_DEFAULTS.seed})
  --every N   summarize every N rounds (default ${DEMO_DEFAULTS.every})
  --style NAME art style: ${STYLE_NAMES.join(", ")} (default ${DEMO_DEFAULTS.style})
  --out DIR   output directory (default out)
Runs offline in mock mode. Nothing is signed or sent.`;

function parseArgs(argv) {
  const opts = { rounds: DEMO_DEFAULTS.rounds, seed: DEMO_DEFAULTS.seed, every: DEMO_DEFAULTS.every, style: DEMO_DEFAULTS.style, out: "out", help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...opts, help: true }; // help wins over any other argument
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--rounds" || flag === "--seed" || flag === "--every") {
      // A seed may be 0; rounds and every must be at least 1.
      const pattern = flag === "--seed" ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
      if (value === undefined || !pattern.test(value) || !Number.isSafeInteger(Number(value))) {
        const kind = flag === "--seed" ? "a non-negative integer" : "a positive integer";
        throw new Error(`${flag} must be ${kind}, got ${value === undefined ? "no value" : JSON.stringify(value)}`);
      }
      if (flag !== "--seed" && Number(value) > MAX_ROUNDS) throw new Error(`${flag} must be at most ${MAX_ROUNDS}, got ${value}`);
      opts[flag.slice(2)] = Number(value);
      i++;
    } else if (flag === "--style") {
      if (!value || value.startsWith("-")) throw new Error(`--style needs a name, got ${value === undefined ? "no value" : JSON.stringify(value)}`);
      getStyle(value); // throws "unknown style" with the valid names
      opts.style = value;
      i++;
    } else if (flag === "--out") {
      if (!value || value.startsWith("-")) throw new Error(`--out needs a directory, got ${value === undefined ? "no value" : JSON.stringify(value)}`);
      opts.out = value;
      i++;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  // --help wins over every other flag, so "--rounds 2 --help" prints usage, not an error.
  if (!opts.help && opts.every > opts.rounds) {
    throw new Error(`--every (${opts.every}) must not exceed --rounds (${opts.rounds}), or no character sheet is written`);
  }
  return opts;
}

// `name` prefixes error lines; scripts/site.mjs wraps this and passes "site".
export async function main(argv = process.argv.slice(2), { env = process.env, log = console.log, name = "demo" } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`${name}: ${error.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  let mode;
  try {
    mode = parseMode(env.MOCK_INFERENCE);
  } catch (error) {
    console.error(`${name}: ${error.message} (see --help)`);
    return 2;
  }
  if (mode === "live") {
    console.error(`${name}: runs in mock mode only; unset MOCK_INFERENCE or set it to 1`);
    return 2;
  }
  const at = (p) => join(opts.out, p);
  // require() needs "./" for a relative path; an absolute path works as is.
  const requirePath = (p) => (isAbsolute(p) ? p : `./${p}`);
  try {
    const run = await runDemo({ outDir: opts.out, rounds: opts.rounds, seed: opts.seed, every: opts.every, style: opts.style });
    const { manifest } = run;
    const sheetCount = manifest.agents.reduce((n, a) => n + a.sheets.length, 0);
    const eventCount = manifest.roundHashes.length * manifest.agents.length;
    log(`[1/5] swarm: ${plural(manifest.rounds, "round")}, ${plural(eventCount, "event")}, verify: ok`);
    log(`[2/5] memory: ${plural(sheetCount, "sheet")} (a summary every ${plural(manifest.every, "round")}, ${plural(manifest.agents.length, "agent")})`);
    // One line per agent: first sheet -> latest sheet. This is what the camera sees.
    for (const agent of manifest.agents) log(`     ${memoryDiffLine(agent)}`);
    const artCount = manifest.agents.length * (2 + manifest.moods.length);
    log(`[3/5] art: ${plural(artCount, "svg")} in style ${manifest.style} (now, at mint, ${manifest.moods.length} mood${manifest.moods.length === 1 ? "" : "s"} per agent), ${plural(manifest.shares.length, "share card")}, ${manifest.memes.length} meme card${manifest.memes.length === 1 ? "" : "s"}`);
    log(`[4/5] anchor (dry run): ${plural(sheetCount, "call")} prepared, 0 signed`);
    log(`[5/5] viewer: ${at("index.html")}`);
    log("");
    log("Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.");
    log("");
    log("Do this, see that:");
    log(`  1. Open ${at("index.html")} in a browser. See the hero line "Your NFT remembers who you are", the four agents with a strip of reaction faces each, their character sheets, the channel with a reaction face beside every message, the share cards and the dry-run anchor table.`);
    log(`  2. Open ${at(manifest.shares[0].file)} in a browser. See a standalone share card: the reaction face for one channel line, the quote and a "Personality NFT" footer.`);
    if (manifest.memes.length) {
      log(`     Then open ${at(manifest.memes[0].file)}. See ${manifest.memes.length === 1 ? "the one meme card" : `one of ${manifest.memes.length} meme cards`} (caption, villain arc) built from that agent's real channel lines and sheet.`);
    }
    log(`  3. Open ${at("transcript.txt")}. See the swarm conversation, round by round, with replies marked.`);
    log(`  4. Open ${at("memory/aloof/sheet.json")}. See Aloof's latest character sheet and its sha256 hash.`);
    log(`     Check the hash: node -p 'require("${requirePath(at("memory/aloof/sheet.json"))}").sheet' | shasum -a 256`);
    log(`  5. Open ${at("anchors.json")}. See ${sheetCount} anchor_sheet calls for testnet, each "dry-run" with a null transaction hash; Aloof's last sheet_hash is the hash from step 4.`);
    log(`  6. Run the same command again. See the same final round hash (same --rounds, --seed, --every and --style): ${run.finalRoundHash}.`);
    log("");
    log(`Files written (${run.files.length}):`);
    for (const f of run.files) log(`  ${at(f)}`);
    // Keep this the very last line: the one-click way to the page. Never auto-opens.
    const page = at("index.html");
    const shown = /[^\w./@:+-]/.test(page) ? JSON.stringify(page) : page;
    log(`Open the page: open ${shown}  (${pathToFileURL(resolve(page)).href})`);
  } catch (error) {
    if (error.code === "ENOTDIR" || error.code === "EEXIST") {
      console.error(`${name}: cannot write to ${JSON.stringify(opts.out)}: it, or a parent, is a file, not a directory. Pass a directory path that is free or does not exist yet (see --help)`);
      return 1;
    }
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
      console.error(`${name}: cannot write to ${JSON.stringify(opts.out)}: permission denied or read-only. Pass a directory you can write to (see --help)`);
      return 1;
    }
    console.error(`${name}: ${error.message}`);
    return 1;
  }
  return 0;
}

// import.meta.url is a realpath; argv[1] is not when the script is run through a symlink.
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isEntryPoint()) {
  process.exitCode = await main();
}
