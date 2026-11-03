// Hostile input hardening beyond plain strings: objects that lie about their
// type, throwing getters, proxies, JSON-shaped prototype keys, and a check that
// no renderer output ever contains a raw ampersand or an angle bracket inside
// an attribute, which is how an injected value would surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSvg } from "./render.mjs";
import { renderSheet } from "./sheet.mjs";
import { STYLES } from "./styles/index.mjs";
import { MOODS } from "./moods.mjs";
import { TRAIT_VALUES } from "../traits/validate.mjs";

const GOOD = Object.freeze({ temperament: "neon", role: "trickster", risk: "high", voice: "loud", memory_depth: 4 });
const RENDERERS = [["base", (t, o) => renderSvg(t, o)], ...Object.values(STYLES).map((s) => [s.name, (t, o) => s.render(t, o)])];

test("trait values that only look like enum members when coerced are rejected", () => {
  const lookalikes = (v) => [new String(v), { toString: () => v }, { valueOf: () => v }, [v], Symbol(v)];
  for (const [name, render] of RENDERERS) {
    for (const key of ["temperament", "role", "risk", "voice"]) {
      for (const bad of lookalikes(GOOD[key])) assert.throws(() => render({ ...GOOD, [key]: bad }), TypeError, `${name} ${key}`);
    }
  }
});

test("a traits object with a throwing getter or a hostile proxy is a TypeError, not a crash elsewhere", () => {
  const throwing = { ...GOOD };
  Object.defineProperty(throwing, "role", { enumerable: true, get() { throw new Error("boom"); } });
  const proxy = new Proxy({ ...GOOD }, { ownKeys() { throw new Error("no keys for you"); } });
  const lying = new Proxy({ ...GOOD }, { get: (t, k) => (k === "role" ? "<svg onload=alert(1)>" : t[k]) });
  for (const [name, render] of RENDERERS) {
    assert.throws(() => render(throwing), TypeError, `${name} throwing getter`);
    assert.throws(() => render(proxy), TypeError, `${name} hostile proxy`);
    assert.throws(() => render(lying), TypeError, `${name} lying proxy`);
  }
});

test("JSON with a __proto__ or constructor key is rejected as an unknown key", () => {
  const withProto = JSON.parse(`{"temperament":"neon","role":"trickster","risk":"high","voice":"loud","memory_depth":4,"__proto__":{"x":1}}`);
  const withCtor = JSON.parse(`{"temperament":"neon","role":"trickster","risk":"high","voice":"loud","memory_depth":4,"constructor":{"x":1}}`);
  for (const [name, render] of RENDERERS) {
    assert.throws(() => render(withProto), /__proto__: unknown key/, name);
    assert.throws(() => render(withCtor), /constructor: unknown key/, name);
  }
});

test("inherited trait keys do not count: traits must be own properties", () => {
  const inherited = Object.create({ ...GOOD });
  for (const [name, render] of RENDERERS) assert.throws(() => render(inherited), /is required/, name);
  // ...and inherited junk does not poison an otherwise valid object
  const clean = Object.assign(Object.create({ evil: "<script>" }), GOOD);
  for (const [name, render] of RENDERERS) assert.equal(render(clean), render({ ...GOOD }), name);
});

test("arrays and primitives are never accepted as traits", () => {
  for (const [name, render] of RENDERERS) {
    for (const bad of [[], [GOOD], "neon", 4, true, undefined, () => GOOD, JSON.stringify(GOOD)]) {
      assert.throws(() => render(bad), TypeError, `${name} ${typeof bad}`);
    }
  }
});

test("mood objects that stringify to a real mood are still rejected", () => {
  const fakes = [new String("hype"), { toString: () => "hype" }, { valueOf: () => "hype" }, ["hype"], Symbol("hype")];
  for (const style of Object.values(STYLES)) {
    for (const fake of fakes) assert.throws(() => style.render(GOOD, { mood: fake }), /unknown mood/, style.name);
  }
  assert.throws(() => renderSheet(STYLES.sticker, { agents: [{ traits: GOOD }], moods: [{ toString: () => "hype" }] }), /unknown mood/);
});

test("no renderer output contains a raw ampersand, a stray angle bracket or a control character", () => {
  const RAW_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const ANGLE_IN_ATTR = /="[^"]*[<>][^"]*"/;
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
  for (const style of Object.values(STYLES)) {
    for (const temperament of TRAIT_VALUES.temperament) {
      for (const role of TRAIT_VALUES.role) {
        for (const mood of style.moods) {
          const svg = style.render({ ...GOOD, temperament, role, memory_depth: 12 }, { mood });
          const where = `${style.name} ${temperament}/${role}/${mood}`;
          assert.doesNotMatch(svg, RAW_AMP, where);
          assert.doesNotMatch(svg, ANGLE_IN_ATTR, where);
          assert.doesNotMatch(svg, CONTROL, where);
          assert.ok(!svg.includes("\t"), `${where}: tabs`);
        }
      }
    }
  }
  const sheet = renderSheet(STYLES.pixel, { agents: [{ traits: GOOD }], moods: MOODS });
  assert.doesNotMatch(sheet, RAW_AMP);
  assert.doesNotMatch(sheet, ANGLE_IN_ATTR);
});

test("every attribute value in every output is double-quoted and every id is a safe token", () => {
  for (const style of Object.values(STYLES)) {
    for (const mood of style.moods) {
      const svg = style.render(GOOD, { mood });
      for (const m of svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
        const tag = m[0];
        assert.doesNotMatch(tag, /=\s*'[^']*'/, `${style.name} ${mood}: single-quoted attribute in ${tag.slice(0, 60)}`);
        assert.doesNotMatch(tag, /=[^"\s>]/, `${style.name} ${mood}: unquoted attribute in ${tag.slice(0, 60)}`);
      }
      for (const m of svg.matchAll(/\sid="([^"]*)"/g)) assert.match(m[1], /^[A-Za-z][A-Za-z0-9_-]*$/, `${style.name} ${mood}: id ${m[1]}`);
      for (const m of svg.matchAll(/url\(#([^)]*)\)/g)) assert.match(m[1], /^[A-Za-z][A-Za-z0-9_-]*$/, `${style.name} ${mood}: ref ${m[1]}`);
    }
  }
});
