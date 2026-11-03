import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildMemes, fitText, estimateWidth, capLabel, ordinal, parseVillain, SIZE } from "./memes.mjs";
import { cleanText } from "./share.mjs";
import { runDemo } from "./pipeline.mjs";
import { getStyle } from "../art/styles/index.mjs";
import { AGENTS } from "../traits/agents.mjs";

const MOODS = ["neutral", "hype", "shade", "shook"];
const names = { a: "Ann", b: "Bob" };
const face = (id, mood) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10" data-mood="${mood}"><rect width="10" height="10"/></svg>`;
const faces = Object.fromEntries(Object.keys(names).map((id) => [id, Object.fromEntries(MOODS.map((m) => [m, face(id, m)]))]));
const ev = (id, round, agentId, kind, replyTo, text) => ({ id, round, turn: 1, agentId, kind, replyTo, text });
const SHEET = "Who I am: Ann, the villain. Public enemy #1: Bob (2 fights). Ride-or-die: no one yet. Rivalry arc: Bob and I are not done yet. Scorecard: Bob: 2 fights. Receipts: 1 post.";
const NOBODY = "Who I am: Ann, calm. Public enemy #1: nobody yet, the lore is still loading. Rivalry arc: Nobody has picked a side yet. Receipts: 1 post.";

const events = [
  ev(1, 1, "a", "post", null, "gas is free? I doubt it."),
  ev(2, 1, "b", "reply", 1, "@Ann love that for us!"),
  ev(3, 2, "a", "reply", 2, "@Bob fine. whatever."),
  ev(4, 2, "b", "reply", 3, "@Ann wait what?"),
  ev(5, 3, "a", "post", null, "send it \u{1F680}"),
];
const build = (over = {}) => buildMemes({ events, sheets: { a: SHEET, b: NOBODY }, names, moods: MOODS, faces, ...over });
const by = (cards, format, agentId) => cards.find((c) => c.format === format && c.agentId === agentId);

describe("memes: formats come from data", () => {
  it("caption: ordinal is the computed reply count and the bottom is the target's own line", () => {
    const c = by(build(), "caption", "a");
    assert.equal(c.replierId, "b");
    assert.equal(c.count, 2);
    assert.equal(c.top, "When Bob replies again");
    assert.equal(c.bottom, "fine. whatever.");
    assert.equal(c.mood, "shade");
    assert.ok(c.svg.includes("WHEN BOB"));
    assert.ok(c.svg.includes("REPLIES AGAIN"));
    assert.equal(c.file, "share/meme-caption-a.svg");
    assert.equal(by(build(), "caption", "b"), undefined, "Bob has one incoming reply only");
  });

  it("caption: 3+ replies use the ordinal, and the latest non-neutral answer is preferred", () => {
    const more = [
      ev(1, 1, "a", "post", null, "start"),
      ev(2, 1, "b", "reply", 1, "@Ann one"),
      ev(3, 1, "a", "reply", 2, "@Bob I doubt it."),
      ev(4, 2, "b", "reply", 3, "@Ann two"),
      ev(5, 2, "a", "reply", 4, "@Bob plain words"),
      ev(6, 3, "b", "reply", 5, "@Ann three"),
    ];
    const c = by(build({ events: more }), "caption", "a");
    assert.equal(c.top, "When Bob replies for the 3RD time");
    assert.equal(c.bottom, "I doubt it.", "latest non-neutral, not the latest");
    assert.equal(c.mood, "shade");
    const flat = more.map((e) => (e.id === 3 ? { ...e, text: "@Bob plain too" } : e));
    assert.equal(by(build({ events: flat }), "caption", "a").bottom, "plain words");
    assert.equal(by(build({ events: flat }), "caption", "a").mood, "neutral");
  });

  it("caption: needs the target to have answered that replier", () => {
    const unanswered = [
      ev(1, 1, "a", "post", null, "hi"),
      ev(2, 1, "b", "reply", 1, "@Ann x"),
      ev(3, 2, "b", "reply", 1, "@Ann y"),
    ];
    assert.equal(build({ events: unanswered }).filter((c) => c.format === "caption").length, 0);
  });

  it("caption: ties go to the earlier agent in names order", () => {
    const three = { a: "Ann", b: "Bob", c: "Cy" };
    const f = Object.fromEntries(Object.keys(three).map((id) => [id, faces.a]));
    const evs = [
      ev(1, 1, "a", "post", null, "start"),
      ev(2, 1, "c", "reply", 1, "@Ann c1"), ev(3, 1, "b", "reply", 1, "@Ann b1"),
      ev(4, 2, "c", "reply", 1, "@Ann c2"), ev(5, 2, "b", "reply", 1, "@Ann b2"),
      ev(6, 2, "a", "reply", 5, "@Bob fine"), ev(7, 2, "a", "reply", 4, "@Cy fine"),
    ];
    const c = by(buildMemes({ events: evs, sheets: {}, names: three, moods: MOODS, faces: f }), "caption", "a");
    assert.equal(c.replierId, "b");
  });

  it("ordinals", () => {
    assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal),
      ["1ST", "2ND", "3RD", "4TH", "11TH", "12TH", "13TH", "21ST", "22ND", "101ST", "111TH"]);
  });

  it("villain: enemy, fight count and rivalry come from the sheet", () => {
    const c = by(build(), "villain", "a");
    assert.equal(c.enemy, "Bob");
    assert.equal(c.fights, 2);
    assert.equal(c.top, "Ann's villain arc");
    assert.equal(c.bottom, "Public enemy #1: Bob", "fight count hidden below 3");
    assert.equal(c.rivalry, "Bob and I are not done yet.");
    assert.ok(c.svg.includes("ANN&#39;S"));
    assert.ok(c.svg.includes("Bob and I are not done yet."));
    assert.equal(c.mood, "shade");
    assert.ok(c.svg.includes('data-mood="shade"') && !c.svg.includes('data-mood="hype"'), "enemy face is nested in shade");
  });

  it("villain: shows the fight count from 3 fights", () => {
    const c = by(build({ sheets: { a: SHEET.replace("(2 fights)", "(3 fights)"), b: NOBODY } }), "villain", "a");
    assert.equal(c.bottom, "Public enemy #1: Bob (3 fights)");
  });

  it("villain: a mirrored rivalry gets one card (fights, then replies, then agent order)", () => {
    const sheetB = (n) => `Who I am: Bob, x. Public enemy #1: Ann (${n} fights). Rivalry arc: Ann and I. Receipts: 1 post.`;
    const sheetA = (n) => `Who I am: Ann, x. Public enemy #1: Bob (${n} fights). Rivalry arc: Bob and I. Receipts: 1 post.`;
    const villains = (sheets, evs = events) => build({ sheets, events: evs }).filter((c) => c.format === "villain").map((c) => c.agentId);
    assert.deepEqual(villains({ a: sheetA(1), b: sheetB(4) }), ["b"]);
    assert.deepEqual(villains({ a: sheetA(4), b: sheetB(1) }), ["a"]);
    // equal fights: Bob sent 2 replies to Ann, Ann sent 1 to Bob
    assert.deepEqual(villains({ a: sheetA(2), b: sheetB(2) }), ["b"]);
    // equal fights and replies: the earlier agent
    assert.deepEqual(villains({ a: sheetA(2), b: sheetB(2) }, []), ["a"]);
    // a one-sided enemy still gets its card
    assert.deepEqual(villains({ a: sheetA(2), b: NOBODY }), ["a"]);
  });

  it("capLabel caps at 200 code points with an ellipsis", () => {
    assert.equal(capLabel("short"), "short");
    const capped = capLabel("\u{1F525}".repeat(500));
    assert.equal([...capped].length, 200);
    assert.ok(capped.endsWith("…"));
    const c = by(build({ names: { a: "x".repeat(400), b: "Bob" } }), "caption", "a");
    assert.ok([...c.alt].length <= 200);
    assert.ok(c.svg.includes(`aria-label="${"x".repeat(5)}`));
    assert.ok([...c.svg.match(/aria-label="([^"]*)"/)[1]].length <= 200);
    assert.ok([...c.svg.match(/<title>([^<]*)<\/title>/)[1]].length <= 200);
  });

  it("parseVillain handles singular, no count, missing and unparseable lines", () => {
    assert.deepEqual(parseVillain("Public enemy #1: Zed (1 fight). Rivalry arc: x."), { enemy: "Zed", fights: 1, rivalry: "x." });
    assert.deepEqual(parseVillain("Public enemy #1: Zed. Ride-or-die: n."), { enemy: "Zed", fights: null, rivalry: "" });
    for (const s of ["", undefined, "no enemy line", "Public enemy #1: nobody yet.", "Public enemy #1: No one", "Public enemy #1: ", "Public enemy #1: (3 fights)"]) {
      assert.equal(parseVillain(s), null, String(s));
    }
  });
});

describe("memes: skips", () => {
  it("no public enemy: no villain card", () => {
    assert.equal(build({ sheets: { a: NOBODY, b: NOBODY } }).filter((c) => c.format === "villain").length, 0);
    assert.equal(build({ sheets: {} }).filter((c) => c.format === "villain").length, 0);
  });
  it("no reply pairs (or one reply only): no caption", () => {
    assert.equal(build({ events: events.filter((e) => e.kind === "post") }).filter((c) => c.format === "caption").length, 0);
    assert.equal(build({ events: events.slice(0, 2) }).filter((c) => c.format === "caption").length, 0);
  });
  it("an agent without faces is skipped", () => {
    assert.ok(build({ faces: { a: faces.a } }).every((c) => c.agentId === "a"));
  });
});

describe("memes: fit", () => {
  const cases = {
    "500 chars": "lorem ipsum dolor sit amet ".repeat(20).slice(0, 500),
    "200-char word": "x".repeat(200),
    "emoji spam": "\u{1F525}".repeat(150),
    "wide chars": "漢字".repeat(100),
    "zwj emoji": "\u{1F468}‍\u{1F469}‍\u{1F467}".repeat(40),
    "mixed": `a ${"W".repeat(90)} \u{1F480} ${"word ".repeat(60)}`,
  };
  for (const [label, text] of Object.entries(cases)) {
    for (const opts of [
      { width: 840, maxLines: 2, maxSize: 84, minSize: 40, maxHeight: 190 },
      { width: 840, maxLines: 3, maxSize: 72, minSize: 34, maxHeight: 210 },
      { width: 744, maxLines: 4, maxSize: 40, minSize: 20, maxHeight: 150, em: 0.62, upper: false },
      { width: 400, maxLines: 1, maxSize: 26, minSize: 16, em: 0.62, upper: false },
    ]) {
      it(`${label}, ${opts.maxLines} lines`, () => {
        const r = fitText(text, opts);
        assert.ok(r.lines.length >= 1);
        assert.ok(r.lines.length <= opts.maxLines);
        assert.ok(r.size >= opts.minSize && r.size <= opts.maxSize);
        if (opts.maxHeight) assert.ok(r.lines.length * r.size * 1.08 <= opts.maxHeight + r.size * 1.08);
        for (const line of r.lines) {
          assert.ok(estimateWidth(line, r.size, opts.em) <= opts.width, `"${line}" too wide`);
        }
      });
    }
  }
  it("short text keeps the biggest size, long text truncates with an ellipsis", () => {
    const short = fitText("hi", { width: 840, maxLines: 2, maxSize: 84, minSize: 40 });
    assert.equal(short.size, 84);
    assert.equal(short.truncated, false);
    const long = fitText("word ".repeat(200), { width: 840, maxLines: 2, maxSize: 84, minSize: 40 });
    assert.equal(long.size, 40);
    assert.equal(long.truncated, true);
    assert.ok(long.lines.at(-1).endsWith("…"));
  });
});

describe("memes: hostile input", () => {
  const nasty = `<script>alert("x")</script> ]]> 'q' & </svg> \u0000\u0008\u000B\u000C\u000E\u001F￾\uD800 ok \u{1F525} café`;
  const hostileNames = { a: nasty, b: `<b onload="x">&'` };
  const hostileEvents = [
    ev(1, 1, "a", "post", null, nasty),
    ev(2, 1, "b", "reply", 1, nasty),
    ev(3, 2, "a", "reply", 2, nasty),
    ev(4, 2, "b", "reply", 3, nasty),
    ev(5, 3, "a", "post", null, `${nasty} again?`),
  ];
  const hostileSheet = `Who I am: ${nasty}, x. Public enemy #1: ${hostileNames.b} (3 fights). Rivalry arc: ${nasty}. Scorecard: x.`;
  const cards = buildMemes({ events: hostileEvents, sheets: { a: hostileSheet, b: hostileSheet }, names: hostileNames, moods: MOODS, faces });

  it("emits all formats", () => {
    assert.deepEqual([...new Set(cards.map((c) => c.format))], ["caption", "villain"]);
  });

  for (const format of ["caption", "villain"]) {
    it(`${format}: escaped, well formed, no refs`, () => {
      for (const c of cards.filter((x) => x.format === format)) {
        const svg = c.svg;
        assert.ok(!/<script/i.test(svg));
        assert.ok(!/href=|<image|<foreignObject|<b /i.test(svg));
        assert.ok(!svg.includes("]]>"));
        assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(svg));
        assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(svg));
        assert.ok(svg.includes("&lt;script&gt;") || svg.includes("&lt;SCRIPT&gt;"));
        assert.ok(svg.includes("\u{1F525}") || svg.includes("café") || svg.includes("CAFÉ"));
        // Text nodes and attribute values hold no raw < or & (only entities).
        for (const m of svg.matchAll(/>([^<]*)</g)) assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(m[1]), m[1]);
        for (const m of svg.matchAll(/="([^"]*)"/g)) assert.ok(!/&(?!(amp|lt|gt|quot|#39);)/.test(m[1]) && !m[1].includes("<"), m[1]);
        // Tag balance: every non-self-closing element opens and closes.
        const tags = [...svg.matchAll(/<(\/?)([a-zA-Z]+)\b[^>]*?(\/?)>/g)];
        const stack = [];
        for (const [, close, tag, self] of tags) {
          if (self) continue;
          if (close) assert.equal(stack.pop(), tag);
          else stack.push(tag);
        }
        assert.deepEqual(stack, []);
        assert.ok(svg.indexOf("</svg>") === svg.lastIndexOf("</svg>") || svg.split("</svg>").length === 1 + svg.split("<svg").length - 1);
        assert.ok(!c.alt.includes("\u0000"));
      }
    });
  }

  it("cleanText strips XML-invalid characters but keeps emoji and non-ASCII", () => {
    assert.equal(cleanText("a\u0000b\u000Bc￾d\uD800e \u{1F525} é中"), "abcde \u{1F525} é中");
  });
});

describe("memes: determinism and styles", () => {
  it("two calls give identical strings", () => {
    assert.deepEqual(build(), build());
  });
  it("works with neutral only", () => {
    const cards = build({ moods: ["neutral"], faces: Object.fromEntries(Object.keys(names).map((id) => [id, { neutral: face(id, "neutral") }])) });
    assert.deepEqual(cards.map((c) => c.format), ["caption", "villain"]);
    assert.ok(cards.every((c) => c.mood === "neutral"));
  });
});

describe("memes: default demo run", () => {
  let dir;
  let result;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "memes-test-"));
    result = await runDemo({ outDir: dir });
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the pinned meme pack, listed in manifest.memes and manifest.files", () => {
    const pins = JSON.parse(fs.readFileSync(new URL("./golden/memes.sha256.json", import.meta.url), "utf8"));
    assert.deepEqual(result.manifest.memes.map((m) => m.file).sort(), Object.keys(pins));
    for (const [file, sha] of Object.entries(pins)) {
      assert.ok(result.manifest.files.includes(file));
      assert.equal(createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex"), sha, `${file} changed: re-pin if intended`);
    }
  });

  it("is data driven end to end: 2 captions and 3 villains, one card or more per agent", () => {
    const count = (f) => result.manifest.memes.filter((m) => m.format === f).length;
    assert.deepEqual([count("caption"), count("villain")], [2, 3]);
    assert.deepEqual([...new Set(result.manifest.memes.map((m) => m.agentId))].sort(), AGENTS.map((a) => a.id).sort());
    const events = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8")).events;
    const skeptic = fs.readFileSync(path.join(dir, "share/meme-caption-skeptic.svg"), "utf8");
    const n = events.filter((e) => e.kind === "reply" && e.agentId === "chaotic" && events.find((x) => x.id === e.replyTo)?.agentId === "skeptic").length;
    assert.ok(skeptic.includes(`FOR THE ${ordinal(n)} TIME`));
  });

  it("the page shows the Meme pack above the share cards and stays small", () => {
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.ok(html.indexOf("<h2>Meme pack</h2>") > 0);
    assert.ok(html.indexOf("<h2>Meme pack</h2>") < html.indexOf("<h2>Share cards</h2>"));
    for (const m of result.manifest.memes) assert.ok(html.includes(`<img src="${m.file}"`));
    assert.ok(Buffer.byteLength(html) < 100_000);
  });

  it("works for the default style (neutral only)", async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "memes-test-"));
    try {
      const r = await runDemo({ outDir: d2, style: "default" });
      assert.equal(r.manifest.memes.length, 5);
      assert.ok(r.manifest.memes.every((m) => m.mood === "neutral"));
    } finally {
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});

it("hostile text is bounded: 10k unbreakable and bidi/control strings render fast", () => {
  const started = Date.now();
  for (const text of ["A".repeat(10_000), "😀".repeat(10_000), "‮⁦\u0000\u0007​".repeat(2_000) + "x", ("word ".repeat(5000))]) {
    const fit = fitText(text, { width: 840, maxLines: 3, maxSize: 72, minSize: 34, maxHeight: 210 });
    assert.ok(fit.lines.length <= 3);
    assert.ok(fit.lines.join("").length < 500);
  }
  const long = "B".repeat(10_000);
  const names = { a: "Alpha", b: "Beta" };
  const sheet = (n) => `Who I am: x. Public enemy #1: ${n} (3 fights). Rivalry arc: ${long}`;
  const events = [
    { id: 1, round: 1, agentId: "a", kind: "post", replyTo: null, text: "hi" },
    { id: 2, round: 1, agentId: "b", kind: "reply", replyTo: 1, text: long },
    { id: 3, round: 2, agentId: "b", kind: "reply", replyTo: 1, text: "x" },
    { id: 4, round: 2, agentId: "a", kind: "reply", replyTo: 2, text: "‮\u0000" + long },
  ];
  const face = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
  const faces = { a: { neutral: face, shade: face }, b: { neutral: face, shade: face } };
  const out = buildMemes({ events, sheets: { a: sheet("Beta"), b: sheet(long) }, names, moods: ["neutral", "shade"], faces });
  assert.ok(out.length > 0);
  for (const m of out) {
    assert.ok(m.svg.length < 20_000);
    assert.doesNotMatch(m.svg, /[\u0000-\u0008\u202a-\u202e\u2066-\u2069]/);
  }
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});
