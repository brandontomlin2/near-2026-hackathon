// Pure logic for the PREFLIGHT table of `yield-live dry-run`. No network, no subprocess, no env
// values: the caller injects the env object, the clock and a readFile function. Env VALUES are never
// read into any result; only whether each name is set.

import { planTotals, TGAS } from "./live-plan.mjs";

/** The live config's swap floors come from the pool snapshot; older than this and it should be re-taken. */
export const SNAPSHOT_MAX_AGE_HOURS = 72;
/** What the only real send path (`node scripts/yield.mjs --send --i-approve`) needs, see send.mjs assertSendAllowed. */
export const PREFLIGHT_ENV_NAMES = Object.freeze(["NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]);
export const PREFLIGHT_HEADING = "PREFLIGHT (offline; nothing is read from .env, no value is printed)";

/** A hard prerequisite is missing: dry-run exits 3 and prints no plan. */
export class PrerequisiteError extends Error {}

const HOUR_MS = 3_600_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** { taken_at, block_height } from the snapshot fixture; throws PrerequisiteError when unusable. */
export function readSnapshotMeta(path, readFile) {
  const fix = `re-create it with: npm run yield:snapshot (needs network; nothing is signed)`;
  let doc;
  try {
    doc = JSON.parse(readFile(path));
  } catch (e) {
    throw new PrerequisiteError(`pool snapshot ${path} is missing or unreadable (${e.code ?? e.message.split("\n")[0]}); ${fix}`);
  }
  const taken = doc?._taken_at;
  if (typeof taken !== "string" || !ISO_UTC.test(taken) || Number.isNaN(Date.parse(taken))) {
    throw new PrerequisiteError(`pool snapshot ${path} has no valid _taken_at (expected ISO UTC like 2026-11-05T11:06:25Z); ${fix}`);
  }
  const block = doc._block_height;
  return { taken_at: taken, block_height: Number.isSafeInteger(block) ? block : null };
}

/** The single runner execute_swap step; throws PrerequisiteError unless there is exactly one. */
export function findSwapStep(plan) {
  const hits = [];
  plan.steps.forEach((s, i) => {
    const call = s.actions.find((a) => a.type === "FunctionCall" && a.method_name === "execute_swap");
    if (call) hits.push({ step: i + 1, s, call });
  });
  if (hits.length !== 1) {
    throw new PrerequisiteError(`the plan must contain exactly one execute_swap step, found ${hits.length}; fix the live config or src/yield/live-plan.mjs`);
  }
  const { step, s, call } = hits[0];
  return {
    step,
    signer_id: s.signer_id,
    receiver_id: s.receiver_id,
    method_name: call.method_name,
    gas_tgas: (BigInt(call.gas) / TGAS).toString(),
    deposit_yocto: String(call.deposit_yocto ?? "0"),
    near_cli: s.near_cli,
  };
}

/** Everything the table shows, as plain data. `now` is epoch ms. */
export function buildPreflight({ plan, placeholders, env, now, snapshot }) {
  const envPresence = {};
  for (const name of PREFLIGHT_ENV_NAMES) {
    envPresence[name] = Object.prototype.hasOwnProperty.call(env, name) && typeof env[name] === "string" && env[name] !== "";
  }
  const ageMs = now - Date.parse(snapshot.taken_at);
  const totals = planTotals(plan);
  const swap = findSwapStep(plan);
  const stale = ageMs > SNAPSHOT_MAX_AGE_HOURS * HOUR_MS;
  const filled = placeholders.length === 0;
  const missing = [];
  if (!filled) missing.push("config placeholders");
  for (const name of PREFLIGHT_ENV_NAMES) if (!envPresence[name]) missing.push(name);
  if (stale) missing.push("fresh snapshot");
  const { near_cli: nearCli, ...swapCall } = swap;
  return {
    placeholders_filled: filled,
    placeholders_unfilled: placeholders.length,
    env: envPresence,
    snapshot: { taken_at: snapshot.taken_at, block_height: snapshot.block_height, age_hours: Math.round((ageMs / HOUR_MS) * 10) / 10, stale },
    gas_tgas: totals.gas_tgas,
    transactions: totals.transactions,
    swap_call: swapCall,
    missing_for_live: missing,
    near_cli_text: nearCli,
  };
}

/** The JSON-safe part of buildPreflight (no command text). */
export function preflightForJson({ near_cli_text: _text, ...rest }) {
  return rest;
}

const HINTS = {
  "config placeholders": "fill every <FILL_ME> in the live config (copy config/yield-vault.live.example.json, set \"placeholders\": false); see npm run yield:live:preflight",
  NEAR_NETWORK: "export NEAR_NETWORK=testnet in your shell (never mainnet)",
  YIELD_VAULT_ACCOUNT_ID: "export YIELD_VAULT_ACCOUNT_ID=<your vault>.testnet in your shell",
  YIELD_RUNNER_ACCOUNT_ID: "export YIELD_RUNNER_ACCOUNT_ID=<your runner>.testnet (a different account than the vault) in your shell",
  "fresh snapshot": `the pool snapshot is older than ${SNAPSHOT_MAX_AGE_HOURS} h; run: npm run yield:snapshot, then re-check the swap floors`,
};

/** stderr lines for --require-ready, or [] when nothing is missing. */
export function notReadyLines(pf) {
  if (pf.missing_for_live.length === 0) return [];
  return [
    `yield-live: not ready for live: ${pf.missing_for_live.join(", ")}`,
    ...pf.missing_for_live.map((m) => `  - ${m}: ${HINTS[m]}`),
  ];
}

function table(rows) {
  const head = ["check", "status", "detail"];
  const all = [head, ...rows];
  const w = [0, 1].map((c) => Math.max(...all.map((r) => r[c].length)));
  const fmt = (r) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`.trimEnd();
  return [fmt(head), `${"-".repeat(w[0])}  ${"-".repeat(w[1])}  ${"-".repeat(6)}`, ...rows.map(fmt)];
}

/** Human lines: heading, table, the unsent command text and the pointer to the full preflight. */
export function renderPreflight(pf) {
  const s = pf.snapshot;
  const swap = pf.swap_call;
  const rows = [
    ["config placeholders filled", pf.placeholders_filled ? "yes" : "no", pf.placeholders_filled ? "0 unfilled" : `${pf.placeholders_unfilled} unfilled`],
    ...PREFLIGHT_ENV_NAMES.map((n) => [`env ${n}`, pf.env[n] ? "set" : "not set", "value never shown"]),
    ["snapshot age", s.stale ? "stale" : "fresh", `${s.age_hours.toFixed(1)} h old (taken ${s.taken_at}, block ${s.block_height ?? "unknown"}); limit ${SNAPSHOT_MAX_AGE_HOURS} h${s.stale ? "; run npm run yield:snapshot" : ""}`],
    ["prepaid gas", "info", `${pf.gas_tgas} TGas over ${pf.transactions} transactions; unused gas is refunded`],
    ["the one call it would send", "info", `step ${swap.step} ${swap.method_name}, ${swap.signer_id} -> ${swap.receiver_id}, ${swap.gas_tgas} TGas, deposit ${swap.deposit_yocto} yocto`],
  ];
  return [
    PREFLIGHT_HEADING,
    ...table(rows),
    `not sent; text only: ${pf.near_cli_text}`,
    "wasm, toolchain and on-chain reads: npm run yield:live:preflight",
  ];
}
