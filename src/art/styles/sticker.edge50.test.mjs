import { test } from "node:test";
import assert from "node:assert/strict";
import { style } from "./sticker.mjs";
import { AGENTS } from "../../traits/agents.mjs";

const base = { ...AGENTS[0].traits };
const render = (t, opts) => style.render(t, opts);

test("sticker edge: missing, null and non-object traits throw TypeError", () => {
  for (const bad of [undefined, null, 0, "cool", [], true, () => ({})]) {
    assert.throws(() => render(bad), TypeError, String(bad));
  }
});

test("sticker edge: missing or null trait fields throw naming the field", () => {
  for (const key of Object.keys(base)) {
    const missing = { ...base };
    delete missing[key];
    assert.throws(() => render(missing), new RegExp(`${key}: is required`));
    for (const v of [null, undefined]) {
      assert.throws(() => render({ ...base, [key]: v }), TypeError, `${key}=${v}`);
    }
  }
});

test("sticker edge: unknown extra keys are rejected", () => {
  assert.throws(() => render({ ...base, extra: 1 }), /extra: unknown key/);
});

test("sticker edge: memory_depth boundaries and non-integers", () => {
  assert.equal((render({ ...base, memory_depth: 1 }).match(/data-ring="/g) ?? []).length, 1);
  assert.equal((render({ ...base, memory_depth: 12 }).match(/data-ring="/g) ?? []).length, 12);
  for (const d of [0, 13, -1, 1.5, NaN, Infinity, "5", "12", null, 2 ** 53]) {
    assert.throws(() => render({ ...base, memory_depth: d }), /memory_depth: must be an integer from 1 to 12/, String(d));
  }
});

test("sticker edge: unicode, emoji and very long trait strings are rejected, not embedded", () => {
  for (const v of ["cööl", "🔥", "cool\u0000", "x".repeat(100000), "<script>", '"onload="x']) {
    assert.throws(() => render({ ...base, temperament: v }), /temperament: must be one of/);
  }
});

test("sticker edge: hostile traits objects throw instead of crashing oddly", () => {
  const getter = { ...base };
  Object.defineProperty(getter, "role", { enumerable: true, get() { throw new Error("boom"); } });
  assert.throws(() => render(getter), /could not be read \(boom\)/);
});

test("sticker edge: mood handling", () => {
  assert.equal(render(base, { mood: undefined }), render(base, { mood: "neutral" }));
  assert.equal(render(base, {}), render(base));
  for (const bad of [null, "", "HYPE", " hype", "hype ", "😀", "x".repeat(10000), 0, {}, ["hype"]]) {
    assert.throws(() => render(base, { mood: bad }), /unknown mood/, String(bad).slice(0, 20));
  }
});

test("sticker edge: opts null throws rather than rendering", () => {
  assert.throws(() => render(base, null));
});

test("sticker edge: render does not mutate or retain the input traits", () => {
  const t = Object.freeze({ ...base });
  const a = render(t);
  assert.deepEqual(t, base);
  assert.equal(render({ ...base }), a);
});
