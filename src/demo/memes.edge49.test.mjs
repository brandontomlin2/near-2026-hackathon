import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMemes, fitText, estimateWidth, capLabel, ordinal, parseVillain, rivalryLine, rivalryPick, RIVALRY_LINES, SIZE } from "./memes.mjs";

const MOODS = ["neutral", "hype", "shade", "shook"];
const face = (id, mood) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-mood="${mood}"><rect width="10" height="10"/></svg>`;
const mkFaces = (names, moods = MOODS) => Object.fromEntries(Object.keys(names).map((id) => [id, Object.fromEntries(moods.map((m) => [m, face(id, m)]))]));
const ev = (id, agentId, kind, replyTo, text, round = 1) => ({ id, round, turn: 1, agentId, kind, replyTo, text });
const sheetFor = (enemyLine) => `Who I am: Ann. Public enemy #1: ${enemyLine} Ride-or-die: no one yet. Receipts: 1 post.`;
const attr = (svg, name) => new RegExp(`${name}="([^"]*)"`).exec(svg)?.[1];
const fightEvents = [
  ev(1, "a", "post", null, "gas is free? I doubt it."),
  ev(2, "b", "reply", 1, "@Ann love that for us!"),
  ev(3, "a", "reply", 2, "@Bob fine. whatever."),
  ev(4, "b", "reply", 3, "@Ann wait what?"),
];

describe("memes edge: buildMemes inputs", () => {
  const names = { a: "Ann", b: "Bob" };
  const faces = mkFaces(names);

  it("no events, no sheets gives no cards", () => {
    assert.deepEqual(buildMemes({ events: [], names, moods: MOODS, faces }), []);
  });

  it("no agents gives no cards", () => {
    assert.deepEqual(buildMemes({ events: fightEvents, names: {}, moods: MOODS, faces: {} }), []);
  });

  it("an agent without a face is skipped rather than crashing", () => {
    const cards = buildMemes({ events: fightEvents, names, moods: MOODS, faces: { a: faces.a } });
    assert.ok(cards.every((c) => c.agentId !== "b" && c.replierId !== "b"));
  });

  it("null text, null replyTo target and unknown replyTo are tolerated", () => {
    const evs = [ev(1, "a", "post", null, null), ev(2, "b", "reply", 99, undefined), ev(3, "b", "reply", null, "x")];
    assert.deepEqual(buildMemes({ events: evs, names, moods: MOODS, faces }), []);
  });

  it("an empty moods list falls back to neutral faces", () => {
    const neutralOnly = mkFaces(names, ["neutral"]);
    const cards = buildMemes({ events: fightEvents, names, moods: [], faces: neutralOnly });
    assert.ok(cards.length > 0);
    assert.ok(cards.every((c) => c.mood === "neutral"));
  });

  it("self replies never make a caption", () => {
    const evs = [ev(1, "a", "post", null, "hi"), ev(2, "a", "reply", 1, "me again"), ev(3, "a", "reply", 1, "and again")];
    assert.deepEqual(buildMemes({ events: evs, names, moods: MOODS, faces }), []);
  });

  it("a reply whose body is only an @mention gets no caption bottom", () => {
    const evs = fightEvents.map((e) => (e.id === 3 ? { ...e, text: "@Bob" } : e));
    assert.ok(!buildMemes({ events: evs, names, moods: MOODS, faces }).some((c) => c.format === "caption" && c.agentId === "a"));
  });

  it("the same seed gives byte-identical cards; seed 0 and undefined agree", () => {
    const sheets = { a: sheetFor("Bob (4 fights).") };
    const a = buildMemes({ events: fightEvents, sheets, names, moods: MOODS, faces, seed: 7 });
    const b = buildMemes({ events: fightEvents, sheets, names, moods: MOODS, faces, seed: 7 });
    assert.deepEqual(a, b);
    assert.deepEqual(
      buildMemes({ events: fightEvents, sheets, names, moods: MOODS, faces }),
      buildMemes({ events: fightEvents, sheets, names, moods: MOODS, faces, seed: 0 }),
    );
  });

  it("agent ids with path or markup characters make safe file names", () => {
    const odd = { "../x<y>": "Odd", b: "Bob" };
    const evs = [ev(1, "../x<y>", "post", null, "hi"), ev(2, "b", "reply", 1, "yo"), ev(3, "../x<y>", "reply", 2, "hmm"), ev(4, "b", "reply", 3, "again"), ev(5, "../x<y>", "reply", 4, "no")];
    const cards = buildMemes({ events: evs, names: odd, moods: MOODS, faces: mkFaces(odd) });
    assert.ok(cards.length > 0);
    for (const c of cards) assert.match(c.file, /^share\/meme-(caption|villain)-[A-Za-z0-9_-]+\.svg$/);
  });

  it("a hostile long reply and emoji name keep the label bounded and valid text", () => {
    const evs = fightEvents.map((e) => (e.id === 3 ? { ...e, text: `@Bob ${"😀 word ".repeat(5000)}` } : e));
    const cards = buildMemes({ events: evs, names: { a: "A".repeat(5000), b: "🦊 Bob" }, moods: MOODS, faces });
    const c = cards.find((x) => x.format === "caption");
    assert.ok([...c.alt].length <= 201);
    assert.ok(c.svg.length < 20000);
    assert.ok(!c.svg.includes("undefined"));
  });
});

describe("memes edge: villain cards", () => {
  const names = { a: "Ann", b: "Bob" };
  const faces = mkFaces(names);
  const villains = (sheet, over = {}) =>
    buildMemes({ events: [], sheets: { a: sheet }, names, moods: MOODS, faces, ...over }).filter((c) => c.format === "villain");

  it("fight-count boundary: 1 fight none, 2 fights a card, 3 fights shows the count", () => {
    assert.equal(villains(sheetFor("Bob (1 fight).")).length, 0);
    const two = villains(sheetFor("Bob (2 fights)."));
    assert.equal(two.length, 1);
    assert.ok(!two[0].bottom.includes("fights)"));
    assert.ok(villains(sheetFor("Bob (3 fights)."))[0].bottom.includes("(3 fights)"));
  });

  it("zero fights and a missing count give no card", () => {
    assert.equal(villains(sheetFor("Bob (0 fights).")).length, 0);
    assert.equal(villains(sheetFor("Bob.")).length, 0);
  });

  it("a huge fight count is kept as a number and the card stays valid", () => {
    const v = villains(sheetFor("Bob (999999999 fights)."));
    assert.equal(v[0].fights, 999999999);
    assert.ok(v[0].svg.endsWith("</svg>\n"));
  });

  it("an enemy not in the roster still gets a card, with no enemy tile", () => {
    const v = villains(sheetFor("Zed (4 fights)."));
    assert.equal(v.length, 1);
    assert.equal(v[0].enemy, "Zed");
  });

  it("regression: enemy names with replacement-pattern characters appear literally in the rivalry line", () => {
    for (const enemy of ["$&", "$'", "$`", "$$", "a$&b"]) {
      const v = villains(sheetFor(`${enemy} (4 fights).`));
      assert.equal(v.length, 1, enemy);
      assert.ok(!v[0].rivalry.includes("{enemy}"), `${enemy}: ${v[0].rivalry}`);
      assert.ok(v[0].rivalry.includes(enemy), `${enemy}: ${v[0].rivalry}`);
    }
  });

  it("regression: agent ids named like Object.prototype members use the default bank instead of throwing", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const { line } = rivalryPick({ id, seed: 1, enemy: "Cy", fights: 2 });
      assert.ok(RIVALRY_LINES.default.some((t) => t.replaceAll("{enemy}", "Cy").replaceAll("{n}", "2") === line), `${id}: ${line}`);
    }
  });

  it("markup in the enemy name is escaped in the svg", () => {
    const v = villains(sheetFor("<b>&x</b> (4 fights)."));
    assert.ok(!v[0].svg.includes("<b>"));
  });

  it("nobody-style enemies give no card, case-insensitively", () => {
    for (const e of ["Nobody (3 fights).", "NO ONE (3 fights).", "n/a (3 fights).", "unknown (3 fights)."]) {
      assert.equal(villains(sheetFor(e)).length, 0, e);
    }
  });

  it("a mutual rivalry yields a single card", () => {
    const sheets = { a: sheetFor("Bob (3 fights)."), b: sheetFor("Ann (3 fights).") };
    const cards = buildMemes({ events: [], sheets, names, moods: MOODS, faces }).filter((c) => c.format === "villain");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].agentId, "a");
  });

  it("a missing, null or non-string sheet gives no card", () => {
    for (const s of [undefined, null, "", 42]) {
      assert.deepEqual(villains(s), [], String(s));
    }
  });
});

describe("memes edge: pure helpers", () => {
  it("parseVillain handles empty, null, huge and unicode input", () => {
    assert.equal(parseVillain(""), null);
    assert.equal(parseVillain(null), null);
    assert.equal(parseVillain(`${"x ".repeat(100000)}`), null);
    assert.deepEqual(parseVillain("Public enemy #1: Zoë 🦊 (5 fights)."), { enemy: "Zoë 🦊", fights: 5 });
  });

  it("parseVillain singular 'fight' parses, and a count with no enemy is null", () => {
    assert.deepEqual(parseVillain("Public enemy #1: Bob (1 fight)."), { enemy: "Bob", fights: 1 });
    assert.equal(parseVillain("Public enemy #1: (3 fights)."), null);
  });

  it("parseVillain stops at the next label", () => {
    assert.deepEqual(parseVillain("Public enemy #1: Bob (2 fights) Ride-or-die: Cy"), { enemy: "Bob", fights: 2 });
  });

  it("ordinal: teens, zero, hundreds", () => {
    const got = [0, 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112, 113].map(ordinal);
    assert.deepEqual(got, ["0TH", "1ST", "2ND", "3RD", "4TH", "11TH", "12TH", "13TH", "21ST", "22ND", "23RD", "101ST", "111TH", "112TH", "113TH"]);
  });

  it("capLabel boundary: 200 kept, 201 cut to 199 + ellipsis, emoji counted whole", () => {
    assert.equal(capLabel("a".repeat(200)), "a".repeat(200));
    assert.equal(capLabel("a".repeat(201)), `${"a".repeat(199)}…`);
    assert.equal([...capLabel("😀".repeat(500))].length, 200);
    assert.equal(capLabel(""), "");
  });

  it("estimateWidth: empty is 0, emoji wider than ASCII, combining marks and ZWJ add nothing", () => {
    assert.equal(estimateWidth("", 50), 0);
    assert.ok(estimateWidth("😀", 50) > estimateWidth("a", 50));
    assert.equal(estimateWidth("é", 50), estimateWidth("e", 50));
    assert.equal(estimateWidth("a‍b", 50), estimateWidth("ab", 50));
  });

  it("fitText: empty and whitespace give no lines, not truncated", () => {
    const opts = { width: 800, maxLines: 2, maxSize: 60, minSize: 30 };
    for (const t of ["", "   ", null, undefined]) {
      assert.deepEqual(fitText(t, opts), { lines: [], size: 60, truncated: false });
    }
  });

  it("fitText: upper-cases by default, keeps case when upper=false", () => {
    const opts = { width: 800, maxLines: 1, maxSize: 40, minSize: 20 };
    assert.deepEqual(fitText("hi", opts).lines, ["HI"]);
    assert.deepEqual(fitText("hi", { ...opts, upper: false }).lines, ["hi"]);
  });

  it("fitText: never exceeds maxLines and truncates with an ellipsis for huge input", () => {
    const r = fitText("word ".repeat(100000), { width: 840, maxLines: 3, maxSize: 72, minSize: 34, maxHeight: 210 });
    assert.ok(r.truncated);
    assert.ok(r.lines.length <= 3);
    assert.ok(r.lines.at(-1).endsWith("…"));
    assert.equal(r.size, 34);
  });

  it("fitText: a single unbroken long word is split by code point and stays within width", () => {
    const r = fitText("W".repeat(300), { width: 400, maxLines: 4, maxSize: 60, minSize: 30 });
    for (const l of r.lines) assert.ok(estimateWidth(l, r.size) <= 400 + 1, l);
  });

  it("fitText: maxHeight smaller than one line still allows one line", () => {
    const r = fitText("hello world foo bar baz", { width: 200, maxLines: 3, maxSize: 40, minSize: 20, maxHeight: 1 });
    assert.equal(r.lines.length, 1);
    assert.ok(r.truncated);
  });

  it("fitText: maxSize equal to minSize is a single size", () => {
    assert.equal(fitText("hi", { width: 800, maxLines: 1, maxSize: 30, minSize: 30 }).size, 30);
  });

  it("rivalryLine: same inputs same line; used set forces distinct lines for repeated calls", () => {
    const args = { id: "aloof", seed: 3, enemy: "Bob", fights: 4 };
    assert.equal(rivalryLine(args), rivalryLine(args));
    const used = new Set();
    const lines = Array.from({ length: 6 }, () => rivalryLine({ ...args, used }));
    assert.equal(new Set(lines).size, 6);
  });

  it("rivalryLine: unknown id uses the default bank; every line is filled", () => {
    const line = rivalryLine({ id: "nobody-here", seed: 1, enemy: "Cy", fights: 9 });
    assert.ok(!line.includes("{"));
    assert.ok(RIVALRY_LINES.default.some((t) => t.replaceAll("{enemy}", "Cy").replaceAll("{n}", "9") === line));
  });

  it("rivalryPick: when every line is used it still returns a line instead of looping", () => {
    const used = new Set();
    for (let i = 0; i < 40; i += 1) rivalryPick({ id: "skeptic", seed: 1, enemy: "Bob", fights: 2, used });
    assert.ok(rivalryPick({ id: "skeptic", seed: 1, enemy: "Bob", fights: 2, used }).line);
  });

  it("SIZE is the square the cards are drawn in", () => {
    const names = { a: "Ann", b: "Bob" };
    const svg = buildMemes({ events: fightEvents, names, moods: MOODS, faces: mkFaces(names) })[0].svg;
    assert.equal(attr(svg, "width"), String(SIZE));
    assert.equal(attr(svg, "height"), String(SIZE));
  });
});
