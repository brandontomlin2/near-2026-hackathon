#!/usr/bin/env node
// Writes out/evidence.json: the proof a judge can check against the chain.
//
//   node scripts/evidence.mjs                      # mock: placeholders, mock:true
//   EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract-account> \
//     [EVIDENCE_TX_FILE=out/txs.json] node scripts/evidence.mjs
//
// The contract account is NEAR_CONTRACT_ACCOUNT_ID, the same variable the deploy
// step uses for it; NEAR_ACCOUNT_ID (the signer there) is the fallback when it is
// unset, so the account split matches scripts/testnet-deploy.mjs.
//
// Testnet mode makes NEAR RPC `query/call_function` view calls only: no
// signing, no keys, no transactions. It records the raw RPC responses for
// `nft_tokens` and `sheet_anchor` (one per token). Transaction hashes made
// elsewhere (deploy, mint, anchor) come in through EVIDENCE_TX_FILE: a JSON
// array of hashes or {hash, label} objects, or {"transactions": [...]}.
// Mock mode never emits a real-looking hash: placeholders contain "MOCK-".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMemoryLoop } from "../src/memory/loop.mjs";
import { runSwarm } from "../src/swarm/runner.mjs";
import { validateTestnetAccountId } from "./testnet-deploy.mjs";

export const AGENTS = ["Aloof", "Chaotic", "Social", "Skeptic"];
export const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export class EvidenceError extends Error {}

/**
 * The form of an RPC URL that may be written to evidence.json or printed: the
 * origin only (scheme://host[:port]). Paid providers put API keys in userinfo,
 * the query string or the path (Alchemy /v2/<key>, Infura /v3/<key>, QuickNode
 * /<token>/), and verify.sh copies this file into PR "Proof" sections, so none
 * of those parts is kept.
 */
export function publicRpcUrl(rpcUrl) {
  let url;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new EvidenceError("NEAR_RPC_URL is not a valid URL (value not shown)");
  }
  return url.origin;
}

const SECRET_ENV_NAMES = ["NEAR_AI_API_KEY"];

/**
 * Scrub an error message before it is recorded: each full RPC URL becomes its
 * origin, and the values of known secret env vars (raw and encodeURIComponent
 * forms) become [REDACTED]. Messages from fetch or the RPC may quote either.
 */
export function scrubErrorMessage(message, { rpcUrl, env = process.env } = {}) {
  let text = String(message);
  let origin;
  try {
    origin = new URL(rpcUrl).origin;
  } catch {
    origin = undefined;
  }
  if (origin) {
    for (const full of new Set([rpcUrl, new URL(rpcUrl).href])) text = text.split(full).join(origin);
  }
  for (const name of SECRET_ENV_NAMES) {
    const secret = env[name];
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.split(form).join("[REDACTED]");
  }
  return text;
}

/**
 * Testnet evidence must be read from a testnet endpoint over https: the host
 * must carry a "testnet" label and no "mainnet" anywhere. Returns the public
 * form. The value is never echoed: it may contain a key.
 */
export function assertTestnetRpcUrl(rpcUrl) {
  const recorded = publicRpcUrl(rpcUrl);
  const { protocol, hostname } = new URL(rpcUrl);
  const labels = hostname.toLowerCase().split(/[.-]/);
  if (protocol !== "https:" || !labels.includes("testnet") || /mainnet/i.test(hostname)) {
    throw new EvidenceError("NEAR_RPC_URL must be an https URL whose host names testnet (value not shown); mainnet or unlabelled endpoints are refused");
  }
  return recorded;
}

/**
 * The contract account must be a named testnet account; mainnet and implicit ids
 * are refused. The rule itself lives in scripts/testnet-deploy.mjs so the tools
 * that send apply the same one. `label` names the variable the value came from.
 * Never echoes the value.
 */
export function assertTestnetAccountId(contract, label = "NEAR_CONTRACT_ACCOUNT_ID") {
  try {
    return validateTestnetAccountId(contract, label);
  } catch (err) {
    throw new EvidenceError(err.message);
  }
}

const MOCK_LABEL = "MOCK: dry-run only. Nothing signed, nothing sent, no chain queried. Not on-chain proof.";
const MOCK_BANNER = [
  "#".repeat(64),
  "# MOCK EVIDENCE - NOT ON-CHAIN PROOF".padEnd(63) + "#",
  "# dry-run only: nothing signed, nothing sent, no chain queried".padEnd(63) + "#",
  "#".repeat(64),
].join("\n");

function evidenceAnchor(a) {
  return {
    mock: true,
    status: a.status,
    method: a.methodName,
    contract: a.contractId,
    args: { ...a.args },
    gas: a.gas,
    deposit_yocto: a.depositYocto,
    transaction_hash: a.transactionHash,
    linked_round_hash: a.linkedRoundHash,
  };
}

/** Same code path as `npm run swarm` (5 rounds, seed 1): persona mocks, the sheet stand-in, dry-run anchors. */
async function mockMemoryLoop(contract) {
  const rounds = 5;
  const seed = 1;
  const swarm = await runSwarm({ rounds, seed });
  const loop = await runMemoryLoop({ swarm, contractId: contract });
  return {
    mock: true,
    label: MOCK_LABEL,
    flow: ["swarm", "summary sheet hash", "anchor_sheet dry-run per token", "final round hash"],
    note: "The contract has no round-hash method; the final round hash is linked by recording it on each anchor dry-run.",
    swarm: {
      rounds,
      seed,
      every: loop.every,
      events: swarm.events.length,
      round_hashes: loop.roundHashes,
      final_round_hash: loop.finalRoundHash,
    },
    tokens: loop.tokens.map((t) => ({
      token_id: t.tokenId,
      agent: t.name,
      mock: true,
      sheet: {
        round: t.sheet.round,
        sheet_hash: t.sheet.sheetHash,
        words: t.sheet.sheet.split(/\s+/).filter(Boolean).length,
        through_index: t.sheet.throughIndex,
        mode: t.sheet.mode,
      },
      anchor: evidenceAnchor(t.anchor),
      // Every sheet, oldest first: each with its own anchor_sheet dry-run and the hash of the round it was written at.
      sheets: t.sheets.map((s) => ({
        round: s.round,
        sheet_hash: s.sheet.sheetHash,
        previous_hash: s.diff.previousHash,
        anchor: evidenceAnchor(s.anchor),
      })),
    })),
  };
}

/** Deterministic placeholder evidence. Nothing here came from a chain. */
export async function mockEvidence() {
  const contract = "mock-contract.testnet";
  return {
    mock: true,
    network: "mock",
    note: "Placeholder entries. No chain was queried and no transaction was sent.",
    contract,
    memory_loop: await mockMemoryLoop(contract),
    transactions: ["deploy", "mint", "anchor_sheet"].map((label) => ({
      label,
      hash: `MOCK-${label}`,
      mock: true,
    })),
    views: AGENTS.flatMap((agent) => [
      { method: "nft_tokens", agent, mock: true, args: { from_index: "0", limit: 4 }, result: null },
      {
        method: "sheet_anchor",
        agent,
        mock: true,
        args: { token_id: agent.toLowerCase() },
        result: null,
      },
    ]),
  };
}

/** Reads tx hashes from a file. Throws on anything that is not a base58 hash. */
export function loadTransactions(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new EvidenceError(`cannot read tx file ${file}: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.transactions;
  if (!Array.isArray(list)) {
    throw new EvidenceError("tx file must be an array or {transactions: [...]}");
  }
  return list.map((entry) => {
    const tx = typeof entry === "string" ? { hash: entry } : { ...entry };
    if (typeof tx.hash !== "string" || !BASE58_HASH.test(tx.hash)) {
      throw new EvidenceError(`invalid transaction hash: ${JSON.stringify(tx.hash)}`);
    }
    return tx;
  });
}

/**
 * One view call over JSON-RPC. Returns the record, with the raw rpc response.
 * Every failure, an unparsable rpcUrl included, lands in record.error; the call
 * never throws. Only the public form of the URL is recorded.
 */
export async function viewCall({ fetchImpl, rpcUrl, contract, method, args, extra = {} }) {
  const record = { method, ...extra, args };
  const body = {
    jsonrpc: "2.0",
    id: "evidence",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  };
  try {
    record.request = { rpc_url: publicRpcUrl(rpcUrl), ...body };
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    record.response = json;
    if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    const out = json.result;
    if (!out || !Array.isArray(out.result)) throw new Error("RPC result has no result bytes");
    if (out.error) throw new Error(`contract error: ${out.error}`);
    record.block_height = out.block_height;
    record.block_hash = out.block_hash;
    record.result = JSON.parse(Buffer.from(out.result).toString("utf8"));
  } catch (err) {
    record.error = scrubErrorMessage(err.message, { rpcUrl });
  }
  return record;
}

function agentFor(token, index) {
  const title = `${token?.metadata?.title ?? ""} ${token?.metadata?.description ?? ""}`.toLowerCase();
  return AGENTS.find((a) => title.includes(a.toLowerCase())) ?? AGENTS[index] ?? null;
}

/** Which variable supplies the contract account, and its value: NEAR_CONTRACT_ACCOUNT_ID, else NEAR_ACCOUNT_ID. */
export function contractAccountFrom(env) {
  if (env.NEAR_CONTRACT_ACCOUNT_ID) return { contract: env.NEAR_CONTRACT_ACCOUNT_ID, contractLabel: "NEAR_CONTRACT_ACCOUNT_ID" };
  return { contract: env.NEAR_ACCOUNT_ID, contractLabel: env.NEAR_ACCOUNT_ID ? "NEAR_ACCOUNT_ID" : "NEAR_CONTRACT_ACCOUNT_ID (or NEAR_ACCOUNT_ID)" };
}

export async function testnetEvidence({ contract, contractLabel = "NEAR_CONTRACT_ACCOUNT_ID", fetchImpl = globalThis.fetch, rpcUrl = DEFAULT_RPC_URL, txFile }) {
  if (!contract) throw new EvidenceError(`${contractLabel} is required for testnet evidence`);
  assertTestnetAccountId(contract, contractLabel);
  const recordedRpcUrl = assertTestnetRpcUrl(rpcUrl);
  const transactions = txFile ? loadTransactions(txFile) : [];
  const views = [];
  const tokensView = await viewCall({
    fetchImpl,
    rpcUrl,
    contract,
    method: "nft_tokens",
    args: { from_index: "0", limit: AGENTS.length },
  });
  views.push(tokensView);
  const tokens = Array.isArray(tokensView.result) ? tokensView.result : [];
  for (const [i, token] of tokens.slice(0, AGENTS.length).entries()) {
    views.push(
      await viewCall({
        fetchImpl,
        rpcUrl,
        contract,
        method: "sheet_anchor",
        args: { token_id: token.token_id },
        extra: { agent: agentFor(token, i) },
      }),
    );
  }
  return {
    mock: false,
    network: "testnet",
    contract,
    rpc_url: recordedRpcUrl,
    generated_at: new Date().toISOString(),
    transactions,
    views,
  };
}

export async function main(env = process.env, { fetchImpl = globalThis.fetch, cwd = process.cwd() } = {}) {
  const network = env.EVIDENCE_NETWORK ?? "mock";
  let evidence;
  if (network === "mock") {
    evidence = await mockEvidence();
    console.log(MOCK_BANNER);
  } else if (network === "testnet") {
    evidence = await testnetEvidence({
      ...contractAccountFrom(env),
      fetchImpl,
      rpcUrl: env.NEAR_RPC_URL || DEFAULT_RPC_URL,
      txFile: env.EVIDENCE_TX_FILE,
    });
  } else {
    throw new EvidenceError(`EVIDENCE_NETWORK must be mock or testnet, got ${network}`);
  }
  const outFile = path.resolve(cwd, env.EVIDENCE_OUT || "out/evidence.json");
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch (err) {
    throw new Error(`cannot write ${outFile}: ${err.message}`);
  }
  const failed = evidence.views.filter((v) => v.error);
  console.log(`wrote ${outFile} (${evidence.mock ? "mock" : evidence.network})`);
  for (const v of failed) console.error(`view failed: ${v.method}: ${v.error}`);
  return failed.length ? 1 : 0;
}

const USAGE = `Usage: node scripts/evidence.mjs
Writes out/evidence.json. Takes no options; it is configured by the environment:
  EVIDENCE_NETWORK   mock (default) or testnet
  NEAR_CONTRACT_ACCOUNT_ID
                     contract account to query (testnet only; must be a named .testnet
                     account). Falls back to NEAR_ACCOUNT_ID when unset.
  NEAR_RPC_URL       RPC endpoint (default ${DEFAULT_RPC_URL}); https with a testnet host.
                     Only its origin (scheme://host[:port]) is written to the evidence
                     file: userinfo, path, query and fragment (where providers put API
                     keys) are used for the request and never recorded.
  EVIDENCE_TX_FILE   JSON file of transaction hashes to include (testnet only)
  EVIDENCE_OUT       output file (default out/evidence.json)
Mock mode never touches the network. Testnet mode makes read-only view calls only:
nothing is signed, nothing is sent. Exits 0 on success, 1 when a view call failed.`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === "--help" || a === "-h")) {
    console.log(USAGE);
    process.exit(0);
  } else if (argv.length > 0) {
    console.error(`evidence: unknown argument ${JSON.stringify(argv[0])}; this script takes no options (see --help)`);
    process.exit(2);
  }
  main().then(
    (code) => process.exit(code),
    (err) => {
      // EvidenceError: a bad environment value or tx file, the user's to fix. Anything else is a runtime failure.
      const usage = err instanceof EvidenceError;
      console.error(`evidence: ${err instanceof Error ? err.message : err}${usage ? " (see --help)" : ""}`);
      process.exit(usage ? 2 : 1);
    },
  );
}
