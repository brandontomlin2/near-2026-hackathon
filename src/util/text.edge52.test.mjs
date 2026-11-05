import assert from "node:assert/strict";
import { test } from "node:test";
import { capUtf8Bytes, replaceUnsafeChars } from "./text.mjs";

const FFFD = "�";

test("replaceUnsafeChars keeps look-alike separators and invisibles that are not in the unsafe set", () => {
  const kept = "  ​‌‍﻿ ­ ⁠⁥⁪";
  // U+206A..U+206F (deprecated format controls) and U+2065 are outside the listed ranges.
  assert.equal(replaceUnsafeChars(kept), kept);
});

test("replaceUnsafeChars replaces the Arabic letter mark and LRM/RLM but not neighbours", () => {
  assert.equal(replaceUnsafeChars("؜‎‏"), FFFD.repeat(3));
  assert.equal(replaceUnsafeChars("؛؝‍‐"), "؛؝‍‐");
});

test("replaceUnsafeChars leaves lone surrogates alone while replacing controls between them", () => {
  assert.equal(replaceUnsafeChars("\ud83d\u0000\ude00"), `\ud83d${FFFD}\ude00`);
  assert.equal(replaceUnsafeChars("\ud83d"), "\ud83d");
});

test("replaceUnsafeChars cleans a control inside a ZWJ family and a combining sequence without breaking either", () => {
  const family = "👨‍👩‍👧";
  assert.equal(replaceUnsafeChars(`${family}\u0007${family}`), `${family}${FFFD}${family}`);
  assert.equal(replaceUnsafeChars("é\u0085é"), `é${FFFD}é`);
});

test("replaceUnsafeChars: objects, arrays, symbols, negative zero and bigint go through String()", () => {
  assert.equal(replaceUnsafeChars({}), "[object Object]");
  assert.equal(replaceUnsafeChars([1, "\u0000"]), `1,${FFFD}`);
  assert.equal(replaceUnsafeChars(Symbol("s")), "Symbol(s)");
  assert.equal(replaceUnsafeChars(-0), "0");
  assert.equal(replaceUnsafeChars(12n), "12");
  assert.equal(replaceUnsafeChars(NaN), "NaN");
  assert.equal(replaceUnsafeChars(Infinity), "Infinity");
  assert.equal(replaceUnsafeChars(true), "true");
});

test("replaceUnsafeChars: an object whose toString yields a control is still cleaned", () => {
  assert.equal(replaceUnsafeChars({ toString: () => "a\u001b[2Jb" }), `a${FFFD}[2Jb`);
});

test("replaceUnsafeChars handles a megabyte of mixed text and keeps its length", () => {
  const unit = "ok\u0000‮🙂\t";
  const input = unit.repeat(150_000);
  const out = replaceUnsafeChars(input);
  assert.equal(out.length, input.length);
  assert.equal(out.slice(0, unit.length), `ok${FFFD}${FFFD}🙂\t`);
  assert.ok(!/[\u0000‮]/.test(out));
});

test("replaceUnsafeChars is safe to call after the shared regex was used with .test()", () => {
  // UNSAFE_CHARS is global; a stale lastIndex must not make the next call skip a match.
  const re = /[\u0000-\u0008]/g;
  re.test("\u0001");
  assert.equal(replaceUnsafeChars("\u0001\u0001"), FFFD + FFFD);
  assert.equal(replaceUnsafeChars("\u0001\u0001"), FFFD + FFFD);
});

test("capUtf8Bytes: MAX_SAFE_INTEGER and -0 are valid limits", () => {
  assert.equal(capUtf8Bytes("héllo 🙂", Number.MAX_SAFE_INTEGER), "héllo 🙂");
  assert.equal(capUtf8Bytes("abc", -0), "");
});

test("capUtf8Bytes rejects NaN, null, undefined, bigint, boolean and array limits with RangeError", () => {
  for (const bad of [NaN, null, undefined, 3n, true, [3], "3", 2.5, -1, -Infinity]) {
    assert.throws(() => capUtf8Bytes("abc", bad), RangeError, String(bad));
  }
});

test("capUtf8Bytes validates the limit before looking at the text", () => {
  assert.throws(() => capUtf8Bytes(null, -1), RangeError);
});

test("capUtf8Bytes throws a TypeError for non-string text", () => {
  for (const bad of [null, undefined, 123, {}, ["a"]]) {
    assert.throws(() => capUtf8Bytes(bad, 5), TypeError);
  }
});

test("capUtf8Bytes cuts a ZWJ family at a code point boundary, keeping whole emoji", () => {
  const family = "👨‍👩‍👧"; // 4+3+4+3+4 = 18 bytes
  assert.equal(Buffer.byteLength(family), 18);
  assert.equal(capUtf8Bytes(family, 18), family);
  assert.equal(capUtf8Bytes(family, 17), "👨‍👩‍");
  assert.equal(capUtf8Bytes(family, 14), "👨‍👩‍");
  assert.equal(capUtf8Bytes(family, 13), "👨‍👩");
  assert.equal(capUtf8Bytes(family, 7), "👨‍");
  assert.equal(capUtf8Bytes(family, 3), "");
  assert.equal(capUtf8Bytes(family, 4), "👨");
});

test("capUtf8Bytes drops a combining mark rather than splitting it, and may leave a bare base letter", () => {
  assert.equal(capUtf8Bytes("éx", 3), "é");
  assert.equal(capUtf8Bytes("éx", 2), "e");
  assert.equal(capUtf8Bytes("éx", 1), "e");
  assert.equal(capUtf8Bytes("́", 1), "");
});

test("capUtf8Bytes on a flag pair keeps a whole regional indicator, never half of one", () => {
  const flag = "🇯🇵";
  assert.equal(capUtf8Bytes(flag, 8), flag);
  assert.equal(capUtf8Bytes(flag, 7), "🇯");
  assert.equal(capUtf8Bytes(flag, 3), "");
});

test("capUtf8Bytes result is always well-formed UTF-8 text that round-trips", () => {
  const text = "a é € 😀 ‍ 日本語 é 🇯🇵";
  for (let max = 0; max <= Buffer.byteLength(text) + 1; max++) {
    const cut = capUtf8Bytes(text, max);
    assert.ok(Buffer.byteLength(cut) <= max);
    assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
    assert.ok(!cut.includes(FFFD));
  }
});

test("capUtf8Bytes on a very long string cuts exactly and fast", () => {
  const text = "€".repeat(400_000); // 3 bytes each
  const out = capUtf8Bytes(text, 1_000_001);
  assert.equal(out.length, 333_333);
  assert.equal(Buffer.byteLength(out), 999_999);
  assert.equal(capUtf8Bytes(text, 1_200_000), text);
});

test("capUtf8Bytes with a lone high surrogate before a character keeps going past it", () => {
  assert.equal(capUtf8Bytes("\ud83dab", 5), "\ud83dab");
  assert.equal(capUtf8Bytes("\ud83dab", 4), "\ud83da");
});
