// Edge-case tests for transfer-verify.mjs: tampered or partial records.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTransfer, verifySheetAgainstAnchor, tamperSheet } from "./transfer-verify.mjs";
import { hashSheet } from "../anchor/hash.mjs";

const agent = (id, sheets, extra = {}) => ({
  id, name: `name-${id}`, personality: "Aloof", traits: { role: "scout" }, sheets: sheets.map((sheet) => ({ sheet })), ...extra,
});
const anchorFor = (id, sheet) => ({ tokenId: id, args: { sheet_hash: hashSheet(sheet) } });
const mock = { contractId: "c.testnet", mode: "mock" };
const live = { contractId: "c.testnet", mode: "live" };

describe("verifySheetAgainstAnchor: what counts as an edit", () => {
  it("an in-line whitespace change is detected, trailing whitespace and CRLF are not", () => {
    const sheet = "I am calm.\nI watch.";
    const h = hashSheet(sheet);
    assert.equal(verifySheetAgainstAnchor("I am  calm.\nI watch.", h).match, false);
    assert.equal(verifySheetAgainstAnchor("I am calm.\n\nI watch.", h).match, false);
    assert.equal(verifySheetAgainstAnchor("I am calm.\n \nI watch.", h).match, false);
    assert.equal(verifySheetAgainstAnchor("I am calm.\n I watch.", h).match, false);
    assert.equal(verifySheetAgainstAnchor("I am calm.   \r\nI watch.\t\n\n", h).match, true);
  });

  it("returns exactly the recomputed hash and the verdict", () => {
    const r = verifySheetAgainstAnchor("s", "nope");
    assert.deepEqual(r, { recomputedHash: hashSheet("s"), match: false });
  });
});

describe("tamperSheet", () => {
  it("strips trailing whitespace before appending, and the hash differs from the original", () => {
    for (const s of ["x", "x \n\t\n", "line one\nline two   \r\n"]) {
      const t = tamperSheet(s);
      assert.ok(t.endsWith(" Secretly, it now trusts everyone."));
      assert.ok(!t.includes("\n\n") || s.includes("\n\n"));
      assert.notEqual(t, s);
      assert.notEqual(hashSheet(t), hashSheet(s));
    }
  });

  it("is deterministic and not idempotent in effect (tampering twice differs again)", () => {
    assert.equal(tamperSheet("abc"), tamperSheet("abc"));
    assert.notEqual(tamperSheet(tamperSheet("abc")), tamperSheet("abc"));
  });
});

describe("buildTransfer: anchors", () => {
  it("a wrong (well-formed but different) hash gives a MISMATCH row carrying that hash", () => {
    const wrong = "a".repeat(64);
    const t = buildTransfer([agent("a", ["sa"])], { calls: [{ tokenId: "a", args: { sheet_hash: wrong } }] }, mock);
    assert.equal(t.tokens[0].anchoredHash, wrong);
    assert.equal(t.tokens[0].recomputedHash, hashSheet("sa"));
    assert.equal(t.tokens[0].match, false);
    // a wrong non-empty hash still drives the tamper example
    assert.equal(t.tamper.tokenId, "a");
    assert.equal(t.tamper.anchoredHash, wrong);
  });

  it("an empty-string or non-string hash becomes anchoredHash '' and never drives the tamper example", () => {
    for (const sheet_hash of ["", 7, {}, [], true]) {
      const t = buildTransfer([agent("a", ["sa"])], { calls: [{ tokenId: "a", args: { sheet_hash } }] }, mock);
      assert.equal(t.tokens[0].anchoredHash, "", JSON.stringify(sheet_hash));
      assert.equal(t.tokens[0].match, false);
      assert.equal(t.tamper, null);
    }
  });

  it("a later anchor without a hash overrides an earlier good one (last wins) and shows MISMATCH", () => {
    const t = buildTransfer([agent("a", ["sa"])], { calls: [anchorFor("a", "sa"), { tokenId: "a", args: {} }] }, mock);
    assert.equal(t.tokens.length, 1);
    assert.equal(t.tokens[0].anchoredHash, "");
    assert.equal(t.tokens[0].match, false);
    assert.equal(t.tamper, null);
  });

  it("three anchors for one token: only the last counts, and only one row is emitted", () => {
    const calls = [anchorFor("a", "x"), anchorFor("a", "y"), anchorFor("a", "sa")];
    const t = buildTransfer([agent("a", ["sa"])], { calls }, mock);
    assert.equal(t.tokens.length, 1);
    assert.equal(t.tokens[0].match, true);
  });

  it("anchors for tokens interleaved with unknown ids do not shift which anchor each agent gets", () => {
    const calls = [anchorFor("ghost", "g"), anchorFor("b", "sb"), anchorFor("ghost2", "g2"), anchorFor("a", "sa")];
    const t = buildTransfer([agent("a", ["sa"]), agent("b", ["sb"])], { calls }, mock);
    assert.deepEqual(t.tokens.map((k) => [k.tokenId, k.match]), [["a", true], ["b", true]]);
  });

  it("token id matching is exact: case and whitespace differences do not match", () => {
    const t = buildTransfer([agent("a", ["sa"])], { calls: [anchorFor("A", "sa"), anchorFor("a ", "sa")] }, mock);
    assert.deepEqual(t.tokens, []);
    assert.equal(t.tamper, null);
  });

  it("anchors null, undefined, calls null or calls missing: empty result, no throw", () => {
    for (const anchors of [null, undefined, {}, { calls: null }, { calls: undefined }]) {
      const t = buildTransfer([agent("a", ["sa"])], anchors, mock);
      assert.deepEqual(t.tokens, []);
      assert.equal(t.tamper, null);
    }
  });

  it("a call whose args are null is a MISMATCH row", () => {
    const t = buildTransfer([agent("a", ["sa"])], { calls: [{ tokenId: "a", args: null }] }, mock);
    assert.equal(t.tokens[0].match, false);
    assert.equal(t.tokens[0].anchoredHash, "");
  });
});

describe("buildTransfer: agents", () => {
  it("only the LATEST sheet is verified, not earlier ones", () => {
    const t = buildTransfer([agent("a", ["old", "new"])], { calls: [anchorFor("a", "old")] }, mock);
    assert.equal(t.tokens[0].recomputedHash, hashSheet("new"));
    assert.equal(t.tokens[0].match, false);
    const ok = buildTransfer([agent("a", ["old", "new"])], { calls: [anchorFor("a", "new")] }, mock);
    assert.equal(ok.tokens[0].match, true);
  });

  it("agents with an empty sheets array, missing sheets, or null sheets are skipped even when anchored", () => {
    const agents = [
      agent("e", []),
      { id: "m", name: "m", personality: "p", traits: {} },
      { id: "n", name: "n", personality: "p", traits: {}, sheets: null },
      agent("ok", ["s"]),
    ];
    const calls = ["e", "m", "n"].map((id) => anchorFor(id, "s")).concat(anchorFor("ok", "s"));
    const t = buildTransfer(agents, { calls }, mock);
    assert.deepEqual(t.tokens.map((k) => k.tokenId), ["ok"]);
    assert.equal(t.tamper.tokenId, "ok");
  });

  it("an empty agents list gives empty tokens, null tamper, and still labels the transfer", () => {
    const t = buildTransfer([], { calls: [anchorFor("a", "s")] }, mock);
    assert.deepEqual(t.tokens, []);
    assert.equal(t.tamper, null);
    assert.equal(t.placeholder, true);
    assert.equal(t.from, "alice.demo.testnet");
    assert.equal(t.to, "bob.demo.testnet");
  });

  it("duplicate agent ids, both with sheets: each emits a row against the same (last) anchor", () => {
    const agents = [agent("a", ["s1"]), agent("a", ["s2"])];
    const t = buildTransfer(agents, { calls: [anchorFor("a", "s2")] }, mock);
    assert.equal(t.tokens.length, 2);
    assert.deepEqual(t.tokens.map((k) => k.match), [false, true]);
    // tamper example is built from the first emitted row, which is the first agent
    assert.equal(t.tamper.tokenId, "a");
    assert.equal(t.tamper.tamperedSheet, tamperSheet("s1"));
  });

  it("tamper example takes the first token with a non-empty hash, skipping earlier empty-hash rows", () => {
    const agents = [agent("a", ["sa"]), agent("b", ["sb"]), agent("c", ["sc"])];
    const calls = [{ tokenId: "a", args: {} }, { tokenId: "b", args: { sheet_hash: 5 } }, anchorFor("c", "sc")];
    const t = buildTransfer(agents, { calls }, mock);
    assert.deepEqual(t.tokens.map((k) => k.tokenId), ["a", "b", "c"]);
    assert.equal(t.tamper.tokenId, "c");
    assert.equal(t.tamper.tamperedSheet, tamperSheet("sc"));
    assert.equal(t.tamper.match, false);
    assert.equal(t.tamper.anchoredHash, hashSheet("sc"));
  });

  it("tamper example uses the matching agent's latest sheet, not another agent's", () => {
    const agents = [agent("a", ["a-old", "a-new"]), agent("b", ["b-only"])];
    const t = buildTransfer(agents, { calls: [anchorFor("b", "b-only"), anchorFor("a", "a-new")] }, mock);
    assert.equal(t.tamper.tokenId, "a");
    assert.equal(t.tamper.tamperedSheet, tamperSheet("a-new"));
    assert.equal(t.tamper.recomputedHash, hashSheet(tamperSheet("a-new")));
  });

  it("tamper on a trailing-whitespace sheet still mismatches the anchor of the original", () => {
    const sheet = "calm and watchful   \n\n";
    const t = buildTransfer([agent("a", [sheet])], { calls: [anchorFor("a", sheet)] }, mock);
    assert.equal(t.tokens[0].match, true);
    assert.equal(t.tamper.match, false);
    assert.notEqual(t.tamper.recomputedHash, t.tamper.anchoredHash);
  });

  it("nftMetadata reflects name, personality and traits with memory_depth 1 overriding a trait of the same name", () => {
    const a = agent("a", ["sa"], { traits: { role: "scout", memory_depth: 99 }, name: "Alba", personality: "Bold" });
    const t = buildTransfer([a], { calls: [anchorFor("a", "sa")] }, mock);
    assert.equal(t.tokens[0].nftMetadata.title, "Alba");
    assert.equal(t.tokens[0].nftMetadata.description, "Bold agent in the personality NFT swarm.");
    assert.deepEqual(JSON.parse(t.tokens[0].nftMetadata.extra), { role: "scout", memory_depth: 1 });
  });

  it("does not mutate its inputs", () => {
    const agents = [agent("a", ["sa"])];
    const anchors = { calls: [anchorFor("a", "sa")] };
    const before = JSON.stringify([agents, anchors]);
    buildTransfer(agents, anchors, mock);
    assert.equal(JSON.stringify([agents, anchors]), before);
  });
});

describe("buildTransfer: determinism and mode", () => {
  it("same input twice gives deep-equal output", () => {
    const agents = [agent("a", ["sa"]), agent("b", ["sb"])];
    const anchors = { calls: [anchorFor("a", "sa"), anchorFor("b", "zz")] };
    assert.deepEqual(buildTransfer(agents, anchors, mock), buildTransfer(agents, anchors, mock));
    assert.deepEqual(buildTransfer(agents, anchors, live), buildTransfer(agents, anchors, live));
  });

  it("mode does not change tokens or tamper, only explorer and teeInference", () => {
    const agents = [agent("a", ["sa"])];
    const anchors = { calls: [anchorFor("a", "sa")] };
    const m = buildTransfer(agents, anchors, mock);
    const l = buildTransfer(agents, anchors, live);
    assert.deepEqual(m.tokens, l.tokens);
    assert.deepEqual(m.tamper, l.tamper);
    assert.notDeepEqual(m.explorer, l.explorer);
    assert.notDeepEqual(m.teeInference, l.teeInference);
  });

  it("any mode other than 'mock' is treated as live and unattested", () => {
    for (const mode of ["live", "testnet", "", undefined, "MOCK"]) {
      const t = buildTransfer([], { calls: [] }, { contractId: "c.testnet", mode });
      assert.equal(t.teeInference.status, "live (unattested)", String(mode));
      assert.equal(t.explorer.mock, false);
      assert.equal(t.explorer.contractUrl, "https://testnet.nearblocks.io/address/c.testnet");
    }
  });

  it("mock explorer mentions the contract id in its note and has no URL; live has no note", () => {
    const m = buildTransfer([], { calls: [] }, mock).explorer;
    assert.ok(m.note.includes("c.testnet"));
    assert.equal(m.contractUrl, undefined);
    assert.equal(m.accountUrlTemplate, undefined);
    const l = buildTransfer([], { calls: [] }, live).explorer;
    assert.equal(l.note, undefined);
    assert.equal(l.accountUrlTemplate, "https://testnet.nearblocks.io/address/{account_id}");
  });

  it("teeInference never claims attestation in either mode", () => {
    for (const o of [mock, live]) {
      const { label, status } = buildTransfer([], { calls: [] }, o).teeInference;
      assert.equal(label, "Inference (NEAR AI Cloud)");
      assert.doesNotMatch(status, /^attested|TEE|verified/i);
    }
  });

  it("live mode with odd contract ids: the id is substituted verbatim into the URL without throwing", () => {
    for (const contractId of ["a/b", "x y", "Foo.TESTNET", "é.testnet", "{account_id}", ""]) {
      const t = buildTransfer([], { calls: [] }, { contractId, mode: "live" });
      assert.equal(t.contractId, contractId);
      assert.ok(t.explorer.contractUrl.startsWith("https://testnet.nearblocks.io/address/"));
    }
  });

  it("mock mode with odd contract id keeps it in the note only", () => {
    const t = buildTransfer([], { calls: [] }, { contractId: "a/b c", mode: "mock" });
    assert.ok(t.explorer.note.includes("a/b c"));
    assert.ok(!JSON.stringify(t.explorer).includes("https://"));
  });
});

describe("regression: duplicate agent id where first has no sheets", () => {
  it("builds the tamper example from the duplicate that produced the token, without throwing", () => {
    const agents = [agent("a", []), agent("a", ["real sheet"])];
    const t = buildTransfer(agents, { calls: [anchorFor("a", "real sheet")] }, mock);
    assert.equal(t.tokens.length, 1);
    assert.equal(t.tokens[0].match, true);
    assert.equal(t.tamper.tokenId, "a");
    assert.equal(t.tamper.tamperedSheet, tamperSheet("real sheet"));
    assert.equal(t.tamper.match, false);
  });
});
