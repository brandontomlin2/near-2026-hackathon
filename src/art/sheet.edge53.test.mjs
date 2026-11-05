// Edge cases for the contact sheet (sheet.mjs): malformed options, stub styles
// with hostile output, layout with 0 / 1 / many items. Complements
// sheet.test.mjs, sheet.layout.test.mjs and escaping.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSheet } from "./sheet.mjs";
import { STYLES, getStyle } from "./styles/index.mjs";
import { MOODS } from "./moods.mjs";

const A = Object.freeze({ traits: Object.freeze({ temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 1 }) });
const B = Object.freeze({ traits: Object.freeze({ temperament: "neon", role: "trickster", risk: "high", voice: "loud", memory_depth: 12 }) });

const rootOf = (s) => s.match(/^<svg [^>]*>/)[0];
const dims = (s) => {
  const m = rootOf(s).match(/viewBox="0 0 (\d+) (\d+)" width="(\d+)" height="(\d+)"/);
  return { w: Number(m[1]), h: Number(m[2]), W: Number(m[3]), H: Number(m[4]) };
};
const stub = (render, moods = ["m"]) => ({ name: "stub", moods, render });
const sticker = getStyle("sticker");

test("a missing, null or non-style first argument is a TypeError", () => {
  for (const bad of [undefined, null, {}, { moods: ["a"] }, { render: "x" }, 5, "sticker"]) {
    assert.throws(() => renderSheet(bad, { agents: [A] }), TypeError, String(bad));
  }
});

test("a null options bag is a TypeError, an undefined one means the default roster", () => {
  assert.throws(() => renderSheet(sticker, null), TypeError);
  const full = renderSheet(sticker);
  assert.equal(full, renderSheet(sticker, undefined));
  assert.equal(full, renderSheet(sticker, {}));
});

test("non-array agents and moods are TypeErrors", () => {
  for (const bad of [null, "ab", 3, {}, { length: 1 }, true]) {
    assert.throws(() => renderSheet(sticker, { agents: bad }), TypeError, `agents=${String(bad)}`);
    assert.throws(() => renderSheet(sticker, { agents: [A], moods: bad }), TypeError, `moods=${String(bad)}`);
  }
});

test("an empty moods list with agents is a frame with no tiles, width equal to one gap", () => {
  const sheet = renderSheet(sticker, { agents: [A, B], moods: [] });
  assert.deepEqual(dims(sheet), { w: 8, h: 2 * 264 + 8, W: 8, H: 2 * 264 + 8 });
  assert.equal((sheet.match(/<svg[ >]/g) ?? []).length, 1);
});

test("empty agents and empty moods together are the smallest frame", () => {
  const sheet = renderSheet(sticker, { agents: [], moods: [] });
  assert.deepEqual(dims(sheet), { w: 8, h: 8, W: 8, H: 8 });
  assert.equal(sheet.split("\n").length, 4);
  assert.ok(sheet.endsWith("</svg>\n"));
});

test("an undefined mood column draws the neutral mood, same as naming it", () => {
  assert.equal(renderSheet(sticker, { agents: [A], moods: [undefined] }), renderSheet(sticker, { agents: [A], moods: ["neutral"] }));
});

test("an unknown, prototype-named or non-string mood fails the sheet", () => {
  for (const mood of ["__proto__", "constructor", "toString", "hasOwnProperty", "", "HYPE", "hype ", "<b>", null, 1, {}, ["hype"]]) {
    assert.throws(() => renderSheet(sticker, { agents: [A], moods: [mood] }), /unknown mood/, String(mood));
  }
});

test("a single bad mood among good ones fails the whole sheet", () => {
  assert.throws(() => renderSheet(sticker, { agents: [A], moods: ["neutral", "nope", "hype"] }), /mood/);
});

test("agents whose traits are missing, null or wrong-typed fail with TypeError", () => {
  for (const bad of [{ traits: null }, { traits: "cool" }, { traits: [] }, { traits: { ...A.traits, role: "__proto__" } }, { traits: { ...A.traits, memory_depth: NaN } }, { traits: { ...A.traits, memory_depth: Infinity } }, { traits: { ...A.traits, memory_depth: -1 } }]) {
    assert.throws(() => renderSheet(sticker, { agents: [bad], moods: ["neutral"] }), TypeError, JSON.stringify(bad.traits));
  }
});

test("layout scales linearly: n agents x m moods has (n*264+8) by (m*264+8) and n*m nested tiles", () => {
  for (const [n, m] of [[1, 1], [1, 4], [5, 1], [7, 4]]) {
    const agents = Array.from({ length: n }, (_, i) => ({ traits: { ...A.traits, memory_depth: 1 + (i % 12) } }));
    const sheet = renderSheet(sticker, { agents, moods: MOODS.slice(0, m) });
    const d = dims(sheet);
    assert.equal(d.w, m * 264 + 8, `${n}x${m} w`);
    assert.equal(d.h, n * 264 + 8, `${n}x${m} h`);
    assert.equal(d.W, d.w);
    assert.equal(d.H, d.h);
    assert.equal((sheet.match(/<svg x="/g) ?? []).length, n * m);
  }
});

test("many identical agents (100 rows) keep unique ids and unique tile coordinates", () => {
  const agents = Array.from({ length: 100 }, () => A);
  const sheet = renderSheet(getStyle("default"), { agents, moods: ["neutral"] });
  const ids = [...sheet.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const ys = [...sheet.matchAll(/<svg x="(\d+)" y="(\d+)"/g)].map((m) => m[2]);
  assert.equal(new Set(ys).size, 100);
  assert.deepEqual(dims(sheet), { w: 272, h: 100 * 264 + 8, W: 272, H: 100 * 264 + 8 });
});

test("the same agent object listed twice still gets distinct tile ids per row", () => {
  const sheet = renderSheet(getStyle("default"), { agents: [A, A], moods: ["neutral"] });
  for (const row of [0, 1]) assert.match(sheet, new RegExp(`<g id="t${row}-0-background">`));
  assert.doesNotMatch(sheet, /<g id="background">/);
});

test("only the exact four layer ids are renamed; other ids and look-alikes are untouched", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g id="background"><g id="background2"/><g id="face" class="x"/></g><g id="rings"></g><g id="glyph"></g><g id="face"></g><g id="other"></g></svg>\n';
  const sheet = renderSheet(stub(() => svg), { agents: [A], moods: ["m"] });
  assert.match(sheet, /<g id="t0-0-background">/);
  assert.match(sheet, /<g id="t0-0-rings">/);
  assert.match(sheet, /<g id="t0-0-glyph">/);
  assert.match(sheet, /<g id="t0-0-face">/);
  assert.match(sheet, /<g id="background2"\/>/);
  assert.match(sheet, /<g id="face" class="x"\/>/);
  assert.match(sheet, /<g id="other"><\/g>/);
});

test("renaming is global: every occurrence of a layer id in a tile is namespaced, and only the first <svg is positioned", () => {
  const svg = '<svg a="1"><svg a="2"><g id="face"></g></svg><g id="face"></g></svg>\n';
  const sheet = renderSheet(stub(() => svg), { agents: [A, B], moods: ["m"] });
  assert.equal((sheet.match(/<g id="t1-0-face">/g) ?? []).length, 2);
  assert.equal((sheet.match(/<svg x="8" y="272" a="1">/g) ?? []).length, 1);
  assert.equal((sheet.match(/<svg a="2">/g) ?? []).length, 2);
});

test("hostile text returned by a style is passed through unchanged, so styles must escape (sheet adds nothing of its own)", () => {
  const hostile = '<svg a="1"><desc>]]&gt;</desc></svg>\n';
  const sheet = renderSheet(stub(() => hostile), { agents: [A], moods: ["m"] });
  assert.ok(sheet.includes('<svg x="8" y="8" a="1"><desc>]]&gt;</desc></svg>'));
  assert.doesNotMatch(sheet, /NaN|undefined|Infinity/);
});

test("a style render that returns a non-string, or throws, fails the sheet", () => {
  for (const ret of [undefined, null, 42, {}, ["<svg/>"]]) {
    assert.throws(() => renderSheet(stub(() => ret), { agents: [A] }), TypeError, String(ret));
  }
  assert.throws(() => renderSheet(stub(() => { throw new RangeError("nope"); }), { agents: [A] }), RangeError);
});

test("render is called with the agent traits and the mood, once per tile, row-major", () => {
  const calls = [];
  const style = stub((t, opts) => {
    calls.push([t.memory_depth, opts.mood]);
    return "<svg></svg>\n";
  }, ["x", "y"]);
  renderSheet(style, { agents: [A, B] });
  assert.deepEqual(calls, [[1, "x"], [1, "y"], [12, "x"], [12, "y"]]);
});

test("a style without moods and no explicit moods option falls back to the global mood list", () => {
  const seen = [];
  renderSheet({ render: (_t, { mood }) => (seen.push(mood), "<svg></svg>\n") }, { agents: [A] });
  assert.deepEqual(seen, [...MOODS]);
});

test("agents with huge memory_depth style data never make coordinates or sizes non-finite text", () => {
  const sheet = renderSheet(sticker, { agents: [A, B], moods: MOODS });
  assert.doesNotMatch(sheet, /NaN|undefined|Infinity|null|\[object/);
  assert.doesNotMatch(sheet, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});

test("determinism: sheets are byte-identical across calls for every style and do not mutate inputs", () => {
  const agents = Object.freeze([A, B]);
  for (const style of Object.values(STYLES)) {
    const moods = style.moods;
    const first = renderSheet(style, { agents, moods });
    assert.equal(renderSheet(style, { agents, moods }), first, style.name);
    assert.equal(renderSheet(style, { agents: [...agents], moods: [...moods] }), first, style.name);
  }
});
