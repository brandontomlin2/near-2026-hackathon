// Render a swarm result to one self-contained HTML page.
//
// Input is the canonical swarm output (runSwarm result, as written to
// out/events.json): { seed, rounds, events, roundHashes }. The page has no
// scripts, no external assets and no network calls. Every value is escaped.
// renderViewer validates the result first and throws rather than writing a
// partial page.

import { createHash } from "node:crypto";
import { GENESIS_HASH, hashRound, verifyRounds } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { replaceUnsafeChars } from "../util/text.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** The page's <title>. scripts/viewer.mjs uses it to recognise its own earlier output before overwriting. */
export const PAGE_TITLE = "Swarm viewer";

/**
 * The one HTML escaping helper: element text and double- or single-quoted attribute values.
 * Control and bidi characters become U+FFFD first (src/util/text.mjs).
 * @param {unknown} value
 */
export function escapeHtml(value) {
  return replaceUnsafeChars(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

/**
 * Defense in depth for the static pages: a CSP and referrer policy as <meta> tags. Nothing is
 * fetched (default-src 'none'), there is no script, and the single <style> block is allowed by
 * hash rather than 'unsafe-inline'. Images are same-directory files. `<meta>` cannot carry
 * frame-ancestors, so that one needs a response header on the host.
 * @param {string} css exact text of the page's one <style> block
 */
export function securityMetaTags(css) {
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  const csp = `default-src 'none'; style-src 'sha256-${hash}'; img-src 'self'; base-uri 'none'; form-action 'none'`;
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">`;
}

/**
 * Throws a TypeError naming the first problem. Returns the result when it passes.
 * @param {any} result
 * @param {readonly { id: string, name: string }[]} [agents]
 */
export function validateResult(result, agents = AGENTS) {
  const fail = (msg) => {
    throw new TypeError(`invalid swarm result: ${msg}`);
  };
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("must be an object");
  if (!Array.isArray(agents) || agents.length === 0) fail("agents must be a non-empty array");
  agents.forEach((a, i) => {
    if (!a || typeof a.name !== "string" || a.name === "") fail(`agent ${i} needs a non-empty string name`);
  });
  if (!Array.isArray(result.events)) fail("events must be an array");
  if (!Array.isArray(result.roundHashes)) fail("roundHashes must be an array");
  result.roundHashes.forEach((hash, i) => {
    if (typeof hash !== "string" || !HEX64.test(hash)) fail(`round ${i + 1} hash must be 64 lowercase hex characters`);
  });

  const ids = new Set(agents.map((a) => a.id));
  let lastRound = 1;
  for (const e of result.events) {
    if (!e || typeof e.text !== "string") fail("each event needs string text");
    if (!Number.isInteger(e.round) || e.round < lastRound || e.round > result.roundHashes.length) {
      fail(`event ${e.id} has round ${JSON.stringify(e.round)} out of order or without a round hash`);
    }
    lastRound = e.round;
    if (!ids.has(e.agentId)) fail(`event ${e.id} is from unknown agent ${JSON.stringify(e.agentId)}`);
  }
  return result;
}

/**
 * Report the first round whose stored hash does not match its events.
 * Assumes the result has passed validateResult.
 * @param {{ events: any[], roundHashes: string[] }} result
 * @returns {{ ok: boolean, brokenRound: number | null }}
 */
export function chainStatus(result) {
  if (verifyRounds(result)) return { ok: true, brokenRound: null };
  let prev = GENESIS_HASH;
  for (const [i, hash] of result.roundHashes.entries()) {
    prev = hashRound(prev, result.events.filter((e) => e.round === i + 1));
    if (prev !== hash) return { ok: false, brokenRound: i + 1 };
  }
  return { ok: false, brokenRound: null };
}

const STYLE = `
  :root { color-scheme: light dark; --ink: #1d1d1f; --muted: #6b6b70; --rule: #d6d6da; --bg: #fafafa; --card: #ffffff; --ok: #2f7d4f; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ececef; --muted: #9a9aa2; --rule: #3a3a40; --bg: #141416; --card: #1c1c20; } }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  .meta { color: var(--muted); font-size: 13px; }
  .chain-ok { color: var(--ok); } .chain-bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; background: var(--card); }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--rule); font-size: 13px; }
  .round { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 8px 14px; margin-bottom: 12px; }
  .round-head { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
  .hash { font-family: ui-monospace, monospace; word-break: break-all; }
  .post { margin: 8px 0; }
  .author { font-weight: 600; margin-right: 6px; }
`;

/**
 * @param {any} result canonical swarm output
 * @param {readonly { id: string, name: string, personality: string, traits: object }[]} [agents]
 */
export function renderViewer(result, agents = AGENTS) {
  validateResult(result, agents);
  const chain = chainStatus(result);
  const chainLabel = chain.ok
    ? `<span class="chain-ok">chain: ok</span>`
    : `<span class="chain-bad">chain: broken${chain.brokenRound ? ` at round ${chain.brokenRound}` : ""}</span>`;
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const eventById = new Map(result.events.map((e) => [e.id, e]));

  const agentRows = agents.map((agent) => {
    const traits = agent.traits && typeof agent.traits === "object" ? agent.traits : {};
    const traitText = Object.entries(traits).map(([k, v]) => `${k}: ${v}`).join(", ");
    return `<tr><td>${escapeHtml(agent.name)}</td><td>${escapeHtml(agent.personality ?? "")}</td><td>${escapeHtml(traitText)}</td></tr>`;
  }).join("\n      ");

  const roundBlocks = result.roundHashes.map((hash, i) => {
    const posts = result.events.filter((e) => e.round === i + 1).map((e) => {
      const target = e.kind === "reply" ? eventById.get(e.replyTo) : undefined;
      const replyTo = target ? ` <span class="meta">&rarr; ${escapeHtml(nameOf.get(target.agentId))}</span>` : "";
      return `<p class="post"><span class="author">${escapeHtml(nameOf.get(e.agentId))}</span>${replyTo} ${escapeHtml(e.text)}</p>`;
    }).join("\n      ");
    return `<section class="round">
      <div class="round-head"><span>Round ${i + 1}</span><span class="hash">${escapeHtml(hash)}</span></div>
      ${posts}
    </section>`;
  }).join("\n    ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${securityMetaTags(STYLE)}
  <title>${PAGE_TITLE}</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Swarm run</h1>
    <p class="meta">seed: ${escapeHtml(result.seed ?? "unknown")} · ${result.roundHashes.length} rounds · ${result.events.length} posts · ${chainLabel}</p>

    <h2>Agents</h2>
    <table>
      <thead><tr><th>Name</th><th>Personality</th><th>Traits</th></tr></thead>
      <tbody>
      ${agentRows}
      </tbody>
    </table>

    <h2>Channel</h2>
    ${roundBlocks}
  </main>
</body>
</html>
`;
}
