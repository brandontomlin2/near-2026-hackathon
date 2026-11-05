#!/usr/bin/env node
// Yield Optimizer: one debate round (or more) of the four strategy agents, dry run by default.
//
//   npm run yield
//   npm run yield -- --agent skeptic --rounds 3 --json
//
// Each agent proposes a swap with NEAR AI (mock by default: offline, no keys, same bytes
// every run; live with MOCK_INFERENCE=0 and NEAR_AI_API_KEY like npm run infer). Every
// proposal is checked off chain against the vault's hard rules (the same error codes, same
// order) and the agent's own strategy. Accepted proposals print the execute_swap call as a
// DRY RUN. Sending needs --send AND --i-approve AND NEAR_NETWORK=testnet AND
// YIELD_VAULT_ACCOUNT_ID and YIELD_RUNNER_ACCOUNT_ID (named .testnet accounts). Mainnet is refused.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InferenceError, createInferenceClient, parseMode } from "../src/inference/client.mjs";
import { AGENTS } from "../src/traits/agents.mjs";
import { assertSafeOutDir } from "../src/util/outdir.mjs";
import { AGENT_IDS, runRound } from "../src/yield/debate.mjs";
import { createLedger, formatScoreboard, formatUsd } from "../src/yield/ledger.mjs";
import { yieldMockResponder } from "../src/yield/mock.mjs";
import { loadPoolFixture } from "../src/yield/pools.mjs";
import { dayOf, validateVaultConfig } from "../src/yield/rules.mjs";
import { RefusalError, assertNotMainnet, assertSendAllowed, buildExecuteSwapArgv, formatCommand } from "../src/yield/send.mjs";
import { PLACEHOLDER_RUNNER, PLACEHOLDER_VAULT, defaultVaultConfig, strategyFor } from "../src/yield/strategies.mjs";

const MAX_ROUNDS = 50;
const MOCK_EPOCH_MS = Date.UTC(2026, 10, 3);
/** A --vault-state snapshot older than this is refused: the chain is the authority, the file is only a cache. */
export const MAX_VAULT_STATE_AGE_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

const USAGE = `Usage: node scripts/yield.mjs [--agent ID] [--rounds N] [--json] [--out DIR] [--send --i-approve --vault-state FILE]
  --agent ID    show (and, with --send, execute) only this agent: ${AGENT_IDS.join(", ")}
                (the whole swarm still debates, so social and skeptic keep their inputs)
  --rounds N    debate rounds, 1 to ${MAX_ROUNDS} (default 1)
  --json        print one JSON document instead of text
  --out DIR     where the track record goes: DIR/yield/ledger.json (default out; rewritten each run)
  --vault-state FILE  JSON {"config": <get_config()>, "state": <get_state()>} of the target vault
                (state: the raw get_state() JSON; balances and spent_today are [token, amount] pairs), plus "fetched_at" (ISO time) and
                "block_height" of the view calls. Required with --send: proposals are checked against
                it, never against the built-in demo config. Refused if older than 10 minutes. It is
                only a cache: the chain is the authority and re-checks every rule on execute_swap.
  --send        really send the accepted execute_swap calls with near-cli-rs (one round only:
                --rounds above 1 is refused with --send). Also needs
                --i-approve, --agent, NEAR_NETWORK=testnet, YIELD_VAULT_ACCOUNT_ID and
                YIELD_RUNNER_ACCOUNT_ID (named .testnet accounts). Mainnet is refused.
  -h, --help    print this help and exit 0
Default is a dry run: nothing is signed or sent. Mock by default (offline, no keys);
live NEAR AI Cloud with MOCK_INFERENCE=0, NEAR_AI_API_KEY and NEAR_AI_MODEL.
A proposal that fails the vault's hard rules off chain is never sent.
Exit 0 ok, 1 refused or failed, 2 usage error.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { agent: undefined, rounds: 1, json: false, out: "out", send: false, approve: false, vaultState: undefined, help: false };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...o, help: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    if (a === "--agent") {
      o.agent = value().toLowerCase();
      if (!AGENT_IDS.includes(o.agent)) throw new UsageError(`unknown agent ${JSON.stringify(o.agent)}; one of ${AGENT_IDS.join(", ")}`);
    } else if (a === "--rounds") {
      const v = value();
      if (!/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > MAX_ROUNDS) throw new UsageError(`--rounds must be an integer from 1 to ${MAX_ROUNDS}`);
      o.rounds = Number(v);
    } else if (a === "--out") o.out = value();
    else if (a === "--vault-state") o.vaultState = value();
    else if (a === "--json") o.json = true;
    else if (a === "--send") o.send = true;
    else if (a === "--i-approve") o.approve = true;
    else throw new UsageError(`unknown argument ${JSON.stringify(a)}`);
  }
  if (o.vaultState && !o.send) throw new UsageError("--vault-state only applies together with --send");
  if (o.approve && !o.send) throw new UsageError("--i-approve only applies together with --send");
  if (o.send && o.rounds > 1) {
    throw new UsageError("--rounds greater than 1 cannot be combined with --send: the ledger is simulated, so later rounds would sign swaps against state that diverged from the chain. Send one round at a time.");
  }
  return o;
}

const U128_MAX = (1n << 128n) - 1n;
const RAW_STATE_KEYS = ["swap_in_flight", "recovery_in_flight", "release_in_flight", "spent_today", "day"];

/** [token, amount] pairs as the contract serializes Vec<(AccountId, U128)> -> { token: decimal string }. */
function pairsToRecord(pairs, name) {
  if (!Array.isArray(pairs)) throw new Error(`--vault-state state.${name} must be an array of [token, amount] pairs`);
  const out = {};
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`--vault-state state.${name} has a malformed pair; each must be [token, amount]`);
    const [token, amount] = pair;
    if (typeof token !== "string" || token === "") throw new Error(`--vault-state state.${name} has a pair without a token id`);
    if (typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) > U128_MAX) {
      throw new Error(`--vault-state state.${name} amount for ${token} must be a decimal U128 string`);
    }
    if (Object.hasOwn(out, token)) throw new Error(`--vault-state state.${name} lists ${token} twice`);
    out[token] = amount;
  }
  return out;
}

/**
 * Convert the contract's get_state() JSON (VaultState: balances and spent_today as [token, amount]
 * pairs, day, and the swap/recovery/release_in_flight booleans) into the mirror that checkProposal
 * reads ({ paused, in_flight, spent: { day, amounts }, balances: { token: amount } }).
 * Any of the three locks blocks swaps, as on chain. A state already in the mirror shape (no raw
 * fields, balances an object) is passed through unchanged. Throws on a malformed raw state.
 */
export function normalizeContractState(state, nowMs) {
  const isRaw = Array.isArray(state.balances) || RAW_STATE_KEYS.some((k) => Object.hasOwn(state, k));
  if (!isRaw) return state;
  for (const k of ["paused", "swap_in_flight", "recovery_in_flight", "release_in_flight"]) {
    if (typeof state[k] !== "boolean") throw new Error(`--vault-state state.${k} must be a boolean`);
  }
  if (!Number.isSafeInteger(state.day) || state.day < 0) throw new Error("--vault-state state.day must be a non-negative integer");
  const balances = pairsToRecord(state.balances, "balances");
  const amounts = pairsToRecord(state.spent_today, "spent_today");
  if (state.day > dayOf(nowMs)) throw new Error("--vault-state state.day is in the future");
  return {
    paused: state.paused,
    in_flight: state.swap_in_flight || state.recovery_in_flight || state.release_in_flight,
    // spentOn() ignores amounts whose day is not today, matching the contract's rollover.
    spent: { day: state.day, amounts },
    balances,
  };
}

/** Read the target vault's real config and state; throws an Error with a clear message. */
function loadVaultState(file, nowMs) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read --vault-state ${file}: ${e.message.split("\n")[0]}`);
  }
  const { config, state, fetched_at: fetchedAt, block_height: blockHeight } = doc ?? {};
  if (!config || typeof config !== "object" || !state || typeof state !== "object") throw new Error(`--vault-state ${file} needs both "config" and "state" objects`);
  const problems = validateVaultConfig(config);
  if (problems.length) throw new Error(`--vault-state config is invalid: ${problems.join("; ")}`);
  const fetchedMs = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
  if (Number.isNaN(fetchedMs) || !Number.isInteger(blockHeight) || blockHeight <= 0) {
    throw new Error(`--vault-state ${file} needs "fetched_at" (ISO time) and "block_height" (positive integer) from when the view calls were made`);
  }
  if (fetchedMs > nowMs + MAX_CLOCK_SKEW_MS) throw new Error(`--vault-state fetched_at is in the future`);
  if (nowMs - fetchedMs > MAX_VAULT_STATE_AGE_MS) {
    throw new Error(`--vault-state is stale (fetched_at older than ${MAX_VAULT_STATE_AGE_MS / 60000} minutes); re-fetch get_config and get_state`);
  }
  if (Number.isInteger(state.spent?.day) && state.spent.day > dayOf(nowMs)) throw new Error("--vault-state spent.day is in the future");
  return { config, state: normalizeContractState(state, nowMs) };
}

function defaultSpawner(bin, args) {
  const r = spawnSync(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
  return r.error ? 127 : (r.status ?? 1);
}

/**
 * @param {string[]} argv
 * @param {{ env?: object, log?: (s: string) => void, err?: (s: string) => void, spawner?: (bin: string, args: string[]) => number, hasNear?: () => boolean, now?: () => number }} [io]
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const { env = process.env, log = console.log, err = (s) => console.error(s), spawner = defaultSpawner, now = Date.now } = io;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`yield: ${e.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  try {
    assertNotMainnet(env); // before anything else
    if (opts.send) assertSendAllowed(env, { approve: opts.approve, agent: opts.agent });
  } catch (e) {
    if (!(e instanceof RefusalError)) throw e;
    err(`yield: ${e.message}`);
    return e.exitCode;
  }

  let outDir;
  try {
    outDir = assertSafeOutDir(opts.out);
  } catch (e) {
    err(`yield: ${e.message}`);
    return 2;
  }

  let client;
  try {
    client = createInferenceClient({ env, responder: yieldMockResponder });
  } catch (e) {
    if (!(e instanceof InferenceError)) throw e;
    const hint = e.code === "missing_api_key" || e.code === "missing_model" ? " (set NEAR_AI_API_KEY and NEAR_AI_MODEL, or unset MOCK_INFERENCE for mock mode)" : "";
    err(`yield: ${e.code}: ${e.message.split("\n")[0]}${hint}`);
    return e.code === "bad_config" ? 2 : 1;
  }
  const mode = parseMode(env.MOCK_INFERENCE);
  err(`mode: ${mode} model: ${client.model}`);

  const vault = env.YIELD_VAULT_ACCOUNT_ID || PLACEHOLDER_VAULT;
  const runner = env.YIELD_RUNNER_ACCOUNT_ID || PLACEHOLDER_RUNNER;
  const fixture = loadPoolFixture();
  const configs = Object.fromEntries(AGENT_IDS.map((id) => [id, defaultVaultConfig(id, { runner })]));
  const ledger = createLedger({ fixture });
  if (opts.send) {
    if (!opts.vaultState) {
      err("yield: --send needs --vault-state FILE with the target vault's get_config() and get_state(); proposals are never checked against the demo config when sending. Nothing was sent.");
      return 1;
    }
    try {
      const v = loadVaultState(opts.vaultState, now());
      configs[opts.agent] = v.config;
      ledger.states[opts.agent] = v.state;
    } catch (e) {
      err(`yield: ${e.message}. Nothing was sent.`);
      return 1;
    }
  }
  const shown = opts.agent ? [opts.agent] : AGENT_IDS;

  if (opts.send) {
    const hasNear = io.hasNear ?? (() => spawner("near", ["--version"]) === 0);
    if (!hasNear()) {
      err("yield: near-cli-rs (the `near` command) is not on PATH. Nothing was sent.");
      return 1;
    }
  }

  const rounds = [];
  const sent = [];
  let exitCode = 0;
  for (let round = 1; round <= opts.rounds; round++) {
    // With --send the real clock always applies: the vault's daily cap is keyed on the real UTC day.
    const nowMs = mode === "mock" && !opts.send ? MOCK_EPOCH_MS + (round - 1) * 3_600_000 : now();
    const record = await runRound({ client, configs, states: ledger.states, fixture, round, nowMs, runnerId: runner });
    // A sent round starts from the real vault state: simulated fills must not be merged into it or the track record.
    if (!opts.send) ledger.record(record);
    for (const x of record.executions) {
      x.argv = buildExecuteSwapArgv({ vault, runner, proposal: x.proposal });
      x.command = formatCommand(x.argv);
    }
    if (opts.send) {
      for (const x of record.executions.filter((e) => e.agent === opts.agent)) {
        const status = spawner("near", x.argv);
        sent.push({ round, agent: x.agent, status });
        if (status !== 0) {
          err(`yield: near exited with status ${status} sending round ${round}; stopping`);
          exitCode = 1;
          break;
        }
      }
    }
    rounds.push(record);
    if (exitCode !== 0) break;
  }
  const ledgerFile = opts.send ? null : await ledger.save(outDir);
  const scoreboard = ledger.scoreboard();

  if (opts.json) {
    log(JSON.stringify({
      mode, dry_run: !opts.send, vault, runner, pool_snapshot_block: fixture._block_height,
      configs: Object.fromEntries(shown.map((id) => [id, configs[id]])),
      rounds: rounds.map((r) => ({
        round: r.round,
        now_ms: r.now_ms,
        consensus: r.consensus,
        decisions: Object.fromEntries(shown.map((id) => [id, r.decisions[id]])),
        executions: r.executions.filter((x) => shown.includes(x.agent)).map(({ agent, proposal, vault_args, command }) => ({ agent, proposal, vault_args, command, sent: opts.send })),
      })),
      sent, scoreboard, ledger: ledgerFile,
    }, null, 2));
    return exitCode;
  }

  const head = opts.send ? "SENDING to testnet (--send --i-approve)" : "DRY RUN, not sent (nothing is signed)";
  log(`Yield Optimizer: ${opts.rounds} round(s), ${mode} inference, ${head}`);
  log(`vault ${vault} | runner ${runner} | Ref testnet pool snapshot at block ${fixture._block_height}`);
  for (const r of rounds) {
    log("");
    log(`== round ${r.round} ==`);
    if (r.consensus) log(`swarm consensus: pool ${r.consensus.pool_id} ${r.consensus.token_in} -> ${r.consensus.token_out}, ${r.consensus.supporters.join(" + ")}`);
    for (const id of shown) log(...renderAgent(r.decisions[id], r, opts.send));
  }
  log("");
  log(formatScoreboard(scoreboard));
  log(ledgerFile ? `track record written to ${ledgerFile}` : "track record not updated (--send: simulated fills are not merged with real vault state)");
  return exitCode;
}

function renderAgent(d, round, sending) {
  const s = strategyFor(d.agent);
  const name = AGENTS.find((a) => a.id === d.agent).name;
  const lines = [`\n[${d.agent}] ${name}: ${s.name}`];
  if (d.status === "invalid") lines.push(`  invalid reply (${d.error.code}): ${d.error.message}; ignored`);
  else if (!d.proposal) lines.push(`  no proposal (${d.status === "abstained" ? "abstained" : "none"})`);
  else {
    const p = d.proposal;
    lines.push(`  proposal: pool ${p.pool_id} ${p.token_in} -> ${p.token_out}, amount_in ${p.amount_in}, min_amount_out ${p.min_amount_out}`);
    lines.push(`  why: ${p.rationale}`);
    lines.push(`  vault rules (off chain): ${d.hard.ok ? "OK" : `${d.hard.code}: ${d.hard.reason}`}`);
    lines.push(`  strategy checks: ${d.soft.ok ? "OK" : d.soft.violations.map((v) => `${v.code}: ${v.reason}`).join("; ")}`);
  }
  if (d.veto) lines.push(`  VETOED by ${d.veto.by}: ${d.veto.reason}`);
  lines.push(`  outcome: ${d.outcome}`);
  const x = round.executions.find((e) => e.agent === d.agent);
  if (x) {
    lines.push(sending ? "  SENDING:" : "  DRY RUN, not sent:");
    lines.push(`    args: ${JSON.stringify(x.vault_args)}`);
    lines.push(`    ${x.command}`);
  }
  return [lines.join("\n")];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
