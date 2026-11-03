#!/usr/bin/env node
// Buyer-side check: does the character sheet I was handed match the hash the
// contract has anchored for this token?
//
//   npm run check-sheet -- --contract <id>.testnet --token <token_id> --sheet <file> [--rpc <https-testnet-url>]
//   npm run check-sheet -- --mock --token <token_id> --sheet <file> [--out DIR] [--contract <id>]
//
// The sheet is hashed locally with hashSheet (src/anchor/hash.mjs), the same
// function the anchor step uses, then compared with the contract's
// `sheet_anchor` for the token. `nft_in_flight` is read too: a token with a
// pending transfer can still be returned to its seller, so it is not safe to buy.
//
// Read-only guarantee: testnet mode makes two NEAR RPC `query/call_function`
// view calls (sheet_anchor, nft_in_flight) and nothing else. There is no
// signing, no key access, no transaction submission and no subprocess here.
// Mock mode makes no network call at all; it reads out/anchors.json from
// `npm run demo`. Only the public origin of the RPC URL is ever printed.
//
// Exit codes: 0 MATCH, 1 MISMATCH or IN-FLIGHT, 2 usage or RPC error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashSheet, SHEET_HASH_RE } from "../src/anchor/hash.mjs";
import { assertTestnetAccountId, assertTestnetRpcUrl, DEFAULT_RPC_URL, viewCall } from "./evidence.mjs";

// Same rule as TOKEN_RE in src/anchor/anchor.mjs (1-64 chars of [a-z0-9_-]).
const TOKEN_RE = /^[a-z0-9_-]+$/;

export class UsageError extends Error {}

const USAGE = `Usage:
  npm run check-sheet -- --contract <id>.testnet --token <token_id> --sheet <file> [--rpc <url>]
  npm run check-sheet -- --mock --token <token_id> --sheet <file> [--out DIR] [--contract <id>]

Hashes the sheet file and compares it with the hash anchored for the token.
  --contract  named testnet contract account (required unless --mock)
  --token     token id, 1-64 chars of [a-z0-9_-]
  --sheet     sheet file. A .json file must be {"sheet": "<text>"} (out/memory/<token>/sheet.json);
              any other file is hashed as a whole.
  --rpc       https testnet RPC URL (default ${DEFAULT_RPC_URL}); only its origin is printed
  --mock      offline: compare with <out>/anchors.json from npm run demo (dry-run anchors, not chain data)
  --out       demo output dir for --mock (default out)
Read-only: two view calls (sheet_anchor, nft_in_flight); nothing is signed or sent.
Exit 0 MATCH, 1 MISMATCH or IN-FLIGHT, 2 usage or RPC error.`;

// A stalled RPC must not hang the check: each view call is aborted after this.
export const RPC_TIMEOUT_MS = 15000;

const VALUE_FLAGS = new Set(["--contract", "--token", "--sheet", "--rpc", "--out"]);

export function parseArgs(argv) {
  const opts = { mock: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--mock") opts.mock = true;
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = value;
    } else if (arg.startsWith("-") && arg.includes("=")) {
      // Never echo the value: --rpc=<url> may carry an API key.
      throw new UsageError(`${arg.slice(0, arg.indexOf("="))}=<value> is not supported; pass the value as the next argument (value not shown)`);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    } else {
      throw new UsageError("unexpected positional argument (value not shown)");
    }
  }
  if (opts.help) return opts;
  if (opts.token === undefined) throw new UsageError("--token is required");
  if (opts.token.length > 64 || !TOKEN_RE.test(opts.token)) throw new UsageError("--token must be 1-64 chars of [a-z0-9_-]");
  if (opts.sheet === undefined) throw new UsageError("--sheet is required");
  if (opts.mock) {
    if (opts.rpc !== undefined) throw new UsageError("--rpc cannot be used with --mock (mock makes no network call)");
  } else {
    if (opts.contract === undefined) throw new UsageError("--contract is required (or use --mock)");
    if (opts.out !== undefined) throw new UsageError("--out only applies to --mock");
  }
  return opts;
}

/** Returns the normalized sheet hash of a file. Throws UsageError on any problem. */
export function readSheetFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read sheet file ${file}: ${err.code ?? err.message}`);
  }
  if (path.extname(file).toLowerCase() === ".json") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`sheet file ${file} is not valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.sheet !== "string") {
      throw new UsageError(`sheet file ${file} must be a JSON object with a string "sheet" field`);
    }
    text = parsed.sheet;
  }
  try {
    return hashSheet(text);
  } catch (err) {
    throw new UsageError(`sheet file ${file}: ${err.message}`);
  }
}

function verdict({ sheetHash, anchorHash, inFlight }) {
  if (inFlight) {
    return {
      code: 1,
      result:
        "IN-FLIGHT (a transfer is pending; nft_resolve_transfer may still return the token to its seller. Do not buy until in flight is false)",
    };
  }
  if (anchorHash === null) return { code: 1, result: "MISMATCH (no sheet anchored yet)" };
  return anchorHash === sheetHash ? { code: 0, result: "MATCH" } : { code: 1, result: "MISMATCH" };
}

const fail = (error) => ({ code: 2, error });

/** Replaces every form of the RPC URL that may carry a key (as given, normalized, path+query) with its origin. */
export function redact(text, rpcUrl, origin) {
  const url = new URL(rpcUrl);
  const forms = [rpcUrl, url.href, `${url.pathname}${url.search}`, url.username, url.password, url.hash].filter((f) => f.length > 1);
  return forms.reduce((out, form) => out.split(form).join(form.startsWith("/") ? "/<redacted>" : origin), text);
}

/** Two read-only view calls. Never throws for chain/RPC problems; returns { code, error } or a report. */
export async function checkTestnet({ contract, token, sheetHash, rpcUrl = DEFAULT_RPC_URL, fetchImpl = globalThis.fetch }) {
  let account;
  let rpc;
  try {
    account = assertTestnetAccountId(contract, "--contract");
    rpc = assertTestnetRpcUrl(rpcUrl);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const timedFetch = (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const call = (method) => viewCall({ fetchImpl: timedFetch, rpcUrl, contract: account, method, args: { token_id: token } });
  const anchorView = await call("sheet_anchor");
  const flightView = await call("nft_in_flight");
  for (const view of [anchorView, flightView]) {
    if (view.error) {
      const message = redact(String(view.error), rpcUrl, rpc);
      return fail(`RPC error: ${message}`);
    }
  }
  const anchor = anchorView.result;
  if (anchor === null) return fail(`token ${token} not found on ${account}`);
  if (
    typeof anchor !== "object" ||
    Array.isArray(anchor) ||
    !("sheet_hash" in anchor) ||
    !(anchor.sheet_hash === null || (typeof anchor.sheet_hash === "string" && SHEET_HASH_RE.test(anchor.sheet_hash))) ||
    !Number.isSafeInteger(anchor.memory_depth) ||
    anchor.memory_depth < 0
  ) {
    return fail("malformed sheet_anchor response (expected {sheet_hash: 64 hex | null, memory_depth: non-negative integer, ...})");
  }
  if (typeof flightView.result !== "boolean") return fail("malformed nft_in_flight response (expected a boolean)");
  const inFlight = flightView.result;
  return {
    ...verdict({ sheetHash, anchorHash: anchor.sheet_hash, inFlight }),
    header: "check-sheet: testnet, read-only view calls (nothing signed or sent)",
    fields: {
      contract: account,
      token,
      rpc,
      sheetHash,
      anchorHash: anchor.sheet_hash,
      memoryDepth: anchor.memory_depth,
      inFlight: String(inFlight),
    },
  };
}

/** Offline: compare with the latest dry-run anchor for the token in <outDir>/anchors.json. */
export function checkMock({ outDir = "out", token, sheetHash, contract, cwd = process.cwd() }) {
  const file = path.resolve(cwd, outDir, "anchors.json");
  const shown = path.join(outDir, "anchors.json");
  let anchors;
  try {
    anchors = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fail(`cannot read ${shown} (run npm run demo first)`);
  }
  if (!anchors || typeof anchors.contractId !== "string" || !Array.isArray(anchors.calls)) {
    return fail(`${shown} is not a demo anchors file (run npm run demo first)`);
  }
  if (contract !== undefined && contract !== anchors.contractId) {
    return fail(`--contract does not match ${shown} (it holds ${anchors.contractId})`);
  }
  const last = anchors.calls.filter((c) => c?.tokenId === token).at(-1);
  const anchorHash = last?.args?.sheet_hash;
  if (!last) return fail(`token ${token} not found in ${shown}`);
  if (typeof anchorHash !== "string" || !SHEET_HASH_RE.test(anchorHash)) return fail(`${shown} has a malformed sheet_hash for ${token}`);
  return {
    ...verdict({ sheetHash, anchorHash, inFlight: false }),
    header: `check-sheet: MOCK, offline: compares with ${shown} (dry-run anchors, not chain data)`,
    fields: {
      contract: anchors.contractId,
      token,
      sheetHash,
      anchorHash,
      inFlight: "false (mock: demo has no transfer locks)",
    },
  };
}

function render(report, sheetPath) {
  const f = report.fields;
  const rows = [
    ["contract:", f.contract],
    ["token:", f.token],
    ...(f.rpc !== undefined ? [["rpc:", f.rpc]] : []),
    ["sheet file:", sheetPath],
    ["sheet hash:", f.sheetHash],
    ["anchor hash:", String(f.anchorHash)],
    ...(f.memoryDepth !== undefined ? [["memory depth:", String(f.memoryDepth)]] : []),
    ["in flight:", f.inFlight],
  ];
  return [report.header, ...rows.map(([k, v]) => `${k.padEnd(14)}${v}`), `result: ${report.result}`];
}

export async function main(
  argv = process.argv.slice(2),
  { fetchImpl = globalThis.fetch, log = console.log, error = console.error, cwd = process.cwd() } = {},
) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      log(USAGE);
      return 0;
    }
    const sheetHash = readSheetFile(path.resolve(cwd, opts.sheet));
    const report = opts.mock
      ? checkMock({ outDir: opts.out ?? "out", token: opts.token, sheetHash, contract: opts.contract, cwd })
      : await checkTestnet({ contract: opts.contract, token: opts.token, sheetHash, rpcUrl: opts.rpc ?? DEFAULT_RPC_URL, fetchImpl });
    if (report.error) {
      error(`check-sheet: ${report.error}`);
      return report.code;
    }
    for (const line of render(report, opts.sheet)) log(line);
    return report.code;
  } catch (err) {
    if (err instanceof UsageError) {
      error(`check-sheet: ${err.message} (see --help)`);
      return 2;
    }
    error(`check-sheet: ${err instanceof Error ? err.message : err}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
