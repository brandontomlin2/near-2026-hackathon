#!/usr/bin/env node
// DRY RUN: derive the MPC-controlled ed25519 key for (agent contract, path), then print
//  1. the AddKey tx that would attach it to the executor account (function-call key, vault-only),
//  2. the execute_swap tx signed by that key, and the exact MPC `sign` args for its hash.
// Sends nothing. Holds no private key. Nonce and block hash are placeholders; a live run reads them from RPC.
//
// usage: node spikes/shade/dry-run.mjs [--agent <id>] [--path <p>] [--executor <id>] [--vault <id>]
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MPC_CONTRACT_TESTNET, SIGN_DEPOSIT_YOCTO, SIGN_MIN_GAS_TGAS,
  deriveEd25519PublicKey, serializeTransaction, sha256, buildSignRequest, base58Encode,
} from './chainsig.mjs';

// public_key {domain_id:1} on v1.signer-prod.testnet, captured in evidence/testnet-mpc-views.txt
export const TESTNET_ED25519_ROOT = 'ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2';
const PLACEHOLDER_BLOCK_HASH = new Uint8Array(32); // live: block.header.hash from RPC
const PLACEHOLDER_NONCE = 1n; // live: access key nonce + 1

export function plan({ agent, path, executor, vault, root = TESTNET_ED25519_ROOT }) {
  const derivedKey = deriveEd25519PublicKey(root, agent, path);
  const swapArgs = { token_in: 'wrap.testnet', token_out: 'usdc.fakes.testnet', amount_in: '1000', min_amount_out: '990' };
  const swapTx = serializeTransaction({
    signerId: executor, publicKey: derivedKey, nonce: PLACEHOLDER_NONCE, receiverId: vault,
    blockHash: PLACEHOLDER_BLOCK_HASH,
    actions: [{ type: 'FunctionCall', methodName: 'execute_swap', args: swapArgs, gas: 50_000_000_000_000n, deposit: 0n }],
  });
  const swapHash = sha256(swapTx);
  return {
    dryRun: true,
    mpcContract: MPC_CONTRACT_TESTNET,
    derivation: { predecessor: agent, path, domainId: 1, rootKey: root, derivedKey },
    // One-time setup, signed by whoever owns `executor` today (a human or the factory that creates it).
    addKey: {
      signerId: executor, receiverId: executor,
      action: { type: 'AddKey', publicKey: derivedKey, permission: { allowance: null, receiverId: vault, methodNames: ['execute_swap'] } },
    },
    swap: { signerId: executor, receiverId: vault, method: 'execute_swap', args: swapArgs, txSha256Base58: base58Encode(swapHash) },
    // What the agent contract sends: `sign` on the MPC contract, 1 yocto, >= 15 Tgas.
    mpcSignCall: {
      receiverId: MPC_CONTRACT_TESTNET, method: 'sign', depositYocto: String(SIGN_DEPOSIT_YOCTO),
      minGasTgas: String(SIGN_MIN_GAS_TGAS), args: buildSignRequest({ path, txHash: swapHash }),
    },
  };
}

function parseArgs(argv) {
  const out = { agent: 'yield-agent.testnet', path: 'yield-vault-1', executor: 'yield-executor.testnet', vault: 'yield-vault.testnet' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const key = a.startsWith('--') ? a.slice(2) : '';
    if (!Object.hasOwn(out, key) || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option: ${a}`);
    const value = argv[++i];
    if (value === '' || value.startsWith('--')) throw new Error(`${a} needs a value, got ${JSON.stringify(value)}`);
    out[key] = value;
  }
  return out;
}

function isMain() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('usage: node spikes/shade/dry-run.mjs [--agent <id>] [--path <p>] [--executor <id>] [--vault <id>]\nPrints the plan as JSON. Sends nothing.');
    } else {
      console.log(JSON.stringify(plan(args), null, 2));
    }
  } catch (e) {
    console.error(`dry-run: ${e.message}`);
    process.exit(2);
  }
}
