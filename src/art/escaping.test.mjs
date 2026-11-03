// The art renderers never interpolate free text. Traits and moods are checked
// against closed enums first, so a hostile string must throw and can never
// reach the SVG. The sheet inherits that: it only takes the trait objects.
import assert from "node:assert/strict";
import test from "node:test";

import { renderSvg } from "./render.mjs";
import { renderSheet } from "./sheet.mjs";
import { STYLES } from "./styles/index.mjs";
import { AGENTS } from "../traits/agents.mjs";

const EVIL = [`<script>alert(1)</script>`, `"><svg onload=alert(1)>`, `' & "`];
const GOOD = AGENTS[0].traits;

test("every style and the base renderer reject hostile trait values", () => {
  const renderers = [["base", (t) => renderSvg(t)], ...Object.values(STYLES).map((s) => [s.name, (t) => s.render(t)])];
  for (const [name, render] of renderers) {
    for (const key of ["temperament", "role", "risk", "voice"]) {
      for (const evil of EVIL) {
        assert.throws(() => render({ ...GOOD, [key]: evil }), TypeError, `${name} ${key}`);
      }
    }
    for (const evil of EVIL) assert.throws(() => render({ ...GOOD, memory_depth: evil }), TypeError, name);
    assert.throws(() => render({ ...GOOD, [EVIL[0]]: "x" }), TypeError, `${name} extra key`);
  }
});

test("every style rejects hostile moods", () => {
  for (const style of Object.values(STYLES)) {
    for (const evil of EVIL) assert.throws(() => style.render(GOOD, { mood: evil }), /unknown mood/, style.name);
  }
});

test("rendered SVG from every style and mood contains no script, handler or text node", () => {
  for (const style of Object.values(STYLES)) {
    for (const agent of AGENTS) {
      for (const mood of style.moods ?? ["neutral", "hype", "shade", "shook"]) {
        const svg = style.render(agent.traits, { mood });
        assert.doesNotMatch(svg, /<script|<foreignObject|<text|<[^>]*\son\w+=/i, `${style.name} ${mood}`);
      }
    }
  }
});

test("the contact sheet rejects hostile traits and moods instead of embedding them", () => {
  const style = Object.values(STYLES)[0];
  assert.throws(() => renderSheet(style, { agents: [{ traits: { ...GOOD, role: EVIL[0] } }] }), TypeError);
  assert.throws(() => renderSheet(style, { moods: [EVIL[1]] }), /unknown mood/);
});
