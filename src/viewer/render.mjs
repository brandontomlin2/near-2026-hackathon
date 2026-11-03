// Render a swarm run to one self-contained HTML page.
//
// The page has no scripts, no external assets and no network calls. Every
// value from the run is escaped. renderViewer validates the run first and
// throws rather than writing a partial page.

import { GENESIS_HASH, RUN_SCHEMA, roundHash } from "./run.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

/**
 * Throws a TypeError naming the first problem. Returns the run when it passes.
 * @param {any} run
 */
export function validateRun(run) {
  const fail = (msg) => {
    throw new TypeError(`invalid run: ${msg}`);
  };
  if (!run || typeof run !== "object" || Array.isArray(run)) fail("must be an object");
  if (run.schema !== RUN_SCHEMA) fail(`schema must be ${RUN_SCHEMA}`);
  if (!Array.isArray(run.agents) || run.agents.length === 0) fail("agents must be a non-empty array");

  const names = new Set();
  const ids = new Set();
  for (const agent of run.agents) {
    if (!agent || typeof agent.id !== "string" || typeof agent.name !== "string" || typeof agent.role !== "string") {
      fail("each agent needs string id, name and role");
    }
    if (ids.has(agent.id) || names.has(agent.name)) fail(`duplicate agent ${agent.name}`);
    ids.add(agent.id);
    names.add(agent.name);
  }

  if (!Array.isArray(run.rounds)) fail("rounds must be an array");
  for (const [i, round] of run.rounds.entries()) {
    if (!round || round.round !== i + 1) fail(`round numbers must run 1..n in order (round ${i + 1})`);
    if (typeof round.hash !== "string" || !HEX64.test(round.hash)) {
      fail(`round ${round.round} hash must be 64 lowercase hex characters`);
    }
    if (!Array.isArray(round.posts)) fail(`round ${round.round} posts must be an array`);
    for (const post of round.posts) {
      if (!post || typeof post.text !== "string") fail(`round ${round.round} has a post without text`);
      if (!names.has(post.author)) fail(`round ${round.round} post from unknown author ${JSON.stringify(post.author)}`);
    }
  }
  return run;
}

/**
 * Recompute the hash chain. Reports the first round whose stored hash does not
 * match its posts. Assumes the run has passed validateRun.
 * @param {any} run
 * @returns {{ ok: boolean, brokenRound: number | null }}
 */
export function chainStatus(run) {
  let prev = GENESIS_HASH;
  for (const round of run.rounds) {
    const expected = roundHash(prev, round.posts);
    if (expected !== round.hash) return { ok: false, brokenRound: round.round };
    prev = round.hash;
  }
  return { ok: true, brokenRound: null };
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

/** @param {any} run */
export function renderViewer(run) {
  validateRun(run);
  const chain = chainStatus(run);
  const chainLabel = chain.ok
    ? `<span class="chain-ok">chain: ok</span>`
    : `<span class="chain-bad">chain: broken at round ${chain.brokenRound}</span>`;
  const postCount = run.rounds.reduce((n, r) => n + r.posts.length, 0);

  const agentRows = run.agents.map((agent) => {
    const traits = agent.traits && typeof agent.traits === "object" ? agent.traits : {};
    const traitText = Object.entries(traits).map(([k, v]) => `${k}: ${v}`).join(", ");
    return `<tr><td>${escapeHtml(agent.name)}</td><td>${escapeHtml(agent.role)}</td><td>${escapeHtml(traitText)}</td></tr>`;
  }).join("\n      ");

  const roundBlocks = run.rounds.map((round) => {
    const posts = round.posts.map((post) => (
      `<p class="post"><span class="author">${escapeHtml(post.author)}</span>${escapeHtml(post.text)}</p>`
    )).join("\n      ");
    return `<section class="round">
      <div class="round-head"><span>Round ${round.round}</span><span class="hash">${escapeHtml(round.hash)}</span></div>
      ${posts}
    </section>`;
  }).join("\n    ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swarm viewer</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Swarm run</h1>
    <p class="meta">mode: ${escapeHtml(run.mode ?? "unknown")} · model: ${escapeHtml(run.model ?? "unknown")} · ${run.rounds.length} rounds · ${postCount} posts · ${chainLabel}</p>

    <h2>Agents</h2>
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Traits</th></tr></thead>
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
