import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMemes, capLabel } from "./memes.mjs";

const MOODS = ["neutral", "hype", "shade", "shook"];
const face = (mood) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10" data-mood="${mood}"><rect width="10" height="10"/></svg>`;
const facesFor = (ids, moods = MOODS) => Object.fromEntries(ids.map((id) => [id, Object.fromEntries(moods.map((m) => [m, face(m)]))]));
const ev = (id, round, agentId, kind, replyTo, text) => ({ id, round, turn: 1, agentId, kind, replyTo, text });
const SHEET = "Who I am: Ann, the villain. Public enemy #1: Bob (3 fights). Ride-or-die: no one yet. Receipts: 1 post.";
const LEAK = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]/;

const names = { a: "Ann", b: "Bob" };
const pingPong = [
  ev(1, 1, "a", "post", null, "gas is free? I doubt it."),
  ev(2, 1, "b", "reply", 1, "@Ann love that for us!"),
  ev(3, 2, "a", "reply", 2, "@Bob fine. whatever."),
  ev(4, 2, "b", "reply", 3, "@Ann wait what?"),
];
const build = (over = {}) => buildMemes({ events: pingPong, sheets: { a: SHEET, b: SHEET }, names, moods: MOODS, faces: facesFor(["a", "b"]), ...over });
const wellFormed = (card) => {
  assert.ok(card.svg.startsWith("<svg ") && card.svg.trimEnd().endsWith("</svg>"), card.file);
  assert.ok(!LEAK.test(card.svg), `${card.file} leaks a placeholder`);
  assert.ok(!LEAK.test(card.alt), `${card.file} alt leaks a placeholder`);
  assert.match(card.file, /^share\/meme-[a-z]+-[A-Za-z0-9_-]+\.svg$/);
};

describe("memes edge62: roster size", () => {
  it("no agents gives no cards", () => {
    assert.deepEqual(buildMemes({ events: [], sheets: {}, names: {}, moods: MOODS, faces: {} }), []);
  });

  it("no moods list falls back to neutral only and still draws every card", () => {
    const cards = build({ moods: [], faces: facesFor(["a", "b"], ["neutral"]) });
    assert.ok(cards.length >= 2);
    for (const c of cards) { wellFormed(c); assert.equal(c.mood, "neutral"); }
  });

  it("exactly one agent: no caption (needs a replier), a villain card whose enemy is not on the roster renders without an enemy tile", () => {
    const cards = buildMemes({
      events: [ev(1, 1, "a", "post", null, "hello")], sheets: { a: SHEET }, names: { a: "Ann" }, moods: MOODS, faces: facesFor(["a"]),
    });
    assert.deepEqual(cards.map((c) => c.format), ["villain"]);
    wellFormed(cards[0]);
    assert.ok(cards[0].alt.includes("Bob"));
    assert.equal(cards[0].svg.split("<svg").length - 1, 2, "root plus the one nested face, no enemy tile");
  });

  it("exactly one agent with no events and no sheet gives no cards", () => {
    assert.deepEqual(buildMemes({ events: [], names: { a: "Ann" }, moods: MOODS, faces: facesFor(["a"]) }), []);
  });

  it("an agent present in events but not in names never becomes a card or a crash", () => {
    const events = [...pingPong, ev(5, 3, "ghost", "reply", 1, "@Ann boo"), ev(6, 3, "ghost", "reply", 2, "@Bob boo")];
    const cards = build({ events });
    for (const c of cards) { wellFormed(c); assert.ok(["a", "b"].includes(c.agentId)); }
  });
});

describe("memes edge62: duplicate ids", () => {
  it("duplicated event ids and a duplicated event list stay well-formed and deterministic", () => {
    const events = [...pingPong, ...pingPong];
    const first = build({ events });
    assert.ok(first.length >= 1);
    first.forEach(wellFormed);
    assert.deepEqual(build({ events }), first);
  });

  it("two agents with the same display name keep distinct files and agent ids", () => {
    const same = { a: "Sam", b: "Sam" };
    const cards = build({ names: same, sheets: { a: "Public enemy #1: Sam (4 fights).", b: "Public enemy #1: Sam (4 fights)." } });
    cards.forEach(wellFormed);
    const files = cards.map((c) => c.file);
    assert.equal(new Set(files).size, files.length);
  });

  it("ids that differ only in unsafe characters cannot escape the share dir or break the file name", () => {
    const odd = { "a/../b": "Ann", "c d": "Bob" };
    const events = [
      ev(1, 1, "a/../b", "post", null, "hi"), ev(2, 1, "c d", "reply", 1, "@Ann yo"),
      ev(3, 2, "a/../b", "reply", 2, "@Bob no"), ev(4, 2, "c d", "reply", 3, "@Ann what"),
    ];
    const cards = buildMemes({ events, sheets: { "a/../b": SHEET }, names: odd, moods: MOODS, faces: facesFor(Object.keys(odd)) });
    assert.ok(cards.length >= 1);
    for (const c of cards) assert.match(c.file, /^share\/meme-(caption|villain)-[A-Za-z0-9_-]+\.svg$/);
  });
});

describe("memes edge62: unicode names and lines", () => {
  const ugly = {
    a: "\u{1F469}\u200D\u{1F680} Ann\u0301\u0301",
    b: "\u05D1\u05D5\u05D1 \u0645\u0631\u062D\u0628\u0627 \u202E",
  };
  const events = [
    ev(1, 1, "a", "post", null, "start"),
    ev(2, 1, "b", "reply", 1, "@x \u05E9\u05DC\u05D5\u05DD \u{1F680} !"),
    ev(3, 2, "a", "reply", 2, "@y e\u0301 \u{1F468}\u200D\u{1F469}\u200D\u{1F467} lol"),
    ev(4, 2, "b", "reply", 3, "@x again"),
  ];
  const sheets = { a: `Who I am: x. Public enemy #1: ${ugly.b.trim()} (3 fights). Receipts: 1.`, b: SHEET };

  it("emoji, combining marks and RTL names/lines render whole and keep their script; bidi controls are dropped", () => {
    const cards = buildMemes({ events, sheets, names: ugly, moods: MOODS, faces: facesFor(["a", "b"]) });
    assert.ok(cards.length >= 2);
    cards.forEach(wellFormed);
    for (const c of cards) assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(c.svg), `${c.file} svg keeps a bidi control`);
    assert.ok(cards.some((c) => c.svg.includes("\u05D1\u05D5\u05D1")));
    assert.ok(cards.some((c) => c.svg.includes("\u{1F680}")));
    // no lone surrogate was produced anywhere
    for (const c of cards) assert.equal(c.svg, c.svg.toWellFormed());
  });

  it("the same unicode input gives identical cards", () => {
    const args = { events, sheets, names: ugly, moods: MOODS, faces: facesFor(["a", "b"]) };
    assert.deepEqual(buildMemes(args), buildMemes(args));
  });
});

describe("memes edge62: very long text", () => {
  const long = "A".repeat(10000);
  it("10k-character names, lines and sheets give bounded, well-formed cards", () => {
    const start = Date.now();
    const events = pingPong.map((e) => ({ ...e, text: `@Ann ${"word ".repeat(2000)}` }));
    const cards = buildMemes({
      events, sheets: { a: `Public enemy #1: ${long} (9 fights).`, b: `Public enemy #1: ${"Bob ".repeat(2500)}` },
      names: { a: long, b: "Bob" }, moods: MOODS, faces: facesFor(["a", "b"]),
    });
    assert.ok(Date.now() - start < 5000, "bounded work");
    assert.ok(cards.length >= 1);
    for (const c of cards) {
      wellFormed(c);
      assert.ok(c.svg.length < 20000, `${c.file} is ${c.svg.length} bytes`);
      assert.ok([...c.alt].length <= 200, "alt is capped");
    }
  });

  it("capLabel keeps text at the cap whole and never splits a surrogate pair at the cut", () => {
    const exact = "\u{1F680}".repeat(200);
    assert.equal(capLabel(exact), exact);
    const cut = capLabel("\u{1F680}".repeat(201));
    assert.equal([...cut].length, 200);
    assert.ok(cut.endsWith("\u2026"));
    assert.equal(cut, cut.toWellFormed());
  });
});

describe("memes edge62: missing data", () => {
  it("null, undefined, empty and numeric event text never prints undefined/null/NaN", () => {
    for (const text of [null, undefined, "", "   ", 42]) {
      const events = pingPong.map((e) => ({ ...e, text }));
      const cards = build({ events });
      cards.forEach(wellFormed);
    }
  });

  it("a missing, null or non-string sheet means no villain card, not a crash", () => {
    for (const sheets of [undefined, {}, { a: null, b: undefined }, { a: 7, b: {} }]) {
      const cards = build({ sheets });
      assert.ok(cards.every((c) => c.format === "caption"));
      cards.forEach(wellFormed);
    }
  });

  it("null or missing display names render as empty text, never the words null/undefined", () => {
    for (const bad of [{ a: null, b: null }, { a: "Ann", b: undefined }, { a: undefined, b: undefined }]) {
      const cards = build({ names: bad });
      assert.ok(cards.length >= 1);
      cards.forEach(wellFormed);
    }
  });

  it("empty-string face art still renders closed, well-formed cards", () => {
    const blank = Object.fromEntries(["a", "b"].map((id) => [id, Object.fromEntries(MOODS.map((m) => [m, ""]))]));
    const cards = build({ faces: blank });
    assert.ok(cards.length >= 2);
    cards.forEach(wellFormed);
  });

  it("a null face for the wanted mood falls back to neutral instead of crashing", () => {
    const bad = { a: { neutral: face("neutral"), hype: null }, b: { neutral: face("neutral"), hype: face("hype") } };
    build({ faces: bad }).forEach(wellFormed);
  });

  it("an agent whose faces lack the wanted mood falls back to its neutral face instead of throwing", () => {
    const onlyNeutral = facesFor(["a", "b"], ["neutral"]);
    const cards = build({ faces: onlyNeutral });
    assert.ok(cards.length >= 2);
    for (const c of cards) {
      wellFormed(c);
      assert.ok(c.svg.includes('data-mood="neutral"'), "the nested face is the neutral one");
    }
  });

  it("an agent with no neutral face (or null/empty face map) is skipped like an agent with no faces", () => {
    for (const bad of [{}, { hype: face("hype") }, { neutral: null }, { neutral: 5 }]) {
      const faces = { a: facesFor(["a"]).a, b: bad };
      const cards = build({ faces });
      for (const c of cards) { wellFormed(c); assert.notEqual(c.agentId, "b"); }
    }
  });

  it("missing faces map entirely gives no cards", () => {
    assert.deepEqual(build({ faces: undefined }), []);
  });
});

describe("memes edge62: escaping", () => {
  it("markup, entities and quotes in names, lines and enemy names are escaped in text and attributes", () => {
    const nasty = `<img src=x onerror=alert(1)> & "q" 'a' \${x}`;
    const events = pingPong.map((e) => ({ ...e, text: e.kind === "reply" ? `@Ann ${nasty}` : e.text }));
    const cards = build({
      events, names: { a: nasty, b: "Bob" },
      sheets: { a: "Public enemy #1: <b>Bob</b> (4 fights).", b: SHEET },
    });
    assert.ok(cards.length >= 1);
    for (const c of cards) {
      wellFormed(c);
      assert.ok(!c.svg.includes("<img"), `${c.file} has raw img`);
      assert.ok(!c.svg.includes("<b>"), `${c.file} has raw b`);
    }
  });
});
