// Style registry. `default` is the original layered renderer (render.mjs),
// kept byte-identical so its goldens and any minted metadata stay valid. It has
// no mood variants. The other styles are memeable directions with one
// reaction face per mood (see docs/art-directions.md).

import { renderSvg } from "../render.mjs";
import { MOODS, assertMood } from "../moods.mjs";
import { style as sticker } from "./sticker.mjs";
import { style as pixel } from "./pixel.mjs";
import { style as deepfried } from "./deepfried.mjs";

/** @typedef {{ name: string, title: string, description: string, moods: readonly string[], render: (traits: object, opts?: { mood?: string }) => string }} Style */

const defaultStyle = Object.freeze({
  name: "default",
  title: "Default layers",
  description: "The original palette, rings, glyph and face layers. One image per token, no mood variants.",
  moods: Object.freeze(["neutral"]),
  render(traits, { mood } = {}) {
    if (assertMood(mood) !== "neutral") throw new Error(`style default has no mood ${mood}`);
    return renderSvg(traits);
  },
});

const withMoods = (s) => Object.freeze({ ...s, moods: MOODS });

/** @type {Readonly<Record<string, Style>>} */
export const STYLES = Object.freeze({
  default: defaultStyle,
  sticker: withMoods(sticker),
  pixel: withMoods(pixel),
  deepfried: withMoods(deepfried),
});

export const STYLE_NAMES = Object.freeze(Object.keys(STYLES));

/**
 * @param {string} name
 * @returns {Style}
 */
export function getStyle(name) {
  if (!Object.hasOwn(STYLES, name)) {
    throw new Error(`unknown style: ${String(name)} (expected one of ${STYLE_NAMES.join(", ")})`);
  }
  return STYLES[name];
}
