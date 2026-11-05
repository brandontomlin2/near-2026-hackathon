// The hand-built scenario must not pass as real data: every account id in it, the exchange
// included, is in the *.fixture.testnet namespace, and the planner's output says it is hand-built.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan, renderPlan } from "./plan.mjs";
import { loadSnapshot } from "./snapshot.mjs";

const FILE = fileURLToPath(new URL("./fixtures/scenario.hand-built.json", import.meta.url));
const raw = JSON.parse(readFileSync(FILE, "utf8"));

/** Every string in the file that looks like a NEAR account id (has a dot and ends in .testnet or .near). */
function accountIds(v, out = []) {
  if (typeof v === "string" && /^[a-z0-9_.-]+\.(testnet|near)$/.test(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => accountIds(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) accountIds(k, out), accountIds(x, out);
  return out;
}

test("every account id in the hand-built scenario, the exchange included, is *.fixture.testnet", () => {
  const ids = [...new Set(accountIds(raw))];
  assert.ok(ids.length >= 6, `found ${ids.join(", ")}`);
  assert.ok(ids.includes(raw.exchange));
  for (const id of ids) assert.match(id, /\.fixture\.testnet$/, id);
});

test("the planner labels the scenario as hand-built and never names the real Ref exchange", () => {
  const snap = loadSnapshot(FILE);
  const text = renderPlan(snap, buildPlan(snap));
  assert.match(text, /^Snapshot: exchange\.fixture\.testnet pools taken 2026-11-04T12:00:00Z - hand-built test scenario, not fetched from any network$/m);
  assert.doesNotMatch(text, /ref-finance|Rhea/i);
});
