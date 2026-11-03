// Memory loop, dry-run only: swarm events -> per-token character sheet ->
// anchor_sheet dry-run -> each anchor linked to the swarm's final round hash.
//
// The contract has no round-hash method, only anchor_sheet(token_id,
// sheet_hash). The final round hash is linked by recording it as
// linkedRoundHash on each dry-run record. Nothing is signed or sent: this
// module never takes a `send` function and never passes `live`.

import { AGENTS } from "../traits/agents.mjs";
import { prepareAnchor, submitAnchor } from "../anchor/anchor.mjs";
import { makeEvent, summarize } from "./summarizer.mjs";

/**
 * Per agent id, the summarizer log in swarm order: own posts and replies, plus
 * a mention for every reply another agent made to one of this agent's events.
 */
export function tokenLogs(events, agents = AGENTS) {
  const logs = Object.fromEntries(agents.map((a) => [a.id, []]));
  const authorById = new Map(events.map((e) => [e.id, e.agentId]));
  for (const e of events) {
    logs[e.agentId]?.push(makeEvent({ round: e.round, kind: e.kind, from: e.agentId, text: e.text }));
    const target = e.replyTo === null ? undefined : authorById.get(e.replyTo);
    if (target && target !== e.agentId && logs[target]) {
      logs[target].push(makeEvent({ round: e.round, kind: "mention", from: e.agentId, text: e.text }));
    }
  }
  return logs;
}

export async function runMemoryLoop({ swarm, agents = AGENTS, client, contractId = "mock-contract.testnet" }) {
  const finalRoundHash = swarm.roundHashes.at(-1);
  const logs = tokenLogs(swarm.events, agents);
  const tokens = [];
  for (const agent of agents) {
    const sheet = await summarize({
      client,
      tokenId: agent.id,
      name: agent.name,
      round: swarm.rounds,
      log: logs[agent.id],
      previous: null,
    });
    // Pass sheetHash, never sheet: the summarizer hashes the raw sheet, while
    // prepareAnchor would normalize it first and produce a different hash.
    const prepared = prepareAnchor({
      contractId,
      tokenId: agent.id,
      sheetHash: sheet.sheetHash,
      network: "testnet",
    });
    const result = await submitAnchor(prepared);
    if (result.status !== "dry-run") throw new Error(`anchor for ${agent.id} was not a dry run: ${result.status}`);
    tokens.push({
      tokenId: agent.id,
      name: agent.name,
      sheet,
      anchor: {
        status: result.status,
        methodName: prepared.methodName,
        contractId: prepared.contractId,
        args: prepared.args,
        gas: prepared.gas,
        depositYocto: prepared.depositYocto,
        transactionHash: null,
        linkedRoundHash: finalRoundHash,
      },
    });
  }
  return { finalRoundHash, roundHashes: swarm.roundHashes, tokens };
}
