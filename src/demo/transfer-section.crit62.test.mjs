// crit62: honest caveats in the page's Transfer section (src/demo/transfer-section.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTransfer } from "./transfer-verify.mjs";
import { transferSection } from "./transfer-section.mjs";
import { hashSheet } from "../anchor/hash.mjs";

const SHEET = "Aloof the scout\nrivals: none";
const agents = [{ id: "aloof", name: "Aloof", personality: "Aloof", traits: { role: "scout" }, sheets: [{ sheet: SHEET }] }];
const calls = [{ tokenId: "aloof", args: { sheet_hash: hashSheet(SHEET) } }];
const withTamper = () => buildTransfer(agents, { calls }, { contractId: "c.testnet", mode: "mock" });
const render = (transfer) => transferSection({ transfer });

describe("transfer intro caveat", () => {
  it("says the anchored hash is the dry-run value, not a chain read, and mentions the tampered sheet when one exists", () => {
    const t = withTamper();
    assert.ok(t.tamper, "fixture must produce a tamper");
    const html = render(t);
    assert.ok(html.includes("Here the anchored hash is the dry-run value from <code>anchors.json</code>, not read from a chain, so a match shows the hashing is consistent; the tampered sheet below shows what a rewrite looks like."));
  });

  it("ends after 'consistent.' when there is no tamper", () => {
    const t = withTamper();
    t.tamper = null;
    const html = render(t);
    assert.ok(html.includes("not read from a chain, so a match shows the hashing is consistent.</p>"));
    assert.ok(!html.includes("tampered sheet below"));
  });

  it("keeps the caveat inside the intro paragraph, before the table", () => {
    const html = render(withTamper());
    const p = html.match(/<p class="mut">Simulated transfer[\s\S]*?<\/p>/)[0];
    assert.match(p, /not read from a chain/);
  });
});

describe("mint metadata label", () => {
  const html = render(withTamper());
  const label = html.match(/<h3>Mint metadata<\/h3>\s*<p class="mut">([\s\S]*?)<\/p>/)[1];

  it("calls it a preview and points at npm run mint for the exact call", () => {
    assert.match(label, /^A preview of the NEP-177 <code>TokenMetadata<\/code> fields/);
    assert.match(label, /<code>npm run mint<\/code> prints the exact mint call \(dry run\)/);
    assert.match(label, /<code>media<\/code> and <code>media_hash<\/code>/);
  });

  it("says the real mint call uses its own title, description and extra", () => {
    assert.match(label, /title, description and extra are its own/);
  });

  it("no longer claims these are what each token would mint with", () => {
    assert.ok(!html.includes("each token would mint with"));
  });
});
