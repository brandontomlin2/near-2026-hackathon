// Boundaries of the unsafe-character class and the byte cap.
import test from "node:test";
import assert from "node:assert/strict";
import { capUtf8Bytes, replaceUnsafeChars } from "./text.mjs";

const cp = (n) => String.fromCodePoint(n);

test("replaceUnsafeChars: the first code point on each side of every range is decided correctly", () => {
  const replaced = [0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x9f, 0x61c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069];
  const kept = [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0xa0, 0x61b, 0x61d, 0x200b, 0x200d, 0x202f, 0x2065, 0x206a, 0x2028, 0xfeff];
  for (const n of replaced) assert.equal(replaceUnsafeChars(`a${cp(n)}b`), "a�b", `U+${n.toString(16)} should be replaced`);
  for (const n of kept) assert.equal(replaceUnsafeChars(`a${cp(n)}b`), `a${cp(n)}b`, `U+${n.toString(16)} should be kept`);
});

test("replaceUnsafeChars: null, undefined and numbers are stringified", () => {
  assert.equal(replaceUnsafeChars(null), "null");
  assert.equal(replaceUnsafeChars(undefined), "undefined");
  assert.equal(replaceUnsafeChars(0), "0");
});

test("replaceUnsafeChars replaces each unsafe character separately, not a run as one", () => {
  assert.equal(replaceUnsafeChars("\u0000\u0001‮"), "���");
});

test("capUtf8Bytes: Infinity is not a valid limit and a lone surrogate counts as its 3-byte encoding", () => {
  assert.throws(() => capUtf8Bytes("abc", Infinity), RangeError);
  assert.equal(capUtf8Bytes("a\uD800b", 3), "a", "a lone surrogate encodes to 3 bytes, so it does not fit in the remaining 2");
  assert.equal(capUtf8Bytes("a\uD800b", 4), "a\uD800");
});

test("capUtf8Bytes: exactly at the limit is returned as the same string, one under cuts the last character", () => {
  const s = "ab€"; // 5 bytes
  assert.equal(capUtf8Bytes(s, 5), s);
  assert.equal(capUtf8Bytes(s, 4), "ab");
  assert.equal(capUtf8Bytes(s, 2), "ab");
  assert.equal(capUtf8Bytes(s, 1), "a");
});
