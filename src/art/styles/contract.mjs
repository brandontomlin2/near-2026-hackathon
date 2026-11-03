// Shared golden + contract tests for style modules. Each style's test file
// calls runStyleContract(style) and then adds its own style-specific tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../../traits/agents.mjs";
import { TRAIT_VALUES, MEMORY_DEPTH_MIN, MEMORY_DEPTH_MAX } from "../../traits/validate.mjs";
import { rarityTier, defsPrefix, range, LAYER_IDS } from "./shared.mjs";
import { MOODS } from "../moods.mjs";

export const MAX_SVG_BYTES = 32768;
export { LAYER_IDS };

/** All ids defined in an SVG. */
export const definedIds = (svg) => [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

/**
 * @param {{ name: string, title: string, description: string, render: (t: object, opts?: { mood?: string }) => string }} style
 */
export function runStyleContract(style) {
  const goldenDir = new URL(`./golden/${style.name}/`, import.meta.url);
  const goldenPath = (file) => fileURLToPath(new URL(`${file}.svg`, goldenDir));
  const base = { ...AGENTS[0].traits };
  const render = (t, mood) => style.render(t, mood === undefined ? undefined : { mood });

  test(`${style.name}: module shape`, () => {
    assert.match(style.name, /^[a-z][a-z0-9-]*$/);
    assert.equal(typeof style.title, "string");
    assert.ok(style.description.length > 20);
    assert.equal(typeof style.render, "function");
  });

  for (const a of AGENTS) {
    for (const mood of MOODS) {
      test(`${style.name}: golden ${a.id}-${mood}`, () => {
        const svg = render(a.traits, mood);
        if (process.env.UPDATE_GOLDEN === "1") {
          mkdirSync(fileURLToPath(goldenDir), { recursive: true });
          writeFileSync(goldenPath(`${a.id}-${mood}`), svg);
        }
        assert.equal(svg, readFileSync(goldenPath(`${a.id}-${mood}`), "utf8"));
      });
    }
  }

  test(`${style.name}: default mood is neutral`, () => {
    for (const a of AGENTS) {
      assert.equal(render(a.traits), render(a.traits, "neutral"));
      assert.equal(style.render(a.traits, {}), render(a.traits, "neutral"));
    }
  });

  test(`${style.name}: every mood is a distinct face for every agent`, () => {
    for (const a of AGENTS) {
      const faces = new Set(MOODS.map((m) => render(a.traits, m).match(/<g id="face">[\s\S]*$/)[0]));
      assert.equal(faces.size, MOODS.length, a.id);
    }
  });

  test(`${style.name}: unknown mood throws`, () => {
    assert.throws(() => render(base, "angry"));
    assert.throws(() => render(base, null));
  });

  test(`${style.name}: deterministic`, () => {
    for (const a of AGENTS) for (const m of MOODS) assert.equal(render(a.traits, m), render({ ...a.traits }, m));
  });

  for (const slot of ["temperament", "role", "risk", "voice"]) {
    test(`${style.name}: slot ${slot} changes output`, () => {
      const outs = new Set(TRAIT_VALUES[slot].map((v) => render({ ...base, [slot]: v })));
      assert.equal(outs.size, TRAIT_VALUES[slot].length);
    });
  }

  test(`${style.name}: one data-ring element per memory_depth`, () => {
    for (const d of range(MEMORY_DEPTH_MAX).map((i) => i + MEMORY_DEPTH_MIN)) {
      const svg = render({ ...base, memory_depth: d });
      assert.equal((svg.match(/\sdata-ring="/g) ?? []).length, d, `depth ${d}`);
    }
  });

  test(`${style.name}: rarity tier and mood on root`, () => {
    for (const d of [1, 3, 4, 6, 7, 9, 10, 12]) {
      for (const m of MOODS) {
        const svg = render({ ...base, memory_depth: d }, m);
        assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" data-style="${style.name}" data-tier="${rarityTier(d)}" data-mood="${m}">`));
      }
    }
  });

  test(`${style.name}: invalid traits throw`, () => {
    assert.throws(() => render({ ...base, role: "wizard" }));
    assert.throws(() => render({ ...base, memory_depth: 0 }));
    assert.throws(() => render({ ...base, memory_depth: 13 }));
    assert.throws(() => render(null));
  });

  test(`${style.name}: well-formed, self-contained, bounded`, () => {
    for (const a of AGENTS) {
      for (const [d, mood] of [[1, "neutral"], [12, "neutral"], ...MOODS.map((m) => [12, m])]) {
        const t = { ...a.traits, memory_depth: d };
        const svg = render(t, mood);
        assert.ok(svg.endsWith("</svg>\n"));
        assert.ok(!svg.includes("\r"));
        assert.ok(Buffer.byteLength(svg) <= MAX_SVG_BYTES, `${a.id}@${d}: ${Buffer.byteLength(svg)} bytes`);
        assert.ok(!/<script|href=|<image|<foreignObject|<text|<style|@import|http:\/\/(?!www\.w3\.org)|https:\/\/|NaN|undefined|Infinity|\d\.\d{3,}/.test(svg));
        for (const id of LAYER_IDS) assert.ok(svg.includes(`<g id="${id}">`), `layer ${id}`);
        assert.equal((svg.match(/<g[ >]/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
        assert.equal((svg.match(/<svg[ >]/g) ?? []).length, 1);
        assert.equal((svg.match(/<\/svg>/g) ?? []).length, 1);

        const ids = definedIds(svg);
        assert.equal(new Set(ids).size, ids.length, "duplicate id");
        const prefix = defsPrefix(style.name, t, mood);
        for (const id of ids) {
          if (!LAYER_IDS.includes(id)) assert.ok(id.startsWith(`${prefix}-`), `id ${id} lacks prefix ${prefix}-`);
        }
        for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) assert.ok(ids.includes(m[1]), `dangling url(#${m[1]})`);
      }
    }
  });
}
