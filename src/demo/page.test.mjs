import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enemyInSheet, formatDeposit, renderDemoPage, thenNowCaption } from "./page.mjs";
import { moodForText } from "../art/moods.mjs";

const HASH = "a".repeat(64);

const agentFixture = (id, name, extra = {}) => ({
  id,
  name,
  personality: "calm",
  traits: { memory_depth: 1, vibe: "x" },
  memoryDepth: 2,
  art: `art/${id}.svg`,
  mintArt: `art/${id}.mint.svg`,
  faces: { neutral: `art/${id}.neutral.svg`, shook: `art/${id}.shook.svg` },
  sheets: [{ round: 3, sheetHash: HASH, words: 12, sheet: `Who I am: ${name}.` }],
  ...extra,
});

// A sparse manifest: no moods, shares, memes or style.
const baseManifest = (over = {}) => ({
  rounds: 2,
  seed: 1,
  every: 1,
  roundHashes: [HASH, HASH],
  finalRoundHash: HASH,
  agents: [agentFixture("aloof", "Aloof"), agentFixture("chaotic", "Chaotic")],
  files: ["index.html", "demo.json", "art/aloof.svg"],
  ...over,
});
const baseData = (over = {}) => ({ events: [], anchors: { contractId: "c.testnet", calls: [] }, ...over });
const render = (manifest = baseManifest(), data = baseData()) => renderDemoPage(manifest, data);

describe("renderDemoPage with a sparse manifest", () => {
  it("renders with no moods, shares, memes or style fields", () => {
    const html = render();
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(!html.includes('class="moods"'));
    assert.ok(!html.includes("Meme pack"));
    assert.ok(html.includes("0 share cards"));
    assert.ok(html.includes("art style default"));
  });

  it("pluralizes share cards and summaries", () => {
    const one = render(baseManifest({ shares: [{ file: "share/aloof-1.svg", agentId: "aloof", round: 1, mood: "neutral" }] }));
    assert.ok(one.includes("1 share card<"));
    assert.ok(!one.includes("1 share cards"));
    assert.ok(one.includes("after 1 summary"));
    const two = render(baseManifest({
      agents: [agentFixture("aloof", "Aloof", { sheets: [
        { round: 1, sheetHash: HASH, words: 1, sheet: "a" },
        { round: 2, sheetHash: HASH, words: 1, sheet: "b" },
      ] })],
    }));
    assert.ok(two.includes("after 2 summaries"));
  });

  it("memes render a Meme pack section and escape the alt text", () => {
    const html = render(baseManifest({ memes: [{ file: "share/meme-x-aloof.svg", alt: "a <b> meme" }] }));
    assert.ok(html.includes("Meme pack"));
    assert.ok(html.includes('alt="a &lt;b&gt; meme"'));
  });

  it("a mood strip appears only for a manifest with more than one mood", () => {
    const html = render(baseManifest({ moods: ["neutral", "shook"] }));
    assert.ok(html.includes('class="moods"'));
    assert.ok(html.includes("Aloof in mood shook"));
  });

  it("an agent with no sheets shows placeholders and no arc caption", () => {
    const html = render(baseManifest({ agents: [agentFixture("aloof", "Aloof", { sheets: [] })] }));
    assert.ok(html.includes("No sheet yet."));
    assert.ok(html.includes('<div class="hash">none</div>'));
    assert.ok(html.includes("No sheets yet."));
    assert.ok(!html.includes('<span class="arc">'));
  });

  it("escapes a hostile round and words value", () => {
    const html = render(baseManifest({
      agents: [agentFixture("aloof", "Aloof", { sheets: [{ round: "<img src=x>", sheetHash: HASH, words: "<script>1</script>", sheet: "s" }] })],
    }));
    assert.ok(!html.includes("<img src=x>"));
    assert.ok(!html.includes("<script>1"));
    assert.ok(html.includes("round &lt;img src=x&gt;"));
    assert.ok(html.includes("&lt;script&gt;1&lt;/script&gt; words"));
  });

  it("lists every file except index.html, escapes the contract id", () => {
    const html = render(baseManifest(), baseData({ anchors: { contractId: "<x>", calls: [] } }));
    const list = html.slice(html.indexOf("<h2>Files</h2>"));
    assert.ok(list.includes('<a href="demo.json">demo.json</a>'));
    assert.ok(list.includes('<a href="art/aloof.svg">art/aloof.svg</a>'));
    assert.ok(!list.includes("index.html"));
    assert.ok(html.includes("<code>&lt;x&gt;</code>"));
    assert.ok(!html.includes("<code><x></code>"));
  });

  it("renders anchor calls with a formatted deposit", () => {
    const html = render(baseManifest(), baseData({ anchors: { contractId: "c", calls: [
      { tokenId: "aloof", round: 3, method: "anchor_sheet", args: { sheet_hash: HASH }, depositYocto: "10000000000000000000000", status: "dry-run" },
    ] } }));
    assert.ok(html.includes("<td>0.01 NEAR</td>"));
    assert.ok(html.includes("<td>dry-run</td>"));
  });

  it("refuses a manifest path that is not a plain relative file", () => {
    for (const bad of ["javascript:alert(1)", "../x.svg", "/abs.svg", "a/../b.svg", "", 5, undefined]) {
      assert.throws(() => render(baseManifest({ agents: [agentFixture("aloof", "Aloof", { art: bad })] })), TypeError, String(bad));
    }
    assert.throws(() => render(baseManifest({ shares: [{ file: "x y.svg", agentId: "aloof", round: 1, mood: "neutral" }] })), TypeError);
  });

  it("a mood strip whose face file is missing throws instead of printing a broken src", () => {
    const m = baseManifest({ moods: ["neutral", "hype"] });
    assert.throws(() => render(m), TypeError);
  });

  it("a share for an unknown agent uses the id in its alt text", () => {
    const html = render(baseManifest({ shares: [{ file: "share/ghost-1.svg", agentId: "ghost", round: 1, mood: "hype" }] }));
    assert.ok(html.includes('alt="Share card: ghost, round 1, hype"'));
  });
});

describe("renderDemoPage channel", () => {
  const shookText = "WHAT?!";
  const events = [
    { id: "e1", round: 1, agentId: "aloof", kind: "post", text: "hello there" },
    { id: "e2", round: 1, agentId: "chaotic", kind: "reply", replyTo: "e1", text: "hello back" },
    { id: "e3", round: 1, agentId: "ghost", kind: "post", text: "boo" },
    { id: "e4", round: 1, agentId: "aloof", kind: "reply", replyTo: "missing", text: "orphan" },
    { id: "e5", round: 1, agentId: "aloof", kind: "reply", replyTo: "e3", text: "reply to a ghost" },
    { id: "e6", round: 1, agentId: "chaotic", kind: "post", text: shookText },
  ];
  const html = render(baseManifest({ moods: ["neutral"], rounds: 3 }), baseData({ events }));
  const msgs = html.split('<div class="msg">').slice(1);
  const msgFor = (text) => msgs.find((m) => m.includes(`${text}</div></div>`));

  it("renders exactly manifest.rounds round headers, even for rounds with no events", () => {
    assert.equal((html.match(/<h3>Round \d+<\/h3>/g) ?? []).length, 3);
    assert.ok(html.includes("<h3>Round 3</h3>"));
  });

  it("an event from an unknown agent shows its id and no image", () => {
    const m = msgFor("boo");
    assert.ok(m.includes('<span class="who">ghost</span>'));
    assert.ok(!m.includes("<img"));
  });

  it("a reply to a known event shows Name → Target", () => {
    assert.ok(msgFor("hello back").includes('<span class="who">Chaotic → Aloof</span>'));
  });

  it("a reply to a missing event has no arrow", () => {
    const m = msgFor("orphan");
    assert.ok(m.includes('<span class="who">Aloof</span>'));
    assert.ok(!m.includes("→"));
  });

  it("a reply whose target agent is unknown shows the target agent id", () => {
    assert.ok(msgFor("reply to a ghost").includes("Aloof → ghost"));
  });

  it("a mood outside manifest.moods shows the neutral face but the real mood text", () => {
    assert.equal(moodForText(shookText), "shook");
    const m = msgFor(shookText);
    assert.ok(m.includes('src="art/chaotic.neutral.svg"'));
    assert.ok(m.includes('<span class="mood">shook</span>'));
    assert.ok(m.includes('data-mood="shook"'));
  });

  it("an agent without faces gets no image", () => {
    const noFaces = render(
      baseManifest({ agents: [agentFixture("aloof", "Aloof", { faces: undefined })] }),
      baseData({ events: [events[0]] }),
    );
    const m = noFaces.split('<div class="msg">')[1];
    assert.ok(!m.includes("<img"));
  });

  it("an agent whose faces lack the shown mood gets no image", () => {
    const sparse = render(
      baseManifest({ agents: [agentFixture("aloof", "Aloof", { faces: {} })] }),
      baseData({ events: [events[0]] }),
    );
    assert.ok(!sparse.split('<div class="msg">')[1].includes("<img"));
  });
});

describe("formatDeposit", () => {
  it("formats the yocto/NEAR boundary", () => {
    assert.equal(formatDeposit("0"), "0 yoctoNEAR");
    assert.equal(formatDeposit(10n ** 18n - 1n), "999999999999999999 yoctoNEAR");
    assert.equal(formatDeposit("999999999999999999"), "999999999999999999 yoctoNEAR");
    assert.equal(formatDeposit(10n ** 18n), "0.000001 NEAR");
    assert.equal(formatDeposit(10n ** 24n), "1 NEAR");
    assert.equal(formatDeposit(15n * 10n ** 23n), "1.5 NEAR");
  });

  it("accepts a bigint, a number and a string", () => {
    assert.equal(formatDeposit(5n), "5 yoctoNEAR");
    assert.equal(formatDeposit(5), "5 yoctoNEAR");
    assert.equal(formatDeposit(1e21), "0.001 NEAR");
    assert.equal(formatDeposit("1500000000000000000000000"), "1.5 NEAR");
  });

  it("throws on a non-numeric string", () => {
    assert.throws(() => formatDeposit("abc"), SyntaxError);
    assert.throws(() => formatDeposit("1.5"), SyntaxError);
  });
});

describe("enemyInSheet", () => {
  it("matches a name with regex metacharacters only as a whole word", () => {
    assert.equal(enemyInSheet("Public enemy #1: A+B (3 fights).", ["A+B"]), "A+B");
    assert.equal(enemyInSheet("Public enemy #1: AAB.", ["A+B"]), null);
    assert.equal(enemyInSheet("Public enemy #1: xA+B.", ["A+B"]), null);
    assert.equal(enemyInSheet("Public enemy #1: A+Bx.", ["A+B"]), null);
  });

  it("does not match a longer word that contains the name", () => {
    assert.equal(enemyInSheet("Public enemy #1: Skeptical.", ["Skeptic"]), null);
    assert.equal(enemyInSheet("Public enemy #1: Skeptic.", ["Skeptic"]), "Skeptic");
  });

  it("reads the label case-insensitively", () => {
    assert.equal(enemyInSheet("public enemy #1: Skeptic", ["Skeptic"]), "Skeptic");
    assert.equal(enemyInSheet("PUBLIC ENEMY #1:Skeptic", ["Skeptic"]), "Skeptic");
  });

  it("stops the field at a sentence end", () => {
    assert.equal(enemyInSheet("Public enemy #1: nobody yet. Skeptic is fine.", ["Skeptic"]), null);
    assert.equal(enemyInSheet("Public enemy #1: nobody yet.\nSkeptic is fine.", ["Skeptic"]), null);
  });

  it("a field running to the end of the string works, with or without a final period", () => {
    assert.equal(enemyInSheet("Who I am: x. Public enemy #1: Social", ["Social"]), "Social");
    assert.equal(enemyInSheet("Who I am: x. Public enemy #1: Social.", ["Social"]), "Social");
  });

  it("returns null for no names, no sheet, no label or an empty field", () => {
    assert.equal(enemyInSheet("Public enemy #1: Skeptic", []), null);
    assert.equal(enemyInSheet(null, ["Skeptic"]), null);
    assert.equal(enemyInSheet(undefined, ["Skeptic"]), null);
    assert.equal(enemyInSheet("Skeptic is my enemy", ["Skeptic"]), null);
    assert.equal(enemyInSheet("Public enemy #1: . Skeptic", ["Skeptic"]), null);
  });
});

describe("thenNowCaption", () => {
  const names = ["Aloof", "Chaotic", "Skeptic"];
  const sheet = (round, text) => ({ round, sheet: text });

  it("joins first and latest with an arrow when they differ", () => {
    const agent = { name: "Chaotic", sheets: [sheet(3, "Public enemy #1: nobody yet."), sheet(6, "Public enemy #1: Skeptic (4 fights).")] };
    assert.equal(thenNowCaption(agent, names), "Round 3: no enemies → Round 6: Public enemy #1 Skeptic");
  });

  it("gives a single label for one sheet and an empty caption for none", () => {
    assert.equal(thenNowCaption({ name: "Chaotic", sheets: [sheet(3, "Public enemy #1: Aloof.")] }, names), "Round 3: Public enemy #1 Aloof");
    assert.equal(thenNowCaption({ name: "Chaotic", sheets: [] }, names), "");
  });

  it("never names the agent itself as its enemy", () => {
    const agent = { name: "Chaotic", sheets: [sheet(3, "Public enemy #1: Chaotic.")] };
    assert.equal(thenNowCaption(agent, names), "Round 3: no enemies");
  });

  it("shows the arc in the hero figure", () => {
    const html = render(baseManifest({ agents: [
      agentFixture("aloof", "Aloof", { sheets: [sheet(3, "Public enemy #1: none."), sheet(6, "Public enemy #1: Chaotic.")] }),
      agentFixture("chaotic", "Chaotic"),
    ] }));
    assert.ok(html.includes('<span class="arc">Round 3: no enemies → Round 6: Public enemy #1 Chaotic</span>'));
  });
});

describe("renderDemoPage hero subtitle", () => {
  const call = (over = {}) => ({ tokenId: "aloof", round: 1, method: "anchor_sheet", args: { sheet_hash: HASH }, depositYocto: "1", status: "dry-run", transactionHash: null, ...over });

  it("says the hash is only prepared for anchoring when the anchors are dry runs", () => {
    const html = render(baseManifest(), baseData({ anchors: { contractId: "c.testnet", signed: false, calls: [call()] } }));
    assert.ok(html.includes("whose hash is prepared for anchoring on NEAR (dry run here, nothing sent)"));
    assert.ok(!html.includes("is anchored on NEAR"));
  });

  it("does not claim anchoring when signed is set but a call is still a dry run", () => {
    const html = render(baseManifest(), baseData({ anchors: { contractId: "c.testnet", signed: true, calls: [call({ status: "sent", transactionHash: "tx" }), call()] } }));
    assert.ok(!html.includes("is anchored on NEAR"));
  });

  it("says anchored only when every call was signed and sent", () => {
    const html = render(baseManifest(), baseData({ anchors: { contractId: "c.testnet", signed: true, calls: [call({ status: "sent", transactionHash: "tx" })] } }));
    assert.ok(html.includes("whose hash is anchored on NEAR,"));
  });
});
