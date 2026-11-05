// Edge cases for the base renderer (render.mjs): hostile / malformed / odd-typed
// trait objects, numeric extremes, and output hygiene. Complements
// render.test.mjs, render.layers.test.mjs and escaping*.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSvg } from "./render.mjs";
import { TRAIT_VALUES } from "../traits/validate.mjs";

const BASE = Object.freeze({ temperament: "cool", role: "observer", risk: "low", voice: "dry", memory_depth: 1 });
const SLOTS = ["temperament", "role", "risk", "voice"];

const HOSTILE = [
  "<script>alert(1)</script>",
  `"><svg onload=alert(1)>`,
  "a&b",
  "]]>",
  "x\u0000y",
  "x\u0008y",
  "x\u001fy",
  "x y",
  "\ud800",
  "cool\n",
  " cool",
  "COOL",
  "",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "x".repeat(1_000_000),
];

test("hostile strings in every enum slot throw TypeError and never reach the output", () => {
  for (const slot of SLOTS) {
    for (const bad of HOSTILE) {
      assert.throws(() => renderSvg({ ...BASE, [slot]: bad }), TypeError, `${slot}=${JSON.stringify(bad.slice(0, 20))}`);
    }
  }
});

test("a hostile enum value never leaks into the thrown message verbatim at megabyte size", () => {
  const huge = "y".repeat(2_000_000);
  try {
    renderSvg({ ...BASE, voice: huge });
    assert.fail("should throw");
  } catch (err) {
    assert.ok(err instanceof TypeError);
    assert.ok(err.message.length < 1000, `message length ${err.message.length}`);
  }
});

test("prototype-ish keys are unknown keys, not silently ignored or polluting", () => {
  for (const key of ["__proto__", "constructor", "toString", "prototype", "hasOwnProperty"]) {
    const traits = JSON.parse(`{"temperament":"cool","role":"observer","risk":"low","voice":"dry","memory_depth":1,${JSON.stringify(key)}:"x"}`);
    assert.throws(() => renderSvg(traits), { name: "TypeError", message: new RegExp(`${key}: unknown key`) }, key);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test("a null-prototype object and a class instance with own trait fields render like a plain object", () => {
  const plain = renderSvg(BASE);
  assert.equal(renderSvg(Object.assign(Object.create(null), BASE)), plain);
  class Shape {
    constructor() {
      Object.assign(this, BASE);
    }
  }
  assert.equal(renderSvg(new Shape()), plain);
});

test("symbol keys and non-enumerable extras do not change the output", () => {
  const plain = renderSvg(BASE);
  const withSym = { ...BASE, [Symbol("note")]: "x" };
  const hidden = { ...BASE };
  Object.defineProperty(hidden, "extra", { value: "x", enumerable: false });
  assert.equal(renderSvg(withSym), plain);
  assert.equal(renderSvg(hidden), plain);
});

test("missing, null and wrong-type arguments are TypeErrors", () => {
  const bads = [undefined, null, 0, 1, "cool", true, Symbol("s"), () => BASE, [], [BASE], new Map(Object.entries(BASE))];
  for (const bad of bads) assert.throws(() => renderSvg(bad), TypeError, String(typeof bad));
});

test("every missing key is reported, and an empty object names all five", () => {
  assert.throws(() => renderSvg({}), (e) => e instanceof TypeError && ["temperament", "role", "risk", "voice", "memory_depth"].every((k) => e.message.includes(k)));
  for (const k of Object.keys(BASE)) {
    const { [k]: _dropped, ...rest } = BASE;
    assert.throws(() => renderSvg(rest), new RegExp(`${k}: is required`), k);
  }
});

test("an undefined or null value for a present key is rejected, not treated as missing-and-defaulted", () => {
  for (const k of Object.keys(BASE)) {
    for (const v of [undefined, null]) assert.throws(() => renderSvg({ ...BASE, [k]: v }), TypeError, `${k}=${v}`);
  }
});

test("memory_depth numeric extremes are all rejected", () => {
  const bads = [NaN, Infinity, -Infinity, -0, 0, -1, 13, 12.0000001, 0.9999, 2 ** 31, 2 ** 53, Number.MAX_VALUE, Number.MIN_VALUE, -Number.MAX_VALUE, Number.EPSILON, 1e21];
  for (const bad of bads) assert.throws(() => renderSvg({ ...BASE, memory_depth: bad }), TypeError, String(bad));
});

test("memory_depth boundaries 1 and 12 render with exactly that many rings and no bad number text", () => {
  for (const d of [1, 12]) {
    const svg = renderSvg({ ...BASE, memory_depth: d });
    const rings = svg.match(/<g id="rings">.*?<\/g>/)[0];
    assert.equal((rings.match(/<circle/g) ?? []).length, d);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity|null/);
  }
});

test("no combination of enum values leaks NaN, undefined, Infinity, null or [object", () => {
  for (const temperament of TRAIT_VALUES.temperament) {
    for (const role of TRAIT_VALUES.role) {
      for (const risk of TRAIT_VALUES.risk) {
        const svg = renderSvg({ temperament, role, risk, voice: "open", memory_depth: 12 });
        assert.doesNotMatch(svg, /NaN|undefined|Infinity|null|\[object/, `${temperament}/${role}/${risk}`);
      }
    }
  }
});

test("a throwing getter or revoked proxy is a TypeError, and a getter is read the same way on every call", () => {
  const getterTraits = {
    ...BASE,
    get voice() {
      throw new Error("boom");
    },
  };
  assert.throws(() => renderSvg(getterTraits), TypeError);
  const { proxy, revoke } = Proxy.revocable({ ...BASE }, {});
  revoke();
  assert.throws(() => renderSvg(proxy), TypeError);
});

test("a stateful getter cannot make the output disagree with itself", () => {
  let reads = 0;
  const flip = {
    ...BASE,
    get role() {
      reads += 1;
      return reads % 2 ? "observer" : "trickster";
    },
  };
  const svg = renderSvg(flip);
  const roleSvgs = new Set([renderSvg({ ...BASE, role: "observer" }), renderSvg({ ...BASE, role: "trickster" })]);
  assert.ok(roleSvgs.has(svg), "output must equal a single coherent role rendering");
});

test("frozen, sealed and extensible inputs give identical bytes and are not mutated", () => {
  const frozen = Object.freeze({ ...BASE });
  const sealed = Object.seal({ ...BASE });
  const plain = { ...BASE };
  const out = renderSvg(plain);
  assert.equal(renderSvg(frozen), out);
  assert.equal(renderSvg(sealed), out);
  assert.deepEqual(plain, BASE);
});

test("the document is a single well-formed root with only whitelisted element names and a trailing newline", () => {
  const svg = renderSvg({ ...BASE, memory_depth: 7 });
  assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" `));
  assert.ok(svg.endsWith("</svg>\n"));
  assert.equal((svg.match(/<svg[ >]/g) ?? []).length, 1);
  const names = new Set([...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  for (const n of names) assert.ok(["svg", "g", "rect", "circle", "path", "polyline"].includes(n), `unexpected element ${n}`);
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  assert.doesNotMatch(svg, /\r/);
});

test("determinism: repeated and interleaved renders give identical bytes", () => {
  const a = { ...BASE, memory_depth: 5, risk: "high" };
  const b = { ...BASE, memory_depth: 9, role: "auditor" };
  const first = [renderSvg(a), renderSvg(b)];
  for (let i = 0; i < 20; i++) {
    assert.equal(renderSvg(b), first[1]);
    assert.equal(renderSvg(a), first[0]);
  }
});

test("a failed render does not poison later renders", () => {
  const ok = renderSvg(BASE);
  assert.throws(() => renderSvg({ ...BASE, risk: "nope" }), TypeError);
  assert.equal(renderSvg(BASE), ok);
});

test("only the four layer groups carry ids, in the fixed order, once each", () => {
  const svg = renderSvg(BASE);
  const ids = [...svg.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["background", "rings", "glyph", "face"]);
});

test("output size stays bounded for the largest legal input", () => {
  const svg = renderSvg({ temperament: "neon", role: "connector", risk: "high", voice: "loud", memory_depth: 12 });
  assert.ok(Buffer.byteLength(svg) < 8192);
});
