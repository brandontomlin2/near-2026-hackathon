import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDemo } from "./pipeline.mjs";
import { verifySheetAgainstAnchor, tamperSheet, buildTransfer } from "./transfer-verify.mjs";
import { transferSection } from "./transfer-section.mjs";
import { hashSheet } from "../anchor/hash.mjs";

let dir;
let result;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-test-"));
  result = await runDemo({ outDir: dir });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("transfer verify", () => {
  it("every transferred sheet re-hashes to its anchored hash", () => {
    const { tokens } = result.manifest.transfer;
    assert.equal(tokens.length, 4);
    for (const t of tokens) {
      assert.equal(t.match, true, t.tokenId);
      assert.equal(t.recomputedHash, t.anchoredHash);
    }
  });

  it("anchored hashes are the ones in anchors.json, not recomputed copies", () => {
    const anchors = JSON.parse(fs.readFileSync(path.join(dir, "anchors.json"), "utf8"));
    for (const t of result.manifest.transfer.tokens) {
      const last = anchors.calls.filter((c) => c.tokenId === t.tokenId).at(-1);
      assert.equal(t.anchoredHash, last.args.sheet_hash);
    }
  });

  it("a tampered sheet does not match the anchor", () => {
    const { tamper } = result.manifest.transfer;
    assert.equal(tamper.match, false);
    assert.notEqual(tamper.recomputedHash, tamper.anchoredHash);
    const original = result.manifest.agents.find((a) => a.id === tamper.tokenId).sheets.at(-1).sheet;
    assert.notEqual(tamper.tamperedSheet, original);
    assert.equal(hashSheet(tamper.tamperedSheet), tamper.recomputedHash);
  });

  it("verifySheetAgainstAnchor accepts a sheet and rejects an edit of it", () => {
    const sheet = "I am Aloof. I watch.";
    const anchored = hashSheet(sheet);
    assert.equal(verifySheetAgainstAnchor(sheet, anchored).match, true);
    assert.equal(verifySheetAgainstAnchor(`${sheet}\r\n`, anchored).match, true); // same after normalizing
    assert.equal(verifySheetAgainstAnchor(tamperSheet(sheet), anchored).match, false);
  });

  it("labels accounts, contract and TEE inference as placeholder or mocked", () => {
    const t = result.manifest.transfer;
    assert.equal(t.placeholder, true);
    assert.equal(t.explorer.placeholder, true);
    assert.equal(t.teeInference.status, "mocked");
    assert.match(t.teeInference.label, /NEAR AI Cloud \(TEE\)/);
    // Mock mode never carries an explorer URL: the contract is not deployed, so a link would point at an account nobody owns.
    assert.equal(t.explorer.mock, true);
    assert.equal(t.explorer.contractUrl, undefined);
    assert.ok(!JSON.stringify(t.explorer).includes("https://"));
    assert.match(t.explorer.note, /mock placeholder/);
    for (const k of t.tokens) assert.ok(JSON.parse(k.nftMetadata.extra).role);
  });

  it("the page shows the match, the tamper failure and the mocked badge", () => {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.ok(html.includes("Transfer: memory travels with the NFT"));
    assert.ok(html.includes("alice.demo.testnet") && html.includes("bob.demo.testnet"));
    assert.ok(html.includes("MISMATCH"));
    assert.ok(html.includes("mock placeholder"));
    assert.match(html, /NEAR AI Cloud \(TEE\) in live mode<\/strong>: <span class="neutral">mocked/);
  });

  it("the mocked TEE badge is styled neutral (grey), not like a passing check", () => {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    // The page CSS gives .neutral the muted colour, and .ok keeps the accent colour for real passes.
    assert.ok(html.includes(".neutral{color:var(--mut)"), "page CSS lacks a .neutral rule");
    assert.ok(html.includes(".ok{color:var(--acc)"), "page CSS lost the .ok rule");
    assert.doesNotMatch(html, /<span class="ok">mocked</);
    // Real pass styling is unchanged: the hash matches still use .ok.
    assert.ok(html.includes('<span class="ok">match</span>'));
  });
});

const mkAgent = (id, sheets, extra = {}) => ({
  id, name: id, personality: "Aloof", traits: { role: "scout" }, sheets: sheets.map((sheet) => ({ sheet })), ...extra,
});
const anchorFor = (id, sheet) => ({ tokenId: id, args: { sheet_hash: hashSheet(sheet) } });
const opts = { contractId: "c.testnet", mode: "mock" };

describe("buildTransfer / transferSection (unit)", () => {
  it("skips agents with no sheets or no anchor call without throwing", () => {
    const agents = [mkAgent("a", []), mkAgent("b", ["sb"]), mkAgent("c", ["sc"])];
    const t = buildTransfer(agents, { calls: [anchorFor("c", "sc")] }, opts);
    assert.deepEqual(t.tokens.map((k) => k.tokenId), ["c"]);
  });

  it("tamper example comes from the first anchored token (regression: first agent unanchored)", () => {
    const agents = [mkAgent("a", ["sa"]), mkAgent("b", ["sb"])];
    const t = buildTransfer(agents, { calls: [anchorFor("b", "sb")] }, opts);
    assert.equal(t.tokens.length, 1);
    assert.equal(t.tamper.tokenId, "b");
    assert.equal(t.tamper.anchoredHash, hashSheet("sb"));
    assert.equal(t.tamper.match, false);
    assert.deepEqual(Object.keys(t.tamper), ["tokenId", "anchoredHash", "tamperedSheet", "recomputedHash", "match"]);
  });

  it("no sheets anywhere: tokens [] and tamper null, no tamper heading", () => {
    const t = buildTransfer([mkAgent("a", [])], { calls: [] }, opts);
    assert.deepEqual(t.tokens, []);
    assert.equal(t.tamper, null);
    const html = transferSection({ transfer: t });
    assert.ok(html.includes("<th>Token</th>"));
    assert.ok(!html.includes("Tampered sheet"));
  });

  it("mode controls the TEE inference status and the no-call note", () => {
    const mock = buildTransfer([], { calls: [] }, { ...opts, mode: "mock" });
    const live = buildTransfer([], { calls: [] }, { ...opts, mode: "live" });
    assert.equal(mock.teeInference.status, "mocked");
    assert.equal(live.teeInference.status, "live");
    assert.ok(transferSection({ transfer: mock }).includes("(this demo makes no inference call)"));
    assert.ok(!transferSection({ transfer: live }).includes("(this demo makes no inference call)"));
  });

  it("a mocked TEE badge never gets the success class; live keeps it", () => {
    const badge = (mode) => transferSection({ transfer: buildTransfer([], { calls: [] }, { ...opts, mode }) }).match(/<strong>NEAR AI Cloud \(TEE\) in live mode<\/strong>: <span class="([^"]*)">([^<]*)<\/span>/);
    const mock = badge("mock");
    assert.ok(mock, "mock badge not rendered");
    assert.equal(mock[2], "mocked");
    assert.equal(mock[1], "neutral");
    assert.ok(!mock[1].split(/\s+/).includes("ok"), "mocked badge must not carry the success class");
    const live = badge("live");
    assert.ok(live, "live badge not rendered");
    assert.deepEqual([live[1], live[2]], ["ok", "live"]);
  });

  it("transferSection returns empty string without a transfer", () => {
    assert.equal(transferSection({}), "");
    assert.equal(transferSection(), "");
  });

  it("mock mode: the contract is a labelled mock placeholder in plain text, never a link", () => {
    const t = buildTransfer([], { calls: [] }, { ...opts, mode: "mock" });
    assert.equal(t.explorer.placeholder, true);
    assert.equal(t.explorer.mock, true);
    assert.ok(!("contractUrl" in t.explorer));
    assert.equal(t.explorer.accountUrlPattern, "testnet.nearblocks.io/address/<account_id>");
    const html = transferSection({ transfer: t });
    assert.ok(html.includes("mock placeholder"));
    assert.ok(html.includes("<code>c.testnet</code>"));
    assert.ok(html.includes("testnet.nearblocks.io/address/&lt;account_id&gt;"));
    assert.ok(!html.includes("https://"));
    assert.ok(!html.includes("<a href"));
  });

  it("live mode: the contract links to its real testnet explorer page", () => {
    const t = buildTransfer([], { calls: [] }, { ...opts, mode: "live" });
    assert.equal(t.explorer.placeholder, false);
    assert.equal(t.explorer.mock, false);
    assert.equal(t.explorer.contractUrl, "https://testnet.nearblocks.io/address/c.testnet");
    const html = transferSection({ transfer: t });
    assert.ok(html.includes('<a href="https://testnet.nearblocks.io/address/c.testnet" rel="noopener noreferrer">testnet.nearblocks.io/address/c.testnet</a>'));
    assert.ok(!html.includes("is not deployed, so there is no explorer link"));
  });

  it("live mode: a contract id that cannot form a safe explorer URL is shown as text, not linked", () => {
    const t = buildTransfer([], { calls: [] }, { contractId: 'x"><script>', mode: "live" });
    const html = transferSection({ transfer: t });
    assert.ok(!html.includes("<a href"));
    assert.ok(!html.includes("<script>"));
  });

  it("escapes ids, hashes and sheet text; extra carries traits and memory_depth 1", () => {
    const id = "<b>&x";
    const t = buildTransfer([mkAgent(id, ["s<b>&"], { traits: { role: "scout", mood: "calm" } })], { calls: [anchorFor(id, "s<b>&")] }, opts);
    const extra = JSON.parse(t.tokens[0].nftMetadata.extra);
    assert.equal(extra.memory_depth, 1);
    assert.equal(extra.role, "scout");
    assert.equal(extra.mood, "calm");
    const html = transferSection({ transfer: t });
    assert.ok(!html.includes("<b>"));
    assert.ok(html.includes("&lt;b&gt;"));
  });
});
