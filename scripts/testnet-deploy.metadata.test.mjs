import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AGENTS, agentSvg, tokenMetadata, buildPlan, run, MEDIA_PLACEHOLDER_BASE,
} from "./testnet-deploy.mjs";

// Limits from contracts/personality-nft/src/lib.rs (validate_token_metadata).
const MAX = { title: 128, description: 1024, extra: 2048, media: 512 };
const NEP177 = ["title", "description", "media", "media_hash", "reference", "reference_hash", "copies",
  "issued_at", "expires_at", "starts_at", "updated_at", "extra"];

function capture() {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: () => {}, text: () => lines.join("\n") };
}

test("every agent's metadata uses only NEP-177 fields and fits the contract's limits", () => {
  for (const agent of AGENTS) {
    const m = tokenMetadata(agent);
    for (const key of Object.keys(m)) assert.ok(NEP177.includes(key), `${key} is not a NEP-177 field`);
    for (const [field, max] of Object.entries(MAX)) {
      assert.ok(Buffer.byteLength(m[field]) <= max, `${agent.token_id} ${field} exceeds ${max} bytes`);
    }
    assert.ok(m.description.length > 20 && m.description !== `${agent.title} agent.`);
    assert.deepEqual(JSON.parse(m.extra), agent.traits); // extra is a JSON object of the traits
  }
});

test("descriptions differ per agent (each speaks in its own voice)", () => {
  assert.equal(new Set(AGENTS.map((a) => tokenMetadata(a).description)).size, AGENTS.length);
});

test("media_hash is the base64 sha256 (32 bytes) of the agent's SVG", () => {
  for (const agent of AGENTS) {
    const { media_hash } = tokenMetadata(agent);
    assert.equal(Buffer.from(media_hash, "base64").length, 32);
    assert.equal(media_hash, createHash("sha256").update(agentSvg(agent)).digest("base64"));
  }
  assert.equal(new Set(AGENTS.map((a) => tokenMetadata(a).media_hash)).size, AGENTS.length);
});

test("media points at <token_id>.svg under --media-base, else a labelled placeholder", () => {
  const hosted = tokenMetadata(AGENTS[2], { mediaBase: "https://art.example/agents/" });
  assert.equal(hosted.media, "https://art.example/agents/social.svg");
  const placeholder = tokenMetadata(AGENTS[2]);
  assert.ok(placeholder.media.startsWith(MEDIA_PLACEHOLDER_BASE));
  assert.match(placeholder.media, /PLACEHOLDER/);
});

test("mint steps carry the exact token_metadata in nft_mint args", () => {
  const steps = buildPlan({ command: "mint", contract: "c.testnet", owner: "o.testnet", receiver: "o.testnet", mediaBase: "ipfs://cid" });
  assert.equal(steps.length, AGENTS.length);
  steps.forEach((step, i) => {
    assert.deepEqual(Object.keys(step.args), ["token_id", "receiver_id", "token_metadata"]);
    assert.deepEqual(step.args.token_metadata, tokenMetadata(AGENTS[i], { mediaBase: "ipfs://cid" }));
  });
});

test("dry-run text and --json both show the full metadata", async () => {
  const text = capture();
  assert.equal(await run(["mint"], {}, text), 0);
  for (const agent of AGENTS) {
    const m = tokenMetadata(agent);
    for (const v of [m.title, m.description, m.media, m.media_hash, m.extra]) assert.ok(text.text().includes(v), v);
  }
  const json = capture();
  assert.equal(await run(["mint", "--json", "--media-base", "https://art.example"], {}, json), 0);
  const plan = JSON.parse(json.text());
  assert.equal(plan.steps[0].args.token_metadata.media, "https://art.example/aloof.svg");
  assert.equal(plan.steps[3].args.token_metadata.title, "Skeptic");
});

test("mint --send refuses to run without --media-base, before touching near", async () => {
  const io = capture();
  let called = false;
  const code = await run(["mint", "--send", "--i-approve"], { NEAR_ACCOUNT_ID: "o.testnet" }, { ...io, hasNear: () => true, exec: () => { called = true; return 0; } });
  assert.notEqual(code, 0);
  assert.equal(called, false);
});

test("--media-base must be a URL, and is rejected for deploy", async () => {
  assert.notEqual(await run(["mint", "--media-base", "not a url"], {}, capture()), 0);
  assert.notEqual(await run(["deploy", "--media-base", "https://a.example"], {}, capture()), 0);
});
