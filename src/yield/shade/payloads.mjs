// DRY RUN ONLY. Builders for the UNSIGNED payloads a Shade Agent runner would send to the Yield vault.
// Nothing here signs, sends, reads a key or touches the network. Pure functions over their inputs.
//
// Exports:
//   buildExecuteSwapAction(proposal)                      -> FunctionCall action (bigint gas/deposit)
//   buildRunnerTx({executor, vault, derivedKey, nonce?, blockHash?, proposal})
//   buildMpcSignRequest({agentContract, path, txHash})    -> MPC `sign` call + agent `request_signature` shape
//   buildRunnerAuthorization({owner, vault, executor, derivedKey})
//   toJsonSafe(value)                                     -> bigint/Uint8Array -> JSON-safe
//   assertDryRunOptions(options)                          -> throws RefusalError on any signing/mainnet input

import { isValidAccountId } from "../../anchor/anchor.mjs";
import {
  MPC_CONTRACT_TESTNET, SIGN_DEPOSIT_YOCTO, SIGN_MIN_GAS_TGAS, base58Encode,
  buildSignRequest, serializeTransaction, sha256,
} from "../../../spikes/shade/chainsig.mjs";
import { VAULT_PROPOSAL_KEYS, vaultArgs } from "../proposal.mjs";
import { EXECUTE_SWAP_GAS, TGAS } from "../gas.mjs";
import { METHOD, RefusalError, assertNotMainnet } from "../send.mjs";

export { RefusalError };
export { EXECUTE_SWAP_GAS, TGAS }; // 280 Tgas = vault MIN_EXECUTE_GAS (see ../gas.mjs)
export const OWNER_CALL_DEPOSIT = 1n; // 1 yocto: owner_one_yocto on #[payable] owner methods
// UNMEASURED CHOICE: 2x the 15 Tgas minimum for the MPC `sign` call. Not benchmarked on testnet.
export const MPC_SIGN_GAS = 30n * TGAS;
// UNMEASURED CHOICE: the agent contract forwards to MPC, so give it generous headroom. Not benchmarked.
export const AGENT_REQUEST_SIGNATURE_GAS = 100n * TGAS;
// Function-call key allowance: 1 NEAR. https://docs.near.org/protocol/access-keys (fetched 2026-11-05): the allowance
// "defines how much NEAR the key can spend on gas fees", is charged at the buy price, is credited back when the gas
// refund arrives (so the key needs more allowance than the final tx cost), and once used up the key cannot sign.
// Adding NEAR to the account does not help and an existing key's allowance cannot be changed (DeleteKey + AddKey).
// Each swap prepays 280 Tgas at the buy price: about 0.028 NEAR at the 0.0001 NEAR/Tgas minimum gas price (that price
// is an ASSUMPTION, not read from chain). Burnt fees accumulate; refunds credit back. 1 NEAR is headroom for a
// testnet run. The value is a CHOICE, not measured.
export const EXECUTOR_KEY_ALLOWANCE_YOCTO = 1_000_000_000_000_000_000_000_000n;
export const PLACEHOLDER_NONCE = 1n; // live: executor access-key nonce + 1 from RPC
export const PLACEHOLDER_BLOCK_HASH = base58Encode(new Uint8Array(32)); // live: block.header.hash from RPC

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkAccount(role, id) {
  if (!isValidAccountId(id)) throw new RefusalError(`${role} is not a valid account id (value not shown)`);
  if (/\.near$/i.test(id)) throw new RefusalError(`refused: ${role} ends in .near (mainnet). Testnet only.`);
  if (!id.endsWith(".testnet")) throw new RefusalError(`refused: ${role} must be a named .testnet account (value not shown)`);
}

/** The vault args, validated: exactly the SwapProposal fields (rationale and anything else is rejected). */
function checkProposal(proposal) {
  if (!isObj(proposal)) throw new Error("proposal must be an object");
  for (const k of VAULT_PROPOSAL_KEYS) if (!Object.hasOwn(proposal, k)) throw new Error(`proposal is missing key ${k}`);
  for (const k of Object.keys(proposal)) {
    if (!VAULT_PROPOSAL_KEYS.includes(k)) throw new Error(`proposal has unexpected key ${JSON.stringify(k).slice(0, 40)}`);
  }
  if (!Number.isSafeInteger(proposal.pool_id) || proposal.pool_id < 0) throw new Error("proposal pool_id must be a non-negative safe integer");
  for (const k of ["token_in", "token_out"]) {
    if (typeof proposal[k] !== "string") throw new Error(`proposal ${k} must be a string`);
  }
  for (const k of ["amount_in", "min_amount_out"]) {
    if (typeof proposal[k] !== "string" || !/^(0|[1-9][0-9]*)$/.test(proposal[k])) {
      throw new Error(`proposal ${k} must be a decimal integer string without leading zeros`);
    }
  }
}

export function buildExecuteSwapAction(proposal) {
  checkProposal(proposal);
  return { type: "FunctionCall", methodName: METHOD, args: vaultArgs(proposal), gas: EXECUTE_SWAP_GAS, deposit: 0n };
}

export function buildRunnerTx({ executor, vault, derivedKey, nonce, blockHash, proposal }) {
  checkAccount("executor", executor);
  checkAccount("vault", vault);
  const nonceIsPlaceholder = nonce === undefined;
  const blockHashIsPlaceholder = blockHash === undefined;
  const useNonce = nonceIsPlaceholder ? PLACEHOLDER_NONCE : BigInt(nonce);
  const useHash = blockHashIsPlaceholder ? PLACEHOLDER_BLOCK_HASH : blockHash;
  const action = buildExecuteSwapAction(proposal);
  const bytes = serializeTransaction({
    signerId: executor, publicKey: derivedKey, nonce: useNonce, receiverId: vault, blockHash: useHash, actions: [action],
  });
  const hash = sha256(bytes);
  return {
    signerId: executor, receiverId: vault, publicKey: derivedKey,
    nonce: String(useNonce),
    nonceNote: nonceIsPlaceholder ? "PLACEHOLDER, not read from chain; live: signer access-key nonce + 1" : "caller supplied",
    blockHash: useHash,
    blockHashNote: blockHashIsPlaceholder ? "PLACEHOLDER (32 zero bytes), not read from chain; live: block.header.hash from RPC" : "caller supplied",
    actions: [toJsonSafe(action)],
    unsignedTxBorshBase64: Buffer.from(bytes).toString("base64"),
    txHashHex: Buffer.from(hash).toString("hex"),
    txHashBase58: base58Encode(hash),
    signed: false, sent: false,
  };
}

export function buildMpcSignRequest({ agentContract, path, txHash }) {
  checkAccount("agentContract", agentContract);
  const hashBytes = typeof txHash === "string"
    ? (/^[0-9a-f]{64}$/.test(txHash) ? Uint8Array.from(Buffer.from(txHash, "hex")) : null)
    : txHash;
  if (!hashBytes) throw new Error("txHash must be 32 bytes or 64 lowercase hex chars");
  const args = buildSignRequest({ path, txHash: hashBytes });
  return {
    // What the MPC contract receives. The predecessor it derives the key from is the AGENT CONTRACT, not the executor.
    mpcSign: {
      receiverId: MPC_CONTRACT_TESTNET, methodName: "sign", args,
      deposit: String(SIGN_DEPOSIT_YOCTO), depositUnit: "yoctoNEAR",
      gas: String(MPC_SIGN_GAS), gasUnit: "gas", minGasTgas: String(SIGN_MIN_GAS_TGAS),
      gasNote: "UNMEASURED CHOICE: 30 Tgas, 2x the 15 Tgas minimum (config.sign_call_gas_attachment_requirement_tera_gas). Not benchmarked.",
      predecessor: agentContract,
      signed: false, sent: false,
    },
    // What the runner (inside the TEE) would call on the agent contract. Never executed against a deployed contract.
    agentRequestSignature: {
      receiverId: agentContract, methodName: "request_signature",
      args: { path, payload: Buffer.from(hashBytes).toString("hex"), key_type: "Eddsa" },
      deposit: "0", gas: String(AGENT_REQUEST_SIGNATURE_GAS),
      confirmed: false,
      note: "Never executed. Method name and arg names {path, payload, key_type} are CONFIRMED by https://raw.githubusercontent.com/NearDeFi/shade-agent-framework/main/docs/reference/agent-contract.md. UNCONFIRMED: the \"Eddsa\" key_type spelling and its mapping to MPC domain 1, the deposit and the gas. The agent contract then calls `sign` on the MPC contract as predecessor.",
      signed: false, sent: false,
    },
  };
}

export function buildRunnerAuthorization({ owner, vault, executor, derivedKey }) {
  checkAccount("owner", owner);
  checkAccount("vault", vault);
  checkAccount("executor", executor);
  const ownerCall = (methodName, args) => ({
    signerId: owner, receiverId: vault, methodName, args,
    gas: String(30n * TGAS), gasNote: "UNMEASURED CHOICE", deposit: String(OWNER_CALL_DEPOSIT), depositUnit: "yoctoNEAR",
    signed: false, sent: false,
  });
  return {
    addRunner: ownerCall("add_runner", { runner_id: executor }),
    executorAddKey: {
      signerId: executor, receiverId: executor, note: "Signed by whoever controls the executor account today (full-access key).",
      action: toJsonSafe({
        type: "AddKey", publicKey: derivedKey,
        permission: { allowance: EXECUTOR_KEY_ALLOWANCE_YOCTO, receiverId: vault, methodNames: [METHOD] },
      }),
      allowanceNote: "CHOICE, not measured: explicit 1 NEAR allowance, never unlimited. Per https://docs.near.org/protocol/access-keys the allowance is charged at the buy price, credited back on refund, cannot be changed later, and an exhausted key cannot sign (rotate with DeleteKey + AddKey).",
      signed: false, sent: false,
    },
    revocation: {
      revokeRunner: ownerCall("revoke_runner", { runner_id: executor }),
      revokeAllRunners: { ...ownerCall("revoke_all_runners", {}), note: "Kill switch: removes every runner and pauses the vault." },
      deleteKey: {
        signerId: executor, receiverId: executor,
        action: { type: "DeleteKey", publicKey: derivedKey },
        note: "DESCRIBED ONLY: serializeTransaction does not encode DeleteKey; not serialized.",
        signed: false, sent: false,
      },
    },
  };
}

/** bigint -> decimal string, Uint8Array -> hex, recursively. */
export function toJsonSafe(v) {
  if (typeof v === "bigint") return String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJsonSafe(x)]));
  return v;
}

const SIGN_FLAG_KEYS = new Set(["sign", "send", "broadcast", "approve", "signed", "sent"]);
const SECRET_KEY_RE = /^(private_?key|secret_?key|seed_?phrase|mnemonic|secret|password|signature)$/i;

/** Refuse any signing/sending/secret option, any non-testnet network, any .near id, and NEAR_NETWORK=mainnet. */
export function assertDryRunOptions(options, env = process.env) {
  assertNotMainnet(env ?? {});
  const walk = (v, path) => {
    if (typeof v === "string") {
      if (/\.near$/i.test(v.trim())) throw new RefusalError(`refused: ${path} ends in .near (mainnet). Testnet only.`);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (!isObj(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const here = path ? `${path}.${k}` : k;
      if (SECRET_KEY_RE.test(k.replace(/[-\s]/g, "_")) || /(private|secret).?key|seed.?phrase/i.test(k)) {
        throw new RefusalError(`refused: option ${JSON.stringify(k).slice(0, 40)} would carry a secret. Dry run only; nothing is signed.`);
      }
      if (SIGN_FLAG_KEYS.has(k) && x) throw new RefusalError(`refused: option ${JSON.stringify(k)} asks to sign or send. Dry run only.`);
      if (/^network$/i.test(k) && x !== undefined && x !== "testnet") {
        throw new RefusalError("refused: network must be testnet. This tool never targets mainnet.");
      }
      walk(x, here);
    }
  };
  walk(options ?? {}, "");
}
