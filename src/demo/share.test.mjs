// Behavior gaps for the share card renderer: captions that are empty, huge,
// emoji-heavy, right-to-left with bidi controls, or full of control characters;
// the wrap and fit limits; output that stays well-formed SVG with no raw "<"
// or "&" anywhere; byte-for-byte determinism; and a byte bound for hostile input.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_CAPTION, PROJECT_FOOTER, renderShareCard, wrapText, cleanText, clipText, nest } from "./share.mjs";

const WRAP = 22;
const LINE_H = 40;
const FACE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10"/></svg>';
const card = (text, over = {}) => renderShareCard({ agentName: "Ann", text, mood: "hype", round: 3, faceSvg: FACE, ...over });

const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BIDI = /[؜‎‏‪-‮⁦-⁩]/;
const ENTITY_ONLY = /&(?!(?:amp|lt|gt|quot|#39);)/;

const tagsOf = (svg) => svg.match(/<[^>]*>/g) ?? [];
const tspansOf = (svg) => [...svg.matchAll(/<tspan x="(\d+)" y="(\d+)">([^<]*)<\/tspan>/g)].map((m) => ({ x: +m[1], y: +m[2], text: m[3] }));
const attrOf = (svg, name) => svg.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Well-formed, self-contained, inert: the invariants every card must keep whatever the caption. */
function assertValidCard(svg, label = "card") {
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 '), `${label}: root element`);
  assert.ok(svg.endsWith("</svg>\n"), `${label}: ends with the root close tag`);
  assert.doesNotMatch(svg, XML_INVALID, `${label}: XML-invalid character or lone surrogate`);
  assert.doesNotMatch(svg, BIDI, `${label}: bidi control reached the output`);
  assert.doesNotMatch(svg, /<script|<image|<foreignObject|<style|<use|<!--|<!\[CDATA\[|\]\]>|<\?xml/i, `${label}: forbidden construct`);
  // Every "<" starts a tag we wrote: text nodes and attribute values hold no raw "<" or "&".
  for (const m of svg.matchAll(/>([^<]*)</g)) {
    assert.doesNotMatch(m[1], ENTITY_ONLY, `${label}: raw & in text node ${JSON.stringify(m[1].slice(0, 40))}`);
  }
  for (const t of tagsOf(svg)) {
    assert.match(t, /^<\/?[A-Za-z][\w:-]*(?:\s+[A-Za-z][\w:-]*="[^"<]*")*\s*\/?>$/, `${label}: tag not of the form name attr="..."; got ${t.slice(0, 80)}`);
    for (const m of t.matchAll(/="([^"]*)"/g)) assert.doesNotMatch(m[1], ENTITY_ONLY, `${label}: raw & in attribute ${m[1].slice(0, 40)}`);
    assert.doesNotMatch(t.replace(/="[^"]*"/g, '=""'), /\s(?:on[a-z]+|href|xlink:href|src)=/i, `${label}: live attribute in ${t.slice(0, 80)}`);
  }
  // Numeric geometry is always a plain integer: no NaN, undefined, Infinity or float noise.
  for (const t of tagsOf(svg)) {
    for (const m of t.matchAll(/\s(?:x|y|width|height|rx|font-size|stroke-width)="([^"]*)"/g)) assert.match(m[1], /^\d+$/, `${label}: geometry ${m[0]} in ${t.slice(0, 60)}`);
  }
  assert.doesNotMatch(tagsOf(svg).map((t) => t.replace(/="[^"]*"/g, '=""')).join("\n"), /NaN|undefined|Infinity/, `${label}: junk in a tag`);
  // Tag balance: every element that opens closes, in order; exactly one nested face.
  const stack = [];
  for (const [, close, name, self] of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `${label}: close tag ${name} out of order`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], `${label}: unclosed elements`);
  assert.equal((svg.match(/<svg[\s>]/g) ?? []).length, 2, `${label}: root plus one nested face`);
  assert.equal((svg.match(/<\/svg>/g) ?? []).length, 2, `${label}: two svg close tags`);
  // Geometry is consistent: viewBox matches width/height, and each line sits one LINE_H below the last.
  const height = +attrOf(svg, "height");
  assert.equal(attrOf(svg, "viewBox"), `0 0 900 ${height}`, `${label}: viewBox tracks height`);
  const lines = tspansOf(svg);
  lines.forEach((l, i) => {
    assert.equal(l.x, 376, `${label}: line ${i} x`);
    assert.equal(l.y, 96 + i * LINE_H, `${label}: line ${i} y`);
    assert.ok(unescape(l.text).length <= WRAP, `${label}: line ${i} wider than ${WRAP}: ${l.text}`);
    assert.notEqual(l.text, "", `${label}: empty line ${i}`);
  });
  // The name sits below the last line and the footer below the name, all inside the card.
  const nameY = +svg.match(/<text x="376" y="(\d+)" font-family="[^"]*" font-size="24"/)[1];
  const footerY = +svg.match(/<text x="860" y="(\d+)" text-anchor="end"/)[1];
  assert.equal(nameY, 96 + lines.length * LINE_H + 24, `${label}: name y`);
  assert.ok(nameY < footerY && footerY === height - 24, `${label}: name ${nameY} < footer ${footerY} = height ${height} - 24`);
  assert.ok(height >= 420, `${label}: shorter than the face needs`);
  return { height, lines };
}

describe("share: project footer", () => {
  it("carries the repo link and tag at bottom-left, clear of the Personality NFT label and the name", () => {
    assert.match(PROJECT_FOOTER, /github\.com\/brandontomlin2\/near-2026-hackathon/);
    assert.match(PROJECT_FOOTER, /#NEARHackathon/);
    for (const text of ["", "short", "a much longer caption ".repeat(8)]) {
      const svg = card(text);
      const { height } = assertValidCard(svg, "footer");
      const m = svg.match(/<text x="40" y="(\d+)"[^>]*font-size="16"[^>]*>([^<]*)<\/text>/);
      assert.equal(+m[1], height - 24);
      assert.equal(m[2], PROJECT_FOOTER);
      // ~0.62em per char at 16px, from x=40, must end before the right label starts (~x=730).
      assert.ok(40 + PROJECT_FOOTER.length * 16 * 0.62 < 730, "footer clear of the right label");
      assert.ok(svg.includes(">Personality NFT</text>"));
    }
  });
});

describe("share: degenerate captions", () => {
  for (const [label, text] of [["empty string", ""], ["whitespace only", " \t\n\r   "], ["undefined", undefined], ["null", null], ["only control chars", "\u0000\u0001\u001F\u007F\u009F￾"]]) {
    it(`${label} renders a valid card with no lines and the minimum height`, () => {
      const svg = card(text);
      const { height, lines } = assertValidCard(svg, label);
      assert.deepEqual(lines, []);
      assert.equal(height, 420);
      assert.equal(attrOf(svg, "aria-label"), "Ann says: ");
      assert.ok(svg.includes("<text font-family=\"system-ui,Arial,sans-serif\" font-size=\"32\" font-weight=\"700\" fill=\"#1c1c1a\"></text>"), "empty quote element");
      assert.ok(!svg.includes("undefined") && !svg.includes("null"), "no stringified nullish value");
    });
  }

  it("a numeric or string round and mood both render as text and never as raw markup", () => {
    assert.ok(card("x", { round: 7 }).includes(">round 7 · hype</text>"));
    assert.ok(card("x", { round: "07" }).includes(">round 07 · hype</text>"));
    const svg = card("x", { round: '1"><script>', mood: "<b onload=x>&" });
    assertValidCard(svg, "hostile round and mood");
    assert.equal(attrOf(svg, "data-mood"), "&lt;b onload=x&gt;&amp;");
    assert.ok(svg.includes(">round 1&quot;&gt;&lt;script&gt; · &lt;b onload=x&gt;&amp;</text>"));
  });

  it("a non-string caption is stringified, not crashed on", () => {
    assert.ok(card(12345).includes(">12345</tspan>"));
    assert.ok(card({ toString: () => "<obj>" }).includes(">&lt;obj&gt;</tspan>"));
    assert.ok(card(["a", "b"]).includes(">a,b</tspan>"));
  });
});

describe("share: angle brackets and ampersands", () => {
  const hostile = [
    `<script>alert("x")</script>`,
    `"><svg onload=alert(1)>`,
    `' onmouseover='alert(1)' x='`,
    `]]></tspan></text></svg><svg onload=alert(1)>`,
    `<![CDATA[<script>x</script>]]>`,
    `&lt;already&gt; &amp; &#60; &#x3c; &quot;`,
    `Tom & "Jerry" <b>bold</b> it's 5 > 3 && 2 < 4`,
    `<!-- comment --><?xml version="1.0"?>`,
    `<a href="javascript:alert(1)">x</a> <image href="https://evil.example/x.svg"/>`,
  ];
  for (const text of hostile) {
    it(`escapes once and stays inert: ${JSON.stringify(text.slice(0, 32))}`, () => {
      const svg = card(text, { agentName: text, mood: text, round: text });
      assertValidCard(svg, "hostile");
      assert.ok(!svg.includes("alert(1)>") && !svg.includes("<script"), "payload never becomes markup");
      // Each tspan unescapes back to exactly the wrapped line, so escaping happened exactly once.
      const lines = wrapText(cleanText(text));
      assert.deepEqual(tspansOf(svg).map((l) => unescape(l.text)), lines);
      assert.equal(unescape(attrOf(svg, "aria-label")), `${cleanText(text)} says: ${cleanText(text)}`);
      assert.equal(unescape(attrOf(svg, "data-mood")), cleanText(text));
      assert.ok(!/&amp;(?:amp|lt|gt|quot|#39);/.test(svg) || text.includes("&amp;") || text.includes("&lt;") || text.includes("&#"), "no double escaping of our own entities");
    });
  }

  it("an entity in the caption is shown literally (escaped one level, not decoded)", () => {
    const svg = card("&lt;b&gt; &amp;");
    assert.ok(svg.includes(">&amp;lt;b&amp;gt; &amp;amp;</tspan>"));
    assert.ok(!svg.includes("<b>") && !svg.includes(">&lt;b&gt;<"));
  });
});

describe("share: emoji, RTL and control characters", () => {
  const FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // ZWJ sequence, 11 UTF-16 units
  const FLAG = "\u{1F1FA}\u{1F1F8}"; // regional indicator pair
  const TONE = "\u{1F44D}\u{1F3FD}"; // thumbs up + skin tone

  it("emoji-heavy captions keep every code point whole and within the wrap width", () => {
    const text = `${FAMILY} ${FLAG} ${TONE} ${"\u{1F525}".repeat(40)} ${FAMILY.repeat(5)}`;
    const svg = card(text);
    const { lines } = assertValidCard(svg, "emoji");
    assert.ok(lines.length >= 5, `wrapped into ${lines.length} lines`);
    assert.equal(lines.map((l) => l.text).join("").replace(/ /g, ""), text.replace(/ /g, ""), "no emoji lost or changed");
    for (const l of lines) assert.doesNotMatch(l.text, /^‍|‍$/, `line starts or ends with a bare joiner: ${l.text}`);
  });

  it("a long ZWJ family is cut only between code points, never inside a surrogate pair", () => {
    const lines = wrapText(FAMILY.repeat(10));
    assert.ok(lines.length > 1);
    for (const l of lines) assert.doesNotMatch(l, XML_INVALID, l);
    assert.equal(lines.join(""), FAMILY.repeat(10));
  });

  it("right-to-left captions wrap in logical order, keep the script and drop the bidi controls", () => {
    const hebrew = "שלום עולם מה נשמע היום בבוקר הזה";
    const arabic = "مرحبا بالعالم كيف حالك اليوم";
    const svg = card(`${hebrew} ${arabic}`);
    const { lines } = assertValidCard(svg, "rtl");
    assert.equal(lines.map((l) => l.text).join(" "), `${hebrew} ${arabic}`, "words in logical order, none dropped");
    assert.ok(lines.length >= 3);
    for (const mark of ["‮", "‪", "⁦", "⁩", "‏", "‎", "؜"]) {
      const out = card(`a${mark}b ${hebrew}`, { agentName: `N${mark}`, mood: `m${mark}` });
      assertValidCard(out, `bidi ${mark.codePointAt(0).toString(16)}`);
      assert.ok(out.includes(`>a�b</tspan>`) || out.includes(`>a�b `), "the mark is replaced, not deleted, so hidden reordering cannot happen");
      assert.equal(attrOf(out, "data-mood"), "m�");
      assert.ok(out.includes(">N�</text>"));
    }
  });

  it("C0, C1, DEL, noncharacters and lone surrogates are stripped; tab, newline and nbsp collapse to one space", () => {
    const text = "a\u0000b\u0007c\u0008d\u000Be\u000Cf\u001Bg\u001Fh\u007Fi\u0080j\u009Fk￾l￿m\uD800n\uDC00o";
    assert.equal(cleanText(text), "abcdefghijklmno");
    assert.equal(cleanText(" a \t b\n\nc\r\nd e f　g "), "a b c d e f g");
    assert.equal(cleanText("\u{1F525}\u0000\u{1F525}"), "\u{1F525}\u{1F525}", "a valid pair around a NUL survives");
    const svg = card(text, { agentName: `N\u0000a\u0085me`, mood: "h\u0001ype", round: "1￿" });
    assertValidCard(svg, "controls");
    assert.ok(svg.includes(">abcdefghijklmno</tspan>"));
    assert.ok(svg.includes(">round 1 · hype</text>") && svg.includes(">Name</text>"));
  });

  it("zero-width and format characters that are legal XML are kept, so text is not silently rewritten", () => {
    assert.equal(cleanText("a​b‌c­d⁠e"), "a​b‌c­d⁠e");
    assert.equal(cleanText("a﻿b"), "a b", "BOM is whitespace to \\s and collapses like one");
    assert.ok(card("a​b").includes(">a​b</tspan>"));
  });
});

describe("share: wrap and fit limits", () => {
  it("every line fits the width, keeps word order and drops nothing but spaces", () => {
    const text = `${"x".repeat(60)} short words here and a ${"y".repeat(23)} tail ${"\u{1F600}".repeat(15)}`;
    const lines = wrapText(text);
    assert.ok(lines.every((l) => l.length > 0 && l.length <= WRAP), JSON.stringify(lines));
    assert.equal(lines.join("").replace(/ /g, ""), text.replace(/ /g, ""));
    assert.ok(lines.every((l) => l === l.trim()), "no leading or trailing spaces on a line");
  });

  it("exact-fit boundaries: a line may be exactly the width, one more unit wraps", () => {
    assert.deepEqual(wrapText("a".repeat(22)), ["a".repeat(22)]);
    assert.deepEqual(wrapText("a".repeat(23)), ["a".repeat(22), "a"]);
    assert.deepEqual(wrapText(`${"a".repeat(11)} ${"b".repeat(10)}`), [`${"a".repeat(11)} ${"b".repeat(10)}`]);
    assert.deepEqual(wrapText(`${"a".repeat(11)} ${"b".repeat(11)}`), ["a".repeat(11), "b".repeat(11)]);
    assert.deepEqual(wrapText(`${"a".repeat(22)} ${"b".repeat(22)}`), ["a".repeat(22), "b".repeat(22)]);
    assert.deepEqual(wrapText("ab cd", 2), ["ab", "cd"]);
    assert.deepEqual(wrapText("abc", 1), ["a", "b", "c"]);
  });

  it("a width smaller than one code point still emits one code point per line instead of looping", () => {
    assert.deepEqual(wrapText("\u{1F600}\u{1F600}", 1), ["\u{1F600}", "\u{1F600}"]);
    assert.deepEqual(wrapText("ab\u{1F600}c", 1), ["a", "b", "\u{1F600}", "c"]);
    assert.deepEqual(wrapText("\u{1F600}".repeat(3), 3), ["\u{1F600}", "\u{1F600}", "\u{1F600}"], "an odd width never splits a pair");
  });

  it("full-width and combining characters count in UTF-16 units, so lines stay within the width", () => {
    for (const lines of [wrapText("漢字".repeat(30)), wrapText("é".repeat(30)), wrapText("ｗｉｄｅ ".repeat(12))]) {
      assert.ok(lines.every((l) => l.length <= WRAP), JSON.stringify(lines));
    }
  });

  it("an invalid width is rejected rather than hanging or silently not wrapping", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, 1.5, "22", null]) {
      assert.throws(() => wrapText("a b c", bad), RangeError, `width ${String(bad)}`);
    }
    assert.deepEqual(wrapText("a b c", undefined), ["a b c"], "undefined means the default");
  });

  it("the card grows one line height per wrapped line and the layout stays consistent under the cap", () => {
    let prev = 0;
    for (const n of [1, 2, 3, 6, 10, 20]) {
      const svg = card(Array.from({ length: n }, (_, i) => `l${i}`.padEnd(WRAP, "x")).join(" "));
      const { height, lines } = assertValidCard(svg, `${n} lines`);
      assert.equal(lines.length, n);
      assert.ok(height >= prev, `height never shrinks: ${n} lines ${height} >= ${prev}`);
      assert.equal(height, Math.max(420, n * LINE_H + 230), "the face sets the floor, then one LINE_H per line");
      prev = height;
    }
  });
});

describe("share: bounded output for huge input", () => {
  // With the tiny FACE above a capped caption is a few KB; the worst packing of
  // 500 code points (eleven-letter words, one per line) is about 1900px tall.
  const BYTE_BOUND = 32_000;
  const HEIGHT_BOUND = 2_500;
  const huge = {
    "one million letters, one word": "A".repeat(1_000_000),
    "one million letters, short words": "ab ".repeat(333_334),
    "two hundred thousand emoji": "\u{1F600}".repeat(200_000),
    "half a million angle brackets": "<&>".repeat(170_000),
    "a long run of single letters": "a ".repeat(500_000),
    "controls and bidi marks between letters": "x\u0000‮⁦".repeat(250_000),
  };

  for (const [label, text] of Object.entries(huge)) {
    it(`${label}: bytes and height stay bounded, the card stays valid and renders fast`, () => {
      const started = process.cpuUsage(); // CPU time, so machine load cannot fail the bound
      const svg = card(text, { agentName: "Ann" });
      const cpu = process.cpuUsage(started);
      const ms = (cpu.user + cpu.system) / 1000;
      const { height, lines } = assertValidCard(svg, label);
      assert.ok(Buffer.byteLength(svg) < BYTE_BOUND, `${label}: ${Buffer.byteLength(svg)} bytes`);
      assert.ok(height < HEIGHT_BOUND, `${label}: ${height}px tall`);
      assert.ok(lines.length > 0 && lines.length <= MAX_CAPTION, `${label}: ${lines.length} lines`);
      assert.ok(lines.at(-1).text.endsWith("…"), `${label}: truncation is visible`);
      assert.ok([...unescape(attrOf(svg, "aria-label"))].length <= MAX_CAPTION + "Ann says: …".length, `${label}: aria-label is capped`);
      assert.ok(ms < 2000, `${label}: took ${ms}ms`);
    });
  }

  it("a caption at the channel limit is shown in full; one code point more is cut with an ellipsis", () => {
    const atLimit = Array.from({ length: MAX_CAPTION }, (_, i) => (i % 9 === 8 ? " " : "k")).join("");
    assert.equal(atLimit.length, MAX_CAPTION);
    assert.equal(cleanText(atLimit), atLimit);
    const full = card(atLimit);
    const { lines } = assertValidCard(full, "at limit");
    assert.equal(lines.map((l) => l.text).join(" "), atLimit);
    assert.ok(!full.includes("…"));
    assert.equal(unescape(attrOf(full, "aria-label")), `Ann says: ${atLimit}`);

    const emoji = "\u{1F600}".repeat(MAX_CAPTION);
    assert.ok(!card(emoji).includes("…"), "the cap counts code points, so a 500-emoji caption is not cut");
    const over = card(`${emoji}\u{1F600}`);
    const shown = tspansOf(over).map((l) => l.text).join("");
    assert.equal(shown, `${"\u{1F600}".repeat(MAX_CAPTION)}…`);
    assert.equal(unescape(attrOf(over, "aria-label")), `Ann says: ${"\u{1F600}".repeat(MAX_CAPTION)}…`);
    assert.doesNotMatch(over, XML_INVALID, "the cut never lands inside a surrogate pair");
  });

  it("clipText counts code points, keeps short text as is, and glues the ellipsis to the last word", () => {
    assert.equal(clipText("short"), "short");
    assert.equal(clipText("a".repeat(MAX_CAPTION)), "a".repeat(MAX_CAPTION));
    assert.equal(clipText("a".repeat(MAX_CAPTION + 1)), `${"a".repeat(MAX_CAPTION)}…`);
    assert.equal(clipText("\u{1F600}".repeat(3), 2), "\u{1F600}\u{1F600}…");
    assert.equal(clipText("abc def", 4), "abc…", "a cut that lands after a space does not leave the ellipsis dangling");
    const svg = card(`${"a".repeat(MAX_CAPTION - 1)} b`);
    assert.equal(tspansOf(svg).at(-1).text, `${"a".repeat(MAX_CAPTION - 1 - 22 * 22)}…`);
  });

  it("the cap applies after cleaning, so control characters and extra spaces do not eat the budget", () => {
    const padded = `${"\u0000".repeat(10_000)}${"w ".repeat(10)}${"\t".repeat(10_000)}end`;
    const svg = card(padded);
    assert.equal(tspansOf(svg).map((l) => l.text).join(" "), "w w w w w w w w w w end");
    assert.ok(!svg.includes("…"));
  });
});

describe("share: determinism", () => {
  it("the same input gives the same bytes, independent of call order or other calls", () => {
    const a = card("first \u{1F600} <x> & y");
    const b = card("second");
    assert.equal(card("first \u{1F600} <x> & y"), a);
    assert.equal(card("second"), b);
    assert.notEqual(a, b);
    assert.equal(card("A".repeat(100_000)), card("A".repeat(100_000)), "the truncated path is deterministic too");
    assert.ok(!/\d{13}|Date|Math\.random/.test(a), "no clock or random value in the output");
  });

  it("the pinned card for a fixed input has not changed", () => {
    const svg = renderShareCard({ agentName: "Pinned <&> name", text: "gas is free? \"I\" doubt it & so should you \u{1F680} <script>", mood: "shade", round: 2, faceSvg: FACE });
    assertValidCard(svg, "pinned");
    const sha = createHash("sha256").update(svg).digest("hex");
    assert.equal(sha, "0be03f6b1a706be325b08f2da2f288bca5d7419fe5cb9ea5395f832e3d4fa243", "share card layout changed: re-pin if intended");
  });
});

describe("share: nesting the face", () => {
  it("an XML prolog and the face's own placement are dropped, so the card has one root and one positioned face", () => {
    const face = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" x="1" y="2" width="256" height="256" viewBox="0 0 256 256"><g/></svg>';
    const svg = card("hi", { faceSvg: face });
    assertValidCard(svg, "prolog face");
    assert.ok(svg.includes('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" x="40" y="60" width="300" height="300"><g/></svg>'));
    assert.equal(nest(face, 0, 0, 1), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" x="0" y="0" width="1" height="1"><g/></svg>');
  });

  it("the face is placed by substitution only; its text is never escaped or rewrapped", () => {
    const face = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-width="9" data-x="1 > 0"><rect/></svg>';
    const svg = card("hi", { faceSvg: face });
    assert.ok(svg.includes('data-width="9" data-x="1 > 0" x="40" y="60" width="300" height="300">'), "attributes merely named like x/width survive");
    assert.equal(nest(face, 1, 2, 3), nest(face, 1, 2, 3));
  });
});
