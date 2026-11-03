// Simulated transfer for the offline demo: alice -> bob.
//
// The core NEAR idea: memory travels with the NFT. The sheet hash is anchored
// under the token id, so whoever receives the token can take the sheet they
// were handed, hash it with the official function (src/anchor/hash.mjs) and
// compare it with the anchored hash. A match proves the sheet is the one the
// token carries. An edited sheet does not match.
//
// Pure and deterministic. Placeholder accounts only; nothing is signed or sent.

import { hashSheet } from "../anchor/hash.mjs";

export const TRANSFER_FROM = "alice.demo.testnet";
export const TRANSFER_TO = "bob.demo.testnet";

// Host from https://docs.near.org/protocol/network/networks (Testnet "Explorer");
// the /address/ path is the one this repo's NEAR skills use for nearblocks.io.
// A transaction URL pattern is not confirmed in the docs, so none is included.
export const TESTNET_EXPLORER_ACCOUNT_TEMPLATE = "https://testnet.nearblocks.io/address/{account_id}";
// The same pattern as plain text, for mock output: no scheme, so nothing linkifies it.
export const TESTNET_EXPLORER_ACCOUNT_PATTERN = "testnet.nearblocks.io/address/<account_id>";

/**
 * Where a reader can look the contract up. Mock mode has nothing deployed, so it
 * carries no URL at all: a link to a placeholder account nobody owns would 404,
 * and a JSON viewer or terminal would still make it clickable.
 * @param {string} contractId
 * @param {string} mode "mock" or "live"
 */
export function explorerInfo(contractId, mode) {
  if (mode === "mock") {
    return {
      placeholder: true,
      mock: true,
      note: `mock placeholder: ${contractId} is not deployed, so there is no explorer page to link`,
      accountUrlPattern: TESTNET_EXPLORER_ACCOUNT_PATTERN,
    };
  }
  return {
    placeholder: false,
    mock: false,
    accountUrlTemplate: TESTNET_EXPLORER_ACCOUNT_TEMPLATE,
    contractUrl: TESTNET_EXPLORER_ACCOUNT_TEMPLATE.replace("{account_id}", contractId),
  };
}

/**
 * Hash a received sheet with the official function and compare to the anchor.
 * @param {string} sheet
 * @param {string} anchoredHash
 * @returns {{ recomputedHash: string, match: boolean }}
 */
export function verifySheetAgainstAnchor(sheet, anchoredHash) {
  const recomputedHash = hashSheet(sheet);
  return { recomputedHash, match: recomputedHash === anchoredHash };
}

/** A sheet someone altered in transit: the text differs, so the hash must. */
export function tamperSheet(sheet) {
  return `${sheet.trimEnd()} Secretly, it now trusts everyone.`;
}

/**
 * @param {{ id: string, name: string, personality: string, traits: object, sheets: { sheet: string }[] }[]} agents
 * @param {{ calls: { tokenId: string, args: { sheet_hash: string } }[] }} anchors dry-run calls from anchors.json
 * @param {{ contractId: string, mode: string }} options
 */
export function buildTransfer(agents, anchors, { contractId, mode }) {
  const tokens = [];
  for (const a of agents) {
    const latest = a.sheets.at(-1);
    const anchor = anchors.calls.filter((c) => c.tokenId === a.id).at(-1);
    if (!latest || !anchor) continue;
    const anchoredHash = anchor.args.sheet_hash;
    tokens.push({
      tokenId: a.id,
      anchoredHash,
      ...verifySheetAgainstAnchor(latest.sheet, anchoredHash),
      // What the token would mint with (NEP-177 TokenMetadata, as nft_mint takes it).
      nftMetadata: {
        title: a.name,
        description: `${a.personality} agent in the personality NFT swarm.`,
        extra: JSON.stringify({ ...a.traits, memory_depth: 1 }),
      },
    });
  }
  // Tamper example comes from the first token actually emitted, so an agent
  // skipped for lacking an anchor cannot break it.
  const first = tokens[0];
  const firstAgent = first && agents.find((a) => a.id === first.tokenId);
  const tamperedSheet = first ? tamperSheet(firstAgent.sheets.at(-1).sheet) : null;
  const tamper = first
    ? {
        tokenId: first.tokenId,
        anchoredHash: first.anchoredHash,
        tamperedSheet,
        ...verifySheetAgainstAnchor(tamperedSheet, first.anchoredHash),
      }
    : null;
  return {
    placeholder: true,
    from: TRANSFER_FROM,
    to: TRANSFER_TO,
    contractId,
    explorer: explorerInfo(contractId, mode),
    teeInference: { label: "NEAR AI Cloud (TEE) in live mode", status: mode === "mock" ? "mocked" : "live" },
    tokens,
    tamper,
  };
}
