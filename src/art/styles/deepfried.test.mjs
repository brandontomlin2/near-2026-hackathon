import { test } from "node:test";
import assert from "node:assert/strict";
import { runStyleContract } from "./contract.mjs";
import { style } from "./deepfried.mjs";
import { AGENTS } from "../../traits/agents.mjs";

runStyleContract(style);

const traits = (id) => AGENTS.find((a) => a.id === id).traits;
const seedOf = (svg) => svg.match(/feTurbulence[^>]*seed="(\d+)"/)[1];

test("deepfried: the frying chain is present and bounded", () => {
  const svg = style.render(traits("aloof"));
  for (const needle of ["feTurbulence", "feColorMatrix", "feComponentTransfer", 'type="discrete"', "feConvolveMatrix", "feGaussianBlur"]) {
    assert.ok(svg.includes(needle), needle);
  }
  assert.ok((svg.match(/<filter /g) ?? []).length <= 2);
});

test("deepfried: hype is fried harder than shade", () => {
  const sat = (m) => Number(style.render(traits("social"), { mood: m }).match(/type="saturate" values="(\d+)"/)[1]);
  assert.ok(sat("hype") > sat("shade"));
  assert.ok(sat("shook") > sat("neutral"));
});

test("deepfried: chaotic hype has laser beams and flares", () => {
  const svg = style.render(traits("chaotic"), { mood: "hype" });
  assert.ok(svg.includes("-beamL)") && svg.includes("-beamR)"));
  assert.ok(svg.includes("-flare)"));
  assert.ok(!style.render(traits("chaotic"), { mood: "shade" }).includes("-beamL)"));
});

test("deepfried: every agent's hype glows (laser-eye series)", () => {
  for (const id of ["aloof", "chaotic", "skeptic"]) {
    const hype = style.render(traits(id), { mood: "hype" });
    assert.ok(hype.includes("-flare)"), id);
    assert.ok(!style.render(traits(id), { mood: "neutral" }).includes("-flare)"), id);
  }
  assert.ok(style.render(traits("aloof"), { mood: "hype" }).includes("-beamR)"), "aloof monocle beam");
  assert.ok(style.render(traits("social"), { mood: "hype" }).includes("-flarePink)"), "social pink glow");
});

test("deepfried: fry has a warm colour cast and a burned vignette", () => {
  const svg = style.render(traits("aloof"));
  assert.match(svg, /<feColorMatrix in="ct" type="matrix"/);
  assert.ok(svg.includes("-vig)"));
});

test("deepfried: turbulence seed differs between tokens", () => {
  const a = seedOf(style.render(traits("aloof")));
  const b = seedOf(style.render({ ...traits("aloof"), memory_depth: 7 }));
  const c = seedOf(style.render(traits("chaotic")));
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("deepfried: every role carries its signature prop", () => {
  const face = (id, mood) => style.render(traits(id), { mood }).match(/<g id="face">[\s\S]*$/)[0];
  assert.ok(face("aloof", "neutral").includes('stroke="#ffc400"'), "monocle");
  assert.ok(face("chaotic", "neutral").includes("translate(0 -22)"), "jester cap");
  assert.ok(face("social", "neutral").includes("#ff1a2a"), "notification badge");
  assert.ok(style.render(traits("social"), { mood: "neutral" }).includes("#8b8f99"), "typing dots");
  assert.ok(face("skeptic", "neutral").includes('stroke-width="30"'), "raised finger");
});

test("deepfried: non-seeded combos render coherently in every mood", () => {
  const t = { temperament: "neon", role: "auditor", risk: "mid", voice: "loud", memory_depth: 12 };
  const outs = new Set(["neutral", "hype", "shade", "shook"].map((m) => style.render(t, { mood: m })));
  assert.equal(outs.size, 4);
});
