import { test } from "node:test";
import assert from "node:assert/strict";
import { runStyleContract, MAX_SVG_BYTES } from "./contract.mjs";
import { style } from "./pixel.mjs";
import { AGENTS } from "../../traits/agents.mjs";
import { MOODS } from "../moods.mjs";

runStyleContract(style);

const svgOf = (t, mood) => style.render(t, { mood });

test("pixel: every rect sits on the 8px grid", () => {
  for (const a of AGENTS) {
    for (const mood of MOODS) {
      const svg = svgOf({ ...a.traits, memory_depth: 12 }, mood);
      for (const m of svg.matchAll(/\s(?:x|y|width|height)="(\d+)"/g)) {
        const v = Number(m[1]);
        if (m[0].includes("width=\"256\"") || m[0].includes("height=\"256\"")) continue;
        assert.equal(v % 8, 0, `${a.id}/${mood}: ${m[0]}`);
      }
    }
  }
});

test("pixel: size budget has headroom (under 20000 of 32768 bytes)", () => {
  for (const a of AGENTS) {
    for (const mood of MOODS) {
      const bytes = Buffer.byteLength(svgOf({ ...a.traits, memory_depth: 12 }, mood));
      assert.ok(bytes < 20000, `${a.id}/${mood}: ${bytes}`);
    }
  }
});

test("pixel: crispEdges and no layers other than the four", () => {
  const svg = svgOf(AGENTS[0].traits);
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.deepEqual([...svg.matchAll(/<g id="([^"]+)">/g)].map((m) => m[1]), ["background", "rings", "glyph", "face"]);
});

test("pixel: data-ring only on rings-layer rects", () => {
  const svg = svgOf({ ...AGENTS[0].traits, memory_depth: 9 });
  const rings = svg.match(/<g id="rings">[\s\S]*?<g id="glyph">/)[0];
  assert.equal((rings.match(/data-ring=/g) ?? []).length, 9);
  assert.equal((svg.match(/data-ring=/g) ?? []).length, 9);
});

test("pixel: skeptic neutral draws the raised finger, other moods differ", () => {
  const t = AGENTS.find((a) => a.id === "skeptic").traits;
  const face = (m) => svgOf(t, m).match(/<g id="face">[\s\S]*$/)[0];
  // the finger tip: light-skin "e" pixels at x 28..29, y 9 (inside the frame, in the face group)
  const tip = (m) => new RegExp(`<g fill="#ffe2c6">(?:<rect[^>]*/>)*<rect x="224" y="72" width="16"`).test(face(m));
  assert.ok(tip("neutral"));
  assert.ok(tip("shade"));
  assert.ok(!tip("shook"));
});

test("pixel: every role x temperament renders a coherent head", () => {
  for (const role of ["observer", "trickster", "connector", "auditor"]) {
    for (const temperament of ["cool", "neon", "warm", "muted"]) {
      for (const mood of MOODS) {
        const svg = svgOf({ temperament, role, risk: "mid", voice: "flat", memory_depth: 5 }, mood);
        assert.match(svg, /<g id="face">/);
        assert.ok(Buffer.byteLength(svg) <= MAX_SVG_BYTES);
      }
    }
  }
});
