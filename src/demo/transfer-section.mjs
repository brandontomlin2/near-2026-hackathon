// HTML for the "Transfer" section of the offline demo page. Reads manifest.transfer.

import { escapeHtml as esc } from "../viewer/render.mjs";

const verdict = (match) => (match ? '<span class="ok">match</span>' : "<strong>MISMATCH</strong>");

/**
 * @param {{ transfer?: object }} manifest
 * @returns {string} HTML, or "" when the manifest has no transfer
 */
export function transferSection({ transfer: t } = {}) {
  if (!t) return "";
  const rows = t.tokens.map((k) => `<tr><td>${esc(k.tokenId)}</td><td class="hash">${esc(k.anchoredHash)}</td><td class="hash">${esc(k.recomputedHash)}</td><td>${verdict(k.match)}</td></tr>`).join("\n");
  const meta = t.tokens.map((k) => `<details><summary>${esc(k.tokenId)}</summary><pre>${esc(JSON.stringify(k.nftMetadata, null, 2))}</pre></details>`).join("\n");
  const x = t.tamper;
  // Shown without a scheme and not as a link: the contract is a placeholder, so a link would 404.
  const contractHost = t.explorer.contractUrl.replace(/^https?:\/\//, "");
  return `<h2>Transfer: memory travels with the NFT</h2>
<p class="mut">Simulated, placeholder accounts: <code>${esc(t.from)}</code> sends every token to <code>${esc(t.to)}</code>. The new owner takes each sheet, hashes it with the official sheet hash function and compares it with the hash anchored under the token id.</p>
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
<p>Explorer page for the contract (<strong>placeholder</strong>, nothing is deployed): <code>${esc(contractHost)}</code>. Pattern: <code>testnet.nearblocks.io/address/&lt;account_id&gt;</code>.</p>
<p><strong>${esc(t.teeInference.label)}</strong>: <span class="ok">${esc(t.teeInference.status)}</span>${t.teeInference.status === "mocked" ? " (this demo makes no inference call)" : ""}</p>
`;
}
