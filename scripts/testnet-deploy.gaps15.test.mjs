// Deploy agent builder: what a dry run prints and refuses, observed through the CLI and the pure builders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENTS, UsageError, agentSvg, buildPlan, tokenMetadata, validateMediaBase } from "./testnet-deploy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = (...args) => {
  const env = { ...process.env };
  delete env.NEAR_ACCOUNT_ID; delete env.NEAR_CONTRACT_ACCOUNT_ID; delete env.NEAR_NETWORK;
  return spawnSync(process.execPath, ["scripts/testnet-deploy.mjs", ...args], { cwd: ROOT, encoding: "utf8", env });
};

test("validateMediaBase accepts http, https, ipfs and ar bases and returns them unchanged", () => {
  for (const ok of ["https://h.example/p", "http://h.example/p/", "ipfs://bafyabc", "ar://txid/dir"]) assert.equal(validateMediaBase(ok), ok);
});

test("validateMediaBase refuses other schemes, queries, fragments, spaces, empties and non-strings with a UsageError", () => {
  for (const bad of ["ftp://h/p", "file:///x", "javascript:alert(1)", "https://h/p?x=1", "https://h/p#f", "https://h/ p", "https://", "", "h.example/p", null, undefined, 5]) {
    assert.throws(() => validateMediaBase(bad), (e) => e instanceof UsageError && /--media-base must be an http\(s\), ipfs or ar URL without a query or fragment/.test(e.message), String(bad));
  }
});

test("tokenMetadata: media is <base>/<token_id>.svg with trailing slashes collapsed, media_hash is the base64 sha256 of the art", () => {
  const agent = AGENTS[1];
  const m = tokenMetadata(agent, { mediaBase: "https://h.example/art///" });
  assert.equal(m.media, `https://h.example/art/${agent.token_id}.svg`);
  assert.equal(m.media_hash, createHash("sha256").update(agentSvg(agent)).digest("base64"));
  assert.deepEqual(JSON.parse(m.extra), agent.traits);
});

test("tokenMetadata without a base uses the labelled placeholder host, which can never resolve", () => {
  assert.match(tokenMetadata(AGENTS[0]).media, /^https:\/\/media-host-not-set\.invalid\/.*PLACEHOLDER.*\/aloof\.svg$/);
});

test("each agent's art is distinct, so each token gets its own media_hash", () => {
  const hashes = AGENTS.map((a) => tokenMetadata(a, { mediaBase: "https://h/x" }).media_hash);
  assert.equal(new Set(hashes).size, AGENTS.length);
});

test("buildPlan mint --count n takes the first n agents in roster order; deploy is one step; anything else throws", () => {
  const base = { contract: "c.testnet", owner: "o.testnet", receiver: "r.testnet", mediaBase: "https://h/x" };
  assert.deepEqual(buildPlan({ ...base, command: "mint", count: 3 }).map((s) => s.name), ["mint aloof", "mint chaotic", "mint social"]);
  assert.equal(buildPlan({ ...base, command: "deploy", wasm: "w.wasm" }).length, 1);
  assert.throws(() => buildPlan({ ...base, command: "burn" }), { message: "unknown command: burn" });
});

test("no step carries --quiet, which would hide the transaction id the live proof reads", () => {
  const steps = buildPlan({ command: "mint", contract: "c.testnet", owner: "o.testnet", receiver: "r.testnet", mediaBase: "https://h/x" });
  steps.push(...buildPlan({ command: "deploy", contract: "c.testnet", owner: "o.testnet", wasm: "w.wasm" }));
  for (const s of steps) assert.ok(!s.argv.includes("--quiet"), s.name);
});

test("CLI dry run: mint --json --count 2 prints two steps, exit 0, signs nothing", () => {
  const r = cli("mint", "--json", "--count", "2", "--media-base", "https://x.example/y/");
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.network, "testnet");
  assert.deepEqual(plan.steps.map((s) => s.args.token_id), ["aloof", "chaotic"]);
  assert.equal(plan.steps[0].args.token_metadata.media, "https://x.example/y/aloof.svg");
  assert.equal(plan.steps[0].deposit, "0.05 NEAR");
});

test("CLI refuses a media base with a query: exit 2, one error line naming --help, empty stdout", () => {
  const r = cli("mint", "--count", "2", "--media-base", "https://x?y");
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trimEnd(), "error: --media-base must be an http(s), ipfs or ar URL without a query or fragment (see --help)");
});

test("CLI refuses --count outside 1..4 and non-numeric counts with exit 2", () => {
  for (const bad of ["0", "5", "-1", "two", "1.5", ""]) {
    const r = cli("mint", "--count", bad);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.equal(r.stdout, "", JSON.stringify(bad));
    assert.match(r.stderr, /^error: /, JSON.stringify(bad));
  }
});
