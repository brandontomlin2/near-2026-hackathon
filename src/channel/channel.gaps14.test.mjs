import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ChannelError, createChannel, loadChannel } from "./channel.mjs";

const failure = (code, message) => (err) => err instanceof ChannelError && err.code === code && err.message === message;

test("each rejected post says what is wrong", () => {
  const ch = createChannel();
  ch.post({ round: 2, author: "aloof", text: "first" });
  const post = (fields) => () => ch.post({ round: 2, author: "aloof", text: "x", ...fields });
  assert.throws(post({ round: "2" }), failure("bad_post", "round must be an integer >= 0"));
  assert.throws(post({ round: 1 }), failure("bad_post", "round 1 is before the last round 2"));
  assert.throws(post({ author: "Aloof" }), failure("bad_post", "author must match /^[a-z][a-z0-9_-]{0,31}$/"));
  assert.throws(post({ text: "  " }), failure("bad_post", "text must be a non-empty string"));
  assert.throws(post({ text: 7 }), failure("bad_post", "text must be a non-empty string"));
  assert.throws(post({ text: "y".repeat(501) }), failure("bad_post", "text is longer than 500 characters"));
  assert.throws(post({ replyTo: 5 }), failure("bad_post", "replyTo 5 is not an existing seq"));
  assert.throws(post({ replyTo: null }), failure("bad_post", "replyTo null is not an existing seq"));
  assert.equal(ch.size, 1);
});

test("post with no argument at all is a bad_post, not a TypeError", () => {
  assert.throws(() => createChannel().post(), failure("bad_post", "round must be an integer >= 0"));
});

test("an entry has a replyTo key only when it is a reply, and the JSONL line lists keys alphabetically", () => {
  const ch = createChannel();
  const root = ch.post({ round: 0, author: "aloof", text: "root" });
  const reply = ch.post({ round: 0, author: "social", text: "re", replyTo: 1 });
  assert.deepEqual(Object.keys(root), ["seq", "round", "author", "text"]);
  assert.deepEqual(Object.keys(reply), ["seq", "round", "author", "text", "replyTo"]);
  assert.equal(
    ch.toJSONL(),
    '{"author":"aloof","round":0,"seq":1,"text":"root"}\n{"author":"social","replyTo":1,"round":0,"seq":2,"text":"re"}\n',
  );
});

test("thread returns copies, stops at the requested seq and a root is a thread of one", () => {
  const ch = createChannel();
  ch.post({ round: 0, author: "aloof", text: "root" });
  ch.post({ round: 0, author: "social", text: "mid", replyTo: 1 });
  ch.post({ round: 0, author: "skeptic", text: "leaf", replyTo: 2 });
  assert.deepEqual(ch.thread(2).map((e) => e.seq), [1, 2], "later replies are not part of the chain");
  assert.deepEqual(ch.thread(1).map((e) => e.text), ["root"]);
  ch.thread(3)[0].text = "tampered";
  assert.equal(ch.read({ author: "aloof" })[0].text, "root");
});

test("thread of an unknown seq names it", () => {
  const ch = createChannel();
  assert.throws(() => ch.thread(4), failure("unknown_seq", "unknown seq 4"));
  assert.throws(() => ch.thread("1"), failure("unknown_seq", "unknown seq 1"));
});

test("length and size both follow the log", () => {
  const ch = createChannel();
  assert.deepEqual([ch.size, ch.length], [0, 0]);
  ch.post({ round: 0, author: "aloof", text: "a" });
  assert.deepEqual([ch.size, ch.length], [1, 1]);
});

test("the digest of a round with no entries is the hash of an empty list and differs from a busy round's", () => {
  const ch = createChannel();
  ch.post({ round: 1, author: "aloof", text: "a" });
  assert.equal(ch.roundDigest(0), createHash("sha256").update("[]").digest("hex"));
  assert.notEqual(ch.roundDigest(1), ch.roundDigest(0));
});

test("editing a post's text changes that round's digest", () => {
  const make = (text) => {
    const ch = createChannel();
    ch.post({ round: 0, author: "aloof", text });
    return ch.roundDigest(0);
  };
  assert.notEqual(make("one"), make("two"));
  assert.equal(make("one"), make("one"));
});

test("loadChannel names the broken line or entry", () => {
  const ok = '{"seq":1,"round":0,"author":"aloof","text":"a"}';
  assert.throws(() => loadChannel(`${ok}\n{"seq":"2","round":0,"author":"aloof","text":"b"}\n`), failure("bad_log", "entry 2 has a missing or out-of-order seq"));
  assert.throws(() => loadChannel(`${ok}\n{oops}\n`), failure("bad_log", "line 2 is not valid JSON"));
  assert.throws(() => loadChannel(`${ok}\n\n`), failure("bad_log", "line 2 is not valid JSON"));
  assert.throws(
    () => loadChannel(`${ok}\n{"seq":2,"round":0,"author":"aloof","text":"b","replyTo":null}\n`),
    failure("bad_log", "entry 2 is invalid: replyTo null is not an existing seq"),
  );
  assert.throws(() => loadChannel("[]\n"), failure("bad_log", "entry 1 has a missing or out-of-order seq"));
});

test("loadChannel without an id is the shared channel, and a log with CRLF line ends and no final newline still loads", () => {
  const log = '{"seq":1,"round":0,"author":"aloof","text":"a"}\r\n{"seq":2,"round":1,"author":"social","text":"b","replyTo":1}';
  const ch = loadChannel(log);
  assert.equal(ch.id, "shared");
  assert.deepEqual(ch.entries().map((e) => e.text), ["a", "b"]);
  assert.ok(!ch.toJSONL().includes("\r"));
  assert.ok(ch.toJSONL().endsWith("}\n"));
});
