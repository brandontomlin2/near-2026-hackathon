// Behavior gaps in src/viewer/render.mjs not covered by viewer.test.mjs / escaping.test.mjs.
// Results are built by hand so nothing depends on a seed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { GENESIS_HASH, hashRound, verifyRounds } from "../swarm/runner.mjs";
import { chainStatus, escapeHtml, renderViewer, validateResult } from "./render.mjs";

const count = (html, re) => (html.match(re) || []).length;

const AG = [
  { id: "a", name: "Ann", personality: "calm", traits: {} },
  { id: "b", name: "Bee", personality: "brisk", traits: {} },
];
const agentsNamed = (a, b = "Bee") => [{ ...AG[0], name: a }, { ...AG[1], name: b }];

/** Hand-built result: `rounds` is an array of arrays of partial events. Hashes are correct. */
function build(rounds, seed = 1) {
  const events = [];
  const roundHashes = [];
  let prev = GENESIS_HASH;
  let id = 0;
  rounds.forEach((list, r) => {
    const evs = list.map((e) => ({
      id: ++id, round: r + 1, turn: id, agentId: "a", kind: "post", replyTo: null, ...e,
    }));
    events.push(...evs);
    prev = hashRound(prev, evs);
    roundHashes.push(prev);
  });
  return { seed, rounds: rounds.length, events, roundHashes };
}
const one = (events, seed) => build([events], seed);

test("an empty swarm renders: zero rounds and posts, agents still listed", () => {
  const html = renderViewer({ seed: 1, rounds: 0, events: [], roundHashes: [] }, AG);
  assert.match(html, /0 rounds · 0 posts · <span class="chain-ok">chain: ok<\/span>/);
  assert.equal(count(html, /class="round"/g), 0);
  assert.equal(count(html, /class="post"/g), 0);
  assert.ok(html.includes("<td>Ann</td>") && html.includes("<td>Bee</td>"));
});

test("one round hash over zero events renders one empty round with chain ok", () => {
  const run = { seed: 1, rounds: 1, events: [], roundHashes: [hashRound(GENESIS_HASH, [])] };
  const html = renderViewer(run, AG);
  assert.equal(count(html, /class="round"/g), 1);
  assert.equal(count(html, /class="post"/g), 0);
  assert.match(html, /1 rounds · 0 posts/);
  assert.match(html, /chain: ok/);
});

test("40 rounds render in ascending order and the posts count equals events.length", () => {
  const run = build(Array.from({ length: 40 }, (_, r) => [{ text: `t${r}` }, { agentId: "b", text: `u${r}` }]));
  const html = renderViewer(run, AG);
  assert.equal(count(html, /class="round"/g), 40);
  let at = -1;
  for (let r = 1; r <= 40; r++) {
    const i = html.indexOf(`<span>Round ${r}</span>`);
    assert.ok(i > at, `Round ${r} out of order`);
    at = i;
  }
  assert.match(html, /40 rounds · 80 posts/);
  assert.equal(count(html, /class="post"/g), run.events.length);
});

test("a 20,000 character name is rendered whole in the table and every author span", () => {
  const name = "ñ".repeat(20_000);
  const run = one([{ text: "x" }, { text: "y" }]);
  const html = renderViewer(run, agentsNamed(name));
  assert.equal(count(html, new RegExp(`<td>${name}</td>`, "g")), 1);
  assert.equal(count(html, new RegExp(`<span class="author">${name}</span>`, "g")), 2);
});

test("CJK, ZWJ emoji, combining marks and RTL letters survive unchanged in names", () => {
  const names = ["世界の名前", "👩‍💻", "ẹ́", "مرحبا", "שלום"];
  for (const name of names) {
    const html = renderViewer(one([{ text: "x" }]), agentsNamed(name));
    assert.ok(html.includes(`<td>${name}</td>`), name);
    assert.ok(html.includes(`<span class="author">${name}</span>`), name);
    assert.ok(!html.includes("�"), name);
  }
  assert.ok(renderViewer(one([{ text: "x" }]), agentsNamed("👩‍💻")).includes("‍"));
});

test("bidi controls and NUL in a name become U+FFFD while the rest is intact", () => {
  for (const bad of ["‮", "‎", "⁦", "\u0000"]) {
    const html = renderViewer(one([{ text: "x" }]), agentsNamed(`pre${bad}post`));
    assert.ok(html.includes(`<span class="author">pre�post</span>`), JSON.stringify(bad));
    assert.ok(!html.includes(bad));
  }
});

test("tab, LF and CR in a name survive", () => {
  const name = "a\tb\nc\rd";
  const html = renderViewer(one([{ text: "x" }]), agentsNamed(name));
  assert.ok(html.includes(`<span class="author">${name}</span>`));
});

test("event text: unicode survives, unsafe code points are replaced, whitespace controls survive", () => {
  const html = renderViewer(one([
    { text: "世界 👩‍💻 مرحبا é" },
    { text: "a‮b⁦c‎d\u0000e" },
    { text: "t\tl\nc\r" },
  ]), AG);
  assert.ok(html.includes(" 世界 👩‍💻 مرحبا é</p>"));
  assert.ok(html.includes(" a�b�c�d�e</p>"));
  assert.ok(html.includes(" t\tl\nc\r</p>"));
  assert.ok(!/[‮⁦‎\u0000]/.test(html));
});

test("an empty-string name renders an empty author span", () => {
  const html = renderViewer(one([{ text: "x" }]), agentsNamed(""));
  assert.ok(html.includes(`<span class="author"></span> x`));
});

test("escapeHtml stringifies non-strings and double-escapes ampersands", () => {
  assert.equal(escapeHtml(42), "42");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml(undefined), "undefined");
  assert.equal(escapeHtml({ toString: () => "<b>" }), "&lt;b&gt;");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
});

test("a reply to an id that is not in events renders as a plain post", () => {
  const html = renderViewer(one([{ agentId: "b", kind: "reply", replyTo: 999, text: "lost" }]), AG);
  assert.equal(count(html, /class="post"/g), 1);
  assert.ok(!html.includes("&rarr;"));
});

test("a reply to one's own earlier post shows the arrow with the author's name", () => {
  const html = renderViewer(one([{ text: "first" }, { kind: "reply", replyTo: 1, text: "second" }]), AG);
  assert.ok(html.includes(`<span class="author">Ann</span> <span class="meta">&rarr; Ann</span> second`));
});

test("kind decides the arrow: a post carrying replyTo shows none", () => {
  const html = renderViewer(one([{ text: "first" }, { agentId: "b", kind: "post", replyTo: 1, text: "second" }]), AG);
  assert.ok(!html.includes("&rarr;"));
});

test("meta line: missing seed is unknown, seed 0 is kept, a string seed is escaped", () => {
  const noSeed = one([]);
  delete noSeed.seed;
  assert.match(renderViewer(noSeed, AG), /seed: unknown /);
  assert.match(renderViewer(one([], 0), AG), /seed: 0 /);
  const html = renderViewer(one([], "<i>"), AG);
  assert.match(html, /seed: &lt;i&gt; /);
  assert.ok(!html.includes("<i>"));
});

test("agents table: traits null, string or missing give an empty cell; personality missing too", () => {
  const rows = (traits, personality) => renderViewer(one([]), [
    { id: "a", name: "Ann", personality, traits },
    AG[1],
  ]);
  for (const traits of [null, "warm", undefined]) {
    assert.ok(rows(traits, "p").includes("<tr><td>Ann</td><td>p</td><td></td></tr>"), String(traits));
  }
  assert.ok(rows({}, undefined).includes("<tr><td>Ann</td><td></td><td></td></tr>"));
});

test("trait values are joined as 'k: v, k2: v2' in insertion order", () => {
  const html = renderViewer(one([]), [
    { id: "a", name: "Ann", personality: "p", traits: { zeta: "z", alpha: 2, mid: "m" } },
    AG[1],
  ]);
  assert.ok(html.includes("<td>zeta: z, alpha: 2, mid: m</td>"));
});

test("chainStatus: ok on a valid run", () => {
  assert.deepEqual(chainStatus(build([[{ text: "a" }], [{ text: "b" }]])), { ok: true, brokenRound: null });
});

test("chainStatus reports the FIRST broken round when rounds 2 and 3 are tampered", () => {
  const run = build([[{ text: "a" }], [{ text: "b" }], [{ text: "c" }], [{ text: "d" }]]);
  run.events[1].text = "B!";
  run.events[2].text = "C!";
  assert.deepEqual(chainStatus(run), { ok: false, brokenRound: 2 });
  assert.match(renderViewer(run, AG), /chain: broken at round 2</);
});

test("an uncovered round-0 event breaks verification but no stored hash: no 'at round'", () => {
  const run = build([[{ text: "a" }]]);
  run.events.push({ id: 9, round: 0, turn: 9, agentId: "a", kind: "post", replyTo: null, text: "stray" });
  assert.equal(verifyRounds(run), false);
  assert.deepEqual(chainStatus(run), { ok: false, brokenRound: null });
  assert.throws(() => validateResult(run, AG), /out of order|round hash/);
});

test("an extra trailing hash that is not hashRound(prev, []) is the broken round", () => {
  const run = build([[{ text: "a" }], [{ text: "b" }]]);
  run.roundHashes.push("f".repeat(64));
  assert.deepEqual(chainStatus(run), { ok: false, brokenRound: 3 });
  const html = renderViewer(run, AG);
  assert.match(html, /chain: broken at round 3</);
  assert.equal(count(html, /class="round"/g), 3);
});

test("validateResult: order, round 0, string round, non-string text, missing id", () => {
  const ev = (o) => ({ id: 1, round: 1, turn: 1, agentId: "a", kind: "post", replyTo: null, text: "t", ...o });
  const hashes = ["a".repeat(64), "b".repeat(64)];
  const mk = (events, roundHashes = hashes) => ({ events, roundHashes });
  assert.throws(() => validateResult(mk([ev({ round: 2 }), ev({ id: 2, round: 1 })]), AG), /out of order/);
  assert.throws(() => validateResult(mk([ev({ round: 0 })]), AG), /round 0/);
  assert.throws(() => validateResult(mk([ev({ round: "1" })]), AG), /round "1"/);
  assert.throws(() => validateResult(mk([ev({ text: 5 })]), AG), /string text/);
  const noId = ev({ round: 9 });
  delete noId.id;
  assert.throws(() => validateResult(mk([noId]), AG), TypeError);
  assert.throws(() => validateResult(mk([noId]), AG), /invalid swarm result: event undefined/);
});

test("validateResult: bad hashes and agents are rejected, a valid result is returned as is", () => {
  const ev = { id: 1, round: 1, turn: 1, agentId: "a", kind: "post", replyTo: null, text: "t" };
  for (const h of ["A".repeat(64), "a".repeat(63), 7, null]) {
    assert.throws(() => validateResult({ events: [], roundHashes: [h] }, AG), /64 lowercase hex/);
  }
  const good = { events: [ev], roundHashes: ["a".repeat(64)] };
  for (const bad of ["agents", {}, []]) {
    assert.throws(() => validateResult(good, bad), /agents must be a non-empty array/);
  }
  assert.equal(validateResult(good, AG), good);
});

test("the CSP hash matches the one <style> block; no unsafe-inline, no script", () => {
  const html = renderViewer(one([{ text: "x" }]), AG);
  assert.equal(count(html, /<style/g), 1);
  assert.doesNotMatch(html, /<script/i);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const hash = createHash("sha256").update(css, "utf8").digest("base64");
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  assert.ok(csp.includes(`style-src 'sha256-${hash}'`));
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(!csp.includes("unsafe-inline"));
});

test("renderViewer is pure: same output twice and the input is not mutated", () => {
  const run = build([[{ text: "a" }, { agentId: "b", kind: "reply", replyTo: 1, text: "b" }], [{ text: "c" }]]);
  const agents = structuredClone(AG);
  const before = structuredClone(run);
  const first = renderViewer(run, agents);
  const second = renderViewer(run, agents);
  assert.equal(first, second);
  assert.deepEqual(run, before);
  assert.deepEqual(agents, AG);
});
