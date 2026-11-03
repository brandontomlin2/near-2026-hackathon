#!/usr/bin/env node
// Read-only preflight for a live testnet run. Prints a checklist of what is missing.
//
// Checks: the contract wasm is built (path + size), NEAR_ACCOUNT_ID and
// NEAR_CONTRACT_ACCOUNT_ID are set and valid (names only; account ids are never printed, the wasm path is),
// NEAR_NETWORK is unset or testnet, and, when online, that the accounts exist via a
// read-only RPC `view_account` call. Never reads .env or key files, never signs.
//
// Exit 0 when ready, 1 when something is missing.

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WASM, NETWORK, validateAccountId } from "./testnet-deploy.mjs";

export const RPC_URL = "https://rpc.testnet.near.org";
export const BUILD_HINT = "Run npm run build:contract first.";

export function wasmMessage(wasm) {
  return `wasm not found at ${wasm}. ${BUILD_HINT}`;
}

function accountState(name, value) {
  if (!value) return { ok: false, note: `${name} is not set` };
  try {
    validateAccountId(value, name);
    return { ok: true, note: `${name} is set` };
  } catch {
    return { ok: false, note: `${name} is set but not a valid NEAR account id (value not shown)` };
  }
}

async function rpcViewAccount(fetchFn, account) {
  const res = await fetchFn(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "live-check", method: "query",
      params: { request_type: "view_account", finality: "final", account_id: account },
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json();
  if (body.error) {
    const text = JSON.stringify(body.error);
    if (/UNKNOWN_ACCOUNT|does not exist/i.test(text)) return "missing";
    throw new Error("rpc error");
  }
  return body.result ? "exists" : "missing";
}

/** Returns { ready, lines }. `deps.statWasm`, `deps.fetch` are injectable. */
export async function check(env = process.env, deps = {}) {
  const statWasm = deps.statWasm ?? ((p) => statSync(p).size);
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const wasm = deps.wasm ?? DEFAULT_WASM;
  const lines = [];
  let ready = true;
  const add = (ok, text) => { lines.push(`${ok ? "[ok]  " : "[todo]"} ${text}`); if (!ok) ready = false; };

  try {
    const size = statWasm(wasm);
    add(size > 0, size > 0 ? `wasm built: ${wasm} (${size} bytes)` : `wasm is empty at ${wasm}. ${BUILD_HINT}`);
  } catch {
    add(false, wasmMessage(wasm));
  }

  const owner = accountState("NEAR_ACCOUNT_ID", env.NEAR_ACCOUNT_ID);
  add(owner.ok, owner.note);
  const contractName = "NEAR_CONTRACT_ACCOUNT_ID";
  const contract = accountState(contractName, env[contractName]);
  add(contract.ok, contract.ok ? contract.note : `${contract.note} (deploy --send will not default it to NEAR_ACCOUNT_ID)`);

  const net = env.NEAR_NETWORK;
  add(!net || net === NETWORK, !net || net === NETWORK ? `NEAR_NETWORK is unset or ${NETWORK}` : `NEAR_NETWORK must be unset or ${NETWORK}`);

  const toView = [["NEAR_ACCOUNT_ID", owner, env.NEAR_ACCOUNT_ID], [contractName, contract, env[contractName]]]
    .filter(([, s, v]) => s.ok && v);
  if (toView.length === 0) {
    lines.push("[skip] account existence check skipped: no valid account env vars set");
  } else if (!fetchFn) {
    lines.push("[skip] account existence check skipped: no fetch available");
  } else {
    for (const [name, , value] of toView) {
      try {
        const state = await rpcViewAccount(fetchFn, value);
        if (state === "exists") lines.push(`[ok]   ${name} exists on ${NETWORK}`);
        else if (name === contractName && value !== env.NEAR_ACCOUNT_ID) {
          lines.push(`[note] ${name} does not exist on ${NETWORK} yet (create it outside this repo before deploy)`);
        } else add(false, `${name} does not exist on ${NETWORK}; create it outside this repo`);
      } catch {
        lines.push(`[skip] account existence check skipped for ${name}: RPC unreachable (offline?)`);
      }
    }
  }
  lines.push(ready ? "ready: yes. Next: npm run live-proof (dry run), then the owner hosts the four SVGs and adds --send --i-approve --media-base <url>." : "ready: no. Fix the [todo] items above.");
  return { ready, lines };
}

const USAGE = `Usage: node scripts/live-check.mjs
Read-only preflight for a live testnet run. Takes no options; reads
NEAR_ACCOUNT_ID, NEAR_CONTRACT_ACCOUNT_ID and NEAR_NETWORK from the environment
(account ids are never printed; the wasm path is). Exits 0 when ready, 1 when something is missing.`;

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
  } else if (argv.length > 0) {
    process.stderr.write(`live-check: unknown argument ${JSON.stringify(argv[0])}; this script takes no options (see --help)\n`);
    process.exitCode = 2;
  } else {
    const { ready, lines } = await check();
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = ready ? 0 : 1;
  }
}
