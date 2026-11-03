// Style registry behaviour: lookup, the closed name list, and the default
// style's single-mood rule. Uses fixed trait objects built here, not the demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES, STYLE_NAMES, getStyle } from "./index.mjs";
import { renderSvg } from "../render.mjs";
import { MOODS } from "../moods.mjs";

const T = Object.freeze({ temperament: "warm", role: "connector", risk: "mid", voice: "open", memory_depth: 3 });

test("getStyle returns the registered style for every listed name", () => {
  assert.deepEqual([...STYLE_NAMES], ["default", "sticker", "pixel", "deepfried"]);
  for (const name of STYLE_NAMES) {
    const style = getStyle(name);
    assert.equal(style, STYLES[name]);
    assert.equal(style.name, name);
    assert.equal(typeof style.render(T), "string");
  }
});

test("getStyle rejects unknown names and lists the valid ones in the error", () => {
  for (const bad of ["", "Default", "sticker ", "svg", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => getStyle(bad), /unknown style: .*expected one of default, sticker, pixel, deepfried/, bad);
  }
  assert.throws(() => getStyle(undefined), /unknown style: undefined/);
  assert.throws(() => getStyle(null), /unknown style: null/);
  assert.throws(() => getStyle(42), /unknown style: 42/);
});

test("registry and every entry are frozen so a caller cannot swap a renderer", () => {
  assert.ok(Object.isFrozen(STYLES));
  assert.ok(Object.isFrozen(STYLE_NAMES));
  for (const style of Object.values(STYLES)) {
    assert.ok(Object.isFrozen(style), style.name);
    assert.ok(Object.isFrozen(style.moods), style.name);
  }
});

test("default style is the base renderer, byte for byte, and only knows neutral", () => {
  const style = getStyle("default");
  assert.deepEqual([...style.moods], ["neutral"]);
  assert.equal(style.render(T), renderSvg(T));
  assert.equal(style.render(T, {}), renderSvg(T));
  assert.equal(style.render(T, { mood: "neutral" }), renderSvg(T));
  assert.equal(style.render(T, { mood: undefined }), renderSvg(T));
  for (const mood of ["hype", "shade", "shook"]) {
    assert.throws(() => style.render(T, { mood }), new RegExp(`style default has no mood ${mood}`));
  }
  assert.throws(() => style.render(T, { mood: "angry" }), /unknown mood: angry/);
});

test("every mood style accepts exactly the four moods and nothing else", () => {
  for (const name of ["sticker", "pixel", "deepfried"]) {
    const style = getStyle(name);
    assert.deepEqual([...style.moods], [...MOODS]);
    for (const mood of MOODS) assert.match(style.render(T, { mood }), new RegExp(`^<svg [^>]*data-mood="${mood}"`));
    for (const bad of ["Neutral", "neutral ", " hype", "HYPE", "", "angry", 0, 1, true, ["hype"], { mood: "hype" }]) {
      assert.throws(() => style.render(T, { mood: bad }), /unknown mood/, `${name} ${String(bad)}`);
    }
  }
});

test("every style carries its own name on the root or, for default, no style attribute", () => {
  for (const name of STYLE_NAMES) {
    const svg = getStyle(name).render(T);
    if (name === "default") assert.doesNotMatch(svg, /data-style=/);
    else assert.match(svg, new RegExp(`^<svg [^>]*data-style="${name}"`));
  }
});
