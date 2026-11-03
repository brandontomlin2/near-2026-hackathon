import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDemo } from "./pipeline.mjs";
import { verifySheetAgainstAnchor, tamperSheet } from "./transfer-verify.mjs";
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
    assert.ok(t.explorer.contractUrl.startsWith("https://testnet.nearblocks.io/address/"));
    for (const k of t.tokens) assert.ok(JSON.parse(k.nftMetadata.extra).role);
  });

  it("the page shows the match, the tamper failure and the mocked badge", () => {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.ok(html.includes("Transfer: memory travels with the NFT"));
    assert.ok(html.includes("alice.demo.testnet") && html.includes("bob.demo.testnet"));
    assert.ok(html.includes("MISMATCH"));
    assert.ok(html.includes("placeholder"));
    assert.match(html, /NEAR AI Cloud \(TEE\) in live mode<\/strong>: <span class="ok">mocked/);
  });
});
