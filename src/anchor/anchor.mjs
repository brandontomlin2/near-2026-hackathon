// Prepare, and gate, the anchor_sheet call on the personality NFT contract.
//
// This module never signs, never reads keys and never opens a connection.
// prepareAnchor builds the call. submitAnchor is a dry run unless the caller
// passes live: true AND injects a `send` function that does the signing.
// Testnet only: any other network is refused.

import { SHEET_HASH_RE, hashSheet } from "./hash.mjs";

export const ANCHOR_METHOD = "anchor_sheet";
// 1e22 yocto = 0.01 NEAR. A generous upper bound on the storage an anchor adds
// (every anchor records its hash in a seen-hash set). The contract refunds the
// unused part.
export const ANCHOR_DEPOSIT_YOCTO = "10000000000000000000000";
export const DEFAULT_GAS = "30000000000000"; // 30 Tgas

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TOKEN_RE = /^[a-z0-9_-]+$/;

export class AnchorError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "AnchorError";
    this.code = details.code ?? "anchor_error";
  }
}

/**
 * Named NEAR accounts only (implicit 64-hex accounts are not accepted).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidAccountId(id) {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);
}

function checkContract(contractId) {
  if (!isValidAccountId(contractId)) {
    throw new AnchorError("contractId is not a valid NEAR account id", { code: "bad_config" });
  }
}

function checkToken(tokenId) {
  if (typeof tokenId !== "string" || tokenId.length === 0 || tokenId.length > 64 || !TOKEN_RE.test(tokenId)) {
    throw new AnchorError("tokenId must be 1-64 chars of [a-z0-9_-]", { code: "bad_token" });
  }
}

/**
 * @typedef {{ sheet_hash: string | null, memory_depth?: number, updated_at?: string }} AnchorView
 *
 * @param {object} params
 * @param {string} params.contractId
 * @param {string} params.tokenId
 * @param {string} [params.sheet] Sheet text. Exactly one of sheet / sheetHash.
 * @param {string} [params.sheetHash] Lowercase 64-char hex.
 * @param {AnchorView | null | undefined} [params.currentAnchor] sheet_anchor view result; undefined if not fetched.
 * @param {string} params.network Must be "testnet".
 * @param {string} [params.gas]
 */
export function prepareAnchor(params) {
  const { contractId, tokenId, sheet, sheetHash, currentAnchor, network, gas } = params ?? {};
  checkContract(contractId);
  if (network !== "testnet") {
    throw new AnchorError(`network ${JSON.stringify(network)} refused: testnet only`, {
      code: "network_refused",
    });
  }
  checkToken(tokenId);

  if ((sheet === undefined) === (sheetHash === undefined)) {
    throw new AnchorError("give exactly one of sheet or sheetHash", { code: "bad_sheet" });
  }
  let hash;
  if (sheet !== undefined) {
    try {
      hash = hashSheet(sheet);
    } catch (err) {
      throw new AnchorError(err.message, { code: "bad_sheet" });
    }
  } else {
    if (typeof sheetHash !== "string" || !SHEET_HASH_RE.test(sheetHash)) {
      throw new AnchorError("sheetHash must be 64 lowercase hex chars", { code: "bad_sheet" });
    }
    hash = sheetHash;
  }

  if (gas !== undefined && (typeof gas !== "string" || !/^[1-9]\d*$/.test(gas))) {
    throw new AnchorError("gas must be a decimal string", { code: "bad_config" });
  }

  let firstAnchor;
  if (currentAnchor === null) {
    throw new AnchorError(`token ${tokenId} is unknown to the contract`, { code: "unknown_token" });
  } else if (currentAnchor === undefined) {
    firstAnchor = true; // unknown state: assume the larger deposit
  } else if (typeof currentAnchor === "object" && currentAnchor.sheet_hash === null) {
    firstAnchor = true;
  } else if (typeof currentAnchor === "object" && typeof currentAnchor.sheet_hash === "string") {
    firstAnchor = false;
  } else {
    throw new AnchorError("currentAnchor is not a sheet_anchor view result", { code: "bad_anchor" });
  }

  return Object.freeze({
    network: "testnet",
    contractId,
    methodName: ANCHOR_METHOD,
    args: Object.freeze({ token_id: tokenId, sheet_hash: hash }),
    gas: gas ?? DEFAULT_GAS,
    depositYocto: ANCHOR_DEPOSIT_YOCTO,
    sheetHash: hash,
    firstAnchor,
    signing: "required",
  });
}

/**
 * Dry run unless live === true and the caller injects `send`.
 * @param {ReturnType<typeof prepareAnchor>} prepared
 * @param {{ live?: boolean, send?: (prepared: object) => Promise<{ transactionHash: string }> }} [options]
 */
export async function submitAnchor(prepared, { live, send } = {}) {
  if (live !== true) {
    return { status: "dry-run", prepared, transactionHash: null };
  }
  if (prepared?.network !== "testnet") {
    throw new AnchorError("only testnet anchors may be submitted", { code: "network_refused" });
  }
  if (typeof send !== "function") {
    throw new AnchorError(
      "live submit needs a sender injected by the caller; this module never signs",
      { code: "not_configured" },
    );
  }
  const result = await send(prepared);
  if (result === null || typeof result !== "object" || typeof result.transactionHash !== "string" || result.transactionHash === "") {
    throw new AnchorError("sender must resolve { transactionHash: string }", { code: "bad_result" });
  }
  return { status: "submitted", prepared, transactionHash: result.transactionHash };
}
