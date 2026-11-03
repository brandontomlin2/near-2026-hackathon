// Static HTML page for the offline demo. No scripts, no external assets, no
// network. Only relative links to files in the same output directory. Every
// value that came from the run is escaped; the SVGs come from our own
// deterministic renderer (src/art/render.mjs) and are inlined as is.

import { GENESIS_HASH as GENESIS } from "../swarm/runner.mjs";
import { escapeHtml as esc } from "../viewer/render.mjs";

const CSS = `
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1c1c1a;--mut:#5f5f58;--card:#fff;--line:#d9d9d0;--acc:#0a6b4f}
@media(prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecece6;--mut:#a0a098;--card:#201f1d;--line:#3a3935;--acc:#5fd3a8}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:1.7rem;margin:.2em 0}h2{font-size:1.2rem;margin:2.2em 0 .6em;border-bottom:1px solid var(--line);padding-bottom:.2em}
h3{font-size:1rem;margin:1em 0 .3em}
code,.hash{font:12px/1.4 ui-monospace,Menlo,monospace;word-break:break-all}
.mut{color:var(--mut)}.ok{color:var(--acc);font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.arts{display:flex;gap:12px}.arts figure{margin:0;flex:1;text-align:center}.arts svg{width:100%;height:auto;max-width:180px}
figcaption{font-size:12px;color:var(--mut)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.msg{margin:.2em 0}.who{font-weight:600}
.banner{border:2px solid var(--acc);border-radius:8px;padding:8px 12px;font-weight:600}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:12px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;overflow-x:auto;font-size:12px}
`;

const YOCTO_PER_NEAR = 10n ** 24n;

/** "10000000000000000000000" -> "0.01 NEAR", "1" -> "1 yoctoNEAR". */
export function formatDeposit(yocto) {
  const y = BigInt(yocto);
  if (y < 10n ** 18n) return `${y} yoctoNEAR`;
  const whole = y / YOCTO_PER_NEAR;
  const frac = (y % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

function agentCard(a, svg) {
  const traits = Object.entries(a.traits)
    .map(([k, v]) => (k === "memory_depth" ? `memory_depth: ${esc(v)} at mint, ${esc(a.memoryDepth)} now` : `${esc(k)}: ${esc(v)}`))
    .join(" · ");
  const latest = a.sheets.at(-1);
  const n = a.sheets.length;
  return `<div class="card">
<div class="arts">
<figure>${svg.mintArt}<figcaption>at mint (1 ring)</figcaption></figure>
<figure>${svg.art}<figcaption>after ${n} summar${n === 1 ? "y" : "ies"} (${esc(a.memoryDepth)} rings)</figcaption></figure>
</div>
<h3>${esc(a.name)} <span class="mut">· ${esc(a.personality)}</span></h3>
<div class="mut">${traits}</div>
<p>${latest ? esc(latest.sheet) : "No sheet yet."}</p>
<div class="mut">sheet hash</div><div class="hash">${latest ? esc(latest.sheetHash) : "none"}</div>
</div>`;
}

function memorySection(a) {
  const cells = a.sheets.map((s, i) => `<div class="card"><div class="mut">${i === 0 ? "first sheet" : "then"}, round ${esc(s.round)} · ${esc(s.words)} words</div>
<p>${esc(s.sheet)}</p>
<div class="hash">sheet hash ${esc(s.sheetHash)}</div></div>`).join("\n");
  return `<h3>${esc(a.name)}</h3>
<div class="pair">${cells || '<div class="mut">No sheets yet.</div>'}</div>`;
}

function channel(manifest, events) {
  const name = new Map(manifest.agents.map((a) => [a.id, a.name]));
  const byId = new Map(events.map((e) => [e.id, e]));
  const out = [];
  for (let r = 1; r <= manifest.rounds; r++) {
    out.push(`<h3>Round ${r}</h3>`);
    for (const e of events.filter((x) => x.round === r)) {
      const target = e.kind === "reply" ? byId.get(e.replyTo) : null;
      const who = target
        ? `${esc(name.get(e.agentId) ?? e.agentId)} → ${esc(name.get(target.agentId) ?? target.agentId)}`
        : esc(name.get(e.agentId) ?? e.agentId);
      out.push(`<div class="msg"><span class="who">${who}</span> ${esc(e.text)}</div>`);
    }
  }
  return out.join("\n");
}

/**
 * @param {object} manifest the near-demo/run@1 manifest (demo.json)
 * @param {{ events: object[], anchors: { calls: object[] }, svgs: Record<string, { art: string, mintArt: string }> }} data
 *   events: runner events; anchors: contents of anchors.json; svgs: inline SVG markup per agent id
 * @returns {string} one self-contained HTML document
 */
export function renderDemoPage(manifest, { events, anchors, svgs }) {
  const chain = manifest.roundHashes.map((h, i) => `<tr><td>${i + 1}</td><td class="hash">${esc(h)}</td></tr>`).join("\n");
  const calls = anchors.calls.map((c) => `<tr><td>${esc(c.tokenId)}</td><td>${esc(c.round)}</td><td>${esc(c.method)}</td><td class="hash">${esc(c.args.sheet_hash)}</td><td>${esc(formatDeposit(c.depositYocto))}</td><td>${esc(c.status)}</td></tr>`).join("\n");
  const files = manifest.files.filter((f) => f !== "index.html").map((f) => `<li><a href="${esc(f)}">${esc(f)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personality NFT swarm — offline demo</title>
<style>${CSS}</style></head><body><main>
<h1>Personality NFT swarm — offline demo</h1>
<p class="banner">Offline demo: inference mocked, nothing signed, nothing sent, no network.</p>
<p class="mut">mode: ${esc(manifest.mode)} · ${esc(manifest.rounds)} rounds · seed ${esc(manifest.seed)} · a sheet every ${esc(manifest.every)} rounds</p>
<ol>
<li>Four AI personalities talk on one shared channel. Each round has a hash that chains to the one before.</li>
<li>Every ${esc(manifest.every)} rounds each agent rewrites its character sheet, and its art gains a ring.</li>
<li>The sheet hash is what would be anchored on its NFT. Here that call is prepared and never signed.</li>
</ol>

<h2>Agents</h2>
<div class="grid">
${manifest.agents.map((a) => agentCard(a, svgs[a.id])).join("\n")}
</div>

<h2>Memory</h2>
<p class="mut">Each agent's sheets in order, oldest first. In this demo the sheet writer is a deterministic stand-in for the model (<code>src/demo/sheet-responder.mjs</code>): it counts exchanges, reads warm or tense words for allies and grudges, and quotes the agent's latest line. With <code>MOCK_INFERENCE=0</code> the summarizer sends the same prompt to NEAR AI Cloud instead.</p>
${manifest.agents.map(memorySection).join("\n")}

<h2>Round hash chain</h2>
<p>Genesis: <span class="hash">${GENESIS}</span></p>
<table><tr><th>Round</th><th>Hash</th></tr>
${chain}</table>
<p>verify: <span class="ok">ok</span> · final round hash <span class="hash">${esc(manifest.finalRoundHash)}</span></p>

<h2>Channel</h2>
${channel(manifest, events)}

<h2>Anchor (dry run)</h2>
<table><tr><th>Token</th><th>Round</th><th>Method</th><th>sheet_hash</th><th>Deposit</th><th>Status</th></tr>
${calls}</table>
<p class="mut">Each <code>sheet_hash</code> is the sha256 of the normalized sheet, the same value recorded in <code>memory/&lt;token&gt;/sheet.json</code>. A new owner recomputes it from the sheet they receive and compares it with the token's <code>sheet_anchor</code>.</p>
<p>A live run would call <code>anchor_sheet</code> on testnet with these arguments. <code>${esc(anchors.contractId)}</code> is a placeholder contract id; nothing is deployed or signed by this demo. The first anchor per token carries a storage deposit (the contract refunds the unused part); later ones carry 1 yoctoNEAR.</p>
<h3>Check a hash yourself</h3>
<p>The sheet is normalized before hashing (Unicode NFC, LF line endings, no trailing spaces, exactly one final newline). A one-line sheet is the text plus a newline, so from the repository root:</p>
<pre>node -p 'require("./out/memory/aloof/sheet.json").sheet' | shasum -a 256
node -p 'require("./out/memory/aloof/sheet.json").sheetHash'</pre>
<p>Both lines print the same hash, and it is Aloof's last <code>sheet_hash</code> in the table above.</p>

<h2>Files</h2>
<ul>
${files}
</ul>
</main></body></html>
`;
}
