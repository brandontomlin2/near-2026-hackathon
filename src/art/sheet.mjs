// Contact sheet: one SVG that tiles every agent (rows) in every mood
// (columns). Used for art review and the README. Each tile is a style's own
// SVG nested as-is, except the four layer ids, which repeat in every tile and
// are renamed to t<row>-<col>-<layer>. Def ids are already unique per trait
// set and mood.

import { AGENTS } from "../traits/agents.mjs";
import { MOODS } from "./moods.mjs";
import { LAYER_IDS } from "./styles/shared.mjs";

const TILE = 256;
const GAP = 8;
const LAYER_ID_RE = new RegExp(`<g id="(${LAYER_IDS.join("|")})">`, "g");

/**
 * @param {{ render: (t: object, opts?: { mood?: string }) => string, moods?: readonly string[] }} style
 * @param {{ agents?: readonly { traits: object }[], moods?: readonly string[] }} [opts]
 * @returns {string}
 */
export function renderSheet(style, { agents = AGENTS, moods = style.moods ?? MOODS } = {}) {
  const w = moods.length * (TILE + GAP) + GAP;
  const h = agents.length * (TILE + GAP) + GAP;
  const tiles = agents.flatMap((a, row) =>
    moods.map((mood, col) => {
      const svg = style.render(a.traits, { mood }).trimEnd();
      const x = GAP + col * (TILE + GAP);
      const y = GAP + row * (TILE + GAP);
      return svg
        .replace(/^<svg /, `<svg x="${x}" y="${y}" `)
        .replace(LAYER_ID_RE, (_, layer) => `<g id="t${row}-${col}-${layer}">`);
    }),
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect width="${w}" height="${h}" fill="#111111"/>`,
    ...tiles,
    `</svg>`,
  ].join("\n") + "\n";
}
