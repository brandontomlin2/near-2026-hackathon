// The live-path status line of `npm run yield:demo`. The demo itself never signs or sends: this
// module only reads a gitignored live config (default out/yield-vault.live.json, the path the
// runbook copies the example to) and the environment, and says whether the separate live path is
// armed. When it is, it prints the exact commands a human would run, in order; each of those
// tools has its own gates (--send --i-approve, NEAR_NETWORK=testnet, named .testnet ids).
// Pure: no network, no subprocess, no key is read. Account ids are public and may be printed;
// nothing that looks like a key is ever echoed (validateLiveConfig refuses such a config).

import { existsSync, readFileSync, statSync } from "node:fs";

import { validateLiveConfig } from "./live-plan.mjs";
import { RefusalError } from "./send.mjs";

export const DEFAULT_LIVE_CONFIG = "out/yield-vault.live.json";
/** The env switch that arms the live path. Anything other than exactly "1" leaves it off. */
export const ARM_ENV = "YIELD_LIVE_ARMED";
/**
 * The --vault-state file `npm run yield -- --send` reads. Nothing in this repo writes it: the human saves the
 * vault's get_config and get_state views into it ({config, state, vault_id, fetched_at, block_height}; see
 * `npm run yield -- --help`), under 10 minutes before sending.
 */
export const VAULT_STATE_FILE = "out/yield-vault.state.json";

/** Flags yield:demo refuses outright: it is a mock-inference dry run and never signs or sends. */
export const DEMO_REFUSED_FLAGS = ["--send", "--i-approve", "--sign", "--live", "--broadcast", "--private-key", "--seed-phrase"];

/** True for any flag the demo must refuse (the list above, or anything containing "sign" or "private"). */
export function isRefusedDemoFlag(arg) {
  if (typeof arg !== "string" || !arg.startsWith("-")) return false;
  const l = arg.toLowerCase().split("=")[0];
  return DEMO_REFUSED_FLAGS.includes(l) || l.includes("sign") || l.includes("private");
}

export const DEMO_SEND_REFUSAL =
  "refused: yield:demo never signs or sends (mock inference, placeholder ids); --send and --i-approve are not accepted here. " +
  `The live testnet path is separate and gated: see the "live path:" line of a plain run and docs/yield-vault-live-runbook.md. Nothing was signed or sent.`;

/**
 * The live-path status for the demo summary.
 * @param {{ env: object, configPath?: string, explicit?: boolean }} o explicit: the path came from --live-config
 * @returns {{ state: "not-configured"|"not-armed"|"armed", lines: string[], problems: string[] }}
 * Throws RefusalError (exit 2) when the config holds something that looks like a private key or a mainnet id.
 */
export function liveStatus({ env, configPath = DEFAULT_LIVE_CONFIG, explicit = false }) {
  const tail = "Default is this dry run; see docs/yield-vault-live-runbook.md.";
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    if (explicit) throw new RefusalError(`--live-config ${configPath} does not exist or is not a file. Nothing was signed or sent.`, 2);
    return { state: "not-configured", problems: [], lines: [`live path: not configured (no ${configPath}). ${tail}`] };
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return notArmed(configPath, ["the file is not valid JSON"], tail);
  }
  let problems;
  try {
    problems = validateLiveConfig(config); // throws RefusalError for secrets, mainnet and .near ids
  } catch (e) {
    if (e instanceof RefusalError) throw e;
    return notArmed(configPath, ["the config could not be checked (unexpected shape)"], tail);
  }
  if (config?.placeholders !== false && !problems.some((p) => p.startsWith("placeholder"))) problems.unshift('"placeholders" must be false');
  if (problems.length === 0) {
    // The send gate in scripts/yield.mjs reads these; if they are set they must name the config's accounts.
    for (const [name, field] of [["YIELD_VAULT_ACCOUNT_ID", "vault_id"], ["YIELD_RUNNER_ACCOUNT_ID", "runner_id"]]) {
      if (env[name] !== undefined && env[name] !== "" && env[name] !== config[field]) problems.push(`${name} is set but is not the config's ${field} (value not shown)`);
    }
  }
  if (problems.length) return notArmed(configPath, problems, tail);

  const gates = [];
  if (env[ARM_ENV] !== "1") gates.push(`${ARM_ENV}=1 is not set`);
  if (env.NEAR_NETWORK !== "testnet") gates.push("NEAR_NETWORK=testnet is not set");
  if (gates.length) {
    return { state: "not-armed", problems: gates, lines: [`live path: not armed (${configPath} is valid; ${gates.join(", ")}). ${tail}`] };
  }
  return { state: "armed", problems: [], lines: armedLines(configPath, config) };
}

/**
 * A problem message with config values taken out. validateLiveConfig messages can quote a value (for
 * example "not a NEAR amount: \"...\""), and a value may be a pasted key without its ed25519: prefix,
 * which assertNoSecrets does not catch. Field paths and fixed wording stay; quoted text longer than a
 * field name and any long base58-like run are replaced.
 */
export function redactProblem(p) {
  return p.replace(/"[^"]{25,}"/g, '"<value not shown>"').replace(/[1-9A-HJ-NP-Za-km-z]{25,}/g, "<value not shown>");
}

function notArmed(configPath, problems, tail) {
  problems = problems.map(redactProblem);
  const shown = problems.slice(0, 3).join("; ") + (problems.length > 3 ? `; and ${problems.length - 3} more` : "");
  return { state: "not-armed", problems, lines: [`live path: not armed (${configPath}: ${shown}). ${tail}`] };
}

const shellQuote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

/** The exact commands of the live path. Printed as text for a human; yield:demo runs none of them. */
export function armedLines(configPath, config) {
  const s = config.swap;
  const cfg = shellQuote(configPath);
  const send = [
    "NEAR_NETWORK=testnet",
    `YIELD_VAULT_ACCOUNT_ID=${config.vault_id}`,
    `YIELD_RUNNER_ACCOUNT_ID=${config.runner_id}`,
    `npm run yield -- --agent ${config.agent} --send --i-approve --vault-state ${VAULT_STATE_FILE}`,
  ].join(" ");
  return [
    `live path: ARMED (${configPath} valid, placeholders false, ${ARM_ENV}=1, NEAR_NETWORK=testnet). This run still signed and sent nothing.`,
    "  The live path is these commands, run by a human in this order; yield:demo runs none of them:",
    `  1. npm run yield:live:preflight -- --config ${cfg} --online`,
    "     read-only testnet views; go on only if it ends READY FOR LIVE: yes",
    `  2. npm run yield:live:dry-run -- --config ${cfg}`,
    "     prints the unsigned deploy, fund and execute_swap near-cli-rs commands; the human signs each one by hand",
    `  3. ${send}`,
    `     you write ${VAULT_STATE_FILE} first from the vault's get_config + get_state views (shape: npm run yield -- --help; under 10 minutes old);`,
    `     the ${config.agent} agent proposes, its swap is checked against that state, then near-cli-rs sends it`,
    `  The live config swaps on pool ${s.pool_id} (${s.token_in} -> ${s.token_out}); this demo's planned call is on its own snapshot pool.`,
  ];
}
