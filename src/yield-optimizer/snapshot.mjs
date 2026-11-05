// Loads and validates the market + vault snapshot the Yield Optimizer plans on.
//
// ONE market: by default this is the Ref testnet snapshot the four personality agents
// trade on (src/yield/fixtures/ref-testnet-pools.json, read through loadPoolFixture), the
// vault is the demo vault (PLACEHOLDER_VAULT / PLACEHOLDER_RUNNER), the clock is the mock
// round's MOCK_EPOCH_MS, and reference prices are the fixture's `mock_usd_price`
// ("mock reference price", never an oracle; null means no reference price).
//
// `--snapshot FILE` takes the same Ref shape (exchange, tokens{decimals, mock_usd_price,
// optional symbol}, pools[{pool_id, pool_kind, token_a, token_b, reserve_a, reserve_b,
// total_fee}], optional _block_height / _source) PLUS:
//   - `vault`: { vault_id, runner_id, config (VaultConfig JSON like get_config),
//                state (VaultState fields the rules read, like get_state) },
//   - the clock: exactly one of `taken_at` (ISO-8601 with Z or an offset) or `now_ms`.
// Nothing here touches the network. Amounts arrive as decimal strings (the contract's
// U128 JSON form) and leave as BigInt, so pools have the shape src/yield/pools.mjs
// `quoteOut` reads.

import { readFileSync } from "node:fs";
import { initialState } from "../yield/ledger.mjs";
import { MOCK_EPOCH_MS } from "../yield/mock.mjs";
import { loadPoolFixture } from "../yield/pools.mjs";
import { U128_MAX, dayOf, validateVaultConfig } from "../yield/rules.mjs";
import { PLACEHOLDER_RUNNER, PLACEHOLDER_VAULT, plannerVaultConfig } from "../yield/strategies.mjs";

/** The snapshot is missing, unreadable or malformed. */
export class SnapshotError extends Error {}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function need(cond, msg) {
  if (!cond) throw new SnapshotError(msg);
}

function str(v, where) {
  need(typeof v === "string" && v.length > 0, `${where} must be a non-empty string`);
  return v;
}

/** A U128 as JSON: a decimal string, 0 <= n <= 2^128-1. */
function u128(v, where) {
  need(typeof v === "string" && /^\d+$/.test(v), `${where} must be a decimal string (U128)`);
  const n = BigInt(v);
  need(n <= U128_MAX, `${where} exceeds u128`);
  return n;
}

function u64(v, where) {
  need(Number.isSafeInteger(v) && v >= 0, `${where} must be a non-negative integer`);
  return v;
}

function bool(v, where) {
  need(typeof v === "boolean", `${where} must be true or false`);
  return v;
}

function arr(v, where) {
  need(Array.isArray(v), `${where} must be an array`);
  return v;
}

/** `[[token, "amount"], ...]` (the VaultState pair form) -> Map<token, BigInt>. */
function pairs(v, where) {
  const m = new Map();
  for (const [i, e] of arr(v, where).entries()) {
    need(Array.isArray(e) && e.length === 2, `${where}[${i}] must be [token_id, amount]`);
    const t = str(e[0], `${where}[${i}][0]`);
    need(!m.has(t), `${where} lists ${t} twice`);
    m.set(t, u128(e[1], `${where}[${i}][1]`));
  }
  return m;
}

function rate(v, where) {
  need(isObj(v), `${where} must be { num, den }`);
  return { num: u128(v.num, `${where}.num`), den: u128(v.den, `${where}.den`) };
}

function parseConfig(c) {
  need(isObj(c), "vault.config must be an object (VaultConfig)");
  const config = {
    strategy: str(c.strategy, "vault.config.strategy"),
    allowed_pools: arr(c.allowed_pools, "vault.config.allowed_pools").map((p, i) => {
      const w = `vault.config.allowed_pools[${i}]`;
      need(isObj(p), `${w} must be an object`);
      return {
        pool_id: u64(p.pool_id, `${w}.pool_id`),
        token_a: str(p.token_a, `${w}.token_a`),
        token_b: str(p.token_b, `${w}.token_b`),
        min_rate_a_to_b: rate(p.min_rate_a_to_b, `${w}.min_rate_a_to_b`),
        min_rate_b_to_a: rate(p.min_rate_b_to_a, `${w}.min_rate_b_to_a`),
      };
    }),
    limits: arr(c.limits, "vault.config.limits").map((l, i) => {
      const w = `vault.config.limits[${i}]`;
      need(isObj(l), `${w} must be an object`);
      return {
        token_id: str(l.token_id, `${w}.token_id`),
        max_trade: u128(l.max_trade, `${w}.max_trade`),
        daily_cap: u128(l.daily_cap, `${w}.daily_cap`),
      };
    }),
    runners: arr(c.runners, "vault.config.runners").map((r, i) => str(r, `vault.config.runners[${i}]`)),
  };
  // The contract would never hold a config that fails validate_config.
  // validateVaultConfig lists every failure; the first is the one the contract would panic with.
  const bad = validateVaultConfig(config);
  need(bad.length === 0, `vault.config is not a valid VaultConfig: ${bad[0]}`);
  return config;
}

function parseState(s) {
  need(isObj(s), "vault.state must be an object (VaultState)");
  return {
    paused: bool(s.paused, "vault.state.paused"),
    swap_in_flight: bool(s.swap_in_flight, "vault.state.swap_in_flight"),
    recovery_in_flight: bool(s.recovery_in_flight, "vault.state.recovery_in_flight"),
    day: BigInt(u64(s.day, "vault.state.day")),
    spent_today: pairs(s.spent_today, "vault.state.spent_today"),
    balances: pairs(s.balances, "vault.state.balances"),
  };
}

/** Symbol shown for a token: the optional `symbol`, else the id before the first dot (as the personality side prints it). */
export const symbolOf = (id) => id.split(".")[0];

function parseToken(id, t) {
  const w = `tokens["${id}"]`;
  need(isObj(t), `${w} must be an object`);
  need(Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= 38, `${w}.decimals must be an integer 0..38`);
  // mock_usd_price: a decimal string, or null/absent = no reference price (never invented).
  let ref_price = null;
  if (t.mock_usd_price !== undefined && t.mock_usd_price !== null) {
    need(typeof t.mock_usd_price === "string" && /^\d+(\.\d+)?$/.test(t.mock_usd_price), `${w}.mock_usd_price must be a decimal string or null`);
    ref_price = Number(t.mock_usd_price);
    need(ref_price > 0, `${w}.mock_usd_price must be > 0`);
  }
  const symbol = t.symbol === undefined ? symbolOf(id) : str(t.symbol, `${w}.symbol`);
  return { symbol, decimals: t.decimals, ref_price };
}

/** A pool in the shape src/yield/pools.mjs reads: reserves as BigInt. */
function parsePool(p, i, tokens) {
  const w = `pools[${i}]`;
  need(isObj(p), `${w} must be an object`);
  // Only constant-product pools are quoted; a stable or rated pool needs a different formula.
  need(p.pool_kind === "SIMPLE_POOL", `${w}.pool_kind must be "SIMPLE_POOL" (got ${JSON.stringify(p.pool_kind)})`);
  const token_a = str(p.token_a, `${w}.token_a`);
  const token_b = str(p.token_b, `${w}.token_b`);
  for (const [k, t] of [["token_a", token_a], ["token_b", token_b]]) need(Object.hasOwn(tokens, t), `${w}.${k} has no entry in tokens`);
  need(token_a !== token_b, `${w} lists the same token twice`);
  const reserve_a = u128(p.reserve_a, `${w}.reserve_a`);
  const reserve_b = u128(p.reserve_b, `${w}.reserve_b`);
  need(reserve_a > 0n && reserve_b > 0n, `${w} has an empty reserve`);
  need(Number.isInteger(p.total_fee) && p.total_fee >= 0 && p.total_fee < 10_000, `${w}.total_fee must be an integer 0..9999 (bps)`);
  return { pool_id: u64(p.pool_id, `${w}.pool_id`), pool_kind: p.pool_kind, token_a, token_b, reserve_a, reserve_b, total_fee: p.total_fee };
}

/** The Ref-shaped market half of a snapshot (the committed fixture or a --snapshot file). */
function parseMarket(raw) {
  const source = typeof raw._source === "string" ? raw._source : "";
  let block_height = null;
  if (raw._block_height !== undefined) block_height = u64(raw._block_height, "_block_height");
  need(isObj(raw.tokens), "tokens must be an object keyed by token account id");
  // No prototype: a token id like "toString" or "__proto__" is just a key.
  const tokens = Object.create(null);
  for (const [id, t] of Object.entries(raw.tokens)) tokens[id] = parseToken(id, t);
  const pools = arr(raw.pools, "pools").map((p, i) => parsePool(p, i, tokens));
  need(new Set(pools.map((p) => p.pool_id)).size === pools.length, "pools lists a pool_id twice");
  return { exchange: str(raw.exchange, "exchange"), source, block_height, tokens, pools };
}

/** The clock: exactly one of taken_at (ISO) or now_ms. Returns { taken_at, now_ms }. */
function parseClock(raw) {
  const hasAt = raw.taken_at !== undefined;
  const hasMs = raw.now_ms !== undefined;
  need(hasAt !== hasMs, "give the clock as exactly one of taken_at (ISO-8601 time) or now_ms");
  if (hasMs) return { taken_at: null, now_ms: u64(raw.now_ms, "now_ms") };
  const takenAt = str(raw.taken_at, "taken_at");
  // An explicit Z or offset is required: Date.parse reads a bare time as local
  // time, which would make the UTC day (and so the daily cap) depend on the machine.
  need(ISO_UTC.test(takenAt), "taken_at must be an ISO-8601 time with Z or an offset, e.g. 2026-11-04T12:00:00Z");
  const ms = Date.parse(takenAt);
  need(Number.isFinite(ms) && ms >= 0, "taken_at must be an ISO-8601 UTC time");
  // Date.parse rolls impossible dates over (Feb 30 -> Mar 2); refuse them instead.
  const [y, mo, d, h, mi, s] = takenAt.match(/\d+/g).slice(0, 6).map(Number);
  const cal = new Date(Date.UTC(y, mo - 1, d));
  need(
    cal.getUTCFullYear() === y && cal.getUTCMonth() === mo - 1 && cal.getUTCDate() === d && h < 24 && mi < 60 && s < 60,
    `taken_at ${takenAt} is not a real calendar date and time`,
  );
  return { taken_at: takenAt, now_ms: ms };
}

/** Validates a parsed JSON value (market + vault + clock). Throws SnapshotError naming the first bad field. */
export function parseSnapshot(raw) {
  need(isObj(raw), "snapshot must be a JSON object");
  const clock = parseClock(raw);
  const market = parseMarket(raw);
  need(isObj(raw.vault), "vault must be an object { vault_id, runner_id, config, state }");
  return {
    ...market,
    ...clock,
    vault_id: str(raw.vault.vault_id, "vault.vault_id"),
    runner_id: str(raw.vault.runner_id, "vault.runner_id"),
    vault: { config: parseConfig(raw.vault.config), state: parseState(raw.vault.state) },
  };
}

/**
 * The default snapshot: the shared Ref testnet fixture, the demo vault and runner, the
 * mock round's clock. The planner vault's config is plannerVaultConfig (strategies.mjs)
 * and its balances are the ledger's fresh-agent initialState, so both halves of the demo
 * start from the same funds. Validated like a file (a broken default throws).
 */
export function defaultSnapshot() {
  const fixture = loadPoolFixture();
  const market = parseMarket(fixture);
  const fresh = initialState();
  const config = JSON.parse(JSON.stringify(plannerVaultConfig({ runner: PLACEHOLDER_RUNNER, fixture })));
  const state = {
    paused: fresh.paused,
    swap_in_flight: fresh.in_flight,
    recovery_in_flight: false,
    day: dayOf(MOCK_EPOCH_MS),
    spent_today: [],
    balances: Object.entries(fresh.balances),
  };
  return {
    ...market,
    taken_at: null,
    now_ms: MOCK_EPOCH_MS,
    vault_id: PLACEHOLDER_VAULT,
    runner_id: PLACEHOLDER_RUNNER,
    vault: { config: parseConfig(config), state: parseState(state) },
  };
}

/** Reads and validates a snapshot file; `null`/undefined gives the shared default (defaultSnapshot). Throws SnapshotError for any problem. */
export function loadSnapshot(file = null) {
  if (file === null || file === undefined) return defaultSnapshot();
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new SnapshotError(`cannot read snapshot ${file}: ${e.code ?? e.message}`);
  }
  need(text.trim().length > 0, `snapshot ${file} is empty`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SnapshotError(`snapshot ${file} is not valid JSON: ${e.message}`);
  }
  return parseSnapshot(raw);
}

/**
 * The vault of a parsed snapshot in the shapes src/yield/rules.mjs reads (the one
 * JavaScript copy of the contract's rules): `{ config, state, nowMs }`. Amounts and
 * rates stay BigInt (rules.mjs accepts them); the VaultState pair lists become
 * `{ spent: { day, amounts }, balances }` keyed by token id; `in_flight` is the
 * contract's swap in flight. `nowMs` is the snapshot time, so the UTC day rules.mjs
 * derives (ms / 86400000) is the contract's ns / NS_PER_DAY. Built on each call, so
 * it always reflects the snapshot's current vault.
 */
export function rulesView(snap) {
  const { config, state } = snap.vault;
  // No prototype: a token id like "toString" is just a key.
  const byToken = (m) => Object.assign(Object.create(null), Object.fromEntries(m));
  return {
    config,
    state: {
      paused: state.paused,
      in_flight: state.swap_in_flight,
      recovery_in_flight: state.recovery_in_flight,
      spent: { day: Number(state.day), amounts: byToken(state.spent_today) },
      balances: byToken(state.balances),
    },
    nowMs: snap.now_ms,
  };
}
