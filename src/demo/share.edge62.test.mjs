import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderShareCard, cleanText, clipText, wrapText, nest, MAX_CAPTION } from "./share.mjs";

const FACE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
const card = (over = {}) => ({ agentName: "Ann", text: "hello world", mood: "hype", round: 1, faceSvg: FACE, ...over });
const LEAK = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]/;
const attr = (svg, name) => new RegExp(` ${name}="([^"]*)"`).exec(svg)?.[1];
const tspanTexts = (svg) => [...svg.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]);
const assertWellFormed = (svg, label = "card") => {
  assert.ok(svg.startsWith("<svg "), label);
  assert.ok(svg.trimEnd().endsWith("</svg>"), label);
  assert.equal(svg.split("<svg ").length - 1, 2, `${label}: card root plus exactly one nested face`);
  assert.ok(!LEAK.test(svg), `${label} leaks a placeholder`);
  assert.equal(svg, svg.toWellFormed(), `${label} has a lone surrogate`);
};

describe("share edge62: invalid input is a clear error", () => {
  it("no card, a null card or a non-object card throws a TypeError naming renderShareCard", () => {
    for (const bad of [undefined, null, "text", 5]) {
      assert.throws(() => renderShareCard(bad), (e) => e instanceof TypeError && /renderShareCard: card must be an object/.test(e.message), String(bad));
    }
  });

  it("a card without face art throws a TypeError naming faceSvg instead of a 'trim' crash", () => {
    for (const faceSvg of [undefined, null, 5, {}]) {
      assert.throws(() => renderShareCard(card({ faceSvg })), (e) => e instanceof TypeError && /faceSvg must be an SVG string/.test(e.message), String(faceSvg));
    }
    assert.throws(() => nest(undefined, 0, 0, 10), /faceSvg must be an SVG string/);
  });

  it("an empty-string face is accepted and still gives a closed card", () => {
    const svg = renderShareCard(card({ faceSvg: "" }));
    assert.ok(svg.startsWith("<svg ") && svg.trimEnd().endsWith("</svg>"));
    assert.ok(!LEAK.test(svg));
  });
});

describe("share edge62: names", () => {
  it("exactly the fields given: an empty-string name, text and mood still give a valid single-root card", () => {
    const svg = renderShareCard(card({ agentName: "", text: "", mood: "" }));
    assertWellFormed(svg);
    assert.equal(attr(svg, "data-mood"), "");
    assert.deepEqual(tspanTexts(svg), []);
  });

  it("two cards for agents with the same name both show the shared name and keep their own caption", () => {
    const a = renderShareCard(card({ agentName: "Sam", text: "one" }));
    const b = renderShareCard(card({ agentName: "Sam", text: "two" }));
    assert.notEqual(a, b);
    assert.ok(a.includes(">Sam</text>") && b.includes(">Sam</text>"));
    assert.deepEqual(tspanTexts(a), ["one"]);
    assert.deepEqual(tspanTexts(b), ["two"]);
    assert.equal(attr(a, "height"), attr(b, "height"));
  });

  it("combining marks, ZWJ families, RTL and CJK in the name stay whole in the label and the name line", () => {
    const names = [
      "é́́ Zalgò́̂",
      "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}",
      "שלום مرحبا",
      "日本語の名前",
    ];
    for (const agentName of names) {
      const svg = renderShareCard(card({ agentName }));
      assertWellFormed(svg, agentName);
      assert.ok(svg.includes(`>${agentName}</text>`), "name line shows the name verbatim");
      assert.ok(attr(svg, "aria-label").startsWith(`${agentName} says: `));
    }
  });

  it("a bidi override in the name is replaced, so it cannot reorder the rest of the card", () => {
    const svg = renderShareCard(card({ agentName: "Ann‮evil" }));
    assert.ok(!/[‪-‮⁦-⁩]/.test(svg));
    assertWellFormed(svg);
  });

  it("a 10k-character name is not truncated by the card, escapes markup, and does not change the card height", () => {
    const short = renderShareCard(card());
    const long = renderShareCard(card({ agentName: `<b>${"N".repeat(10000)}</b>` }));
    assertWellFormed(long);
    assert.ok(!long.includes("<b>"));
    assert.equal(attr(long, "height"), attr(short, "height"));
    assert.ok(long.includes("&lt;b&gt;NNN"));
  });

  it("markup, quotes and entities in name and mood are escaped in text and in attributes", () => {
    const evil = `"><script>alert(1)</script> &amp; 'x'`;
    const svg = renderShareCard(card({ agentName: evil, mood: evil, round: evil }));
    assertWellFormed(svg);
    assert.ok(!svg.includes("<script"));
    assert.ok(!svg.includes(`"><`.concat("script")));
    assert.ok(svg.includes("&amp;amp;"), "an existing entity is shown literally, escaped once");
  });
});

describe("share edge62: lines", () => {
  it("a 10k-character caption of words is clipped to the cap, wrapped, and bounded in size", () => {
    const svg = renderShareCard(card({ text: "lorem ".repeat(2000) }));
    assertWellFormed(svg);
    const shown = tspanTexts(svg).join(" ");
    assert.ok([...shown].length <= MAX_CAPTION + 1);
    assert.ok(shown.endsWith("…"));
    assert.ok(svg.length < 12000);
    assert.ok(Number(attr(svg, "height")) < 1500);
  });

  it("a 10k-character unbroken word is split into lines no wider than the wrap and bounded", () => {
    const svg = renderShareCard(card({ text: "W".repeat(10000) }));
    assertWellFormed(svg);
    const lines = tspanTexts(svg);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(l.length <= 22, l);
    assert.ok(svg.length < 12000);
  });

  it("10k emoji with ZWJ joiners never leave a lone surrogate or an empty tspan", () => {
    const svg = renderShareCard(card({ text: "\u{1F468}‍\u{1F469}‍\u{1F467} ".repeat(3000) }));
    assertWellFormed(svg);
    for (const l of tspanTexts(svg)) assert.ok(l.length > 0);
  });

  it("combining-mark text wraps with every mark still attached to some line, in logical order", () => {
    const word = "é̂̃";
    const text = Array(30).fill(word).join(" ");
    const svg = renderShareCard(card({ text }));
    assertWellFormed(svg);
    assert.equal(tspanTexts(svg).join(" "), text);
  });

  it("mixed RTL and LTR words keep their logical order across the wrap", () => {
    const text = "hello שלום world مرحبا again שלום friend مرحبا end";
    const svg = renderShareCard(card({ text }));
    assertWellFormed(svg);
    assert.equal(tspanTexts(svg).join(" "), text);
  });

  it("numeric and boolean fields print as their text, objects print empty rather than [object Object]", () => {
    const svg = renderShareCard(card({ text: 12345, round: 7, mood: true }));
    assert.ok(svg.includes(">12345</tspan>"));
    assert.ok(svg.includes("round 7 · true"));
    assert.equal(cleanText(undefined), "");
    assert.equal(cleanText(null), "");
  });
});

describe("share edge62: determinism and helpers", () => {
  it("the same unicode card renders to identical bytes every time", () => {
    const c = card({ agentName: "שלום \u{1F680}", text: "é \u{1F468}‍\u{1F469} <&> ".repeat(20), round: 3 });
    const first = renderShareCard(c);
    for (let i = 0; i < 3; i += 1) assert.equal(renderShareCard({ ...c }), first);
  });

  it("rendering does not mutate the card object", () => {
    const c = Object.freeze(card({ text: "x".repeat(1000) }));
    renderShareCard(c);
    assert.equal(c.text.length, 1000);
  });

  it("clipText leaves a short string untouched and cuts a long unicode string on a code point", () => {
    assert.equal(clipText("short"), "short");
    const cut = clipText("\u{1F680}".repeat(MAX_CAPTION + 5));
    assert.equal([...cut].length, MAX_CAPTION + 1);
    assert.equal(cut, cut.toWellFormed());
  });

  it("wrapText of a single word shorter than the width is that word", () => {
    assert.deepEqual(wrapText("שלום"), ["שלום"]);
  });
});
