// Determinism every style must honour beyond "render twice in a row": no state
// leaks between calls in any order, key order and freezing of the input do not
// matter, the input is never mutated, and the ring count holds in every mood.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES } from "./index.mjs";
import { TRAIT_VALUES, MEMORY_DEPTH_MIN, MEMORY_DEPTH_MAX } from "../../traits/validate.mjs";

const FIXED = Object.freeze([
  Object.freeze({ temperament: "cool", role: "trickster", risk: "wary", voice: "open", memory_depth: 1 }),
  Object.freeze({ temperament: "neon", role: "auditor", risk: "low", voice: "dry", memory_depth: 5 }),
  Object.freeze({ temperament: "warm", role: "observer", risk: "high", voice: "flat", memory_depth: 9 }),
  Object.freeze({ temperament: "muted", role: "connector", risk: "mid", voice: "loud", memory_depth: 12 }),
]);

const shuffle = (t) => ({ memory_depth: t.memory_depth, voice: t.voice, risk: t.risk, role: t.role, temperament: t.temperament });

for (const style of Object.values(STYLES)) {
  const jobs = FIXED.flatMap((t) => style.moods.map((mood) => ({ t, mood })));

  test(`${style.name}: output does not depend on what was rendered before`, () => {
    const forward = jobs.map(({ t, mood }) => style.render(t, { mood }));
    const backward = [...jobs].reverse().map(({ t, mood }) => style.render(t, { mood })).reverse();
    assert.deepEqual(backward, forward);
    const interleaved = jobs.map(({ t, mood }, i) => {
      const other = jobs[(i * 7 + 3) % jobs.length];
      style.render(other.t, { mood: other.mood });
      return style.render(t, { mood });
    });
    assert.deepEqual(interleaved, forward);
  });

  test(`${style.name}: key order, freezing and spreading of the traits do not change the bytes`, () => {
    for (const { t, mood } of jobs) {
      const want = style.render(t, { mood });
      assert.equal(style.render(shuffle(t), { mood }), want);
      assert.equal(style.render(Object.freeze(shuffle(t)), { mood }), want);
      assert.equal(style.render({ ...t }, { mood }), want);
    }
  });

  test(`${style.name}: the input traits object is never mutated`, () => {
    for (const { t, mood } of jobs) {
      const copy = shuffle(t);
      const snapshot = JSON.stringify(copy);
      style.render(copy, { mood });
      assert.equal(JSON.stringify(copy), snapshot);
      assert.deepEqual(Object.keys(copy), Object.keys(shuffle(t)));
    }
  });

  test(`${style.name}: a distinct image for every trait set in every mood`, () => {
    const outs = new Set(jobs.map(({ t, mood }) => style.render(t, { mood })));
    assert.equal(outs.size, jobs.length);
  });

  test(`${style.name}: exactly one ring element per memory_depth in every mood`, () => {
    const base = FIXED[1];
    for (const mood of style.moods) {
      for (const d of [MEMORY_DEPTH_MIN, 4, 7, MEMORY_DEPTH_MAX]) {
        const svg = style.render({ ...base, memory_depth: d }, { mood });
        if (style.name === "default") {
          const rings = svg.match(/<g id="rings">[\s\S]*?<\/g>/)[0];
          assert.equal((rings.match(/<circle /g) ?? []).length, d, `${mood} depth ${d}`);
        } else {
          assert.equal((svg.match(/\sdata-ring="/g) ?? []).length, d, `${mood} depth ${d}`);
        }
      }
    }
  });

  test(`${style.name}: only the face and defs may differ between moods; the ring count and tier never do`, () => {
    for (const t of FIXED) {
      const roots = style.moods.map((mood) => style.render(t, { mood }).match(/^<svg [^>]*>/)[0]);
      const tiers = new Set(roots.map((r) => (r.match(/data-tier="([^"]+)"/) ?? [, "none"])[1]));
      assert.equal(tiers.size, 1, `${JSON.stringify(t)} tier changed with mood`);
    }
  });

  test(`${style.name}: all 256 enum combinations render at max depth without error`, () => {
    for (const temperament of TRAIT_VALUES.temperament) {
      for (const role of TRAIT_VALUES.role) {
        for (const risk of TRAIT_VALUES.risk) {
          for (const voice of TRAIT_VALUES.voice) {
            const t = { temperament, role, risk, voice, memory_depth: MEMORY_DEPTH_MAX };
            const svg = style.render(t, { mood: style.moods[style.moods.length - 1] });
            assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>\n"), JSON.stringify(t));
            assert.ok(Buffer.byteLength(svg) <= 32768, `${JSON.stringify(t)} ${Buffer.byteLength(svg)} bytes`);
          }
        }
      }
    }
  });
}
