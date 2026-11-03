// Behaviour of the four seeded agents (src/traits/agents.mjs) as other code and the CLIs observe them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENTS, agentById } from "./agents.mjs";
import { validateTraits } from "./validate.mjs";
import { AGENTS as DEPLOY_AGENTS } from "../../scripts/testnet-deploy.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("the roster is exactly aloof, chaotic, social, skeptic, in that order, with PRODUCT.md personalities", () => {
  assert.deepEqual(
    AGENTS.map((a) => [a.id, a.name, a.personality]),
    [["aloof", "Aloof", "Observer"], ["chaotic", "Chaotic", "Trickster"], ["social", "Social", "Connector"], ["skeptic", "Skeptic", "Auditor"]],
  );
});

test("every agent's traits pass the validator and start at memory depth 1", () => {
  for (const a of AGENTS) {
    assert.equal(a.traits.memory_depth, 1, a.id);
    assert.doesNotThrow(() => validateTraits(a.traits), a.id);
  }
});

test("the four agents differ in every trait except memory depth", () => {
  for (const key of ["temperament", "role", "risk", "voice"]) {
    assert.equal(new Set(AGENTS.map((a) => a.traits[key])).size, 4, key);
  }
});

test("the roster cannot be mutated: the list, an agent and its traits are frozen", () => {
  assert.throws(() => AGENTS.push({}), TypeError);
  assert.throws(() => { AGENTS[0].name = "X"; }, TypeError);
  assert.throws(() => { AGENTS[0].traits.risk = "high"; }, TypeError);
  assert.equal(AGENTS[0].traits.risk, "low");
});

test("agentById returns the same object as the roster", () => {
  for (const a of AGENTS) assert.equal(agentById(a.id), a);
});

test("agentById is an exact, own-key match: case, whitespace, prototype keys and non-strings all throw with the id in the message", () => {
  for (const bad of ["Aloof", "ALOOF", " aloof", "aloof ", "", "__proto__", "constructor", "toString", undefined, null, 0, ["aloof"]]) {
    assert.throws(() => agentById(bad), { message: `unknown agent id: ${String(bad)}` }, String(bad));
  }
});

test("the testnet deploy tokens are these agents: same order, id as token_id, name as title, traits as extra", () => {
  assert.deepEqual(DEPLOY_AGENTS.map((a) => a.token_id), AGENTS.map((a) => a.id));
  for (const [i, d] of DEPLOY_AGENTS.entries()) {
    assert.equal(d.title, AGENTS[i].name);
    assert.deepEqual(d.traits, Object.fromEntries(Object.entries(AGENTS[i].traits).filter(([k]) => k !== "memory_depth")));
  }
});

test("npm run ask lists the roster ids in its usage and rejects an id outside it with the same list", () => {
  const ids = AGENTS.map((a) => a.id).join(", ");
  const help = spawnSync(process.execPath, ["scripts/ask.mjs", "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes(`one of ${ids}`));
  const bad = spawnSync(process.execPath, ["scripts/ask.mjs", "nobody", "hi"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.includes(`one of ${ids}`));
});
