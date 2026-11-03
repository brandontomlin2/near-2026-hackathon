// Static HTML page for the offline demo. No scripts, no external assets, no
// network. Only relative links to files in the same output directory. Every
// value that came from the run is escaped. Art is referenced with <img> and
// relative paths, never inlined, so the page stays small and no SVG ids clash.

import { GENESIS_HASH as GENESIS } from "../swarm/runner.mjs";
import { escapeHtml as esc } from "../viewer/render.mjs";
import { moodForText } from "../art/moods.mjs";
import { transferSection } from "./transfer-section.mjs";

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
.hero{text-align:center;padding:12px 0 4px}.pitch{margin:0;color:var(--mut);font-size:.95rem}
.hero h1{font-size:clamp(2rem,6vw,3.4rem);line-height:1.1;margin:.15em 0}.sub{max-width:36em;margin:.4em auto 1em;font-size:1.1rem}
.faces{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.faces figure{margin:0;text-align:center}.faces img{width:150px;height:150px;border-radius:12px}
.arts{display:flex;gap:12px;align-items:flex-end}.arts figure{margin:0;text-align:center}.arts .big{flex:1}.arts .big img{width:100%;max-width:240px;height:auto}.arts .small img{width:90px;height:auto}
.moods{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0}.moods figure{margin:0;text-align:center}.moods img{width:100%;height:auto}
.shares{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}.shares img{width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
.msg{display:flex;gap:10px;align-items:center;margin:.5em 0}.msg img{width:64px;height:64px;flex:none;border-radius:8px}.msg .mood{display:block;font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
figcaption{font-size:12px;color:var(--mut)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.who{font-weight:600}
.notice{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--mut)}
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

function agentCard(a, moods) {
  const traits = Object.entries(a.traits)
    .map(([k, v]) => (k === "memory_depth" ? `memory_depth: ${esc(v)} at mint, ${esc(a.memoryDepth)} now` : `${esc(k)}: ${esc(v)}`))
    .join(" · ");
  const latest = a.sheets.at(-1);
  const n = a.sheets.length;
  const strip = moods.length > 1
    ? `<div class="moods">${moods.map((m) => `<figure><img src="${esc(a.faces[m])}" alt="${esc(a.name)} in mood ${esc(m)}" loading="lazy"><figcaption>${esc(m)}</figcaption></figure>`).join("")}</div>`
    : "";
  return `<div class="card">
<div class="arts">
<figure class="big"><img src="${esc(a.art)}" alt="${esc(a.name)}, signature image"><figcaption>now, after ${n} summar${n === 1 ? "y" : "ies"} (memory depth ${esc(a.memoryDepth)})</figcaption></figure>
<figure class="small"><img src="${esc(a.mintArt)}" alt="${esc(a.name)} at mint"><figcaption>at mint (memory depth 1)</figcaption></figure>
</div>
${strip}
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

function channel(manifest, events, moods) {
  const byAgent = new Map(manifest.agents.map((a) => [a.id, a]));
  const byId = new Map(events.map((e) => [e.id, e]));
  const out = [];
  for (let r = 1; r <= manifest.rounds; r++) {
    out.push(`<h3>Round ${r}</h3>`);
    for (const e of events.filter((x) => x.round === r)) {
      const agent = byAgent.get(e.agentId);
      const name = agent?.name ?? e.agentId;
      const target = e.kind === "reply" ? byId.get(e.replyTo) : null;
      const who = target ? `${esc(name)} → ${esc(byAgent.get(target.agentId)?.name ?? target.agentId)}` : esc(name);
      const mood = moodForText(e.text);
      const shown = moods.includes(mood) ? mood : "neutral";
      const face = agent?.faces?.[shown]
        ? `<img src="${esc(agent.faces[shown])}" alt="${esc(name)} feeling ${esc(mood)}" data-mood="${esc(mood)}" loading="lazy">`
        : "";
      out.push(`<div class="msg">${face}<div><span class="who">${who}</span> <span class="mood">${esc(mood)}</span> ${esc(e.text)}</div></div>`);
    }
  }
  return out.join("\n");
}

/**
 * @param {object} manifest the near-demo/run@1 manifest (demo.json)
 * @param {{ events: object[], anchors: { calls: object[] } }} data
 *   events: runner events; anchors: contents of anchors.json
 * @returns {string} one self-contained HTML document
 */
export function renderDemoPage(manifest, { events, anchors })
 {
  const moods = manifest.moods ?? ["neutral"];
  const shares = (manifest.shares ?? []).map((x) => {
    const agent = manifest.agents.find((a) => a.id === x.agentId);
    return `<a href="${esc(x.file)}"><img src="${esc(x.file)}" alt="Share card: ${esc(agent?.name ?? x.agentId)}, round ${esc(x.round)}, ${esc(x.mood)}" loading="lazy"></a>`;
  }).join("\n");
  const hero = manifest.agents.map((a) => `<figure><img src="${esc(a.art)}" alt="${esc(a.name)}"><figcaption>${esc(a.name)}</figcaption></figure>`).join("");
  const chain = manifest.roundHashes.map((h, i) => `<tr><td>${i + 1}</td><td class="hash">${esc(h)}</td></tr>`).join("\n");
  const calls = anchors.calls.map((c) => `<tr><td>${esc(c.tokenId)}</td><td>${esc(c.round)}</td><td>${esc(c.method)}</td><td class="hash">${esc(c.args.sheet_hash)}</td><td>${esc(formatDeposit(c.depositYocto))}</td><td>${esc(c.status)}</td></tr>`).join("\n");
  const files = manifest.files.filter((f) => f !== "index.html").map((f) => `<li><a href="${esc(f)}">${esc(f)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your NFT remembers who you are</title>
<style>${CSS}</style></head><body><main>
<header class="hero">
<p class="pitch">Personality NFT: an AI personality that lives in your NFT.</p>
<h1>Your NFT remembers who you are</h1>
<p class="sub">An AI personality lives in your NFT, argues with three others in a swarm, remembers it in a character sheet whose hash is anchored on NEAR, and reacts with a face to every line.</p>
<div class="faces">${hero}</div>
</header>
<p class="notice">Mock mode, dry run: inference is mocked and nothing is signed, sent or deployed. ${esc(manifest.rounds)} rounds, seed ${esc(manifest.seed)}, a sheet every ${esc(manifest.every)} rounds, art style ${esc(manifest.style ?? "default")}.</p>
<ol>
<li>Four AI personalities talk on one shared channel. Each round has a hash that chains to the one before.</li>
<li>Every ${esc(manifest.every)} rounds each agent rewrites its character sheet, and its memory depth goes up by one, which changes its art.</li>
<li>The sheet hash is what would be anchored on its NFT. Here that call is prepared and never signed.</li>
</ol>

<h2>Agents</h2>
<div class="grid">
${manifest.agents.map((a) => agentCard(a, moods)).join("\n")}
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
${channel(manifest, events, moods)}

<h2>Share cards</h2>
<p class="mut">One card per channel message: the reaction face, the quote, the agent and a footer. Each is a standalone SVG in <code>share/</code>.</p>
<div class="shares">
${shares}
</div>

<h2>Anchor (dry run)</h2>
<table><tr><th>Token</th><th>Round</th><th>Method</th><th>sheet_hash</th><th>Deposit</th><th>Status</th></tr>
${calls}</table>
<p class="mut">Each <code>sheet_hash</code> is the sha256 of the normalized sheet, the same value recorded in <code>memory/&lt;token&gt;/sheet.json</code>. A new owner recomputes it from the sheet they receive and compares it with the token's <code>sheet_anchor</code>.</p>
<p>A live run would call <code>anchor_sheet</code> on testnet with these arguments. <code>${esc(anchors.contractId)}</code> is a placeholder contract id; nothing is deployed or signed by this demo. Every anchor carries a storage deposit (the contract refunds the unused part).</p>
<h3>Check a hash yourself</h3>
<p>The sheet is normalized before hashing (Unicode NFC, LF line endings, no trailing spaces, exactly one final newline). A one-line sheet is the text plus a newline, so from the folder that holds this page:</p>
<pre>node -p 'require("./memory/aloof/sheet.json").sheet' | shasum -a 256
node -p 'require("./memory/aloof/sheet.json").sheetHash'</pre>
<p>Both lines print the same hash, and it is Aloof's last <code>sheet_hash</code> in the table above.</p>

${transferSection(manifest)}
<h2>Files</h2>
<ul>
${files}
</ul>
</main></body></html>
`;
}
