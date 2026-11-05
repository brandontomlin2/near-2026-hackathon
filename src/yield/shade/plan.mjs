// DRY RUN ONLY. Composes the unsigned Shade Agent payloads for the Yield vault into one
// JSON-serializable plan. Nothing is signed, sent or read from the network or a key file.
//
//   buildShadePlan(options?) -> plain object (deterministic for the same options)
//   renderShadePlan(plan)    -> pretty JSON string
//
// options: { agentContract, path, executor, vault, owner, proposal, rootKey, nonce, blockHash, env, network }

import { deriveEd25519PublicKey } from "../../../spikes/shade/chainsig.mjs";
import { TESTNET_ED25519_ROOT } from "../../../spikes/shade/dry-run.mjs";
import {
  EXECUTE_SWAP_GAS, assertDryRunOptions, buildMpcSignRequest, buildRunnerAuthorization, buildRunnerTx, toJsonSafe,
} from "./payloads.mjs";

export const DEFAULTS = Object.freeze({
  agentContract: "shade-agent.yield-demo.testnet",
  path: "yield-vault-1",
  executor: "executor.yield-demo.testnet",
  vault: "vault.yield-demo.testnet",
  owner: "owner.yield-demo.testnet",
});
// A fixed illustrative proposal (1 wNEAR -> nUSDT through pool 1). It is NOT rule-checked here and the pool id is a placeholder.
export const SAMPLE_PROPOSAL = Object.freeze({
  pool_id: 1,
  token_in: "wrap.testnet",
  token_out: "nusdt.ft-fin.testnet",
  amount_in: "1000000000000000000000000",
  min_amount_out: "1000000",
});
export const NOTICE = "DRY RUN. Every account below is an invented placeholder that is not deployed on testnet; nonce and block hash are placeholders. "
  + "Nothing is signed or sent. Real: the MPC signer contract and its root key.";

export function buildShadePlan(options = {}) {
  assertDryRunOptions(options, options.env ?? process.env);
  const o = { ...DEFAULTS, proposal: SAMPLE_PROPOSAL, rootKey: TESTNET_ED25519_ROOT, ...stripUndefined(options) };
  const isPlaceholder = (role) => o[role] === DEFAULTS[role];
  // The MPC contract derives from (predecessor = agent contract, path).
  const derivedKey = deriveEd25519PublicKey(o.rootKey, o.agentContract, o.path);
  const tx = buildRunnerTx({ executor: o.executor, vault: o.vault, derivedKey, nonce: o.nonce, blockHash: o.blockHash, proposal: o.proposal });
  const sign = buildMpcSignRequest({ agentContract: o.agentContract, path: o.path, txHash: tx.txHashHex });
  const auth = buildRunnerAuthorization({ owner: o.owner, vault: o.vault, executor: o.executor, derivedKey });
  return toJsonSafe({
    notice: NOTICE,
    dry_run: true, signed: false, sent: false, network: "testnet",
    accounts: Object.fromEntries(["agentContract", "executor", "vault", "owner"].map((r) => [r, {
      id: o[r], status: isPlaceholder(r) ? "placeholder, not deployed" : "user-supplied, not checked on chain",
    }])),
    derivation: { predecessor: o.agentContract, path: o.path, domain_id: 1, root_key: o.rootKey, derived_key: derivedKey },
    execute_swap: { ...tx, methodName: "execute_swap", gas: EXECUTE_SWAP_GAS, deposit: 0n, proposalNote: o.proposal === SAMPLE_PROPOSAL ? "fixed sample, not rule-checked" : "caller supplied" },
    mpc: sign,
    authorization: auth,
  });
}

const stripUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([k, v]) => v !== undefined && k !== "env"));

export const renderShadePlan = (plan) => `${JSON.stringify(plan, null, 2)}\n`;
