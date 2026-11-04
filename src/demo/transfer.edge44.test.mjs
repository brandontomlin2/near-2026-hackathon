// Edge-case behaviour tests for the Transfer section (transfer-verify.mjs, transfer-section.mjs).
// Temp dirs only; nothing is written inside the repo.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildTransfer, verifySheetAgainstAnchor, tamperSheet } from "./transfer-verify.mjs";
import { transferSection } from "./transfer-section.mjs";
import { hashSheet } from "../anchor/hash.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const opts = { contractId: "c.testnet", mode: "mock" };
const agent = (id, sheets, extra = {}) => ({ id, name: id, personality: "Aloof", traits: { role: "scout" }, sheets: sheets.map((sheet) => ({ sheet })), ...extra });
const anchorFor = (id, sheet) => ({ tokenId: id, args: { sheet_hash: hashSheet(sheet) } });

let dir;
let cli;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge44-transfer-"));
  cli = spawnSync(process.execPath, ["scripts/demo.mjs", "--out", dir], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, MOCK_INFERENCE: "1" }, timeout: 120000 });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("transfer section as the README judge sees it", () => {
  it("npm run demo exits 0 and writes the transfer data into demo.json", () => {
    assert.equal(cli.status, 0, cli.stderr);
    const t = JSON.parse(fs.readFileSync(path.join(dir, "demo.json"), "utf8")).transfer;
    assert.equal(t.from, "alice.demo.testnet");
    assert.equal(t.to, "bob.demo.testnet");
    assert.equal(t.tokens.length, 4);
    assert.ok(t.tokens.every((k) => k.match === true));
    assert.equal(t.tamper.match, false);
    assert.equal(t.teeInference.status, "mocked");
  });

  it("the page shows 4 match cells, 1 MISMATCH, the mocked badge, and no link or TEE claim", () => {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    const section = html.slice(html.indexOf("Transfer: memory travels with the NFT"));
    const body = section.slice(0, section.indexOf("<h2>", 10) > 0 ? section.indexOf("<h2>", 10) : undefined);
    assert.equal((body.match(/<span class="ok">match<\/span>/g) ?? []).length, 4);
    assert.equal((body.match(/MISMATCH/g) ?? []).length, 1);
    assert.match(body, /Inference \(NEAR AI Cloud\)<\/strong>: <span class="mut">mocked<\/span> \(this demo makes no inference call\)/);
    assert.ok(body.includes("Tampered sheet") && body.includes("Mint metadata") && body.includes("On testnet"));
    assert.ok(!body.includes("<a href"));
    assert.doesNotMatch(body, /attested|TEE verified/i);
  });

  it("MOCK_INFERENCE=0 exits 2 with the README message and writes nothing", () => {
    const out = path.join(dir, "never");
    const r = spawnSync(process.execPath, ["scripts/demo.mjs", "--out", out], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, MOCK_INFERENCE: "0" }, timeout: 60000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /demo: runs in mock mode only/);
    assert.ok(!fs.existsSync(out));
  });
});

describe("verifySheetAgainstAnchor edge inputs", () => {
  it("an unknown or empty anchored hash is a MISMATCH, never a match", () => {
    for (const h of ["", undefined, null, "0".repeat(64), "not a hash"]) {
      assert.equal(verifySheetAgainstAnchor("a sheet", h).match, false, String(h));
    }
  });

  it("an upper-case copy of the right hash does not match (the contract stores lowercase)", () => {
    assert.equal(verifySheetAgainstAnchor("a sheet", hashSheet("a sheet").toUpperCase()).match, false);
  });

  it("a non-string sheet is rejected with a clear message", () => {
    assert.throws(() => verifySheetAgainstAnchor(undefined, "x"), /sheet must be a string/);
    assert.throws(() => verifySheetAgainstAnchor(42, "x"), /sheet must be a string/);
  });

  it("tamperSheet always changes the hash, even with trailing whitespace; an empty sheet is refused by the hash", () => {
    for (const s of ["x", "x\n\n", "x   "]) {
      assert.notEqual(hashSheet(tamperSheet(s)), hashSheet(s), JSON.stringify(s));
    }
    assert.throws(() => verifySheetAgainstAnchor("  \n", "x"), /sheet is empty after normalizing/);
  });
});

describe("buildTransfer edge inputs", () => {
  it("an anchor for an unknown token id is ignored", () => {
    const t = buildTransfer([agent("a", ["sa"])], { calls: [anchorFor("ghost", "g"), anchorFor("a", "sa")] }, opts);
    assert.deepEqual(t.tokens.map((k) => k.tokenId), ["a"]);
    assert.equal(t.tokens[0].match, true);
  });

  it("when a token has two anchors the latest one is used; a stale anchor shows MISMATCH", () => {
    const t = buildTransfer([agent("a", ["s1", "s2"])], { calls: [anchorFor("a", "s2"), anchorFor("a", "s1")] }, opts);
    assert.equal(t.tokens[0].anchoredHash, hashSheet("s1"));
    assert.equal(t.tokens[0].match, false);
    assert.match(transferSection({ transfer: t }), /<strong>MISMATCH<\/strong>/);
  });

  it("anchors with no calls: no tokens, no tamper section, page still renders", () => {
    const t = buildTransfer([agent("a", ["sa"])], { calls: [] }, opts);
    assert.deepEqual(t.tokens, []);
    assert.equal(t.tamper, null);
    const html = transferSection({ transfer: t });
    assert.ok(html.includes("alice.demo.testnet") && html.includes("bob.demo.testnet"));
    assert.ok(!html.includes("Tampered sheet"));
  });

  it("a non-string sheet in an anchored agent fails loudly instead of showing a match", () => {
    const bad = { ...agent("a", []), sheets: [{ sheet: undefined }] };
    assert.throws(() => buildTransfer([bad], { calls: [{ tokenId: "a", args: { sheet_hash: "x" } }] }, opts), /sheet must be a string/);
  });

  it("markup in ids, hashes and tampered text is escaped in the page", () => {
    const id = '"><img src=x>';
    const t = buildTransfer([agent(id, ["s"])], { calls: [{ tokenId: id, args: { sheet_hash: "<i>h</i>" } }] }, opts);
    const html = transferSection({ transfer: t });
    assert.ok(!html.includes("<img") && !html.includes("<i>h"));
    assert.ok(html.includes("&lt;i&gt;h&lt;/i&gt;"));
  });

  it("live mode: a contract id with uppercase or a slash is shown as text, not linked", () => {
    for (const contractId of ["Foo.testnet", "a/b.testnet", "a b"]) {
      const html = transferSection({ transfer: buildTransfer([], { calls: [] }, { contractId, mode: "live" }) });
      assert.ok(!html.includes("<a href"), contractId);
    }
  });
});

describe("malformed or missing transfer data", () => {
  it("buildTransfer skips an agent with no sheets list, a missing anchors object, or a call without args", () => {
    const noSheets = { id: "a", name: "a", personality: "p", traits: {} };
    assert.deepEqual(buildTransfer([noSheets], { calls: [] }, opts).tokens, []);
    assert.deepEqual(buildTransfer([agent("a", ["s"])], undefined, opts).tokens, []);
    assert.deepEqual(buildTransfer([agent("a", ["s"])], {}, opts).tokens, []);
    const t = buildTransfer([agent("a", ["s"])], { calls: [{ tokenId: "a" }] }, opts);
    assert.deepEqual(t.tokens, []);
    assert.equal(t.tamper, null);
  });

  it("transferSection renders nothing for a null manifest or a null transfer", () => {
    assert.equal(transferSection(null), "");
    assert.equal(transferSection({ transfer: null }), "");
  });

  it("transferSection with a transfer that has no tokens list renders an empty table, not a crash", () => {
    const t = buildTransfer([], { calls: [] }, opts);
    delete t.tokens;
    const html = transferSection({ transfer: t });
    assert.ok(html.includes("<th>Token</th>"));
    assert.ok(html.includes("Mint metadata"));
  });
});
