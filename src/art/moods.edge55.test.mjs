// Edge cases for the mood registry and classifier that moods.test.mjs and
// moods.edges.test.mjs do not cover: prototype keys, immutability, interleaved
// determinism, h+m+ / source? boundaries, surrogate pairs, curly apostrophes,
// more non-string inputs and pathological long inputs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as ns from "./moods.mjs";
import { MOODS, DEFAULT_MOOD, assertMood, moodForText } from "./moods.mjs";

const cases = (list) => {
  for (const [text, want] of list) assert.equal(moodForText(text), want, JSON.stringify(text));
};

// CPU time, not wall time, so a loaded machine does not cause flakes.
const cpuMs = (fn) => {
  const start = process.cpuUsage();
  const out = fn();
  const c = process.cpuUsage(start);
  return { out, ms: (c.user + c.system) / 1000 };
};

describe("assertMood: values that must be rejected", () => {
  test("Object.prototype keys are not moods", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype", "length", "0", "includes", "at"]) {
      assert.throws(() => assertMood(key), { message: `unknown mood: ${key}` }, key);
    }
  });

  test("case variants and padded strings are rejected, not normalised", () => {
    for (const bad of ["Hype", "HYPE", "hYpE", " hype", "hype ", "\thype", "hype\n", " hype", "hy pe", "neutral\u0000", "shade,shook"]) {
      assert.throws(() => assertMood(bad), /unknown mood/, JSON.stringify(bad));
    }
  });

  test("null, empty string, numbers, booleans, arrays and objects are rejected", () => {
    const bads = [null, "", 0, 1, -1, 1.5, NaN, Infinity, true, false, [], [""], ["hype"], [["hype"]], {}, { mood: "hype" }, () => "hype", 1n, Object.create(null), Object.create({ toString: () => "hype" })];
    for (const bad of bads) assert.throws(() => assertMood(bad), (e) => e instanceof Error, String(typeof bad));
  });

  test("the error names the offending value", () => {
    assert.throws(() => assertMood("angry"), { message: "unknown mood: angry" });
    assert.throws(() => assertMood(null), { message: "unknown mood: null" });
    assert.throws(() => assertMood(""), { message: "unknown mood: " });
    assert.throws(() => assertMood(7), { message: "unknown mood: 7" });
    assert.throws(() => assertMood(["hype"]), { message: "unknown mood: hype" });
  });

  test("only undefined falls back to the default; null does not", () => {
    assert.equal(assertMood(undefined), DEFAULT_MOOD);
    assert.equal(assertMood(), DEFAULT_MOOD);
    assert.throws(() => assertMood(null), /unknown mood/);
  });

  test("an accepted mood is returned as the exact primitive string", () => {
    for (const m of MOODS) {
      const out = assertMood(m);
      assert.equal(typeof out, "string");
      assert.ok(Object.is(out, m));
    }
  });
});

describe("MOODS and DEFAULT_MOOD are immutable", () => {
  test("MOODS is frozen and rejects every mutation (ESM is strict)", () => {
    assert.ok(Object.isFrozen(MOODS));
    assert.throws(() => MOODS.push("angry"), TypeError);
    assert.throws(() => MOODS.pop(), TypeError);
    assert.throws(() => MOODS.shift(), TypeError);
    assert.throws(() => MOODS.unshift("angry"), TypeError);
    assert.throws(() => MOODS.splice(0, 1), TypeError);
    assert.throws(() => MOODS.reverse(), TypeError);
    assert.throws(() => MOODS.sort(), TypeError);
    assert.throws(() => { MOODS[0] = "angry"; }, TypeError);
    assert.throws(() => { MOODS[9] = "angry"; }, TypeError);
    assert.throws(() => { MOODS.length = 0; }, TypeError);
    assert.throws(() => { delete MOODS[0]; }, TypeError);
    assert.throws(() => Object.defineProperty(MOODS, "extra", { value: 1 }), TypeError);
    assert.throws(() => Object.setPrototypeOf(MOODS, null), TypeError);
  });

  test("a failed mutation leaves the list, and assertMood, unchanged", () => {
    try { MOODS.push("angry"); } catch { /* expected */ }
    try { MOODS[0] = "angry"; } catch { /* expected */ }
    assert.deepEqual([...MOODS], ["neutral", "hype", "shade", "shook"]);
    assert.throws(() => assertMood("angry"), /unknown mood/);
    assert.equal(assertMood("neutral"), "neutral");
  });

  test("a copy of MOODS is independent of the original", () => {
    const copy = [...MOODS];
    copy.push("angry");
    copy[0] = "x";
    assert.deepEqual([...MOODS], ["neutral", "hype", "shade", "shook"]);
  });

  test("the module namespace bindings cannot be reassigned", () => {
    assert.throws(() => { ns.DEFAULT_MOOD = "hype"; }, TypeError);
    assert.throws(() => { ns.MOODS = []; }, TypeError);
    assert.throws(() => { ns.assertMood = () => "hype"; }, TypeError);
    assert.throws(() => { ns.moodForText = () => "hype"; }, TypeError);
    assert.equal(DEFAULT_MOOD, "neutral");
  });

  test("the module exports exactly the documented names", () => {
    assert.deepEqual(Object.keys(ns).sort(), ["DEFAULT_MOOD", "MOODS", "assertMood", "moodForText"]);
  });

  test("DEFAULT_MOOD is one of MOODS and is what an unmatched post gets", () => {
    assert.ok(MOODS.includes(DEFAULT_MOOD));
    assert.equal(moodForText("Logging it."), DEFAULT_MOOD);
  });
});

describe("moodForText: determinism and no regex state leak", () => {
  test("the same text gives the same mood across many repeated calls", () => {
    for (const [text, want] of [["Fine.", "shade"], ["Wait, what?", "shook"], ["Let's go!", "hype"], ["Logging it.", "neutral"], ["\u{1F680}", "hype"]]) {
      for (let i = 0; i < 500; i++) assert.equal(moodForText(text), want, `${text} #${i}`);
    }
  });

  test("interleaving texts that hit different rules never changes any result", () => {
    // If a rule regex had the g or y flag, lastIndex would carry over between
    // calls and an alternating sequence would flip results.
    const seq = [
      ["\u{1F525} nope", "hype"],
      ["Source?", "shade"],
      ["Huh", "shook"],
      ["Great!", "hype"],
      ["nothing", "neutral"],
      ["Hmmm", "shade"],
      ["send it", "hype"],
      ["WAIT", "shook"],
      ["", "neutral"],
      ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx no", "shade"],
      ["no", "shade"],
    ];
    for (let round = 0; round < 50; round++) {
      for (const [text, want] of seq) assert.equal(moodForText(text), want, `${text} round ${round}`);
      for (const [text, want] of [...seq].reverse()) assert.equal(moodForText(text), want, `${text} reversed round ${round}`);
    }
  });

  test("a match late in a long text does not make a following short text miss", () => {
    const longShade = `${"lorem ipsum ".repeat(500)}wrong`;
    for (let i = 0; i < 20; i++) {
      assert.equal(moodForText(longShade), "shade");
      assert.equal(moodForText("no"), "shade");
      assert.equal(moodForText("!"), "hype");
      assert.equal(moodForText("?"), "shook");
    }
  });

  test("classification does not depend on call order (permutation check)", () => {
    const texts = ["no", "wait", "yes", "ok", "send it", "source?", "hmm", "\u{1F480}", "let’s", "who checked"];
    const baseline = new Map(texts.map((t) => [t, moodForText(t)]));
    // deterministic pseudo-shuffle, no Math.random
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 300; i++) {
      const t = texts[next() % texts.length];
      assert.equal(moodForText(t), baseline.get(t), t);
    }
  });
});

describe("moodForText: h+m+ hesitation", () => {
  test("hm, hmm, hmmm and stretched forms are shade", () => {
    cases([["hm", "shade"], ["hmm", "shade"], ["hmmm", "shade"], ["HMMMMMM", "shade"], ["hhmm", "shade"], ["Hmm...", "shade"], ["hmm?", "shade"], ["hmmm!", "shade"], ["well, hmm, ok", "shade"]]);
  });

  test("h and m must both be present, in that order, as a whole word", () => {
    cases([
      ["h", "neutral"],
      ["m", "neutral"],
      ["mh", "neutral"],
      ["mmh", "neutral"],
      ["hum", "neutral"],
      ["ahmm", "neutral"],
      ["hmmx", "neutral"],
      ["hmx", "neutral"],
      ["hmm1", "neutral"],
      ["hm_m", "neutral"], // underscore is a word character
      ["hmhm", "neutral"],
      ["ohm", "neutral"],
    ]);
  });

  test("a non-word character on either side keeps the word boundary", () => {
    cases([["(hmm)", "shade"], ["hmm-ok", "shade"], ["“hmm”", "shade"], ["hmm\u{1F914}", "shade"]]);
  });
});

describe("moodForText: word boundaries", () => {
  test("keywords inside longer words are ignored (know, nothing, knot, notable)", () => {
    cases([
      ["know", "neutral"],
      ["I know.", "neutral"],
      ["knowing", "neutral"],
      ["nothing", "neutral"],
      ["knot", "neutral"],
      ["snot", "neutral"],
      ["cannot", "neutral"],
      ["notebook", "neutral"],
      ["another", "neutral"],
      ["nonsense", "neutral"],
      ["wrongdoing", "neutral"],
      ["actuallyy", "neutral"],
      ["actual", "neutral"],
      ["refine", "neutral"],
      ["finest", "neutral"],
      ["whatever", "neutral"],
      ["waiter", "neutral"],
      ["huhu", "neutral"],
      ["greater", "neutral"],
      ["agreement", "neutral"],
      ["connected", "neutral"],
      ["niceties", "neutral"],
      ["within", "neutral"], // "in on" needs both words
    ]);
  });

  test("the same keywords at a boundary do count", () => {
    cases([
      ["no", "shade"],
      ["no.", "shade"],
      ["no-one", "shade"],
      ["(no)", "shade"],
      ["actually!", "shade"],
      ["fine-tuned", "shade"],
      ["not_", "neutral"], // underscore is a word character
      ["_not", "neutral"],
      ["not1", "neutral"],
      ["1not", "neutral"],
      ["what", "shook"],
      ["so what", "shook"],
    ]);
  });

  test("underscore and digits are word characters, other punctuation is not", () => {
    cases([["foo_wait", "neutral"], ["wait_foo", "neutral"], ["wait2", "neutral"], ["2wait", "neutral"], ["foo-wait", "shook"], ["foo.wait", "shook"], ["foo/wait", "shook"]]);
  });
});

describe("moodForText: source? vs sources? vs resource?", () => {
  test("source? and sources? are the citation demand and read as shade", () => {
    cases([["source?", "shade"], ["Source?", "shade"], ["SOURCE?", "shade"], ["sources?", "shade"], ["Sources?", "shade"], ["source?!", "shade"], ["Got a source?", "shade"], ["any sources? thanks", "shade"]]);
  });

  test("resource? and other longer words fall through to the plain question rule", () => {
    cases([["resource?", "shook"], ["resources?", "shook"], ["sourced?", "shook"], ["sourcery?", "shook"], ["outsource?", "shook"], ["open-source?", "shade"]]);
  });

  test("the citation demand needs its question mark attached", () => {
    cases([["source", "neutral"], ["sources", "neutral"], ["source ?", "shook"], ["source .", "neutral"], ["source!", "hype"], ["sourcess?", "shook"]]);
  });
});

describe("moodForText: curly apostrophes and quotes", () => {
  test("let's with straight and curly apostrophes, and bare lets, are hype", () => {
    cases([["Let's", "hype"], ["Let’s", "hype"], ["lets", "hype"], ["LET’S GO", "hype"], ["well, let’s see", "hype"]]);
  });

  test("other apostrophe look-alikes are not accepted", () => {
    cases([["Let‘s", "neutral"], ["Let`s", "neutral"], ["Letʼs", "neutral"], ["Let´s", "neutral"], ["Letss", "neutral"], ["Let ' s", "neutral"]]);
  });

  test("contractions around cue words do not trigger them", () => {
    cases([
      ["don’t", "neutral"],
      ["don't", "neutral"],
      ["won’t", "neutral"],
      ["isn't it", "neutral"],
      ["it’s fine", "shade"],
      ["that’s not it", "shade"],
      ["what’s up", "shook"],
    ]);
  });

  test("curly quotes around a cue word keep it word-bounded", () => {
    cases([["“no”", "shade"], ["‘wait’", "shook"], ["“send it”", "hype"]]);
  });
});

describe("moodForText: emoji and surrogate pairs", () => {
  test("astral emoji other than the loud three carry no tone", () => {
    cases([["\u{1F600}", "neutral"], ["\u{1F4A9}", "neutral"], ["\u{1F9D1}", "neutral"], ["\u{1F600}".repeat(100), "neutral"]]);
  });

  test("the loud emoji work when embedded, repeated, or followed by variation selectors", () => {
    cases([
      ["wait\u{1F525}", "hype"],
      ["\u{1F525}️", "hype"],
      ["a\u{1F680}b", "hype"],
      ["\u{1F480}\u{1F480}\u{1F480}", "hype"],
      ["not sure \u{1F480}\u{1F602}", "hype"],
      ["\u{1F602}\u{1F480}", "hype"],
    ]);
  });

  test("a lone surrogate half is not mistaken for a loud emoji", () => {
    // rocket is U+D83D U+DE80 in UTF-16; each half alone must not match
    cases([["\uD83D", "neutral"], ["\uDE80", "neutral"], ["\uD83Dx", "neutral"], ["\uDE80\uD83D", "neutral"], ["\uD83D wait", "shook"], ["\uD83D no", "shade"]]);
  });

  test("a different emoji sharing a high surrogate with the rocket is not hype", () => {
    // U+1F600 starts with the same D83D high surrogate as U+1F680
    cases([["\u{1F600}", "neutral"], ["\u{1F601}?", "shook"], ["\u{1F640}", "neutral"], ["\u{1F300}", "neutral"]]);
  });

  test("emoji next to a keyword do not break its word boundary", () => {
    // astral characters are non-word, so the keyword still has a boundary
    cases([["\u{1F600}no\u{1F600}", "shade"], ["\u{1F600}wait", "shook"], ["\u{1F600}send it\u{1F600}", "hype"]]);
  });

  test("the loud-emoji rule beats every later rule at once", () => {
    cases([["no not nope wrong disagree who checked? what?! \u{1F680}", "hype"]]);
  });
});

describe("moodForText: non-string inputs", () => {
  test("every non-primitive-string value throws TypeError with a stable message", () => {
    const bads = [undefined, null, NaN, 0, -0, 1n, false, Symbol.iterator, () => "wait", function wait() {}, new Date(0), /wait/, new Map(), new Set(["wait"]), new Uint8Array([119, 97, 105, 116]), Buffer.from("wait"), Object.create(null), new Error("wait"), new Number(1), new Boolean(true), Promise.resolve("wait")];
    for (const bad of bads) {
      assert.throws(() => moodForText(bad), { name: "TypeError", message: "text must be a string" }, String(typeof bad));
    }
  });

  test("a String object is rejected rather than unwrapped", () => {
    assert.throws(() => moodForText(new String("hype")), TypeError);
    assert.throws(() => moodForText(Object("wait")), TypeError);
    assert.equal(moodForText(String(new String("wait"))), "shook");
  });

  test("a throwing toString or valueOf is never invoked", () => {
    let called = false;
    const sneaky = { toString() { called = true; return "wait"; }, valueOf() { called = true; return "wait"; } };
    assert.throws(() => moodForText(sneaky), TypeError);
    assert.equal(called, false);
  });

  test("calling with no argument throws TypeError", () => {
    assert.throws(() => moodForText(), TypeError);
  });
});

describe("moodForText: pathological long input stays fast", () => {
  const BUDGET_MS = 1500;

  test("long h runs with and without a trailing m", () => {
    for (const text of ["h".repeat(200000), `${"h".repeat(200000)}x`, `${"h".repeat(100000)}${"m".repeat(100000)}x`, `${"h".repeat(100000)}${"m".repeat(100000)}`, `${"hm".repeat(100000)}x`, "h ".repeat(100000), "hmm ".repeat(50000)]) {
      const { out, ms } = cpuMs(() => moodForText(text));
      assert.ok(["neutral", "shade"].includes(out));
      assert.ok(ms < BUDGET_MS, `took ${ms}ms for ${text.slice(0, 12)}...`);
    }
  });

  test("the h+m+ shade cue is still found at the end of a huge post", () => {
    const text = `${"lorem ".repeat(50000)}hmmm`;
    const { out, ms } = cpuMs(() => moodForText(text));
    assert.equal(out, "shade");
    assert.ok(ms < BUDGET_MS, `took ${ms}ms`);
  });

  test("repeated near-miss keywords and word characters do not backtrack badly", () => {
    const inputs = [
      "sourc".repeat(40000),
      "source".repeat(40000),
      "sources".repeat(30000),
      "send i".repeat(30000),
      "let".repeat(60000),
      "let'".repeat(40000),
      "no".repeat(100000),
      "a".repeat(300000),
      "\u{1F600}".repeat(100000),
      "\uD83D".repeat(100000),
      "rather watc".repeat(20000),
      "count me i".repeat(20000),
    ];
    for (const text of inputs) {
      const { out, ms } = cpuMs(() => moodForText(text));
      assert.ok(["neutral", "hype", "shade", "shook"].includes(out));
      assert.ok(ms < BUDGET_MS, `took ${ms}ms for ${text.slice(0, 12)}...`);
    }
  });

  test("a long text of only cue-free characters followed by a single cue is classified correctly", () => {
    const pad = "z".repeat(500000);
    assert.equal(moodForText(`${pad} no`), "shade");
    assert.equal(moodForText(`${pad} ?`), "shook");
    assert.equal(moodForText(`${pad} !`), "hype");
    assert.equal(moodForText(`${pad} \u{1F680}`), "hype");
    assert.equal(moodForText(pad), "neutral");
  });
});
