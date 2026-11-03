import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { UNSAFE_CHARS, capUtf8Bytes, replaceUnsafeChars } from "./text.mjs";

const FFFD = "�";

describe("replaceUnsafeChars", () => {
  it("stringifies non-string input", () => {
    assert.equal(replaceUnsafeChars(42), "42");
    assert.equal(replaceUnsafeChars(null), "null");
    assert.equal(replaceUnsafeChars(undefined), "undefined");
    assert.equal(replaceUnsafeChars({}), "[object Object]");
    assert.equal(replaceUnsafeChars({ toString: () => "a\u0000b" }), `a${FFFD}b`);
  });

  it("keeps tab, LF and CR", () => {
    assert.equal(replaceUnsafeChars("a\tb\nc\rd\r\n"), "a\tb\nc\rd\r\n");
  });

  it("replaces NUL, DEL and the other C0 controls", () => {
    assert.equal(replaceUnsafeChars("a\u0000b"), `a${FFFD}b`);
    assert.equal(replaceUnsafeChars("a\u007fb"), `a${FFFD}b`);
    assert.equal(replaceUnsafeChars("\u000b\u000c\u0001\u0008\u000e\u001f"), FFFD.repeat(6));
  });

  it("neutralises an ANSI clear-screen sequence", () => {
    assert.equal(replaceUnsafeChars("\u001b[2J"), `${FFFD}[2J`);
  });

  it("replaces C1 controls", () => {
    assert.equal(replaceUnsafeChars("\u0085"), FFFD);
    assert.equal(replaceUnsafeChars("\u009b"), FFFD);
    assert.equal(replaceUnsafeChars("\u0080\u009f"), FFFD + FFFD);
  });

  it("replaces bidi overrides, isolates and marks", () => {
    for (const ch of ["‮", "‪", "‭", "⁦", "⁧", "⁨", "⁩", "‎", "‏", "؜"]) {
      assert.equal(replaceUnsafeChars(`a${ch}b`), `a${FFFD}b`, `U+${ch.codePointAt(0).toString(16)}`);
    }
  });

  it("neutralises an OSC hyperlink sequence", () => {
    assert.equal(replaceUnsafeChars("\u001b]8;;http://x\u0007"), `${FFFD}]8;;http://x${FFFD}`);
  });

  it("preserves length in UTF-16 units", () => {
    const input = "a\u0000‮\u001b[2J\u0085\u{1F525}é";
    assert.equal(replaceUnsafeChars(input).length, input.length);
  });

  it("passes emoji, accents, CJK and zero-width joiner through unchanged", () => {
    const safe = "\u{1F525} café 日本語 👨‍👩‍👧 ok";
    assert.equal(replaceUnsafeChars(safe), safe);
  });

  it("returns the empty string for empty input", () => {
    assert.equal(replaceUnsafeChars(""), "");
  });

  it("exposes a global regex that gives the same result on repeated calls", () => {
    assert.equal(UNSAFE_CHARS.global, true);
    const input = "a\u0000b\u0000c";
    assert.equal(replaceUnsafeChars(input), replaceUnsafeChars(input));
    assert.equal(UNSAFE_CHARS.lastIndex, 0);
  });
});

describe("capUtf8Bytes", () => {
  it("rejects a negative, fractional, NaN or string maxBytes", () => {
    for (const bad of [-1, 1.5, NaN, "3", Infinity, undefined, null]) {
      assert.throws(() => capUtf8Bytes("abc", bad), RangeError, String(bad));
    }
  });

  it("returns an empty string for maxBytes 0", () => {
    assert.equal(capUtf8Bytes("abc", 0), "");
  });

  it("returns text at or under the limit unchanged", () => {
    assert.equal(capUtf8Bytes("abc", 3), "abc");
    assert.equal(capUtf8Bytes("abc", 100), "abc");
    assert.equal(capUtf8Bytes("é", 2), "é");
  });

  it("cuts ASCII at the exact byte", () => {
    assert.equal(capUtf8Bytes("abcdef", 4), "abcd");
    assert.equal(capUtf8Bytes("abcdef", 1), "a");
  });

  it("drops a 2-byte character instead of splitting it", () => {
    assert.equal(capUtf8Bytes("aé", 2), "a");
    assert.equal(capUtf8Bytes("aé", 3), "aé");
    assert.equal(capUtf8Bytes("é", 1), "");
  });

  it("never splits a 3-byte character", () => {
    assert.equal(capUtf8Bytes("日本", 5), "日");
    assert.equal(capUtf8Bytes("日本", 2), "");
  });

  it("never splits a 4-byte emoji", () => {
    assert.equal(capUtf8Bytes("\u{1F525}", 3), "");
    assert.equal(capUtf8Bytes("a\u{1F525}", 4), "a");
    assert.equal(capUtf8Bytes("a\u{1F525}", 5), "a\u{1F525}");
  });

  it("leaves a valid string when cutting a combining sequence", () => {
    const cut = capUtf8Bytes("éx", 2);
    assert.equal(cut, "e");
    assert.equal(Buffer.from(cut, "utf8").toString("utf8"), cut);
  });

  it("keeps the empty string empty", () => {
    assert.equal(capUtf8Bytes("", 0), "");
    assert.equal(capUtf8Bytes("", 10), "");
  });

  it("always fits the budget and returns a prefix, for every limit", () => {
    const samples = ["", "plain ascii", "aé", "é".repeat(5), "日本語テキスト", "a\u{1F525}b\u{1F525}", "éé", "👨‍👩‍👧x", "mix é 日 \u{1F525} z"];
    for (const text of samples) {
      const total = Buffer.byteLength(text, "utf8");
      for (let max = 0; max <= total + 1; max += 1) {
        const out = capUtf8Bytes(text, max);
        assert.ok(Buffer.byteLength(out, "utf8") <= max, `${JSON.stringify(text)} @${max} too long`);
        assert.ok(text.startsWith(out), `${JSON.stringify(text)} @${max} not a prefix`);
        assert.ok(!out.includes(FFFD) || text.includes(FFFD), "no replacement chars introduced");
      }
    }
  });
});
