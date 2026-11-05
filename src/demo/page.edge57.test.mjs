// Edge cases for the offline demo page: hostile text, missing optional fields,
// prototype-key names, determinism, and formatDeposit extremes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enemyInSheet, formatDeposit, renderDemoPage, thenNowCaption } from "./page.mjs";

const HASH = "b".repeat(64);

const agentFixture = (id, name, extra = {}) => ({
  id,
  name,
  personality: "calm",
  traits: { memory_depth: 1, vibe: "x" },
  memoryDepth: 2,
  art: `art/${id}.svg`,
  mintArt: `art/${id}.mint.svg`,
  faces: { neutral: `art/${id}.neutral.svg` },
  sheets: [{ round: 3, sheetHash: HASH, words: 12, sheet: `Who I am: ${name}.` }],
  ...extra,
});

const baseManifest = (over = {}) => ({
  rounds: 2,
  seed: 1,
  every: 1,
  roundHashes: [HASH, HASH],
  finalRoundHash: HASH,
  agents: [agentFixture("aloof", "Aloof"), agentFixture("chaotic", "Chaotic")],
  files: ["index.html", "demo.json"],
  ...over,
});
const baseData = (over = {}) => ({ events: [], anchors: { contractId: "c.testnet", calls: [] }, ...over });
const render = (m = baseManifest(), d = baseData()) => renderDemoPage(m, d);

const LEAKS = ["undefined", "[object Object]", "NaN"];
const assertNoLeaks = (html) => {
  for (const leak of LEAKS) assert.ok(!html.includes(leak), `page leaks ${leak}`);
};
// No script element may exist; every hostile value must have been escaped into text.
const assertInert = (html) => {
  assert.ok(!/<script/i.test(html));
};

describe("hostile text is escaped everywhere it lands", () => {
  const XSS = `<script>alert(1)</script>"'&</textarea>`;
  const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;&lt;/textarea&gt;";

  it("agent name, personality, traits and sheet text", () => {
    const html = render(baseManifest({
      agents: [agentFixture("aloof", XSS, {
        personality: XSS,
        traits: { memory_depth: 1, [XSS]: XSS },
        sheets: [{ round: 1, sheetHash: XSS, words: 1, sheet: XSS }],
      })],
    }));
    assert.ok(html.includes(ESCAPED));
    assert.ok(!html.includes("<script>alert"));
    assert.ok(!html.includes("</textarea>"));
    assertInert(html);
  });

  it("a name with quotes cannot break out of the alt attribute", () => {
    const name = `x" onerror="alert(1)`;
    const html = render(baseManifest({ agents: [agentFixture("aloof", name)] }));
    assert.ok(!html.includes(`alt="${name}`));
    assert.ok(html.includes('alt="x&quot; onerror=&quot;alert(1)"'));
    assertInert(html);
  });

  it("single quotes in a name are escaped too", () => {
    const html = render(baseManifest({ agents: [agentFixture("aloof", "O'Neil")] }));
    assert.ok(html.includes("O&#39;Neil"));
    assert.ok(!html.includes("O'Neil"));
  });

  it("event text, a hostile agent id on an unknown speaker and mood text", () => {
    const events = [
      { id: "e1", round: 1, agentId: XSS, kind: "post", text: XSS },
      { id: "e2", round: 1, agentId: "aloof", kind: "reply", replyTo: "e1", text: "ok" },
    ];
    const html = render(baseManifest(), baseData({ events }));
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes(`<span class="who">${ESCAPED}</span>`));
    assert.ok(html.includes(`Aloof → ${ESCAPED}`));
    assertInert(html);
  });

  it("anchor rows: token, method, status, hash and contract id", () => {
    const call = { tokenId: XSS, round: XSS, method: XSS, args: { sheet_hash: XSS }, depositYocto: "1", status: XSS };
    const html = render(baseManifest(), baseData({ anchors: { contractId: XSS, calls: [call] } }));
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes(`<code>${ESCAPED}</code> is a placeholder`));
    assertInert(html);
  });

  it("round hashes, final hash, seed, style, every and rounds fields", () => {
    const html = render(baseManifest({ roundHashes: [XSS], finalRoundHash: XSS, seed: XSS, style: XSS, every: XSS, rounds: XSS }));
    assert.ok(!html.includes("<script>alert"));
    assert.ok(html.includes(`seed ${ESCAPED}`));
    assert.ok(html.includes(`art style ${ESCAPED}`));
    assertInert(html);
  });

  it("meme alt text, file labels and mood labels", () => {
    const html = render(baseManifest({
      memes: [{ file: "share/m.svg", alt: XSS }],
      moods: ["neutral", "hype"],
      agents: [agentFixture("aloof", "Aloof", { faces: { neutral: "art/n.svg", hype: "art/h.svg" } })],
    }));
    assert.ok(html.includes(`alt="${ESCAPED}"`));
    assert.ok(!html.includes("<script>alert"));
  });

  it("an ampersand in a file name is refused, not emitted", () => {
    assert.throws(() => render(baseManifest({ files: ["index.html", "a&b.svg"] })), TypeError);
  });

  it("unicode, emoji and RTL/control characters survive or are neutralised, never injected", () => {
    const name = "Ægir 🐙 日本語";
    const html = render(baseManifest({ agents: [agentFixture("aloof", name)] }));
    assert.ok(html.includes(name));
    const rtl = render(baseManifest({ agents: [agentFixture("aloof", "ab‮cd\u0007")] }));
    assert.ok(!rtl.includes("‮"));
    assert.ok(!rtl.includes("\u0007"));
    assert.ok(rtl.includes("ab�cd�"));
  });
});

describe("file paths", () => {
  const bad = ["javascript:alert(1)", "JavaScript:x", "data:text/html,x", "//evil.com/x.svg", "a b.svg", 'a".svg', "a<b.svg", "a\nb.svg", "-x.svg", ".hidden", "a/../b", "..", "a\\b.svg"];

  it("rejects every unsafe path in every field that reaches a URL context", () => {
    for (const file of bad) {
      const label = JSON.stringify(file);
      assert.throws(() => render(baseManifest({ agents: [agentFixture("aloof", "Aloof", { mintArt: file })] })), TypeError, `mintArt ${label}`);
      assert.throws(() => render(baseManifest({ memes: [{ file, alt: "m" }] })), TypeError, `meme ${label}`);
      assert.throws(() => render(baseManifest({ files: ["index.html", file] })), TypeError, `files ${label}`);
      assert.throws(() => render(baseManifest({ moods: ["neutral", "hype"], agents: [agentFixture("aloof", "Aloof", { faces: { neutral: "n.svg", hype: file } })] })), TypeError, `face ${label}`);
    }
  });

  it("a hostile face in the channel (not in the strip) is rejected too", () => {
    const m = baseManifest({ agents: [agentFixture("aloof", "Aloof", { faces: { neutral: "javascript:x" } })] });
    const events = [{ id: "e1", round: 1, agentId: "aloof", kind: "post", text: "hello" }];
    assert.throws(() => render(m, baseData({ events })), TypeError);
  });

  it("accepts nested relative paths, dots in names and underscores", () => {
    const html = render(baseManifest({ files: ["index.html", "share/a_b.c-d.svg", "_x.svg", "a..b.svg"] }));
    assert.ok(html.includes('<a href="share/a_b.c-d.svg">'));
    assert.ok(html.includes('<a href="_x.svg">'));
    assert.ok(html.includes('<a href="a..b.svg">'));
  });
});

describe("missing and empty optional data", () => {
  it("no agents renders a page with empty sections and no leaks", () => {
    const html = render(baseManifest({ agents: [] }));
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes('<div class="faces"></div>'));
    assertNoLeaks(html);
  });

  it("no events renders a round header per round and no messages", () => {
    const html = render(baseManifest({ rounds: 3 }), baseData({ events: [] }));
    assert.equal((html.match(/<h3>Round \d+<\/h3>/g) ?? []).length, 3);
    assert.ok(!html.includes('class="msg"'));
  });

  it("zero rounds, no round hashes, no anchors, no files", () => {
    const html = render(baseManifest({ rounds: 0, roundHashes: [], files: [] }));
    assert.ok(!html.includes("<h3>Round"));
    assert.ok(html.includes("0 rounds"));
    assertNoLeaks(html);
  });

  it("events from rounds beyond manifest.rounds are not shown", () => {
    const events = [{ id: "e9", round: 99, agentId: "aloof", kind: "post", text: "off the end" }];
    assert.ok(!render(baseManifest(), baseData({ events })).includes("off the end"));
  });

  it("an agent with no traits renders", () => {
    const html = render(baseManifest({ agents: [agentFixture("aloof", "Aloof", { traits: {} })] }));
    assertNoLeaks(html);
  });

  it("events without text throw a clear error instead of printing undefined", () => {
    const events = [{ id: "e1", round: 1, agentId: "aloof", kind: "post" }];
    assert.throws(() => render(baseManifest(), baseData({ events })), TypeError);
  });

  it("a manifest or data object missing required parts throws instead of rendering", () => {
    assert.throws(() => renderDemoPage(baseManifest({ agents: undefined }), baseData()));
    assert.throws(() => renderDemoPage(baseManifest({ roundHashes: undefined }), baseData()));
    assert.throws(() => renderDemoPage(baseManifest(), { events: [], anchors: { contractId: "c" } }));
    assert.throws(() => renderDemoPage(baseManifest(), { anchors: { contractId: "c", calls: [] } }));
    assert.throws(() => renderDemoPage(baseManifest(), {}));
  });

  it("an anchor call with a missing deposit throws rather than showing a made-up amount", () => {
    const call = { tokenId: "a", round: 1, method: "m", args: { sheet_hash: HASH }, status: "dry-run" };
    assert.throws(() => render(baseManifest(), baseData({ anchors: { contractId: "c", calls: [call] } })));
  });

  it("many anchors and a single-round manifest still pluralise correctly", () => {
    const html = render(baseManifest({ rounds: 1, every: 1, roundHashes: [HASH] }));
    assert.ok(html.includes("1 round, seed"));
    assert.ok(html.includes("a sheet every 1 round,"));
    assert.ok(html.includes("Every round each agent"));
  });

  it("every = 3 reads 'Every 3 rounds'", () => {
    assert.ok(render(baseManifest({ every: 3 })).includes("Every 3 rounds each agent"));
  });
});

describe("prototype-key names and ids", () => {
  const keys = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

  it("agents named after Object.prototype members render with their own names", () => {
    for (const key of keys) {
      const html = render(baseManifest({ agents: [agentFixture("aloof", key), agentFixture("chaotic", "Chaotic")] }));
      assert.ok(html.includes(`<h3>${key} `), key);
      assertNoLeaks(html);
    }
  });

  it("agent ids that are prototype keys resolve events to the right agent", () => {
    for (const key of keys) {
      const m = baseManifest({ agents: [agentFixture(key, "Proto", { faces: { neutral: "art/p.svg" } })] });
      const events = [
        { id: "e1", round: 1, agentId: key, kind: "post", text: "hello there" },
        { id: "e2", round: 1, agentId: key, kind: "reply", replyTo: "e1", text: "again" },
      ];
      const html = render(m, baseData({ events }));
      assert.ok(html.includes('<span class="who">Proto → Proto</span>'), key);
      assert.ok(html.includes('src="art/p.svg"'), key);
    }
  });

  it("an event id or replyTo that is a prototype key is not treated as a known event", () => {
    const events = [{ id: "e1", round: 1, agentId: "aloof", kind: "reply", replyTo: "constructor", text: "lonely" }];
    const html = render(baseManifest(), baseData({ events }));
    assert.ok(html.includes('<span class="who">Aloof</span>'));
    assert.ok(!html.includes("→ "));
    assertNoLeaks(html);
  });

  it("an unknown speaker named __proto__ shows its id and no image", () => {
    const events = [{ id: "e1", round: 1, agentId: "__proto__", kind: "post", text: "hi" }];
    const html = render(baseManifest(), baseData({ events }));
    const msg = html.split('<div class="msg">')[1];
    assert.ok(msg.includes('<span class="who">__proto__</span>'));
    assert.ok(!msg.includes("<img"));
  });

  it("a share whose agentId is a prototype key falls back to the id in the alt text", () => {
    const html = render(baseManifest({ shares: [{ file: "share/x.svg", agentId: "constructor", round: 1, mood: "hype" }] }));
    assert.ok(html.includes('alt="Share card: constructor, round 1, hype"'));
  });

  it("enemyInSheet and thenNowCaption cope with prototype-key names", () => {
    assert.equal(enemyInSheet("Public enemy #1: __proto__ (2 fights).", ["__proto__"]), "__proto__");
    assert.equal(enemyInSheet("Public enemy #1: constructor.", ["toString"]), null);
    const agent = { name: "A", sheets: [{ round: 1, sheet: "Public enemy #1: toString." }] };
    assert.equal(thenNowCaption(agent, ["A", "toString"]), "Round 1: Public enemy #1 toString");
  });
});

describe("determinism and purity", () => {
  const events = [
    { id: "e1", round: 1, agentId: "aloof", kind: "post", text: "hello there" },
    { id: "e2", round: 2, agentId: "chaotic", kind: "reply", replyTo: "e1", text: "WHAT?!" },
  ];
  const anchors = {
    contractId: "c.testnet",
    signed: false,
    calls: [{ tokenId: "aloof", round: 1, method: "anchor_sheet", args: { sheet_hash: HASH }, depositYocto: "10000000000000000000000", status: "dry-run" }],
  };

  it("the same input renders byte-identical output", () => {
    const a = render(baseManifest({ moods: ["neutral"] }), { events, anchors });
    const b = render(baseManifest({ moods: ["neutral"] }), { events, anchors });
    assert.equal(a, b);
  });

  it("the inputs are not mutated", () => {
    const m = baseManifest({
      moods: ["neutral"],
      shares: [{ file: "share/a.svg", agentId: "aloof", round: 1, mood: "neutral" }],
      memes: [{ file: "share/m.svg", alt: "m" }],
    });
    const d = { events: structuredClone(events), anchors: structuredClone(anchors) };
    const before = JSON.stringify([m, d]);
    render(m, d);
    assert.equal(JSON.stringify([m, d]), before);
  });

  it("events given out of order are still shown under their own round, in the order given", () => {
    const shuffled = [events[1], events[0]];
    const html = render(baseManifest(), { events: shuffled, anchors });
    assert.ok(html.indexOf("hello there") < html.indexOf("WHAT?!"));
    assert.ok(html.indexOf("<h3>Round 1</h3>") < html.indexOf("hello there"));
    assert.ok(html.indexOf("<h3>Round 2</h3>") < html.indexOf("WHAT?!"));
  });
});

describe("formatDeposit edge values", () => {
  it("zero in every accepted form", () => {
    for (const z of [0, 0n, "0", "00", "-0"]) assert.equal(formatDeposit(z), "0 yoctoNEAR", String(z));
  });

  it("one yocto, and the last value below and first value at the NEAR-display threshold", () => {
    assert.equal(formatDeposit(1), "1 yoctoNEAR");
    assert.equal(formatDeposit(10n ** 18n - 1n), "999999999999999999 yoctoNEAR");
    assert.equal(formatDeposit(10n ** 18n), "0.000001 NEAR");
  });

  it("exactly one NEAR has no fraction, and one NEAR plus one yocto keeps all 24 digits", () => {
    assert.equal(formatDeposit(10n ** 24n), "1 NEAR");
    assert.equal(formatDeposit(10n ** 24n + 1n), "1.000000000000000000000001 NEAR");
  });

  it("trailing zeros are trimmed but inner zeros are kept", () => {
    assert.equal(formatDeposit(10n ** 24n + 10n ** 23n), "1.1 NEAR");
    assert.equal(formatDeposit(10n ** 24n + 10n ** 20n), "1.0001 NEAR");
    assert.equal(formatDeposit(2n * 10n ** 24n), "2 NEAR");
    assert.equal(formatDeposit(100n * 10n ** 24n), "100 NEAR");
  });

  it("huge values keep full precision and never use exponent notation", () => {
    assert.equal(formatDeposit(10n ** 40n), "10000000000000000 NEAR");
    assert.equal(formatDeposit("340282366920938463463374607431768211455"), "340282366920938.463463374607431768211455 NEAR");
    assert.equal(formatDeposit(10n ** 60n + 5n), `1${"0".repeat(36)}.${"0".repeat(23)}5 NEAR`);
  });

  it("surrounding whitespace in a string is accepted", () => {
    assert.equal(formatDeposit(" 5 "), "5 yoctoNEAR");
  });

  it("non-numeric, fractional and missing inputs throw instead of printing something", () => {
    for (const bad of ["abc", "1.5", "1e3", "NaN", "Infinity", "5 NEAR", "--1"]) assert.throws(() => formatDeposit(bad), SyntaxError, bad);
    for (const bad of [1.5, NaN, Infinity, -Infinity]) assert.throws(() => formatDeposit(bad), RangeError, String(bad));
    for (const bad of [undefined, null, Symbol("x")]) assert.throws(() => formatDeposit(bad), TypeError, String(typeof bad));
    assert.throws(() => formatDeposit({}), SyntaxError);
  });

  it("a very large JS number is converted exactly as the double it is (2^80)", () => {
    assert.equal(formatDeposit(2 ** 80), "1.208925819614629174706176 NEAR");
  });
});

describe("enemyInSheet and thenNowCaption edges", () => {
  it("non-string sheets are read as text, not crashed on", () => {
    assert.equal(enemyInSheet(42, ["Bob"]), null);
    assert.equal(enemyInSheet({}, ["Bob"]), null);
    assert.equal(enemyInSheet("", ["Bob"]), null);
  });

  it("matches a name with unicode letters and emoji boundaries", () => {
    assert.equal(enemyInSheet("Public enemy #1: Ægir (2 fights).", ["Ægir"]), "Ægir");
    assert.equal(enemyInSheet("Public enemy #1: Ægirs.", ["Ægir"]), null);
    assert.equal(enemyInSheet("Public enemy #1: 🐙Bob🐙.", ["Bob"]), "Bob");
  });

  it("the first listed name that appears in the field wins", () => {
    assert.equal(enemyInSheet("Public enemy #1: Bob and Cy.", ["Cy", "Bob"]), "Cy");
  });

  it("an empty-string name never matches", () => {
    assert.equal(enemyInSheet("Public enemy #1: Bob.", [""]), null);
  });

  it("a very long field with no match returns promptly", () => {
    const started = Date.now();
    assert.equal(enemyInSheet(`Public enemy #1: ${"a".repeat(200000)}`, ["Bob"]), null);
    assert.ok(Date.now() - started < 2000);
  });

  it("caption with the same sheet object first and last is a single label, with two equal sheets an arrow", () => {
    const s = { round: 1, sheet: "Public enemy #1: Bob." };
    assert.equal(thenNowCaption({ name: "A", sheets: [s] }, ["A", "Bob"]), "Round 1: Public enemy #1 Bob");
    assert.equal(thenNowCaption({ name: "A", sheets: [s, { ...s }] }, ["A", "Bob"]), "Round 1: Public enemy #1 Bob → Round 1: Public enemy #1 Bob");
  });

  it("the caption passes through the hero figure escaped when the enemy name is hostile", () => {
    const evil = `<i>"x"</i>`;
    const html = render(baseManifest({ agents: [
      agentFixture("aloof", "Aloof", { sheets: [{ round: 1, sheetHash: HASH, words: 1, sheet: `Public enemy #1: ${evil}.` }] }),
      agentFixture("chaotic", evil),
    ] }));
    assert.ok(!html.includes("<i>"));
    assert.ok(html.includes("Public enemy #1 &lt;i&gt;&quot;x&quot;&lt;/i&gt;"));
  });
});

describe("a manifest missing a scalar the page prints throws instead of printing 'undefined'", () => {
  for (const key of ["rounds", "seed", "every", "finalRoundHash"]) {
    it(`manifest.${key}`, () => {
      const m = baseManifest();
      delete m[key];
      assert.throws(() => render(m), TypeError);
    });
  }

  for (const key of ["name", "personality", "memoryDepth"]) {
    it(`agent.${key}`, () => {
      assert.throws(() => render(baseManifest({ agents: [agentFixture("aloof", "Aloof", { [key]: undefined })] })), TypeError);
    });
  }

  it("anchors.contractId", () => {
    assert.throws(() => render(baseManifest(), { events: [], anchors: { calls: [] } }), TypeError);
  });

  it("null counts as missing", () => {
    assert.throws(() => render(baseManifest({ seed: null })), TypeError);
  });

  it("falsy but present values are fine: seed 0, rounds 0, empty personality", () => {
    const html = render(baseManifest({ seed: 0, rounds: 0, agents: [agentFixture("aloof", "Aloof", { personality: "" })] }));
    assert.ok(html.includes("seed 0"));
    assertNoLeaks(html);
  });
});

