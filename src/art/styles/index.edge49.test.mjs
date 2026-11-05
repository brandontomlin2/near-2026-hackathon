// Edge cases for the style registry: hostile lookup keys, immutability of the
// registry, and the render entry point of every registered style under bad
// traits, extreme depths and detached calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES, STYLE_NAMES, getStyle } from "./index.mjs";

const T = Object.freeze({ temperament: "neon", role: "trickster", risk: "high", voice: "loud", memory_depth: 7 });
const styles = Object.values(STYLES);

test("getStyle: names with whitespace, control characters, markup or unicode never resolve", () => {
  for (const bad of ["\tpixel", "pixel\n", "pixel\u0000", "stiсker", "pïxel", "<pixel>", "pixel.mjs", "../pixel", "\u{1F680}", "PIXEL"]) {
    assert.throws(() => getStyle(bad), /unknown style: /, JSON.stringify(bad));
  }
});

test("getStyle: no arguments, symbols and prototype-less objects throw rather than return a style", () => {
  assert.throws(() => getStyle());
  assert.throws(() => getStyle(Symbol("sticker")), /unknown style: Symbol\(sticker\)/);
  assert.throws(() => getStyle(Object.create(null)));
  assert.throws(() => getStyle({}), /unknown style: \[object Object\]/);
});

test("getStyle: inherited Object.prototype members and legacy accessors are not styles", () => {
  for (const bad of ["valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__", "length", "name"]) {
    assert.throws(() => getStyle(bad), /unknown style/, bad);
  }
});

test("STYLE_NAMES is exactly the own keys of STYLES, in registration order, with no prototype leakage", () => {
  assert.deepEqual([...STYLE_NAMES], Object.keys(STYLES));
  assert.equal(Object.getOwnPropertyNames(STYLES).length, STYLE_NAMES.length);
  assert.deepEqual(Object.getOwnPropertySymbols(STYLES), []);
});

test("registry cannot be extended, overwritten or truncated by a caller", () => {
  assert.throws(() => { STYLES.evil = styles[0]; }, TypeError);
  assert.throws(() => { STYLES.sticker = styles[0]; }, TypeError);
  assert.throws(() => { delete STYLES.pixel; }, TypeError);
  assert.throws(() => STYLE_NAMES.push("evil"), TypeError);
  assert.throws(() => STYLE_NAMES.pop(), TypeError);
  assert.throws(() => { STYLES.pixel.render = () => ""; }, TypeError);
  assert.throws(() => STYLES.deepfried.moods.push("angry"), TypeError);
  assert.throws(() => getStyle("evil"), /unknown style: evil/);
  assert.equal(getStyle("pixel"), STYLES.pixel);
});

test("every style: each entry has exactly the documented string metadata and non-empty moods", () => {
  for (const s of styles) {
    assert.equal(typeof s.name, "string", s.name);
    assert.equal(typeof s.title, "string", s.name);
    assert.ok(s.title.trim().length > 0, s.name);
    assert.ok(s.description.trim().length > 20, s.name);
    assert.ok(s.moods.length >= 1, s.name);
    assert.ok(s.moods.includes("neutral"), s.name);
    assert.equal(new Set(s.moods).size, s.moods.length, s.name);
  }
  assert.equal(new Set(styles.map((s) => s.title)).size, styles.length, "titles must be distinct");
});

test("every style: render works detached from its registry entry (no reliance on this)", () => {
  for (const s of styles) {
    const { render } = s;
    assert.equal(render(T), s.render(T), s.name);
    assert.equal(render.call(null, T, { mood: "neutral" }), s.render(T, { mood: "neutral" }), s.name);
  }
});

test("every style: non-object, array and incomplete traits throw before any SVG is returned", () => {
  const incomplete = { temperament: "neon", role: "trickster", risk: "high", voice: "loud" };
  for (const s of styles) {
    for (const bad of [undefined, null, 0, "", "neon", true, [], [T], incomplete, {}]) {
      assert.throws(() => s.render(bad), TypeError, `${s.name} ${JSON.stringify(bad)}`);
    }
  }
});

test("every style: memory_depth outside 1..12 or not an integer throws, edges 1 and 12 render", () => {
  for (const s of styles) {
    for (const d of [0, -1, 13, 1.5, NaN, Infinity, -Infinity, "7", null, undefined, 2 ** 31, Number.MAX_VALUE]) {
      assert.throws(() => s.render({ ...T, memory_depth: d }), TypeError, `${s.name} depth ${String(d)}`);
    }
    for (const d of [1, 12]) assert.match(s.render({ ...T, memory_depth: d }), /^<svg /, `${s.name} depth ${d}`);
  }
});

test("every style: prototype-member names and unknown extra keys are not accepted as trait values", () => {
  for (const s of styles) {
    for (const v of ["__proto__", "constructor", "toString"]) {
      for (const slot of ["temperament", "role", "risk", "voice"]) {
        assert.throws(() => s.render({ ...T, [slot]: v }), TypeError, `${s.name} ${slot}=${v}`);
      }
    }
    assert.throws(() => s.render({ ...T, extra: "x" }), TypeError, s.name);
    assert.throws(() => s.render(JSON.parse('{"__proto__":{"role":"auditor"}}')), TypeError, s.name);
  }
});

test("every style: unrelated keys in the options object do not change the output", () => {
  for (const s of styles) {
    const want = s.render(T, { mood: "neutral" });
    assert.equal(s.render(T, { mood: "neutral", seed: 42, extra: "<script>" }), want, s.name);
  }
});

test("every style: output is a single well-formed document free of NaN, undefined and script at depth extremes", () => {
  for (const s of styles) {
    for (const mood of s.moods) {
      for (const d of [1, 12]) {
        const svg = s.render({ ...T, memory_depth: d }, { mood });
        assert.ok(svg.startsWith("<svg "), `${s.name} ${mood} ${d}`);
        assert.ok(svg.endsWith("</svg>\n"), `${s.name} ${mood} ${d}`);
        assert.equal((svg.match(/<svg[ >]/g) ?? []).length, 1);
        assert.doesNotMatch(svg, /NaN|undefined|Infinity|\bnull\b|\[object|<script/, `${s.name} ${mood} ${d}`);
        assert.equal((svg.match(/<g[ >]/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length, `${s.name} ${mood} ${d} g balance`);
      }
    }
  }
});

test("distinct styles never produce the same bytes for the same traits", () => {
  const outs = styles.map((s) => s.render(T));
  assert.equal(new Set(outs).size, styles.length);
});

test("same traits and mood are byte-identical across repeated calls and a fresh object", () => {
  for (const s of styles) {
    for (const mood of s.moods) {
      const first = s.render(T, { mood });
      for (let i = 0; i < 3; i++) assert.equal(s.render({ ...T }, { mood }), first, `${s.name} ${mood}`);
    }
  }
});
