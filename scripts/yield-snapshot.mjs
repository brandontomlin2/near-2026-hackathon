#!/usr/bin/env node
// Regenerates src/yield/fixtures/ref-testnet-pools.json from read-only NEAR testnet JSON-RPC
// view calls (block, then query/call_function for get_pool, ft_metadata, get_return, all
// pinned to that one block). Nothing here signs or sends: the fetch layer refuses every RPC
// method and contract method outside the allowlists below, and uses curl with no credentials.
//
//   node scripts/yield-snapshot.mjs                 fetch live, write the fixture
//   node scripts/yield-snapshot.mjs --from DIR      build from saved raw responses (no network)
//   node scripts/yield-snapshot.mjs --out FILE      write somewhere else
//   node scripts/yield-snapshot.mjs --check         build, exit 1 if it differs from the fixture
//   node scripts/yield-snapshot.mjs --rpc URL       an allowlisted RPC (default fastnear)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("../src/yield/fixtures/ref-testnet-pools.json", import.meta.url));

export const EXCHANGE = "ref-finance-101.testnet";
export const DEFAULT_RPC = "https://rpc.testnet.fastnear.com";
export const ALLOWED_RPCS = [DEFAULT_RPC, "https://rpc.testnet.near.org"];
export const ALLOWED_RPC_METHODS = ["block", "query"];
export const ALLOWED_VIEW_METHODS = ["get_pool", "ft_metadata", "get_return"];

/** Pools in the snapshot (order is the fixture's _pool_ids order). */
export const POOL_IDS = [0, 1, 2, 5, 6, 8, 747];

/**
 * Demo-owned token labels, NOT market data (decimals come from ft_metadata). Key order is the
 * fixture's token order. stable = the demo treats the token as pegged; mock_usd_price is the
 * demo's reference price: stables use the "1.00" peg, wrap.testnet a fixed mock "3.00", null
 * means no reference price.
 */
export const TOKEN_LABELS = {
  "wrap.testnet": { stable: false, mock_usd_price: "3.00" },
  "nusdt.ft-fin.testnet": { stable: true, mock_usd_price: "1.00" },
  "nusdc.ft-fin.testnet": { stable: true, mock_usd_price: "1.00" },
  "rft.tokenfactory.testnet": { stable: false, mock_usd_price: null },
  "banana.ft-fin.testnet": { stable: false, mock_usd_price: null },
  "usdc.fakes.testnet": { stable: true, mock_usd_price: "1.00" },
  "usdt.fakes.testnet": { stable: true, mock_usd_price: "1.00" },
};

/** get_return queries recorded next to the pools (file = name of the saved raw response). */
export const RETURN_QUERIES = [
  { pool_id: 747, token_in: "usdc.fakes.testnet", amount_in: "50000", token_out: "usdt.fakes.testnet", file: "ret_747_usdc.json" },
];

// Hand-written commentary about the pools in this snapshot; revisit it when the data changes.
const NOTE =
  "Decoded snapshot of selected pools. Amounts are base units (decimal strings); total_fee is in bps (of 10000); decimals come from each token's ft_metadata. mock_usd_price is the demo's reference price, not an oracle: stable tokens use the $1 peg, wrap.testnet a fixed mock $3.00, null means no reference price. Testnet liquidity is thin and most reserves are junk (e.g. pool 1, nusdt/nusdc, is far off the peg); pool 747 (usdc.fakes/usdt.fakes) is shallow but near the peg. Read the reserves below, not this note: it is regenerated unchanged. ref_get_return records Ref's own get_return view at the same block, so the constant-product quote can be checked against the exchange.";

/** View-call results arrive as { result: number[] } holding UTF-8 JSON bytes. */
export function decodeViewResult(result) {
  if (!result || !Array.isArray(result.result)) throw new Error("view result has no result byte array");
  return JSON.parse(Buffer.from(result.result).toString("utf8"));
}

const isoSeconds = (nanos) => new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString().replace(/\.\d+Z$/, "Z");

/**
 * Pure transform from raw RPC `result` objects to the fixture object.
 * block = block result; pools/metadata/returns = call_function results keyed by pool id,
 * token id and RETURN_QUERIES file name.
 */
export function buildFixture({ block, pools, metadata, returns, rpc = DEFAULT_RPC }) {
  const { height, hash, timestamp_nanosec } = block.header;
  const outPools = POOL_IDS.map((id) => {
    const p = decodeViewResult(pools[id]);
    if (p.pool_kind !== "SIMPLE_POOL" || p.token_account_ids.length !== 2 || p.amounts.length !== 2) {
      throw new Error(`pool ${id} is not a two-token SIMPLE_POOL`);
    }
    const [token_a, token_b] = p.token_account_ids;
    for (const t of [token_a, token_b]) if (!(t in TOKEN_LABELS)) throw new Error(`pool ${id} token ${t} has no entry in TOKEN_LABELS`);
    return { pool_id: id, pool_kind: p.pool_kind, token_a, token_b, reserve_a: p.amounts[0], reserve_b: p.amounts[1], total_fee: p.total_fee };
  });
  const tokens = {};
  for (const [id, label] of Object.entries(TOKEN_LABELS)) {
    const decimals = decodeViewResult(metadata[id]).decimals;
    if (!Number.isInteger(decimals)) throw new Error(`ft_metadata of ${id} has no integer decimals`);
    tokens[id] = { decimals, stable: label.stable, mock_usd_price: label.mock_usd_price };
  }
  return {
    _source: `Ref/Rhea testnet exchange ${EXCHANGE}, view get_pool per pool id and ft_metadata per token, via ${rpc} (JSON-RPC query/call_function, block_id ${height}). Regenerate with: node scripts/yield-snapshot.mjs`,
    _block_height: height,
    _block_hash: hash,
    _taken_at: isoSeconds(timestamp_nanosec),
    _pool_ids: [...POOL_IDS],
    _note: NOTE,
    exchange: EXCHANGE,
    tokens,
    pools: outPools,
    ref_get_return: RETURN_QUERIES.map(({ file, ...q }) => ({ ...q, amount_out: decodeViewResult(returns[file]) })),
  };
}

export const serialize = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

// ---------------------------------------------------------------- fetch layer

/** Throws unless this is an allowlisted RPC call: block, or query/call_function of a view method. */
export function assertAllowedRequest(rpc, body) {
  if (!ALLOWED_RPCS.includes(rpc)) throw new Error(`RPC ${rpc} is not allowlisted (${ALLOWED_RPCS.join(", ")})`);
  if (!ALLOWED_RPC_METHODS.includes(body.method)) throw new Error(`RPC method ${body.method} is not allowlisted`);
  if (body.method === "query") {
    const p = body.params ?? {};
    if (p.request_type !== "call_function") throw new Error(`query request_type ${p.request_type} is not allowlisted`);
    if (!ALLOWED_VIEW_METHODS.includes(p.method_name)) throw new Error(`contract method ${p.method_name} is not allowlisted`);
  }
}

/** One JSON-RPC POST through curl (no shell, no credentials). Returns the `result` object. */
export function rpcCall(rpc, method, params, id = 1) {
  const body = { jsonrpc: "2.0", id, method, params };
  assertAllowedRequest(rpc, body);
  const out = execFileSync(
    "curl",
    ["-sS", "--fail", "--max-time", "30", "-X", "POST", "-H", "content-type: application/json", "--data-binary", JSON.stringify(body), rpc],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const res = JSON.parse(out);
  if (res.error || !res.result) throw new Error(`RPC ${method} failed: ${JSON.stringify(res.error ?? res)}`);
  if (res.result.error) throw new Error(`${method} ${params.method_name ?? ""} failed: ${res.result.error}`);
  return res.result;
}

const args64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

/** Fetches every raw response, all pinned to one final block. Returns the buildFixture input. */
export function fetchRaw(rpc = DEFAULT_RPC) {
  const block = rpcCall(rpc, "block", { finality: "final" });
  const block_id = block.header.height;
  const view = (account_id, method_name, args) =>
    rpcCall(rpc, "query", { request_type: "call_function", block_id, account_id, method_name, args_base64: args64(args) });
  const pools = Object.fromEntries(POOL_IDS.map((id) => [id, view(EXCHANGE, "get_pool", { pool_id: id })]));
  const metadata = Object.fromEntries(Object.keys(TOKEN_LABELS).map((t) => [t, view(t, "ft_metadata", {})]));
  const returns = Object.fromEntries(
    RETURN_QUERIES.map(({ file, pool_id, token_in, amount_in, token_out }) => [file, view(EXCHANGE, "get_return", { pool_id, token_in, amount_in, token_out })]),
  );
  return { block, pools, metadata, returns, rpc };
}

// ---------------------------------------------------------------- saved responses

const readRpc = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8")).result;

/** Reads the saved layout: block.json, pool_<id>.json, meta_<token>.json, and RETURN_QUERIES files. */
export function readRaw(dir, rpc = DEFAULT_RPC) {
  return {
    block: readRpc(dir, "block.json"),
    pools: Object.fromEntries(POOL_IDS.map((id) => [id, readRpc(dir, `pool_${id}.json`)])),
    metadata: Object.fromEntries(Object.keys(TOKEN_LABELS).map((t) => [t, readRpc(dir, `meta_${t}.json`)])),
    returns: Object.fromEntries(RETURN_QUERIES.map(({ file }) => [file, readRpc(dir, file)])),
    rpc,
  };
}

// ---------------------------------------------------------------- CLI

const HELP = `Usage: node scripts/yield-snapshot.mjs [--from DIR] [--out FILE] [--check] [--rpc URL] [--help]
  (no flags)  fetch the Ref testnet pools over read-only JSON-RPC and write the fixture
  --from DIR  build from saved raw responses in DIR instead of the network
  --out FILE  write FILE instead of src/yield/fixtures/ref-testnet-pools.json
  --check     build and exit 1 if the result differs from the committed fixture (writes nothing)
  --rpc URL   one of: ${ALLOWED_RPCS.join(", ")}`;

export function main(argv) {
  const opt = { from: null, out: FIXTURE_PATH, check: false, rpc: DEFAULT_RPC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--help" || a === "-h") {
      console.log(HELP);
      return 0;
    } else if (a === "--from") opt.from = val();
    else if (a === "--out") opt.out = val();
    else if (a === "--rpc") opt.rpc = val();
    else if (a === "--check") opt.check = true;
    else throw new Error(`unknown argument ${a}\n${HELP}`);
  }
  const text = serialize(buildFixture(opt.from ? readRaw(opt.from, opt.rpc) : fetchRaw(opt.rpc)));
  if (opt.check) {
    if (text === readFileSync(FIXTURE_PATH, "utf8")) {
      console.log("yield-snapshot: fixture is up to date");
      return 0;
    }
    console.error("yield-snapshot: built output differs from the committed fixture");
    return 1;
  }
  writeFileSync(opt.out, text);
  console.log(`yield-snapshot: wrote ${opt.out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`yield-snapshot: ${err.message}`);
    process.exitCode = 1;
  }
}
