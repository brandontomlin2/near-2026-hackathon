// Edge-case behaviour of the per-agent memory diff line (what `npm run demo` prints
// under "[2/5] memory"). Sheets are read from temp files the way a user's out/ dir holds them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { memoryDiffLine, sheetFacts } from "./memory-diff.mjs";

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "edge46-memdiff-")); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sheet = (enemy, friend, quote) => `Who I am: Test. Public enemy #1: ${enemy}. Ride-or-die: ${friend}. Signature quote: "${quote}". Receipts: 1 post.`;
const agentFrom = (id, ...texts) => ({ id, sheets: texts.map((t) => ({ sheet: t })) });

describe("memory diff: missing, empty and malformed input", () => {
  it("a missing sheet file is reported by the reader, not turned into a diff", () => {
    assert.throws(() => fs.readFileSync(path.join(dir, "nope.json"), "utf8"), { code: "ENOENT" });
  });

  it("an empty manifest file fails to parse, an empty agent still prints a line", () => {
    const f = path.join(dir, "empty.json");
    fs.writeFileSync(f, "");
    assert.throws(() => JSON.parse(fs.readFileSync(f, "utf8")), SyntaxError);
    assert.equal(memoryDiffLine({ id: "chaotic", sheets: [] }), "chaotic: no sheet yet");
  });

  it("malformed agents never throw and say what is missing", () => {
    assert.equal(memoryDiffLine(null), "agent: no sheet yet");
    assert.equal(memoryDiffLine(undefined), "agent: no sheet yet");
    assert.equal(memoryDiffLine({ id: "x" }), "x: no sheet yet");
    assert.equal(memoryDiffLine({ id: "x", sheets: "oops" }), "x: no sheet yet");
    assert.equal(memoryDiffLine({ id: "x", sheets: [null, {}] }), "x: enemy none, ride-or-die none, quote none");
  });

  it("non-string sheets and an empty sheet read as all none", () => {
    for (const s of ["", "   \n", 123, {}, null, undefined]) {
      assert.deepEqual(sheetFacts(s), { enemy: "none", friend: "none", quote: "none" });
    }
  });

  it("a quote label with only an opening quote mark is none", () => {
    assert.equal(sheetFacts('Signature quote: "').quote, "none");
    assert.equal(sheetFacts('Signature quote: "none".').quote, "none");
  });
});

describe("memory diff: identical, added and removed entries", () => {
  const a = sheet("Skeptic (4 fights)", "Social (2 warm moments)", "hi there");

  it("identical first and latest sheets print the value once, with no arrow", () => {
    const line = memoryDiffLine(agentFrom("chaotic", a, a));
    assert.equal(line, 'chaotic: enemy Skeptic (4 fights), ride-or-die Social (2 warm moments), quote "hi there"');
    assert.ok(!line.includes("->"));
  });

  it("a single sheet shows no arrow either", () => {
    assert.ok(!memoryDiffLine(agentFrom("aloof", a)).includes("->"));
  });

  it("an added enemy and friend show none -> value", () => {
    const first = "Public enemy #1: nobody yet. Ride-or-die: no one yet. Signature quote: none.";
    const line = memoryDiffLine(agentFrom("chaotic", first, a));
    assert.equal(line, 'chaotic: enemy none -> Skeptic (4 fights), ride-or-die none -> Social (2 warm moments), quote "hi there"');
  });

  it("a removed entry shows value -> none and the quote falls back to none", () => {
    const later = "Public enemy #1: nobody yet. Ride-or-die: none. Signature quote: none.";
    const line = memoryDiffLine(agentFrom("chaotic", a, later));
    assert.equal(line, "chaotic: enemy Skeptic (4 fights) -> none, ride-or-die Social (2 warm moments) -> none, quote none");
  });

  it("only the first and last sheets matter, not the ones between", () => {
    const mid = sheet("Mid", "Mid", "mid");
    const line = memoryDiffLine(agentFrom("c", a, mid, a));
    assert.ok(!line.includes("Mid"));
  });

  it("CRLF sheets read from a file give the same facts as LF", () => {
    const f = path.join(dir, "crlf.txt");
    fs.writeFileSync(f, a.replace(/\. /g, ".\r\n"));
    assert.deepEqual(sheetFacts(fs.readFileSync(f, "utf8")), sheetFacts(a));
  });
});

describe("memory diff: unicode and terminal safety", () => {
  it("keeps accents, CJK and emoji intact", () => {
    const f = sheetFacts("Public enemy #1: Ünïcödé 日本語 😈 (3 fights). Ride-or-die: 友達. Signature quote: “héllo wörld”.");
    assert.deepEqual(f, { enemy: "Ünïcödé 日本語 😈 (3 fights)", friend: "友達", quote: "héllo wörld" });
  });

  it("control and bidi characters become U+FFFD, so no escape sequence reaches the terminal", () => {
    const line = memoryDiffLine(agentFrom("a\u001b]0;pwn\u0007", "Public enemy #1: a\u001b[2Jb‮Z. Ride-or-die: x."));
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‮]/.test(line));
    assert.ok(line.includes("�"));
  });

  it("clipping a long emoji value never leaves a lone surrogate", () => {
    const { enemy } = sheetFacts(`Public enemy #1: ${"😈".repeat(100)}. Ride-or-die: x.`);
    assert.ok(enemy.endsWith("..."));
    assert.ok(enemy.isWellFormed(), "clipped text must be well-formed UTF-16");
    assert.ok(!enemy.includes("�"));
  });

  it("a long ASCII value is clipped to 80 characters with an ellipsis", () => {
    const { enemy } = sheetFacts(`Public enemy #1: ${"x".repeat(200)}. Ride-or-die: y.`);
    assert.equal(enemy.length, 80);
    assert.ok(enemy.endsWith("..."));
  });
});
