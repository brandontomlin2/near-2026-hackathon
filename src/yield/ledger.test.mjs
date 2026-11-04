import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInferenceClient } from "../inference/client.mjs";
import { AGENT_IDS, runRound } from "./debate.mjs";
import { createLedger, formatScoreboard, formatUsd, ledgerPath } from "./ledger.mjs";
import { yieldMockResponder } from "./mock.mjs";
import { loadPoolFixture } from "./pools.mjs";
import { defaultVaultConfig } from "./strategies.mjs";

const fixture = loadPoolFixture();
const RUNNER = "runner.yield-demo.testnet";
const EPOCH = Date.UTC(2026, 10, 3);

async function playRounds(n) {
  const client = createInferenceClient({ env: {}, responder: yieldMockResponder });
  const configs = Object.fromEntries(AGENT_IDS.map((id) => [id, defaultVaultConfig(id, { runner: RUNNER })]));
  const ledger = createLedger({ fixture });
  const records = [];
  for (let round = 1; round <= n; round++) {
    const rec = await runRound({ client, configs, states: ledger.states, fixture, round, nowMs: EPOCH + (round - 1) * 3_600_000, runnerId: RUNNER });
    ledger.record(rec);
    records.push(rec);
  }
  return { ledger, records };
}

test("scoreboard has one row per agent with rounds, trades, vetoes and P&L", async () => {
  const { ledger } = await playRounds(3);
  const rows = ledger.scoreboard();
  assert.deepEqual(rows.map((r) => r.agent).sort(), ["aloof", "chaotic", "skeptic", "social"]);
  for (const r of rows) {
    assert.equal(r.rounds, 3);
    for (const k of ["trades", "vetoes", "rejected", "invalid"]) assert.equal(typeof r[k], "number", k);
    assert.match(r.pnl_micro_usd, /^-?[0-9]+$/);
  }
});

test("an agent that executed has trades >= 1 and a vetoed agent has vetoes >= 1, matching the round records", async () => {
  const { ledger, records } = await playRounds(3);
  const rows = Object.fromEntries(ledger.scoreboard().map((r) => [r.agent, r]));
  const executed = new Set(records.flatMap((r) => r.executions.map((x) => x.agent)));
  const vetoed = new Set(records.flatMap((r) => Object.values(r.decisions).filter((d) => d.outcome === "vetoed").map((d) => d.agent)));
  assert.ok(executed.size >= 1, "mock run should execute at least one trade");
  for (const id of executed) assert.ok(rows[id].trades >= 1, `${id} executed but has no trades`);
  for (const id of vetoed) assert.ok(rows[id].vetoes >= 1, `${id} was vetoed but has no vetoes`);
  for (const id of AGENT_IDS) {
    if (!executed.has(id)) assert.equal(rows[id].trades, 0);
    if (!vetoed.has(id)) assert.equal(rows[id].vetoes, 0);
  }
});

test("trades move the simulated vault state: spent counter and balances", async () => {
  const { ledger, records } = await playRounds(1);
  const x = records[0].executions[0];
  assert.ok(x, "expected an execution in round 1");
  const st = ledger.states[x.agent];
  assert.equal(st.spent.amounts[x.proposal.token_in], x.proposal.amount_in);
  assert.ok(BigInt(st.balances[x.proposal.token_out]) > 0n);
});

test("P&L is the sum of the agent's trade P&L", async () => {
  const { ledger } = await playRounds(3);
  for (const [id, a] of Object.entries(ledger.book.agents)) {
    const sum = a.trades.reduce((s, t) => s + BigInt(t.pnl_micro_usd), 0n);
    assert.equal(a.pnl_micro_usd, sum.toString(), id);
  }
});

test("scoreboard is sorted by P&L descending", async () => {
  const { ledger } = await playRounds(3);
  const pnl = ledger.scoreboard().map((r) => BigInt(r.pnl_micro_usd));
  for (let i = 1; i < pnl.length; i++) assert.ok(pnl[i - 1] >= pnl[i]);
});

test("the ledger is deterministic for the same inputs", async () => {
  const a = await playRounds(2);
  const b = await playRounds(2);
  assert.deepEqual(a.ledger.book, b.ledger.book);
});

test("save() writes DIR/yield/ledger.json with per-agent entries", async () => {
  const { ledger } = await playRounds(2);
  const dir = mkdtempSync(join(tmpdir(), "yield-ledger-"));
  try {
    const path = await ledger.save(dir);
    assert.equal(path, join(dir, "yield", "ledger.json"));
    assert.equal(path, ledgerPath(dir));
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(data.agents).sort(), ["aloof", "chaotic", "skeptic", "social"]);
    for (const a of Object.values(data.agents)) {
      assert.equal(a.rounds, 2);
      assert.ok(Array.isArray(a.trades));
      assert.ok(Array.isArray(a.vetoed));
      assert.equal(typeof a.pnl_micro_usd, "string");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vetoed decision records the counterfactual and no state change (synthetic record)", () => {
  const ledger = createLedger({ fixture });
  const proposal = { pool_id: 1, token_in: "nusdt.ft-fin.testnet", token_out: "nusdc.ft-fin.testnet", amount_in: "9000", min_amount_out: "8000", rationale: "x" };
  ledger.record({ round: 1, now_ms: EPOCH, decisions: { aloof: { agent: "aloof", status: "ok", proposal, outcome: "vetoed", veto: { by: "skeptic", reason: "too big" } } } });
  const a = ledger.book.agents.aloof;
  assert.equal(a.vetoes, 1);
  assert.equal(a.vetoed.length, 1);
  assert.equal(a.vetoed[0].reason, "too big");
  assert.equal(a.trades.length, 0);
  assert.equal(a.pnl_micro_usd, "0");
  assert.equal(ledger.states.aloof.spent.amounts["nusdt.ft-fin.testnet"], undefined);
});

test("formatUsd and formatScoreboard render signed micro-USD", () => {
  assert.equal(formatUsd("0"), "0.000000");
  assert.equal(formatUsd("1500000"), "+1.500000");
  assert.equal(formatUsd("-123"), "-0.000123");
  const text = formatScoreboard([{ agent: "aloof", rounds: 1, trades: 1, vetoes: 0, rejected: 0, invalid: 0, pnl_micro_usd: "-123" }]);
  assert.match(text, /aloof .*-0\.000123/);
});
