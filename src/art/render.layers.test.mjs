// Base renderer: which trait moves which layer, palette per temperament, and
// input hygiene. Asserts on output SVG text only, with fixed traits built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSvg } from "./render.mjs";
import { TRAIT_VALUES } from "../traits/validate.mjs";

const base = Object.freeze({ temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 2 });
const LAYERS = ["background", "rings", "glyph", "face"];

/** Split an SVG into its four layer groups, keyed by id. */
function layers(svg) {
  const out = {};
  for (const id of LAYERS) {
    const m = svg.match(new RegExp(`<g id="${id}">[\\s\\S]*?(?=\\n<g id="|\\n</svg>)`));
    assert.ok(m, `layer ${id} present`);
    out[id] = m[0];
  }
  return out;
}

test("layers appear in draw order: background, rings, glyph, face", () => {
  const ids = [...renderSvg(base).matchAll(/<g id="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(ids, LAYERS);
});

const ISOLATED = { role: "glyph", risk: "background", voice: "face" };
for (const [slot, layer] of Object.entries(ISOLATED)) {
  test(`${slot} changes only the ${layer} layer`, () => {
    const ref = layers(renderSvg(base));
    for (const v of TRAIT_VALUES[slot]) {
      if (v === base[slot]) continue;
      const got = layers(renderSvg({ ...base, [slot]: v }));
      for (const id of LAYERS) {
        if (id === layer) assert.notEqual(got[id], ref[id], `${slot}=${v} must change ${id}`);
        else assert.equal(got[id], ref[id], `${slot}=${v} must not change ${id}`);
      }
    }
  });
}

test("memory_depth changes only the rings layer, adding one concentric circle per step", () => {
  const ref = layers(renderSvg(base));
  for (const d of [1, 3, 7, 12]) {
    const got = layers(renderSvg({ ...base, memory_depth: d }));
    for (const id of LAYERS) if (id !== "rings") assert.equal(got[id], ref[id], `depth ${d} must not change ${id}`);
    const radii = [...got.rings.matchAll(/ r="(\d+)"/g)].map((m) => Number(m[1]));
    assert.equal(radii.length, d);
    assert.deepEqual(radii, radii.map((_, i) => 56 + i * 5), "rings grow outward by 5");
    assert.ok(got.rings.includes('cx="128" cy="140"'), "rings share the face centre");
  }
});

test("temperament picks the palette: the backdrop fill is unique per temperament and used by every layer", () => {
  const fills = new Map();
  for (const temperament of TRAIT_VALUES.temperament) {
    const svg = renderSvg({ ...base, temperament });
    const bg = svg.match(/<rect width="256" height="256" fill="(#[0-9a-f]{6})"\/>/)[1];
    fills.set(temperament, bg);
    const head = svg.match(/<circle cx="128" cy="140" r="48" fill="(#[0-9a-f]{6})"/)[1];
    assert.equal(head, bg, `${temperament}: the head is filled with the backdrop colour`);
    const got = layers(svg);
    const ref = layers(renderSvg(base));
    for (const id of LAYERS) if (temperament !== base.temperament) assert.notEqual(got[id], ref[id], `${temperament} recolours ${id}`);
  }
  assert.equal(new Set(fills.values()).size, TRAIT_VALUES.temperament.length);
  assert.equal(fills.get("neon"), "#14001f", "neon is the one dark backdrop");
});

test("each voice draws a recognisable mouth and eyes", () => {
  const face = (voice) => layers(renderSvg({ ...base, voice })).face;
  for (const voice of TRAIT_VALUES.voice) assert.equal((face(voice).match(/<circle cx="1[14][06]" cy="128" r="5"/g) ?? []).length, 2, `${voice}: two eyes`);
  assert.match(face("loud"), /<path d="M100 154Q128 190 156 154Z" fill="#/, "loud: a filled wide grin");
  assert.match(face("open"), /<path d="M108 156Q128 176 148 156" stroke=/, "open: a smile stroke");
  assert.match(face("dry"), /M102 124H118M138 124H154/, "dry: half-closed lids over the eyes");
  assert.match(face("dry"), /M112 164H144/, "dry: a flat mouth");
  assert.match(face("flat"), /M138 114L156 108/, "flat: one raised brow");
  assert.match(face("flat"), /M112 164H144/, "flat: a flat mouth");
});

test("each risk draws its own backdrop pattern", () => {
  const bg = (risk) => layers(renderSvg({ ...base, risk })).background;
  assert.equal((bg("low").match(/<circle [^>]*r="2"/g) ?? []).length, 36, "low: a 6x6 field of dots");
  assert.equal((bg("high").match(/<polyline /g) ?? []).length, 6, "high: six zigzag rows");
  assert.equal((bg("mid").match(/<path d="M0 \d+ Q/g) ?? []).length, 8, "mid: eight waves");
  assert.equal((bg("wary").match(/V256M0 \d+H256/g) ?? []).length, 9, "wary: a 9-line grid");
});

test("output does not depend on key order, and the input object is left untouched", () => {
  const shuffled = { memory_depth: 2, voice: "dry", risk: "low", role: "observer", temperament: "cool" };
  const before = JSON.stringify(shuffled);
  assert.equal(renderSvg(shuffled), renderSvg(base));
  assert.equal(JSON.stringify(shuffled), before);
  assert.deepEqual(Object.keys(shuffled), ["memory_depth", "voice", "risk", "role", "temperament"]);
});

test("memory_depth must be a plain integer in range", () => {
  for (const bad of ["3", 3.5, -1, 0, 13, NaN, Infinity, 1e308, 3n, null, true, [3], { valueOf: () => 3 }]) {
    assert.throws(() => renderSvg({ ...base, memory_depth: bad }), TypeError, `memory_depth=${String(bad)}`);
  }
  assert.equal(renderSvg({ ...base, memory_depth: 3.0 }), renderSvg({ ...base, memory_depth: 3 }));
});

test("every slot value is rendered for every other slot value without error and stays bounded", () => {
  const seen = new Set();
  for (const temperament of TRAIT_VALUES.temperament) {
    for (const role of TRAIT_VALUES.role) {
      for (const risk of TRAIT_VALUES.risk) {
        for (const voice of TRAIT_VALUES.voice) {
          const svg = renderSvg({ temperament, role, risk, voice, memory_depth: 12 });
          assert.ok(Buffer.byteLength(svg) < 8192, `${temperament}/${role}/${risk}/${voice}: ${Buffer.byteLength(svg)} bytes`);
          seen.add(svg);
        }
      }
    }
  }
  assert.equal(seen.size, 256, "all 256 combinations are distinct images");
});
