// Contact sheet behaviour a reviewer can see: tile placement, sheet size,
// renamed layer ids, faithful composition and stable bytes. Fixed agents built
// here, so the demo's seeded agents can change without touching this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSheet } from "./sheet.mjs";
import { STYLES, getStyle } from "./styles/index.mjs";
import { LAYER_IDS } from "./styles/shared.mjs";
import { MOODS } from "./moods.mjs";

const TILE = 256;
const GAP = 8;
const A = Object.freeze({ traits: Object.freeze({ temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 1 }) });
const B = Object.freeze({ traits: Object.freeze({ temperament: "neon", role: "trickster", risk: "high", voice: "loud", memory_depth: 12 }) });
const C = Object.freeze({ traits: Object.freeze({ temperament: "warm", role: "auditor", risk: "wary", voice: "flat", memory_depth: 6 }) });

const tilesOf = (sheet) => [...sheet.matchAll(/<svg x="(\d+)" y="(\d+)" [^>]*>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
const rootOf = (sheet) => sheet.match(/^<svg [^>]*>/)[0];

for (const style of Object.values(STYLES)) {
  const moods = style.moods;

  test(`sheet ${style.name}: root size fits agents x moods and tiles sit on the grid`, () => {
    const agents = [A, B, C];
    const sheet = renderSheet(style, { agents });
    const w = moods.length * (TILE + GAP) + GAP;
    const h = agents.length * (TILE + GAP) + GAP;
    assert.equal(rootOf(sheet), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`);
    assert.ok(sheet.includes(`<rect width="${w}" height="${h}" fill="#111111"/>`), "dark backdrop");
    const want = agents.flatMap((_, row) => moods.map((_, col) => ({ x: GAP + col * (TILE + GAP), y: GAP + row * (TILE + GAP) })));
    assert.deepEqual(tilesOf(sheet), want);
    assert.ok(sheet.endsWith("</svg>\n"));
  });

  test(`sheet ${style.name}: every tile is the single render with its layer ids namespaced`, () => {
    const agents = [B, A];
    const sheet = renderSheet(style, { agents });
    agents.forEach((a, row) => {
      moods.forEach((mood, col) => {
        const single = style.render(a.traits, { mood }).trimEnd();
        let want = single.replace(/^<svg /, `<svg x="${GAP + col * (TILE + GAP)}" y="${GAP + row * (TILE + GAP)}" `);
        for (const id of LAYER_IDS) want = want.replace(`<g id="${id}">`, `<g id="t${row}-${col}-${id}">`);
        assert.ok(sheet.includes(`\n${want}\n`), `${style.name} tile ${row},${col}`);
        for (const id of LAYER_IDS) assert.ok(want.includes(`<g id="t${row}-${col}-${id}">`), id);
      });
    });
    for (const id of LAYER_IDS) assert.ok(!sheet.includes(`<g id="${id}">`), `bare layer id ${id} leaked into the sheet`);
  });

  test(`sheet ${style.name}: same input gives the same bytes; key order and freezing do not matter`, () => {
    const a = renderSheet(style, { agents: [A, B] });
    const b = renderSheet(style, { agents: [{ traits: { memory_depth: 1, voice: "dry", risk: "low", role: "observer", temperament: "cool" } }, { traits: { ...B.traits } }] });
    assert.equal(a, b);
    assert.equal(renderSheet(style, { agents: [A, B] }), a);
  });

  test(`sheet ${style.name}: a one-agent, one-mood sheet is a single tile`, () => {
    const sheet = renderSheet(style, { agents: [C], moods: ["neutral"] });
    assert.deepEqual(tilesOf(sheet), [{ x: GAP, y: GAP }]);
    assert.equal(rootOf(sheet), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE + 2 * GAP} ${TILE + 2 * GAP}" width="${TILE + 2 * GAP}" height="${TILE + 2 * GAP}">`);
    assert.equal((sheet.match(/<\/svg>/g) ?? []).length, 2);
  });

  test(`sheet ${style.name}: row order follows the agents list, column order follows the moods list`, () => {
    if (moods.length < 2) return;
    const forward = renderSheet(style, { agents: [A, B], moods: [moods[0], moods[1]] });
    const flipped = renderSheet(style, { agents: [B, A], moods: [moods[1], moods[0]] });
    assert.notEqual(forward, flipped);
    const first = (sheet) => sheet.match(/<svg x="8" y="8" [^>]*>[\s\S]*?<\/svg>/)[0];
    assert.match(first(forward), new RegExp(`data-mood="${moods[0]}"`));
    assert.match(first(flipped), new RegExp(`data-mood="${moods[1]}"`));
  });
}

test("sheet: an empty agents list is an empty frame, not a crash", () => {
  const sheet = renderSheet(getStyle("sticker"), { agents: [] });
  assert.deepEqual(tilesOf(sheet), []);
  assert.match(sheet, /viewBox="0 0 \d+ 8"/);
});

test("sheet: the default style refuses a mood column it cannot draw", () => {
  assert.throws(() => renderSheet(getStyle("default"), { agents: [A], moods: ["hype"] }), /style default has no mood hype/);
  assert.throws(() => renderSheet(getStyle("default"), { agents: [A], moods: MOODS }), /no mood/);
});

test("sheet: one bad agent in the list fails the whole sheet", () => {
  for (const style of Object.values(STYLES)) {
    assert.throws(() => renderSheet(style, { agents: [A, { traits: { ...B.traits, memory_depth: 13 } }] }), TypeError, style.name);
    assert.throws(() => renderSheet(style, { agents: [A, {}] }), TypeError, style.name);
    assert.throws(() => renderSheet(style, { agents: [A, null] }), TypeError, style.name);
  }
});

test("sheet: ids stay unique when two rows share a trait set but differ in depth", () => {
  for (const style of Object.values(STYLES)) {
    const sheet = renderSheet(style, { agents: [A, { traits: { ...A.traits, memory_depth: 2 } }] });
    const ids = [...sheet.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, style.name);
  }
});
