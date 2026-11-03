import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../anchor/hash.mjs";
import { ChannelError, MAX_TEXT_LENGTH, createChannel, loadChannel } from "./channel.mjs";

function codeOf(code) {
  return (err) => err instanceof ChannelError && err.code === code;
}

const seqs = (entries) => entries.map((e) => e.seq);

// 1. Ordering

test("seq is 1..n in post order and read returns ascending seq for any filter", () => {
  const ch = createChannel();
  const authors = ["aloof", "chaotic", "social"];
  for (let i = 0; i < 9; i += 1) {
    const posted = ch.post({ round: Math.floor(i / 3), author: authors[i % 3], text: `m${i}` });
    assert.equal(posted.seq, i + 1);
  }
  const ascending = (list) => seqs(list).every((s, i, all) => i === 0 || all[i - 1] < s);
  assert.deepEqual(seqs(ch.read()), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(ascending(ch.read({ round: 1 })));
  assert.ok(ascending(ch.read({ author: "aloof" })));
  assert.ok(ascending(ch.read({ since: 2 })));
  assert.deepEqual(seqs(ch.read({ author: "aloof" })), [1, 4, 7]);
});

test("rounds may repeat or jump forward but never go back", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "a" });
  ch.post({ round: 0, author: "aloof", text: "b" });
  ch.post({ round: 5, author: "aloof", text: "c" });
  assert.deepEqual(ch.entries().map((e) => e.round), [0, 0, 5]);
  assert.throws(() => ch.post({ round: 3, author: "aloof", text: "d" }), codeOf("bad_post"));
  assert.equal(ch.size, 3);
});

test("round 0 is a valid first round", () => {
  const ch = createChannel();
  assert.equal(ch.post({ round: 0, author: "aloof", text: "a" }).round, 0);
});

test("a rejected post leaves size unchanged and does not leave a seq gap", () => {
  const ch = createChannel();
  ch.post({ round: 1, author: "aloof", text: "a" });
  assert.throws(() => ch.post({ round: 0, author: "aloof", text: "b" }), codeOf("bad_post"));
  assert.throws(() => ch.post({ round: 1, author: "aloof", text: "b", replyTo: 7 }), codeOf("bad_post"));
  assert.equal(ch.size, 1);
  const next = ch.post({ round: 1, author: "aloof", text: "c" });
  assert.equal(next.seq, 2);
  assert.deepEqual(seqs(ch.entries()), [1, 2]);
});

// 2. Limits

test("MAX_TEXT_LENGTH is 500 and trimming happens before the length check", () => {
  assert.equal(MAX_TEXT_LENGTH, 500);
  const ch = createChannel();
  const entry = ch.post({ round: 0, author: "aloof", text: `  \n\t${"a".repeat(500)}\n  ` });
  assert.equal(entry.text.length, 500);
  assert.equal(ch.entries()[0].text, "a".repeat(500));
  assert.throws(() => ch.post({ round: 0, author: "aloof", text: ` ${"a".repeat(501)} ` }), codeOf("bad_post"));
});

test("text length counts UTF-16 code units", () => {
  const ch = createChannel();
  const ok = ch.post({ round: 0, author: "aloof", text: "😀".repeat(250) });
  assert.equal(ok.text.length, 500);
  assert.throws(() => ch.post({ round: 0, author: "aloof", text: "😀".repeat(251) }), codeOf("bad_post"));
  assert.equal(ch.size, 1);
});

test("author length boundaries: 1 and 32 chars accepted, 33 rejected", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "a", text: "x" });
  ch.post({ round: 0, author: "a".repeat(32), text: "x" });
  assert.throws(() => ch.post({ round: 0, author: "a".repeat(33), text: "x" }), codeOf("bad_post"));
  assert.equal(ch.size, 2);
});

test("author may contain dash, underscore and digits after the first char", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "a-b_c9", text: "x" });
  assert.equal(ch.entries()[0].author, "a-b_c9");
  assert.throws(() => ch.post({ round: 0, author: "-ab", text: "x" }), codeOf("bad_post"));
  assert.throws(() => ch.post({ round: 0, author: "_ab", text: "x" }), codeOf("bad_post"));
  assert.throws(() => ch.post({ round: 0, author: "a b", text: "x" }), codeOf("bad_post"));
});

test("a 10_000-entry channel keeps seq correct and since slices exactly", () => {
  const ch = createChannel();
  for (let i = 0; i < 10_000; i += 1) ch.post({ round: 0, author: "aloof", text: `m${i}` });
  assert.equal(ch.size, 10_000);
  assert.equal(ch.entries()[9_999].seq, 10_000);
  assert.deepEqual(seqs(ch.read({ since: 9_990 })), [9_991, 9_992, 9_993, 9_994, 9_995, 9_996, 9_997, 9_998, 9_999, 10_000]);
});

// 3. Filters

test("since 0 returns everything and since size returns nothing", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "a" });
  ch.post({ round: 0, author: "aloof", text: "b" });
  assert.deepEqual(seqs(ch.read({ since: 0 })), [1, 2]);
  assert.deepEqual(ch.read({ since: ch.size }), []);
});

test("unknown round or author returns an empty list", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "a" });
  assert.deepEqual(ch.read({ round: 9 }), []);
  assert.deepEqual(ch.read({ author: "nobody" }), []);
});

test("round, author and since filters compose with AND", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "1" });
  ch.post({ round: 0, author: "chaotic", text: "2" });
  ch.post({ round: 1, author: "aloof", text: "3" });
  ch.post({ round: 1, author: "aloof", text: "4" });
  ch.post({ round: 1, author: "chaotic", text: "5" });
  assert.deepEqual(seqs(ch.read({ round: 1, author: "aloof" })), [3, 4]);
  assert.deepEqual(seqs(ch.read({ round: 1, author: "aloof", since: 3 })), [4]);
  assert.deepEqual(seqs(ch.read({ round: 0, author: "aloof", since: 1 })), []);
  assert.deepEqual(seqs(ch.read({ author: "chaotic", since: 2 })), [5]);
});

// 4. replyTo validation and thread

test("replyTo that is not a positive integer seq is rejected", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "root" });
  for (const bad of [1.5, "1", -1, null, Number.NaN]) {
    assert.throws(() => ch.post({ round: 0, author: "aloof", text: "r", replyTo: bad }), codeOf("bad_post"));
  }
  assert.equal(ch.size, 1);
});

test("replyTo may target the same round, any earlier seq, and the immediately preceding seq", () => {
  const ch = createChannel();
  ch.post({ round: 2, author: "aloof", text: "one" });
  ch.post({ round: 2, author: "aloof", text: "two" });
  ch.post({ round: 2, author: "aloof", text: "three", replyTo: 2 });
  ch.post({ round: 3, author: "aloof", text: "four", replyTo: 1 });
  assert.deepEqual(ch.entries().map((e) => e.replyTo), [undefined, undefined, 2, 1]);
  assert.throws(() => ch.post({ round: 3, author: "aloof", text: "self", replyTo: 5 }), codeOf("bad_post"));
});

test("a reply chain gives a root-first thread of length 3", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "root" });
  ch.post({ round: 0, author: "chaotic", text: "mid", replyTo: 1 });
  ch.post({ round: 1, author: "social", text: "leaf", replyTo: 2 });
  const chain = ch.thread(3);
  assert.equal(chain.length, 3);
  assert.deepEqual(chain.map((e) => e.text), ["root", "mid", "leaf"]);
});

test("thread rejects any seq that is not an existing positive integer", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "root" });
  for (const bad of [0, -1, 1.5, "1", undefined]) {
    assert.throws(() => ch.thread(bad), codeOf("unknown_seq"));
  }
});

// 5. Hostile text

test("hostile text is stored trimmed but otherwise verbatim and survives JSONL", () => {
  const texts = [
    "  <script>alert(1)</script> & <b>bold</b>  ",
    "ctrl\u0000\u0001\u001b[31m\u007f end",
    "lone\ud800surrogate",
    "line one\nline two\r\nline three",
  ];
  const ch = createChannel();
  texts.forEach((text) => ch.post({ round: 0, author: "aloof", text }));
  assert.deepEqual(ch.entries().map((e) => e.text), texts.map((t) => t.trim()));
  assert.equal(ch.entries()[0].text, "<script>alert(1)</script> & <b>bold</b>");

  const jsonl = ch.toJSONL();
  assert.equal(jsonl.split("\n").length, texts.length + 1);
  assert.ok(jsonl.endsWith("\n"));
  const back = loadChannel(jsonl);
  assert.deepEqual(back.entries(), ch.entries());
  assert.equal(back.toJSONL(), jsonl);
});

// 6. createChannel config

test("createChannel rejects blank or non-string ids with bad_config", () => {
  for (const id of ["", "   ", 5, null]) {
    assert.throws(() => createChannel({ id }), codeOf("bad_config"));
  }
});

test("createChannel rejects non-array entries with bad_log", () => {
  assert.throws(() => createChannel({ entries: {} }), codeOf("bad_log"));
  assert.throws(() => createChannel({ entries: "abc" }), codeOf("bad_log"));
});

test("an entry with unknown extra fields loads but the extra field is dropped", () => {
  const ch = createChannel({
    entries: [{ seq: 1, round: 0, author: "aloof", text: "hi", extra: "secret-marker", ts: 123 }],
  });
  assert.equal(ch.size, 1);
  assert.equal("extra" in ch.entries()[0], false);
  assert.equal(ch.toJSONL().includes("secret-marker"), false);
  assert.equal(ch.toJSONL(), '{"author":"aloof","round":0,"seq":1,"text":"hi"}\n');
});

// 7. ChannelError

test("ChannelError name, default code and cause handling", () => {
  const plain = new ChannelError("boom");
  assert.equal(plain.name, "ChannelError");
  assert.equal(plain.code, "channel_error");
  assert.equal("cause" in plain, false);
  assert.ok(plain instanceof Error);
  const root = new Error("root");
  const withCause = new ChannelError("boom", { code: "x", cause: root });
  assert.equal(withCause.code, "x");
  assert.equal(withCause.cause, root);
});

test("loadChannel on bad JSON sets cause to a SyntaxError", () => {
  assert.throws(
    () => loadChannel("{nope\n"),
    (err) => codeOf("bad_log")(err) && err.cause instanceof SyntaxError && /line 1/.test(err.message),
  );
});

test("loadChannel on an invalid entry sets a bad_post cause and names the entry number", () => {
  const good = '{"seq":1,"round":0,"author":"aloof","text":"ok"}';
  const bad = '{"seq":2,"round":0,"author":"BAD","text":"x"}';
  assert.throws(
    () => loadChannel(`${good}\n${bad}\n`),
    (err) =>
      codeOf("bad_log")(err) &&
      /entry 2/.test(err.message) &&
      err.cause instanceof ChannelError &&
      err.cause.code === "bad_post",
  );
});

// 8. Determinism and digest isolation

function build(extra = false) {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "a" });
  ch.post({ round: 0, author: "chaotic", text: "b", replyTo: 1 });
  if (extra) ch.post({ round: 1, author: "social", text: "c" });
  return ch;
}

test("same posts give identical JSONL and round digests", () => {
  const a = build(true);
  const b = build(true);
  assert.equal(a.toJSONL(), b.toJSONL());
  for (const round of [0, 1, 2]) assert.equal(a.roundDigest(round), b.roundDigest(round));
});

test("posting into round 1 does not change the digest of round 0", () => {
  assert.equal(build(false).roundDigest(0), build(true).roundDigest(0));
});

test("roundDigest equals sha256 of the canonical JSON of that round's entries", () => {
  const ch = build(true);
  for (const round of [0, 1]) {
    assert.equal(ch.roundDigest(round), sha256Hex(canonicalJson(ch.entries().filter((e) => e.round === round))));
  }
  assert.equal(ch.roundDigest(9), sha256Hex(canonicalJson([])));
  assert.equal(ch.roundDigest(9), createChannel().roundDigest(0));
});

// 9. Copies

test("mutating the object passed to post does not change the log", () => {
  const ch = createChannel();
  const input = { round: 0, author: "aloof", text: "orig" };
  ch.post(input);
  input.text = "changed";
  input.round = 9;
  input.author = "zed";
  assert.deepEqual(ch.entries(), [{ seq: 1, round: 0, author: "aloof", text: "orig" }]);
});

test("mutating the entries array passed to createChannel does not change the channel", () => {
  const entries = [{ seq: 1, round: 0, author: "aloof", text: "orig" }];
  const ch = createChannel({ entries });
  entries[0].text = "changed";
  entries.push({ seq: 2, round: 0, author: "aloof", text: "more" });
  assert.equal(ch.size, 1);
  assert.equal(ch.entries()[0].text, "orig");
});

test("mutating a post() return value or the entries() array does not change the log", () => {
  const ch = createChannel();
  const posted = ch.post({ round: 0, author: "aloof", text: "orig" });
  posted.text = "changed";
  const list = ch.entries();
  list.length = 0;
  assert.equal(ch.size, 1);
  assert.equal(ch.entries()[0].text, "orig");
});

// 10. id

test("id is a plain writable property: assigning it changes it", () => {
  // Documents current behavior: the channel object is not frozen and id is not
  // a getter, so callers can reassign it.
  const ch = createChannel({ id: "first" });
  ch.id = "x";
  assert.equal(ch.id, "x");
});
