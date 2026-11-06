// Static HTML page for `npm run yield:demo`: the same dry run as the terminal summary, as one
// page a judge can open. No scripts, no external assets, no network, no links. Every value that
// came from the run is escaped. Deterministic: nothing here reads a clock or the environment.

import { escapeHtml as esc, securityMetaTags } from "../viewer/render.mjs";
import { refusalReason } from "./demo.mjs";
import { referenceLine } from "./reference-view.mjs";
import { scenarioSummary } from "./rule-scenarios.mjs";

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1c1c1a;--mut:#5f5f58;--card:#fff;--line:#d9d9d0;--acc:#0a6b4f;--bad:#a02020;--warn:#7a4b00}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecece6;--mut:#a0a098;--card:#201f1d;--line:#3a3935;--acc:#5fd3a8;--bad:#ff8f8f;--warn:#f0c070}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:1.7rem;margin:.2em 0}h2{font-size:1.2rem;margin:2.2em 0 .6em;border-bottom:1px solid var(--line);padding-bottom:.2em}
h3{font-size:1rem;margin:1em 0 .3em}
code{font:12px/1.4 ui-monospace,Menlo,monospace;word-break:break-all}
.mut{color:var(--mut)}.ok{color:var(--acc);font-weight:600}.bad{color:var(--bad);font-weight:600}.warn{color:var(--warn);font-weight:600}
.dry{border:2px solid var(--warn);border-radius:8px;padding:10px 14px;font-weight:600;margin:.6em 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.who{font-weight:600}
details>summary{cursor:pointer;margin:2.2em 0 .6em}details>summary h2{display:inline;border:0}
ul.cand{margin:.3em 0 0;padding-left:1.2em;font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font-size:12px;margin:.3em 0}
`;

const rule = (r) => (r ? (r.ok ? '<span class="ok">OK</span>' : `<span class="bad">${esc(r.reason || r.code)}</span>`) : '<span class="mut">-</span>');
const rate = (r) => (r && typeof r === "object" ? `${esc(r.num)}/${esc(r.den)}` : esc(r ?? "-"));

function configBlock(title, vaultId, runnerId, config, note) {
  const limits = (config?.limits ?? []).map((l) => `<tr><td><code>${esc(l.token_id)}</code></td><td>${esc(l.max_trade)}</td><td>${esc(l.daily_cap)}</td></tr>`).join("\n");
  const pools = (config?.allowed_pools ?? []).map((p) => `<tr><td>${esc(p.pool_id)}</td><td><code>${esc(p.token_a)}</code> / <code>${esc(p.token_b)}</code></td><td>${rate(p.min_rate_a_to_b)}</td><td>${rate(p.min_rate_b_to_a)}</td></tr>`).join("\n");
  return `<div class="card"><h3>${esc(title)}</h3>
<p>vault <code>${esc(vaultId)}</code>, runner <code>${esc(runnerId)}</code> <span class="mut">(${esc(note)})</span></p>
<table><thead><tr><th>token</th><th>max_trade</th><th>daily_cap</th></tr></thead><tbody>
${limits}
</tbody></table>
<table><thead><tr><th>allowed pool</th><th>pair</th><th>price floor a to b</th><th>price floor b to a</th></tr></thead><tbody>
${pools}
</tbody></table></div>`;
}

function configSection(doc) {
  const pa = doc.personality_agents;
  const cards = Object.entries(pa.configs ?? {}).map(([id, c]) => configBlock(`Config for ${id}`, pa.vault_id, pa.runner_id, c, "placeholder ids, not deployed accounts; amounts in base units"));
  const pv = doc.planner_vault;
  if (pv) cards.push(configBlock("Config for yield-optimizer (planner vault)", pv.vault_id, pv.runner_id, pv.config, "placeholder ids, not deployed accounts; amounts in base units"));
  return `<details><summary><h2>Vault config</h2> <span class="mut">(per-agent limits and price floors; click to open)</span></summary>
<p class="mut">The limits and price floors each agent's proposal was checked against. Rates are minimum amount_out per amount_in as num/den.</p>
${cards.join("\n")}
</details>`;
}

function candidates(a) {
  if (!Array.isArray(a.candidates) || a.candidates.length === 0) return "";
  const items = a.candidates.map((c) => `<li>${esc(c.summary)}: ${c.status === "ok" ? '<span class="ok">OK</span>' : c.status === "refused" ? `<span class="bad">REFUSED ${esc(c.rule_check.reason)}</span>` : `<span class="warn">${esc(c.verdict ?? c.status)}</span>`}</li>`).join("\n");
  return `<div class="mut">${esc(a.decision ?? "")}${a.reason ? `: ${esc(a.reason)}` : ""}</div><ul class="cand">
${items}
</ul>`;
}

function strategyCell(a) {
  if (!a.strategy_check) return '<span class="mut">-</span>';
  if (a.strategy_check.ok) return '<span class="ok">OK</span>';
  return `<span class="bad">${a.strategy_check.violations.map((v) => esc(`${v.code}: ${v.reason}`)).join("; ")}</span>`;
}

function referenceDiv(a) {
  if (!a.reference) return "";
  const off = a.reference.reference_deviation_bps !== null && Math.abs(a.reference.reference_deviation_bps) > a.reference.max_reference_deviation_bps;
  return `<div class="${off ? "bad" : "mut"}">reference: ${esc(referenceLine(a.reference))}</div>`;
}

function agentsSection(doc) {
  const rows = doc.agents.map((a) => `<tr><td class="who">${esc(a.agent)}<div class="mut">${esc(a.name)}</div></td>
<td>${esc(a.summary)}${referenceDiv(a)}${a.error ? `<div class="bad">invalid reply (${esc(a.error.code)}): ${esc(a.error.message)}</div>` : ""}${candidates(a)}</td>
<td>${rule(a.rule_check)}</td><td>${strategyCell(a)}</td>
<td>${a.veto ? `<span class="warn">vetoed by ${esc(a.veto.by)}</span>: ${esc(a.veto.reason)}` : '<span class="mut">-</span>'}</td>
<td>${esc(a.outcome)}${a.outcome === "refused" ? `<div class="mut">${esc(refusalReason(a))}</div>` : ""}</td></tr>`).join("\n");
  return `<h2>Agent proposals</h2>
<p class="mut">Four personality agents (mock inference over the committed Ref snapshot) and the rule-based Yield Optimizer planner on the same snapshot. Every proposal is checked with the one JS copy of the vault rules.</p>
<table><thead><tr><th>agent</th><th>proposal</th><th>vault rule check</th><th>strategy check</th><th>veto</th><th>outcome</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function rulesSection(doc) {
  const rs = doc.rule_scenarios;
  const rows = rs.scenarios.map((s) => `<tr><td class="who">${esc(s.label)}</td><td>${esc(scenarioSummary(s))}</td><td><code class="bad">${esc(s.contract_message)}</code></td></tr>`).join("\n");
  return `<h2>Rejected by the on-chain rules</h2>
<p class="mut">Proposals the vault refuses, from the contract's own test vectors in <code>${esc(rs.source)}</code>. Each message is the same string the Rust contract's <code>${esc(rs.contract_fn)}</code> returns; the JS rules produce it byte for byte. Amounts are base units.</p>
<table><thead><tr><th>case</th><th>proposal</th><th>contract message</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}

function callsSection(doc, calls) {
  const cards = calls.calls.map((c, i) => `<div class="card"><h3>call ${i + 1} of ${calls.calls.length} (${esc(c.agent)})</h3>
<table><tbody>
<tr><th>receiver</th><td><code>${esc(c.receiver_id)}</code></td></tr>
<tr><th>method</th><td><code>${esc(c.method_name)}</code></td></tr>
<tr><th>signer</th><td><code>${esc(c.signer_id)}</code></td></tr>
<tr><th>gas</th><td>${esc(c.gas)}</td></tr>
<tr><th>deposit</th><td>${esc(c.deposit)}</td></tr>
<tr><th>signed</th><td>signed: ${esc(c.signed)}</td></tr>
<tr><th>sent</th><td>sent: ${esc(c.sent)}</td></tr>
</tbody></table>
<pre>${esc(JSON.stringify(c.args, null, 2))}</pre></div>`).join("\n");
  return `<h2>Unsigned calls</h2>
${cards || '<p class="mut">No calls planned.</p>'}
<p class="who">${esc(doc.calls_planned)} unsigned execute_swap ${doc.calls_planned === 1 ? "call" : "calls"} planned, ${esc(doc.calls_signed)} signed, ${esc(doc.calls_sent)} sent</p>`;
}

/**
 * The demo page.
 * @param {{ doc: object, calls: { calls: object[] } }} result what runDemo returns
 * @returns {string} a complete HTML document
 */
export function renderDemoPage({ doc, calls }) {
  const s = doc.snapshot;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${securityMetaTags(CSS)}
<title>Yield vault demo (dry run)</title>
<style>${CSS}</style></head><body><main>
<h1>Yield vault demo (dry run)</h1>
<p class="dry">${esc(doc.notice)}</p>
<p class="mut">Snapshot: committed, not fetched. ${s.shared_by_agents_and_planner ? `One Ref testnet snapshot at block ${esc(s.block_height)}, shared by the four agents and the planner (vault ${esc(doc.planner_vault.vault_id)}).` : `Planner on ${esc(s.file)}; the four agents on the committed Ref snapshot.`}</p>
${agentsSection(doc)}
${rulesSection(doc)}
${callsSection(doc, calls)}
${configSection(doc)}
</main></body></html>
`;
}
