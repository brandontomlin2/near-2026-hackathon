// Memory loop, dry-run only: swarm events -> per-token character sheets ->
// one anchor_sheet dry-run per sheet -> each anchor linked to the hash of the
// round its sheet was written at.
//
// The contract has no round-hash method, only anchor_sheet(token_id,
// sheet_hash). The link is off-chain: each dry-run record carries the round
// hash as linkedRoundHash (swarm.roundHashes[round - 1]); only a token whose
// last sheet lands in the last round links to the final round hash. Nothing is
// signed or sent: this module never takes a `send` function and never passes
// `live`.

import { AGENTS } from "../traits/agents.mjs";
import { prepareAnchor, submitAnchor } from "../anchor/anchor.mjs";
import { createMockClient } from "../inference/client.mjs";
import { makeEvent, shouldSummarize, summarize } from "./summarizer.mjs";
import { sheetResponder } from "./sheet-responder.mjs";

/**
 * Per agent id, the summarizer log in swarm order: own posts and replies, plus
 * a mention for every reply another agent made to one of this agent's events.
 * `from` is the author's display name (the name the summarizer prompt and the
 * sheet stand-in use, same as npm run demo); an author outside `agents` keeps
 * its raw id.
 */
export function tokenLogs(events, agents = AGENTS) {
  const logs = Object.fromEntries(agents.map((a) => [a.id, []]));
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const authorById = new Map(events.map((e) => [e.id, e.agentId]));
  for (const e of events) {
    const from = nameOf.get(e.agentId) ?? e.agentId;
    if (Object.hasOwn(logs, e.agentId)) logs[e.agentId].push(makeEvent({ round: e.round, kind: e.kind, from, text: e.text }));
    const target = e.replyTo === null ? undefined : authorById.get(e.replyTo);
    if (target && target !== e.agentId && Object.hasOwn(logs, target)) {
      logs[target].push(makeEvent({ round: e.round, kind: "mention", from, text: e.text }));
    }
  }
  return logs;
}

/** Sheet cadence of npm run swarm and the evidence; same as DEMO_DEFAULTS.every in src/demo/pipeline.mjs. */
export const DEFAULT_LOOP_EVERY = 3;

/** Sentences of a sheet, for the short diff between two sheets. */
const sentences = (text) => text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/**
 * What changed between two consecutive sheets: sentences added and removed
 * (compared as exact text), plus how many new events fed the new sheet.
 * `previous` is null for an agent's first sheet, where everything is added.
 */
export function diffSheets(previous, next) {
  const before = new Set(previous ? sentences(previous.sheet) : []);
  const after = new Set(sentences(next.sheet));
  return {
    fromRound: previous ? previous.round : null,
    toRound: next.round,
    previousHash: previous ? previous.sheetHash : null,
    sheetHash: next.sheetHash,
    changed: !previous || previous.sheetHash !== next.sheetHash,
    added: [...after].filter((x) => !before.has(x)),
    removed: [...before].filter((x) => !after.has(x)),
    newEvents: next.newEvents,
  };
}

/**
 * Rounds that get a sheet: every `every`-th round, plus the final round so the
 * last sheet always covers the whole run and links to the final round hash.
 */
export function sheetRounds(rounds, every) {
  const out = [];
  for (let r = 1; r <= rounds; r++) if (shouldSummarize(r, every) || r === rounds) out.push(r);
  return out;
}

/**
 * Write a sheet for every agent each `every` rounds (and at the final round).
 * Each sheet builds on the agent's previous one and is anchored with its own
 * anchor_sheet dry-run, linked to the hash of the round it was written at.
 * token.sheet / token.anchor are the latest; token.sheets is the history of
 * { round, sheet, diff, anchor }, oldest first.
 * Without a `client` the sheets come from the counting stand-in
 * (./sheet-responder.mjs), the same one npm run demo uses: offline and
 * deterministic. Pass a live inference client for model-written sheets.
 */
export async function runMemoryLoop({ swarm, agents = AGENTS, client = createMockClient({ responder: sheetResponder }), contractId = "mock-contract.testnet", every = DEFAULT_LOOP_EVERY }) {
  const finalRoundHash = swarm.roundHashes.at(-1);
  const logs = tokenLogs(swarm.events, agents);
  const tokens = [];
  for (const agent of agents) {
    const history = [];
    let previous = null;
    for (const round of sheetRounds(swarm.rounds, every)) {
      // Only events up to this round: a sheet never sees the future.
      const log = logs[agent.id].filter((e) => e.round <= round);
      const sheet = await summarize({ client, tokenId: agent.id, name: agent.name, round, log, previous });
      // Both sides use hashSheet (src/anchor/hash.mjs), so this equals sheet.sheetHash.
      const prepared = prepareAnchor({ contractId, tokenId: agent.id, sheet: sheet.sheet, network: "testnet" });
      const result = await submitAnchor(prepared);
      if (result.status !== "dry-run") throw new Error(`anchor for ${agent.id} was not a dry run: ${result.status}`);
      history.push({
        round,
        sheet,
        diff: diffSheets(previous, sheet),
        anchor: {
          status: result.status,
          methodName: prepared.methodName,
          contractId: prepared.contractId,
          args: prepared.args,
          gas: prepared.gas,
          depositYocto: prepared.depositYocto,
          transactionHash: null,
          linkedRoundHash: swarm.roundHashes[round - 1],
        },
      });
      previous = sheet;
    }
    const latest = history.at(-1);
    tokens.push({ tokenId: agent.id, name: agent.name, sheet: latest.sheet, anchor: latest.anchor, sheets: history });
  }
  return { finalRoundHash, roundHashes: swarm.roundHashes, every, tokens };
}
