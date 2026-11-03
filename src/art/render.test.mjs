import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderSvg } from "./render.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { TRAIT_VALUES } from "../traits/validate.mjs";

const goldenPath = (id) => fileURLToPath(new URL(`./golden/${id}.svg`, import.meta.url));
const base = { ...AGENTS[0].traits };

for (const a of AGENTS) {
  test(`golden: ${a.id}`, () => {
    const svg = renderSvg(a.traits);
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(fileURLToPath(new URL("./golden/", import.meta.url)), { recursive: true });
      writeFileSync(goldenPath(a.id), svg);
    }
    assert.equal(svg, readFileSync(goldenPath(a.id), "utf8"));
  });
}

test("deterministic", () => {
  for (const a of AGENTS) assert.equal(renderSvg(a.traits), renderSvg({ ...a.traits }));
});

for (const slot of ["temperament", "role", "risk", "voice"]) {
  test(`slot ${slot} changes output`, () => {
    const outs = new Set(TRAIT_VALUES[slot].map((v) => renderSvg({ ...base, [slot]: v })));
    assert.equal(outs.size, TRAIT_VALUES[slot].length);
  });
}

test("memory_depth changes ring count", () => {
  const count = (d) => {
    const layer = renderSvg({ ...base, memory_depth: d }).match(/<g id="rings">.*?<\/g>/)[0];
    return (layer.match(/<circle/g) ?? []).length;
  };
  assert.equal(count(1), 1);
  assert.equal(count(5), 5);
  assert.equal(count(12), 12);
});

test("invalid traits throw", () => {
  assert.throws(() => renderSvg({ ...base, role: "wizard" }));
  assert.throws(() => renderSvg({ ...base, memory_depth: 0 }));
  assert.throws(() => renderSvg({ ...base, memory_depth: 13 }));
  assert.throws(() => renderSvg(null));
});

test("well-formed", () => {
  for (const a of AGENTS) {
    const svg = renderSvg(a.traits);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"'));
    assert.ok(svg.endsWith("</svg>\n"));
    assert.ok(!svg.includes("\r"));
    assert.ok(!/<script|href=|http:\/\/(?!www\.w3\.org)|https:\/\/|NaN|\d\.\d{3,}/.test(svg));
    for (const id of ["background", "rings", "glyph", "face"]) assert.ok(svg.includes(`<g id="${id}">`));
    assert.equal((svg.match(/<g[ >]/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length);
    assert.equal((svg.match(/<svg[ >]/g) ?? []).length, 1);
    assert.equal((svg.match(/<\/svg>/g) ?? []).length, 1);
  }
});
