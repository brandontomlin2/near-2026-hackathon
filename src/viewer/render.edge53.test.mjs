// Edge cases for the swarm viewer renderer: structure that survives hostile or
// missing fields, wrong types, and determinism. Hostile single-field payloads
// are already covered in escaping.test.mjs; these target gaps around them.
import test from "node:test";
import assert from "node:assert/strict";
import { GENESIS_HASH, hashRound } from "../swarm/runner.mjs";
import { chainStatus, escapeHtml, renderViewer, securityMetaTags, validateResult } from "./render.mjs";

const agent = (id, name, extra = {}) => ({ id, name, personality: "P", traits: {}, ...extra });
const ev = (id, round, agentId, text, extra = {}) => ({ id, round, agentId, text, kind: "post", ...extra });

function makeResult(events, rounds = Math.max(0, ...events.map((e) => e.round)), seed = 7) {
  const roundHashes = [];
  let prev = GENESIS_HASH;
  for (let r = 1; r <= rounds; r += 1) {
    prev = hashRound(prev, events.filter((e) => e.round === r));
    roundHashes.push(prev);
  }
  return { seed, rounds, events, roundHashes };
}

// The page's only elements besides text: strip the one style block and every
// escaped text node, then no tag may remain except the ones the template emits.
const ALLOWED_TAGS = new Set([
  "!doctype", "html", "head", "meta", "title", "style", "body", "main", "h1", "h2", "p", "span",
  "table", "thead", "tbody", "tr", "th", "td", "section", "div",
]);
function tagNames(html) {
  const noStyle = html.replace(/<style>[\s\S]*?<\/style>/, "");
  return [...noStyle.matchAll(/<\/?([a-zA-Z!][\w-]*)/g)].map((m) => m[1].toLowerCase());
}

test("a hostile </style> or <script> in any field adds no tag the template did not emit", () => {
  const bad = "</style><script>alert(1)</script><img src=x onerror=alert(1)>";
  const a = agent("a", bad, { personality: bad, traits: { [bad]: bad } });
  const html = renderViewer(makeResult([ev("e1", 1, "a", bad), ev("e2", 1, "a", bad, { kind: "reply", replyTo: "e1" })], 1, bad), [a]);
  for (const t of tagNames(html)) assert.ok(ALLOWED_TAGS.has(t), `unexpected tag <${t}>`);
  assert.equal(html.split("<style>").length, 2);
  assert.equal(html.split("</style>").length, 2);
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(1\)>/);
});

test("javascript: and data: URL text stays inert text: the page has no href, src attribute or form", () => {
  const url = "javascript:alert(1)";
  const html = renderViewer(
    makeResult([ev("e1", 1, "a", `[x](${url}) data:text/html;base64,PHNjcmlwdD4= ${url}`)], 1, url),
    [agent("a", url, { personality: url, traits: { href: url } })],
  );
  assert.doesNotMatch(html, /<a[\s>]|\shref=|\ssrc=|<form|<iframe|<img|<link/i);
  assert.ok(html.includes(url));
});

test("backticks, a lone ampersand entity lookalike and quotes in a name are escaped exactly once", () => {
  const name = "`a` &amp; &lt;b&gt; \"q\" 'r'";
  const html = renderViewer(makeResult([ev("e1", 1, "a", name)]), [agent("a", name)]);
  const escaped = "`a` &amp;amp; &amp;lt;b&amp;gt; &quot;q&quot; &#39;r&#39;";
  assert.ok(html.includes(`<span class="author">${escaped}</span> ${escaped}`));
  assert.doesNotMatch(html, /<td>[^<]*["'][^<]*<\/td>/);
});

test("NUL bytes and bidi controls in a trait key, trait value and seed become U+FFFD", () => {
  const dirty = "a\u0000b‮c⁦d‏e";
  const html = renderViewer(makeResult([ev("e1", 1, "a", "x")], 1, dirty), [agent("a", "Ann", { traits: { [dirty]: dirty } })]);
  assert.ok(html.includes("a�b�c�d�e: a�b�c�d�e"));
  assert.ok(html.includes("seed: a�b�c�d�e "));
  assert.doesNotMatch(html, /[\u0000‮⁦‏]/);
});

test("an event text of only unsafe characters renders as replacement characters, not an empty post", () => {
  const html = renderViewer(makeResult([ev("e1", 1, "a", "\u0000‮")]), [agent("a", "Ann")]);
  assert.ok(html.includes('<span class="author">Ann</span> ��</p>'));
});

test("an empty event text is a valid post and renders an empty body after the author", () => {
  const html = renderViewer(makeResult([ev("e1", 1, "a", "")]), [agent("a", "Ann")]);
  assert.ok(html.includes('<span class="author">Ann</span> </p>'));
  assert.match(html, /1 post\b/);
});

test("a roster of one agent with a bare {id, name} renders a row with two empty cells and no stray words", () => {
  const html = renderViewer(makeResult([ev("e1", 1, "a", "hi")]), [{ id: "a", name: "Ann" }]);
  assert.ok(html.includes("<tr><td>Ann</td><td></td><td></td></tr>"));
  assert.doesNotMatch(html, /undefined|null|NaN|\[object Object\]/);
});

test("wrong-typed personality (number, array, boolean) is stringified by the module, never dropped or crashed", () => {
  const rows = [
    [42, "42"],
    [["x", "<y>"], "x,&lt;y&gt;"],
    [false, "false"],
    [0, "0"],
  ];
  for (const [personality, shown] of rows) {
    const html = renderViewer(makeResult([ev("e1", 1, "a", "hi")]), [agent("a", "Ann", { personality })]);
    assert.ok(html.includes(`<td>Ann</td><td>${shown}</td>`), `personality ${JSON.stringify(personality)}`);
  }
});

test("an array in the traits slot is treated as an object with index keys: '0: a, 1: b'", () => {
  const html = renderViewer(makeResult([ev("e1", 1, "a", "hi")]), [agent("a", "Ann", { traits: ["a", "b"] })]);
  assert.ok(html.includes("<td>0: a, 1: b</td>"));
});

test("a seed that is an array or a boolean is shown as its string form, not hidden behind 'unknown'", () => {
  const meta = (seed) => renderViewer({ ...makeResult([ev("e1", 1, "a", "x")]), seed }, [agent("a", "Ann")]).match(/seed: (.*?) ·/)[1];
  assert.equal(meta([1, 2]), "1,2");
  assert.equal(meta(false), "false");
  assert.equal(meta(null), "unknown");
  assert.equal(meta(undefined), "unknown");
});

test("a missing or non-numeric result.rounds is ignored: round count comes from roundHashes", () => {
  const base = makeResult([ev("e1", 1, "a", "x"), ev("e2", 2, "a", "y")]);
  for (const rounds of [undefined, "many", NaN, -3, null]) {
    const html = renderViewer({ ...base, rounds }, [agent("a", "Ann")]);
    assert.match(html, /2 rounds · 2 posts/);
    assert.doesNotMatch(html, /NaN|undefined|\[object Object\]/);
  }
});

test("an event with no kind, no id and extra junk fields renders as a plain post and the junk never appears", () => {
  const base = makeResult([{ round: 1, agentId: "a", text: "hello" }]);
  base.events[0].secret = "LEAKME";
  const html = renderViewer({ ...base, events: base.events }, [agent("a", "Ann")]);
  assert.ok(html.includes('<p class="post"><span class="author">Ann</span> hello</p>'));
  assert.doesNotMatch(html, /LEAKME/);
});

test("a reply that points forward to a later event still shows the arrow for the target author", () => {
  const events = [
    ev("e1", 1, "a", "first", { kind: "reply", replyTo: "e2" }),
    ev("e2", 1, "b", "second"),
  ];
  const html = renderViewer(makeResult(events), [agent("a", "Ann"), agent("b", "Bob")]);
  assert.ok(html.includes('<span class="author">Ann</span> <span class="meta">&rarr; Bob</span> first'));
});

test("replyTo naming an Object.prototype key finds no target and renders a plain post", () => {
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const events = [ev("e1", 1, "a", "hi", { kind: "reply", replyTo: key })];
    const html = renderViewer(makeResult(events), [agent("a", "Ann")]);
    assert.ok(html.includes('<span class="author">Ann</span> hi</p>'), key);
    assert.doesNotMatch(html, /&rarr;/);
  }
});

test("agents whose ids are Object.prototype keys render by their own names", () => {
  const agents = [agent("__proto__", "Proto"), agent("constructor", "Ctor")];
  const html = renderViewer(makeResult([ev("e1", 1, "__proto__", "x"), ev("e2", 1, "constructor", "y")]), agents);
  assert.ok(html.includes('<span class="author">Proto</span> x'));
  assert.ok(html.includes('<span class="author">Ctor</span> y'));
});

test("two agents sharing an id: events show the later agent's name, both rows are listed", () => {
  const html = renderViewer(makeResult([ev("e1", 1, "a", "x")]), [agent("a", "First"), agent("a", "Second")]);
  assert.ok(html.includes('<span class="author">Second</span> x'));
  assert.ok(html.includes("<td>First</td>") && html.includes("<td>Second</td>"));
});

test("an event agentId of the wrong type (number for a string id) is refused as an unknown agent", () => {
  const run = makeResult([ev("e1", 1, "1", "x")]);
  run.events[0].agentId = 1;
  assert.throws(() => renderViewer(run, [agent("1", "Ann")]), /unknown agent 1/);
});

test("wrong-typed event text (number, array, null) is refused, not stringified into the page", () => {
  for (const text of [5, ["a"], null, undefined, { toString: () => "x" }]) {
    const run = makeResult([ev("e1", 1, "a", "ok")]);
    run.events[0].text = text;
    assert.throws(() => renderViewer(run, [agent("a", "Ann")]), /each event needs string text/);
  }
});

test("a non-integer or non-finite event round is refused", () => {
  for (const round of [1.5, NaN, Infinity, "1", null, undefined]) {
    const run = makeResult([ev("e1", 1, "a", "ok")]);
    run.events[0].round = round;
    assert.throws(() => renderViewer(run, [agent("a", "Ann")]), TypeError);
  }
});

test("a 2 MB name and event text render whole, once per use", () => {
  const big = "x".repeat(2 * 1024 * 1024);
  const html = renderViewer(makeResult([ev("e1", 1, "a", big)]), [agent("a", big)]);
  assert.equal(html.split(big).length - 1, 3); // table cell, author span, post text
  assert.ok(html.endsWith("</html>\n"));
});

test("a long run of '<' expands to the exact escaped length", () => {
  const s = "<".repeat(100_000);
  const html = renderViewer(makeResult([ev("e1", 1, "a", s)]), [agent("a", "Ann")]);
  assert.ok(html.includes(`Ann</span> ${"&lt;".repeat(100_000)}</p>`));
});

test("escaped output is identical for equal input built in a different key order", () => {
  const a = { id: "a", name: "Ann", personality: "P", traits: { x: 1, y: 2 } };
  const b = { traits: { x: 1, y: 2 }, personality: "P", name: "Ann", id: "a" };
  const events = [ev("e1", 1, "a", "hi")];
  const run = makeResult(events);
  const reordered = { roundHashes: run.roundHashes, events: [{ text: "hi", kind: "post", agentId: "a", round: 1, id: "e1" }], seed: 7, rounds: 1 };
  assert.equal(renderViewer(run, [a]), renderViewer(reordered, [b]));
});

test("a tampered chain with hostile text still renders; the label stays the fixed template string", () => {
  const run = makeResult([ev("e1", 1, "a", "hi")]);
  run.events[0].text = "<b>tampered</b>";
  const html = renderViewer(run, [agent("a", "Ann")]);
  assert.ok(html.includes('<span class="chain-bad">chain: broken at round 1</span>'));
  assert.ok(html.includes("&lt;b&gt;tampered&lt;/b&gt;"));
});

test("a stored hash is only ever 64 hex characters, so a hostile hash string is refused up front", () => {
  const run = makeResult([ev("e1", 1, "a", "hi")]);
  run.roundHashes[0] = "<script>" + "a".repeat(56);
  assert.throws(() => renderViewer(run, [agent("a", "Ann")]), /round 1 hash must be 64 lowercase hex/);
  assert.throws(() => validateResult({ events: [], roundHashes: [123] }, [agent("a", "Ann")]), /round 1 hash/);
});

test("securityMetaTags: the CSP hash tracks the exact css bytes and the output has no raw quote breakout", () => {
  const one = securityMetaTags("a{}");
  const two = securityMetaTags("a{} ");
  assert.notEqual(one, two);
  assert.equal(securityMetaTags("a{}"), one);
  assert.match(one, /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]{43}='; /);
  assert.match(one, /\n<meta name="referrer" content="no-referrer">$/);
});

test("escapeHtml on wrong-typed input never yields '[object' text for arrays and handles symbols-free primitives", () => {
  assert.equal(escapeHtml([1, "<"]), "1,&lt;");
  assert.equal(escapeHtml(12n), "12");
  assert.equal(escapeHtml(-0), "0");
  assert.equal(escapeHtml(""), "");
});

test("chainStatus on an empty result is ok", () => {
  assert.deepEqual(chainStatus({ events: [], roundHashes: [] }), { ok: true, brokenRound: null });
});

test("rendering the same hostile input three times is byte-identical", () => {
  const bad = "<&\"'`\u0000‮>";
  const run = makeResult([ev("e1", 1, "a", bad), ev("e2", 2, "a", bad, { kind: "reply", replyTo: "e1" })], 2, bad);
  const agents = [agent("a", bad, { personality: bad, traits: { [bad]: bad } })];
  const first = renderViewer(run, agents);
  assert.equal(renderViewer(run, agents), first);
  assert.equal(renderViewer(structuredClone(run), structuredClone(agents)), first);
});
