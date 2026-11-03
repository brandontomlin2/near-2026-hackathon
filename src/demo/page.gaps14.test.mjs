import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderDemoPage } from "./page.mjs";
import { GENESIS_HASH } from "../swarm/runner.mjs";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const FINAL = "f".repeat(64);

const agent = (id, name) => ({
  id,
  name,
  personality: "calm",
  traits: { memory_depth: 1 },
  memoryDepth: 2,
  art: `art/${id}.svg`,
  mintArt: `art/${id}.mint.svg`,
  faces: { neutral: `art/${id}.neutral.svg` },
  sheets: [],
});

const manifest = (over = {}) => ({
  rounds: 2,
  seed: 42,
  every: 2,
  style: "pixel",
  roundHashes: [H1, H2],
  finalRoundHash: FINAL,
  agents: [agent("aloof", "Aloof")],
  files: ["index.html", "demo.json", "transcript.txt"],
  ...over,
});
const data = (over = {}) => ({ events: [], anchors: { contractId: "c.testnet", calls: [] }, ...over });
const render = (m = manifest(), d = data()) => renderDemoPage(m, d);

describe("demo page: proof sections", () => {
  it("the notice line states the run options from the manifest", () => {
    const html = render();
    assert.match(html, /2 rounds, seed 42, a sheet every 2 rounds, art style pixel\./);
  });

  it("a manifest without a style says art style default", () => {
    const m = manifest();
    delete m.style;
    assert.match(render(m), /art style default\./);
  });

  it("the round hash chain starts at the genesis hash and lists every round in order", () => {
    const html = render();
    assert.ok(html.includes(`Genesis: <span class="hash">${GENESIS_HASH}</span>`));
    const rows = [...html.matchAll(/<tr><td>(\d+)<\/td><td class="hash">([0-9a-f]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(rows, [["1", H1], ["2", H2]]);
  });

  it("ends the chain with 'verify: ok' and the final round hash", () => {
    const html = render();
    assert.ok(html.includes(`<span class="ok">verify: ok</span> · final round hash <span class="hash">${FINAL}</span>`));
  });

  it("tells the reader how to recompute Aloof's hash from the folder holding the page", () => {
    const html = render();
    assert.ok(html.includes(`node -p 'require("./memory/aloof/sheet.json").sheet' | shasum -a 256`));
    assert.ok(html.includes(`node -p 'require("./memory/aloof/sheet.json").sheetHash'`));
  });

  it("the anchor section names the placeholder contract and escapes it", () => {
    const html = render(manifest(), data({ anchors: { contractId: "<b>x</b>.testnet", calls: [] } }));
    assert.ok(html.includes("<code>&lt;b&gt;x&lt;/b&gt;.testnet</code> is a placeholder contract id"));
    assert.ok(!html.includes("<b>x</b>"));
  });

  it("an anchor row shows token, round, method, hash, formatted deposit and status", () => {
    const call = {
      tokenId: "aloof",
      round: 2,
      method: "anchor_sheet",
      args: { sheet_hash: H1 },
      depositYocto: "10000000000000000000000",
      status: "dry-run",
    };
    const html = render(manifest(), data({ anchors: { contractId: "c.testnet", calls: [call] } }));
    assert.ok(html.includes(`<tr><td>aloof</td><td>2</td><td>anchor_sheet</td><td class="hash">${H1}</td><td>0.01 NEAR</td><td>dry-run</td></tr>`));
  });

  it("is a script-free document with a single title and the hero line", () => {
    const html = render();
    assert.ok(html.startsWith("<!doctype html>"));
    assert.equal(html.match(/<title>/g).length, 1);
    assert.ok(html.includes("<title>Your NFT remembers who you are</title>"));
    assert.ok(!/<script/i.test(html));
  });

  it("the Transfer section appears only when the manifest has a transfer", () => {
    assert.ok(!render().includes("Transfer: memory travels with the NFT"));
  });

  it("with no memes the Meme pack heading is absent, and with no shares the fold says 0 share cards", () => {
    const html = render();
    assert.ok(!html.includes("Meme pack"));
    assert.ok(html.includes("<summary>0 share cards</summary>"));
  });
});
