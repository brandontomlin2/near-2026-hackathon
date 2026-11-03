// HTML for the "Transfer" section of the offline demo page. Reads manifest.transfer.

import { escapeHtml as esc } from "../viewer/render.mjs";

const verdict = (match) => (match ? '<span class="ok">match</span>' : "<strong>MISMATCH</strong>");

// The TEE inference badge is a label set from the inference mode, not an
// attestation check. "mocked" is neutral (grey) so it never reads as a pass.
const teeBadge = ({ label, status }) =>
  `<strong>${esc(label)}</strong>: <span class="${status === "mocked" ? "neutral" : "ok"}">${esc(status)}</span>${status === "mocked" ? " (this demo makes no inference call)" : ""}`;

// href is a URL context, where HTML escaping is not enough. Only the testnet
// explorer host followed by a plain NEAR account id is ever linked.
const SAFE_EXPLORER_URL = /^https:\/\/testnet\.nearblocks\.io\/address\/[a-z0-9._-]+$/;

/** The "On testnet" explorer line: plain text for a mock placeholder, a link for a live contract. */
function explorerLine(t) {
  const { explorer: e } = t;
  if (e.placeholder) {
    return `<p>Explorer page for the contract: <strong>mock placeholder</strong>. <code>${esc(t.contractId)}</code> is not deployed, so there is no explorer link. A live run links <code>${esc(e.accountUrlPattern)}</code>.</p>`;
  }
  const shown = e.contractUrl.replace(/^https?:\/\//, "");
  if (!SAFE_EXPLORER_URL.test(e.contractUrl)) return `<p>Explorer page for the contract: <code>${esc(shown)}</code>.</p>`;
  return `<p>Explorer page for the contract: <a href="${esc(e.contractUrl)}" rel="noopener noreferrer">${esc(shown)}</a>.</p>`;
}

/**
 * @param {{ transfer?: object }} manifest
 * @returns {string} HTML, or "" when the manifest has no transfer
 */
export function transferSection({ transfer: t } = {}) {
  if (!t) return "";
  const rows = t.tokens.map((k) => `<tr><td>${esc(k.tokenId)}</td><td class="hash">${esc(k.anchoredHash)}</td><td class="hash">${esc(k.recomputedHash)}</td><td>${verdict(k.match)}</td></tr>`).join("\n");
  const meta = t.tokens.map((k) => `<details><summary>${esc(k.tokenId)}</summary><pre>${esc(JSON.stringify(k.nftMetadata, null, 2))}</pre></details>`).join("\n");
  const x = t.tamper;
  // alice and bob are constants in every mode: simulated accounts, never linked.
  return `<h2>Transfer: memory travels with the NFT</h2>
<p class="mut">Simulated transfer between mock placeholder accounts (nothing sent, never linked): <code>${esc(t.from)}</code> sends every token to <code>${esc(t.to)}</code>. The new owner takes each sheet, hashes it with the official sheet hash function and compares it with the hash anchored under the token id.</p>
<table><tr><th>Token</th><th>Anchored hash</th><th>Re-hashed by ${esc(t.to)}</th><th>Result</th></tr>
${rows}</table>
${x ? `<h3>Tampered sheet</h3>
<p class="mut">The same transfer, but the sheet of <code>${esc(x.tokenId)}</code> was edited on the way:</p>
<pre>${esc(x.tamperedSheet)}</pre>
<table><tr><th>Anchored hash</th><th>Re-hashed</th><th>Result</th></tr>
<tr><td class="hash">${esc(x.anchoredHash)}</td><td class="hash">${esc(x.recomputedHash)}</td><td>${verdict(x.match)}</td></tr></table>` : ""}
<h3>Mint metadata</h3>
<p class="mut">The <code>nft_metadata</code> each token would mint with (NEP-177 <code>TokenMetadata</code>):</p>
${meta}
<h3>On testnet</h3>
${explorerLine(t)}
<p>${teeBadge(t.teeInference)}</p>
`;
}
