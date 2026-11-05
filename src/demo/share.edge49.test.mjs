import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderShareCard, cleanText, clipText, wrapText, nest, escapeXml, MAX_CAPTION, PROJECT_FOOTER } from "./share.mjs";

const FACE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
const card = (over = {}) => ({ agentName: "Ann", text: "hello", mood: "hype", round: 1, faceSvg: FACE, ...over });
const attr = (svg, name) => new RegExp(`${name}="([^"]*)"`).exec(svg)?.[1];

describe("share edge: renderShareCard missing and odd fields", () => {
  it("null/undefined name, text and mood render empty strings, never the words null/undefined", () => {
    const svg = renderShareCard(card({ agentName: null, text: undefined, mood: null }));
    assert.ok(!/undefined|null/.test(svg));
    assert.equal(attr(svg, "data-mood"), "");
    assert.ok(svg.includes('aria-label=" says: "'));
  });

  it("round 0 and negative rounds are printed as numbers", () => {
    assert.ok(renderShareCard(card({ round: 0 })).includes("round 0 ·"));
    assert.ok(renderShareCard(card({ round: -3 })).includes("round -3 ·"));
  });

  it("regression: undefined or null round never prints the words undefined/null", () => {
    for (const round of [undefined, null]) {
      const svg = renderShareCard(card({ round }));
      assert.ok(!/undefined|null/.test(svg), String(round));
      assert.ok(svg.includes("round  · hype"), String(round));
    }
  });

  it("whitespace-only text yields no tspans and the minimum height", () => {
    const svg = renderShareCard(card({ text: " \t\n  " }));
    assert.ok(!svg.includes("<tspan"));
    assert.equal(attr(svg, "height"), String(300 + 2 * 40 + 40));
  });

  it("a faceSvg without an svg root is passed through without crashing and keeps one card root", () => {
    const svg = renderShareCard(card({ faceSvg: "<g/>" }));
    assert.ok(svg.startsWith("<svg "));
    assert.ok(svg.includes("<g/>"));
  });

  it("emoji agent names and CJK text survive and are escaped only for XML", () => {
    const svg = renderShareCard(card({ agentName: "🦊 <Fox> & Co", text: "你好，世界" }));
    assert.ok(svg.includes("🦊 &lt;Fox&gt; &amp; Co"));
    assert.ok(svg.includes("你好，世界"));
  });

  it("a very long agent name is escaped and does not change the wrapped line count", () => {
    const a = renderShareCard(card({ agentName: "x" }));
    const b = renderShareCard(card({ agentName: "x".repeat(10000) }));
    assert.equal(attr(a, "height"), attr(b, "height"));
    assert.ok(b.includes("x".repeat(10000)));
  });

  it("an attribute-breaking mood cannot close the data-mood attribute", () => {
    const svg = renderShareCard(card({ mood: '"><script>alert(1)</script>' }));
    assert.ok(!svg.includes("<script"));
    assert.ok(svg.includes("data-mood=\"&quot;&gt;&lt;script&gt;"));
  });
});

describe("share edge: helpers", () => {
  it("cleanText handles numbers, booleans, null and objects", () => {
    assert.equal(cleanText(0), "0");
    assert.equal(cleanText(false), "false");
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
    assert.equal(cleanText([1, 2]), "1,2");
  });

  it("clipText boundary: exactly max kept, max+1 cut; max 0 gives just an ellipsis", () => {
    assert.equal(clipText("abc", 3), "abc");
    assert.equal(clipText("abcd", 3), "abc…");
    assert.equal(clipText("abc", 0), "…");
    assert.equal(clipText("", 0), "");
  });

  it("clipText counts an emoji as one point at the boundary", () => {
    assert.equal(clipText("😀😀😀", 3), "😀😀😀");
    assert.equal(clipText("😀😀😀😀", 3), "😀😀😀…");
  });

  it("MAX_CAPTION is respected by the card: 3x the cap in emoji renders only cap points + ellipsis", () => {
    const svg = renderShareCard(card({ text: "😀".repeat(MAX_CAPTION * 3) }));
    const label = attr(svg, "aria-label");
    assert.equal([...label.replace("Ann says: ", "")].length, MAX_CAPTION + 1);
  });

  it("wrapText of empty or whitespace gives no lines", () => {
    assert.deepEqual(wrapText(""), []);
    assert.deepEqual(wrapText("   \n\t "), []);
  });

  it("wrapText rejects zero, negative, fractional, NaN and Infinity widths", () => {
    for (const w of [0, -1, 1.5, NaN, Infinity, "5", null]) {
      assert.throws(() => wrapText("a b", w), RangeError, String(w));
    }
  });

  it("wrapText width 1 puts one code point per line, emoji whole", () => {
    assert.deepEqual(wrapText("a😀b", 1), ["a", "😀", "b"]);
  });

  it("nest places x/y/size on the root and strips only the root's own placement attributes", () => {
    const out = nest(`<svg viewBox="0 0 1 1" x="5" y="6" width="7" height="8"><rect width="2" height="3"/></svg>`, 1, 2, 3);
    assert.equal(out, `<svg viewBox="0 0 1 1" x="1" y="2" width="3" height="3"><rect width="2" height="3"/></svg>`);
  });

  it("nest handles single-quoted attrs containing '>' and surrounding whitespace", () => {
    const out = nest(`  \n<svg data-x='a>b' width='9'>\n<g/></svg>  `, 0, 0, 10);
    assert.ok(out.startsWith(`<svg data-x='a>b' x="0" y="0" width="10" height="10">`));
  });

  it("escapeXml escapes all five characters and leaves unicode alone", () => {
    assert.equal(escapeXml(`<>&"'é😀`), "&lt;&gt;&amp;&quot;&#39;é😀");
  });

  it("the footer is on every card exactly once", () => {
    const svg = renderShareCard(card());
    assert.equal(svg.split(PROJECT_FOOTER).length - 1, 1);
  });
});
