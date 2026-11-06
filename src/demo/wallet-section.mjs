// HTML for the "Wallet" section of the offline demo page. Reads manifest.wallets.

import { escapeHtml as esc } from "../viewer/render.mjs";
import { formatDeposit } from "./page.mjs";
import { plural } from "../util/plural.mjs";

/**
 * @param {{ wallets?: object, agents?: { id: string, name: string }[] }} manifest
 * @returns {string} HTML, or "" when the manifest has no wallets
 */
export function walletSection(manifest) {
  const w = manifest?.wallets;
  if (!w) return "";
  for (const k of ["accounts", "prices", "tokens"]) if (w[k] == null) throw new TypeError(`walletSection: manifest.wallets.${k} is missing`);
  const near = (y) => esc(formatDeposit(y));
  const net = (t) => {
    const d = BigInt(t.tipsYocto) - BigInt(t.inferenceYocto);
    return d >= 0n ? `<span class="ok">+${near(d.toString())}</span>` : `-${near((-d).toString())}`;
  };
  const rows = w.tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>${near(t.tipsYocto)} <span class="mut">(${plural(esc(t.tipCount), "reply", "replies")})</span></td><td>${near(t.inferenceYocto)} <span class="mut">(${plural(esc(t.paidCount), "call")})</span></td><td>${net(t)}</td><td>${near(t.balanceYocto)}</td><td>${near(t.allowanceLeftYocto)}</td></tr>`).join("\n");
  const moved = w.tokens.every((t) => t.afterTransfer.owner === w.accounts.newOwner && t.afterTransfer.balanceYocto === t.balanceYocto);
  const refused = w.tokens.every((t) => t.afterTransfer.staleGrantRefused && !t.afterTransfer.agentActive);
  const a = w.accounts;
  const p = w.prices;
  return `<h2>Wallet: each token pays for its own thinking</h2>
<p class="mut">Every token owns a NEAR balance held by the contract under its token id, so the money goes wherever the token goes. Simulated here between mock placeholder accounts: nothing is signed or sent, and the ${plural(esc(w.calls), "wallet call")} in <code>${esc(w.file)}</code> are dry runs.</p>
<ol>
<li><code>${esc(a.owner)}</code> funds each token with ${near(p.startYocto)} (<code>wallet_deposit</code>) and lets <code>${esc(a.agent)}</code> pay only <code>${esc(a.payee)}</code>, up to ${near(p.allowanceYocto)} per token (<code>wallet_set_agent</code>).</li>
<li>Each line a token speaks costs ${near(p.postPriceYocto)} of inference and each character sheet ${near(p.sheetPriceYocto)}, paid from the token's own wallet (<code>wallet_agent_pay</code>).</li>
<li>Each reply a token gets earns it a ${near(p.tipYocto)} tip from <code>${esc(a.fans)}</code> (<code>wallet_deposit</code>): drama pays.</li>
</ol>
<table><tr><th>Token</th><th>Tips earned</th><th>Inference paid</th><th>Net</th><th>Balance</th><th>Allowance left</th></tr>
${rows}</table>
<p>After the transfer to <code>${esc(a.newOwner)}</code>: ${moved ? '<span class="ok">every wallet moved with its token</span>' : "<strong>a wallet did not move with its token</strong>"}, and ${refused ? `<span class="ok">the runner's grant from ${esc(a.owner)} is refused</span> until the new owner makes their own` : "<strong>an old grant still works</strong>"}.</p>
`;
}
