import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, sha256Hex } from "../anchor/hash.mjs";
import { ChannelError, createChannel, loadChannel } from "./channel.mjs";

function codeOf(code) {
  return (err) => err instanceof ChannelError && err.code === code;
}

function sample() {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "  hello  " });
  ch.post({ round: 0, author: "chaotic", text: "boom", replyTo: 1 });
  ch.post({ round: 1, author: "social", text: "hi all", replyTo: 2 });
  ch.post({ round: 1, author: "skeptic", text: "prove it" });
  return ch;
}

test("post assigns seq and trims text", () => {
  const ch = sample();
  assert.deepEqual(ch.entries().map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(ch.entries()[0].text, "hello");
  assert.equal("replyTo" in ch.entries()[0], false);
  assert.equal(ch.entries()[1].replyTo, 1);
  assert.equal(ch.size, 4);
  assert.equal(ch.length, 4);
  assert.equal(ch.id, "shared");
});

test("post validation", () => {
  const ch = sample();
  const bad = (fields) => assert.throws(() => ch.post({ round: 1, author: "aloof", text: "x", ...fields }), codeOf("bad_post"));
  bad({ round: 0 });
  bad({ round: -1 });
  bad({ round: 1.5 });
  bad({ author: "Bad" });
  bad({ author: "" });
  bad({ author: "1abc" });
  bad({ text: "   " });
  bad({ text: "a".repeat(501) });
  bad({ replyTo: 99 });
  bad({ replyTo: 0 });
  assert.equal(ch.size, 4);
  ch.post({ round: 1, author: "aloof", text: "a".repeat(500) });
});

test("replyTo to a later round is rejected", () => {
  const ch = createChannel();
  ch.post({ round: 5, author: "aloof", text: "x" });
  assert.throws(() => ch.post({ round: 3, author: "aloof", text: "y", replyTo: 1 }), codeOf("bad_post"));
});

test("read filters", () => {
  const ch = sample();
  assert.equal(ch.read().length, 4);
  assert.deepEqual(ch.read({ round: 1 }).map((e) => e.seq), [3, 4]);
  assert.deepEqual(ch.read({ author: "chaotic" }).map((e) => e.seq), [2]);
  assert.deepEqual(ch.read({ since: 2 }).map((e) => e.seq), [3, 4]);
  assert.deepEqual(ch.read({ round: 0, since: 1 }).map((e) => e.seq), [2]);
});

test("returned entries are copies", () => {
  const ch = sample();
  ch.read()[0].text = "changed";
  ch.entries()[0].text = "changed";
  ch.thread(3)[0].text = "changed";
  const posted = ch.post({ round: 2, author: "aloof", text: "z" });
  posted.text = "changed";
  assert.equal(ch.read()[0].text, "hello");
  assert.equal(ch.entries()[4].text, "z");
});

test("thread is root first", () => {
  const ch = sample();
  assert.deepEqual(ch.thread(3).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(ch.thread(4).map((e) => e.seq), [4]);
  assert.throws(() => ch.thread(99), codeOf("unknown_seq"));
});

test("roundDigest", () => {
  const a = sample();
  const b = sample();
  assert.equal(a.roundDigest(0), b.roundDigest(0));
  assert.notEqual(a.roundDigest(0), a.roundDigest(1));
  assert.equal(createChannel().roundDigest(7), sha256Hex(canonicalJson([])));
  const c = createChannel();
  c.post({ round: 0, author: "aloof", text: "hello" });
  c.post({ round: 0, author: "chaotic", text: "BOOM", replyTo: 1 });
  assert.notEqual(c.roundDigest(0), a.roundDigest(0));
});

test("toJSONL and loadChannel round trip", () => {
  const ch = sample();
  const jsonl = ch.toJSONL();
  assert.equal(jsonl.split("\n").length, 5);
  assert.ok(jsonl.endsWith("\n"));
  const back = loadChannel(jsonl, { id: "copy" });
  assert.deepEqual(back.entries(), ch.entries());
  assert.equal(back.id, "copy");
  assert.equal(back.toJSONL(), jsonl);
  assert.equal(createChannel().toJSONL(), "");
  assert.equal(loadChannel("").size, 0);
});

test("loadChannel rejects bad logs", () => {
  const good = sample().toJSONL().split("\n");
  assert.throws(() => loadChannel("not json\n"), codeOf("bad_log"));
  assert.throws(() => loadChannel(`${good[0]}\n\n${good[1]}\n`), codeOf("bad_log"));
  assert.throws(() => loadChannel(`${good[1]}\n${good[0]}\n`), codeOf("bad_log"));
  assert.throws(() => loadChannel(`${good[0]}\n${good[0]}\n`), codeOf("bad_log"));
  assert.throws(() => loadChannel('{"seq":1,"round":0,"author":"BAD","text":"x"}\n'), codeOf("bad_log"));
  assert.throws(() => loadChannel("null\n"), codeOf("bad_log"));
  assert.throws(() => loadChannel(5), codeOf("bad_log"));
});
