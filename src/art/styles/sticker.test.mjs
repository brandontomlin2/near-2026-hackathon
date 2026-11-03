import { test } from "node:test";
import assert from "node:assert/strict";
import { runStyleContract } from "./contract.mjs";
import { style } from "./sticker.mjs";
import { AGENTS } from "../../traits/agents.mjs";

runStyleContract(style);

const svgOf = (id, mood) => style.render(AGENTS.find((a) => a.id === id).traits, { mood });

test("sticker: every layer carries the white die-cut outline", () => {
  for (const a of AGENTS) assert.match(style.render(a.traits), /<g id="glyph">[\s\S]*stroke="#fff" stroke-width="24"/);
});

test("sticker: Skeptic raises the finger (neutral) and Social has typing dots", () => {
  assert.match(svgOf("skeptic", "neutral"), /M198 226 L198 128/);
  assert.equal((svgOf("social", "neutral").match(/rx="6" ry="6" fill="#1b1226"/g) ?? []).length, 3);
});

test("sticker: Social shook asks a question, Aloof shook drops the monocle", () => {
  assert.match(svgOf("social", "shook"), /M46 26 Q46 14 56 14/);
  assert.match(svgOf("aloof", "shook"), /rotate\(-25 212 52\)/);
});

test("sticker: wide trait coverage stays coherent and inside the byte budget", () => {
  const t = { temperament: "cool", role: "trickster", risk: "low", voice: "dry", memory_depth: 12 };
  for (const mood of ["neutral", "hype", "shade", "shook"]) {
    const svg = style.render(t, { mood });
    assert.ok(Buffer.byteLength(svg) < 32768);
    assert.equal((svg.match(/data-ring="/g) ?? []).length, 12);
  }
});
