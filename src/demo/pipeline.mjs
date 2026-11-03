// Offline end-to-end demo: swarm -> memory -> art -> anchor (dry run) -> page.
//
// Mock mode only. No network, no keys, no signing: submitAnchor is always
// called with live:false and no sender. Output is deterministic: no clocks,
// no randomness, no absolute paths, so two runs write identical bytes.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSwarm, verifyRounds, GENESIS_HASH } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { createMemoryStore, maybeSummarize } from "../memory/summarizer.mjs";
import { createMockClient } from "../inference/client.mjs";
import { renderSvg } from "../art/render.mjs";
import { prepareAnchor, submitAnchor } from "../anchor/anchor.mjs";
import { sheetResponder } from "./sheet-responder.mjs";
import { renderDemoPage } from "./page.mjs";
import { buildTransfer } from "./transfer-verify.mjs";

export const DEMO_DEFAULTS = Object.freeze({
  rounds: 6,
  seed: 1,
  every: 3,
  contractId: "personality-nft.demo.testnet",
});

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;


/**
 * Run the whole demo and write it under outDir.
 * @param {{ outDir?: string, rounds?: number, seed?: number, every?: number, contractId?: string }} [options]
 * @returns {Promise<{ outDir: string, files: string[], finalRoundHash: string, verified: true, manifest: object }>}
 */
export async function runDemo({
  outDir = "out",
  rounds = DEMO_DEFAULTS.rounds,
  seed = DEMO_DEFAULTS.seed,
  every = DEMO_DEFAULTS.every,
  contractId = DEMO_DEFAULTS.contractId,
} = {}) {
  if (!Number.isInteger(every) || every < 1 || every > rounds) {
    throw new RangeError(`every must be between 1 and rounds (${rounds}), got ${every}; otherwise no sheet is written`);
  }

  // 1. Swarm, with the persona mocks, then re-check the hash chain.
  const result = await runSwarm({ rounds, seed });
  if (!verifyRounds(result)) throw new Error("demo: round hashes do not verify");

  // 2. Memory. The log is append-only, so start each token's memory clean.
  // Only the four token dirs the demo writes are removed, never all of
  // <outDir>/memory, so --out pointing at a real project cannot wipe it.
  const memoryDir = join(outDir, "memory");
  for (const agent of AGENTS) await rm(join(memoryDir, agent.id), { recursive: true, force: true });
  const store = createMemoryStore(memoryDir);
  const client = createMockClient({ responder: sheetResponder });
  const nameOf = new Map(AGENTS.map((a) => [a.id, a.name]));
  const history = new Map(AGENTS.map((a) => [a.id, []]));

  for (let round = 1; round <= rounds; round++) {
    for (const e of result.events.filter((x) => x.round === round)) {
      const from = nameOf.get(e.agentId);
      await store.appendEvent(e.agentId, { round, kind: e.kind, from, text: e.text });
      if (e.kind === "reply") {
        const target = result.events.find((x) => x.id === e.replyTo);
        if (target) await store.appendEvent(target.agentId, { round, kind: "mention", from, text: e.text });
      }
    }
    for (const agent of AGENTS) {
      const record = await maybeSummarize({ client, store, tokenId: agent.id, name: agent.name, round, every });
      if (record) history.get(agent.id).push(record);
    }
  }

  // 3. Anchor: prepare each call and run it as a dry run. Never signs.
  const calls = [];
  for (const agent of AGENTS) {
    let previousHash = null;
    let depth = 0;
    for (const record of history.get(agent.id)) {
      const currentAnchor = previousHash === null
        ? { sheet_hash: null, memory_depth: 1 }
        : { sheet_hash: previousHash, memory_depth: depth };
      const prepared = prepareAnchor({
        contractId,
        tokenId: agent.id,
        sheet: record.sheet,
        network: "testnet",
        currentAnchor,
      });
      // The hash in sheet.json must be the one the token would anchor.
      if (prepared.sheetHash !== record.sheetHash) {
        throw new Error(`demo: sheet.json hash and anchor hash differ for ${agent.id} round ${record.round}`);
      }
      const submitted = await submitAnchor(prepared, { live: false });
      calls.push({
        tokenId: agent.id,
        round: record.round,
        method: prepared.methodName,
        args: prepared.args,
        depositYocto: prepared.depositYocto,
        gas: prepared.gas,
        firstAnchor: prepared.firstAnchor,
        status: submitted.status,
        transactionHash: submitted.transactionHash,
      });
      previousHash = prepared.sheetHash;
      depth += 1;
    }
  }
  const anchors = { network: "testnet", contractId, signed: false, calls };

  // 4. Art, at mint (1 ring) and now.
  const artDir = join(outDir, "art");
  await mkdir(artDir, { recursive: true });
  const svgs = {};
  const agents = [];
  for (const agent of AGENTS) {
    const sheets = history.get(agent.id);
    const memoryDepth = Math.min(12, 1 + sheets.length);
    const art = renderSvg({ ...agent.traits, memory_depth: memoryDepth });
    const mintArt = renderSvg({ ...agent.traits, memory_depth: 1 });
    await writeFile(join(artDir, `${agent.id}.svg`), art);
    await writeFile(join(artDir, `${agent.id}.mint.svg`), mintArt);
    svgs[agent.id] = { art, mintArt };
    agents.push({
      id: agent.id,
      name: agent.name,
      personality: agent.personality,
      traits: agent.traits,
      memoryDepth,
      art: `art/${agent.id}.svg`,
      mintArt: `art/${agent.id}.mint.svg`,
      sheets: sheets.map((s) => ({
        round: s.round,
        sheetHash: s.sheetHash,
        words: s.sheet.split(/\s+/).filter(Boolean).length,
        sheet: s.sheet,
      })),
    });
  }

  // 5. Write the rest.
  await writeFile(join(outDir, "transcript.txt"), result.transcript);
  await writeFile(join(outDir, "events.json"), json(result));
  await writeFile(join(outDir, "anchors.json"), json(anchors));

  const finalRoundHash = result.roundHashes.at(-1);
  const manifest = {
    schema: "near-demo/run@1",
    mode: "mock",
    rounds,
    seed,
    every,
    finalRoundHash,
    roundHashes: result.roundHashes,
    agents,
    anchors: "anchors.json",
    transfer: buildTransfer(agents, anchors, { contractId, mode: "mock" }),
    files: [],
  };
  // The manifest lists every file the demo wrote, including itself and the page.
  manifest.files = [
    "transcript.txt", "events.json", "anchors.json", "demo.json", "index.html",
    ...AGENTS.flatMap((a) => [
      `art/${a.id}.svg`, `art/${a.id}.mint.svg`,
      `memory/${a.id}/log.jsonl`, `memory/${a.id}/sheet.json`,
    ]),
  ].sort();
  await writeFile(join(outDir, "demo.json"), json(manifest));
  await writeFile(
    join(outDir, "index.html"),
    renderDemoPage(manifest, { events: result.events, anchors, svgs, genesisHash: GENESIS_HASH }),
  );

  return { outDir, files: manifest.files, finalRoundHash, verified: true, manifest };
}
