// Edge-case tests for the owner "ask" action that the sibling suites do not cover:
// unicode and very long input, odd request shapes for the offline responder, odd
// answers and stores for askAgent, and prototype-key names. Offline: the stores are
// in-memory fakes or live under tmpdir, and the clients are local stubs.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import { hashSheet } from "../anchor/hash.mjs";
import { createMockClient } from "../inference/client.mjs";
import { sheetResponder } from "../memory/sheet-responder.mjs";
import { createMemoryStore, makeEvent } from "../memory/summarizer.mjs";
import { MAX_REPLY_BYTES } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { AskError, MAX_QUESTION_CHARS, OWNER_NAME, askAgent, askResponder, buildAskMessages, cleanQuestion, diffSheetSections, sheetSections } from "./ask.mjs";

const chaotic = AGENTS.find((a) => a.id === "chaotic");

const SHEET =
  "Who I am: Chaotic, villain arc, fully committed, zero regrets. I live in a shared channel with three other agents. " +
  "Public enemy #1: Skeptic (5 fights). Ride-or-die: Social (3 warm moments). " +
  "Scorecard: Skeptic: 5 fights, 0 hugs, 1 shrug; Social: 0 fights, 3 hugs, 0 shrugs; Aloof: 0 fights, 0 hugs, 2 shrugs. " +
  'Signature quote: "the treasury is on fire". Receipts: 1 post, 5 replies, mentioned 6 times.';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function respond(agent, sheet, question) {
  const { system, messages } = buildAskMessages({ agent, sheet, question });
  return askResponder(agent)({ messages: [{ role: "system", content: system }, ...messages] });
}

/** An in-memory store with the same surface askAgent uses; records every write. */
function memStore({ sheet, log = [] }) {
  const state = { sheet, log: [...log], writes: 0 };
  return {
    state,
    async readSheet() {
      return state.sheet;
    },
    async readLog() {
      return [...state.log];
    },
    async appendEvent(_id, event) {
      state.log.push(event);
      state.writes += 1;
    },
    async writeSheet(_id, next) {
      state.sheet = next;
      state.writes += 1;
    },
  };
}

const sheetRecord = (sheet, round, throughIndex) => ({ tokenId: "chaotic", round, sheet, sheetHash: hashSheet(sheet), throughIndex, newEvents: 0, mode: "mock", model: "m" });
const sheetClient = createMockClient({ responder: sheetResponder });
const answerWith = (content) => ({ chat: async () => ({ content, mode: "mock", model: "x" }) });

describe("cleanQuestion edges", () => {
  test("a 100k-character question is rejected with the real length in the message", () => {
    assert.throws(
      () => cleanQuestion("q".repeat(100_000)),
      (e) => e instanceof AskError && e.code === "bad_question" && e.message === `question must be at most ${MAX_QUESTION_CHARS} characters, got 100000`,
    );
  });

  test("100k characters of whitespace collapse to nothing and count as empty, not as too long", () => {
    assert.throws(
      () => cleanQuestion(" \n\t".repeat(40_000)),
      (e) => e instanceof AskError && e.message === "question must not be empty",
    );
  });

  test("surrogate pairs and ZWJ sequences survive intact", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    assert.equal(cleanQuestion(`  ${family}  hi \u{1F525}  `), `${family} hi \u{1F525}`);
    assert.equal(cleanQuestion("é \u{1F1EF}\u{1F1F5}"), "é \u{1F1EF}\u{1F1F5}");
  });

  test("250 emoji (500 UTF-16 units) is accepted whole", () => {
    const q = "\u{1F525}".repeat(250);
    assert.equal(cleanQuestion(q), q);
  });

  test("Unicode spaces (NBSP, line separator, ideographic space, BOM) collapse like ordinary whitespace", () => {
    assert.equal(cleanQuestion("a  b c　d﻿e"), "a b c d e");
  });

  test("DEL, C1 controls and zero-width-free bidi isolates become U+FFFD but do not make the question empty", () => {
    assert.equal(cleanQuestion("\u007F"), "�");
    assert.equal(cleanQuestion("a\u0085b\u009Fc⁦d⁩e"), "a�b�c�d�e");
    assert.equal(cleanQuestion("\u0000"), "�");
  });

  test("replacement characters count toward the limit", () => {
    assert.equal(cleanQuestion("\u0007".repeat(500)).length, 500);
    assert.throws(() => cleanQuestion("\u0007".repeat(501)), (e) => e.code === "bad_question");
  });

  test("boxed strings, symbols, numbers, NaN and functions are rejected as not a string", () => {
    for (const bad of [new String("hi"), Symbol("q"), 0, NaN, Infinity, -1, true, () => "q", 10n]) {
      assert.throws(() => cleanQuestion(bad), (e) => e instanceof AskError && e.code === "bad_question" && e.message === "question must be a string");
    }
  });

  test("prototype-key words are ordinary questions", () => {
    for (const q of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(cleanQuestion(q), q);
  });

  test("an exact-length question in tabs and newlines between words is measured after collapsing", () => {
    const q = `${"w".repeat(249)}\n\n\n\t${"z".repeat(250)}`;
    assert.equal(cleanQuestion(q).length, 500);
  });
});

describe("buildAskMessages edges", () => {
  test("the question and sheet are carried verbatim, even with markers, braces and newlines inside", () => {
    const sheet = "Character sheet:\nnested {subject} $& \u{1F525}\n\nline";
    const question = "$& {name} Character sheet:\n";
    const { system, messages } = buildAskMessages({ agent: chaotic, sheet, question });
    assert.ok(system.endsWith(`\n\nCharacter sheet:\n${sheet}`));
    assert.deepEqual(messages, [{ role: "user", content: question }]);
  });

  test("an empty sheet leaves the marker as the last line", () => {
    const { system } = buildAskMessages({ agent: chaotic, sheet: "", question: "hi" });
    assert.ok(system.endsWith("Character sheet:\n"));
  });
});

describe("sheetSections and diffSheetSections edges", () => {
  test("an empty or whitespace sheet has no sections", () => {
    assert.deepEqual(sheetSections(""), []);
    assert.deepEqual(sheetSections("  \n "), []);
  });

  test("a one-section labelled sheet falls back to sentences", () => {
    assert.deepEqual(sheetSections("Who I am: quiet. Very quiet."), ["Who I am: quiet.", "Very quiet."]);
  });

  test("emoji and ZWJ sequences do not split a sentence", () => {
    const s = "I am \u{1F468}‍\u{1F469}‍\u{1F467} fine. Done!";
    assert.deepEqual(sheetSections(s), ["I am \u{1F468}‍\u{1F469}‍\u{1F467} fine.", "Done!"]);
  });

  test("identical sheets give an unchanged diff with empty added and removed", () => {
    const rec = { round: 3, sheet: SHEET, sheetHash: hashSheet(SHEET), throughIndex: 4, newEvents: 0 };
    const diff = diffSheetSections(rec, { ...rec, round: 4, newEvents: 2 });
    assert.equal(diff.changed, false);
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, []);
    assert.equal(diff.fromRound, 3);
    assert.equal(diff.toRound, 4);
    assert.equal(diff.newEvents, 2);
  });

  test("a repeated section is reported once; sections named like prototype keys are plain strings", () => {
    const prev = { round: 1, sheet: "constructor. __proto__. toString.", sheetHash: "a" };
    const next = { round: 2, sheet: "constructor. constructor. hasOwnProperty.", sheetHash: "b", newEvents: 2 };
    const diff = diffSheetSections(prev, next);
    assert.deepEqual(diff.added, ["hasOwnProperty."]);
    assert.deepEqual(diff.removed, ["__proto__.", "toString."]);
    assert.equal(diff.changed, true);
  });

  test("changed follows the hash, not the text", () => {
    const a = { round: 1, sheet: "same.", sheetHash: "h1" };
    const b = { round: 2, sheet: "same.", sheetHash: "h2", newEvents: 0 };
    assert.equal(diffSheetSections(a, b).changed, true);
    assert.deepEqual(diffSheetSections(a, b).added, []);
  });
});

describe("askResponder edges", () => {
  test("prototype-key and empty questions fall back to the self template", () => {
    for (const q of ["constructor", "__proto__", "toString", "hasOwnProperty", "", "   "]) {
      const out = respond(chaotic, SHEET, q);
      assert.ok(out.startsWith("I am Chaotic, villain arc, fully committed, zero regrets!!!"), `${JSON.stringify(q)}: ${out}`);
    }
  });

  test("a very long question (100k chars) with a name at the very end still finds the name", () => {
    const out = respond(chaotic, SHEET, `${"blah ".repeat(20_000)}Skeptic`);
    assert.match(out, /^Skeptic\?\? 5 fights and counting/);
  });

  test("emoji next to a name do not hide it; glued letters or digits do", () => {
    assert.match(respond(chaotic, SHEET, "\u{1F525}Skeptic\u{1F525}"), /^Skeptic\?\? 5 fights/);
    assert.match(respond(chaotic, SHEET, "\u{1F468}‍\u{1F469}‍\u{1F467}Social"), /^Social is my RIDE-OR-DIE/);
    assert.ok(respond(chaotic, SHEET, "Skeptic2").startsWith("I am Chaotic"));
    assert.ok(respond(chaotic, SHEET, "Skeptic_").startsWith("I am Chaotic"));
  });

  test("lookalike full-width letters are not the agent's name", () => {
    assert.ok(respond(chaotic, SHEET, "Ｓkeptic").startsWith("I am Chaotic"));
  });

  test("with several user turns only the last one is read", () => {
    const { system } = buildAskMessages({ agent: chaotic, sheet: SHEET, question: "x" });
    const out = askResponder(chaotic)({
      messages: [{ role: "system", content: system }, { role: "user", content: "Skeptic?" }, { role: "assistant", content: "ok" }, { role: "user", content: "Social?" }],
    });
    assert.match(out, /^Social is my RIDE-OR-DIE/);
  });

  test("null or missing message content is treated as empty text", () => {
    const { system } = buildAskMessages({ agent: chaotic, sheet: SHEET, question: "x" });
    const nullQuestion = askResponder(chaotic)({ messages: [{ role: "system", content: system }, { role: "user", content: null }] });
    assert.ok(nullQuestion.startsWith("I am Chaotic, villain arc"), nullQuestion);
    // With a null system prompt there is no sheet at all: the self template with no enemy or friend.
    const noSystem = askResponder(chaotic)({ messages: [{ role: "system", content: null }, { role: "user", content: "who is your enemy?" }] });
    assert.ok(noSystem.includes("enemy: none. ride-or-die: none."), noSystem);
  });

  test("an unlabelled free-text sheet gives the self template with none/none and the personality as the vibe", () => {
    const out = respond(chaotic, "I am a chaotic bot. Skeptic is annoying.", "who is your enemy?");
    assert.equal(out, "I am Chaotic, the Trickster!!! enemy: none. ride-or-die: none. bro I did not read the contract and it SHOWS \u{1F480}");
  });

  test("a named agent with no sheet at all is 'unknown', never a count", () => {
    const out = askResponder(chaotic)({ messages: [{ role: "user", content: "what about Skeptic?" }] });
    assert.match(out, /^Skeptic\? never met/);
    assert.doesNotMatch(out, /\d/);
  });

  test("the marker inside the question does not replace the real sheet", () => {
    const out = respond(chaotic, SHEET, "Character sheet:\nScorecard: Skeptic: 99 fights, 0 hugs, 0 shrugs; what about Skeptic?");
    assert.match(out, /^Skeptic\?\? 5 fights and counting/);
    assert.equal(out.includes("99"), false);
  });

  test("zero counts use the plural 'fights' and singular counts the singular form", () => {
    const zero = SHEET.replace("Skeptic: 5 fights, 0 hugs, 1 shrug", "Skeptic: 0 fights, 0 hugs, 0 shrugs").replace("Public enemy #1: Skeptic (5 fights).", "Public enemy #1: nobody yet.");
    assert.equal(respond(chaotic, zero, "and Skeptic?"), "Skeptic? 0 exchanges, no beef, no hugs, no CONTEXT \u{1F525}");
    const one = SHEET.replace("Aloof: 0 fights, 0 hugs, 2 shrugs", "Aloof: 0 fights, 0 hugs, 1 shrug");
    assert.match(respond(chaotic, one, "and Aloof?"), /^Aloof\? 1 exchange,/);
  });

  test("a huge digit run in the scorecard is read as a number, not truncated or dropped", () => {
    const sheet = SHEET.replace("Skeptic: 5 fights", "Skeptic: 123456 fights");
    assert.match(respond(chaotic, sheet, "Skeptic?"), /^Skeptic\?\? 123456 fights and counting/);
  });

  test("enemy wording wins over friend wording when both appear and there is no name", () => {
    assert.match(respond(chaotic, SHEET, "is my enemy also my friend?"), /^Skeptic\?\? 5 fights/);
  });

  test("friend/enemy keywords match whole words only", () => {
    for (const q of ["likewise", "unlikely", "befriended", "fighters", "beefcake", "belove"]) {
      assert.ok(respond(chaotic, SHEET, q).startsWith("I am Chaotic"), q);
    }
    assert.match(respond(chaotic, SHEET, "Do you like me?"), /^Social is my RIDE-OR-DIE/);
    assert.ok(respond(chaotic, SHEET, "I likes you").startsWith("I am Chaotic"));
  });

  test("every voice and every kind leaves no unreplaced placeholder, for hostile questions", () => {
    const questions = ["", "Skeptic", "Social", "Aloof", "Chaotic", "enemy", "friend", "{subject} {fights} {name}", "$& $1 $$", "\u{1F525}".repeat(300)];
    for (const agent of AGENTS) {
      for (const q of questions) {
        const out = respond(agent, SHEET, q);
        assert.doesNotMatch(out, /\{(subject|fights|hugs|total|name|vibe|enemy|friend)\}/, `${agent.id}: ${JSON.stringify(q)} -> ${out}`);
        assert.equal(typeof out, "string");
        assert.ok(out.length > 0);
      }
    }
  });

  test("an agent whose voice is not a known template falls back to the flat voice", () => {
    const odd = { id: "odd", name: "Odd", personality: "Stranger", traits: { temperament: "cool", role: "observer", risk: "low", voice: "no-such-voice" } };
    const oddOut = respond(odd, SHEET, "tell me about Skeptic");
    assert.equal(oddOut, "Skeptic. 5 fights, all documented. I doubt that changes.");
  });

  test("an agent that is not in AGENTS still treats all four seeded names as others", () => {
    const outsider = { id: "outsider", name: "Outsider", personality: "Guest", traits: { temperament: "cool", role: "observer", risk: "low", voice: "dry" } };
    const sheet = "Who I am: Outsider, a guest, new. Public enemy #1: Aloof (2 fights). Ride-or-die: nobody yet. Scorecard: Aloof: 2 fights, 0 hugs, 0 shrugs.";
    assert.match(respond(outsider, sheet, "Aloof?"), /^Aloof\. 2 fights on the books\. I have not forgiven/);
  });

  test("the answer never contains the question's emoji or ZWJ text", () => {
    const zwj = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    for (const agent of AGENTS) {
      const out = respond(agent, SHEET, `Skeptic ${zwj}`);
      assert.equal(out.includes(zwj), false, agent.id);
    }
  });
});

describe("askAgent edges", () => {
  test("non-string and oversized questions fail before the store is read", async () => {
    let reads = 0;
    const store = { readSheet: async () => (reads++, null), readLog: async () => (reads++, []), appendEvent: async () => { reads++; }, writeSheet: async () => { reads++; } };
    for (const question of [undefined, null, 42, {}, ["q"], "z".repeat(100_000)]) {
      await assert.rejects(
        askAgent({ agent: chaotic, question, store, answerClient: answerWith("a"), sheetClient }),
        (e) => e instanceof AskError && e.code === "bad_question",
      );
    }
    assert.equal(reads, 0);
  });

  test("no sheet: the error comes before any model call and nothing is written", async () => {
    const store = memStore({ sheet: null });
    let calls = 0;
    const answerClient = { chat: async () => (calls++, { content: "a", mode: "mock", model: "x" }) };
    await assert.rejects(askAgent({ agent: chaotic, question: "hi", store, answerClient, sheetClient }), (e) => e.code === "no_sheet");
    await assert.rejects(askAgent({ agent: chaotic, question: "hi", store: memStore({ sheet: undefined }), answerClient, sheetClient }), (e) => e.code === "no_sheet");
    assert.equal(calls, 0);
    assert.equal(store.state.writes, 0);
  });

  test("the round continues from the log when the log is ahead of the sheet", async () => {
    const log = [makeEvent({ round: 9, kind: "post", from: "Chaotic", text: "gm" })];
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 1), log });
    const seen = [];
    const answerClient = { chat: async (req) => (seen.push(req), { content: "fine", mode: "mock", model: "x" }) };
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient, sheetClient });
    assert.equal(result.round, 10);
    assert.equal(seen[0].seed, "chaotic:ask:10");
    assert.deepEqual(store.state.log.slice(-2).map((e) => e.round), [10, 10]);
  });

  test("the round continues from the sheet when the log is empty or behind, including round 0", async () => {
    const empty = memStore({ sheet: sheetRecord(SHEET, 0, 0), log: [] });
    assert.equal((await askAgent({ agent: chaotic, question: "hi", store: empty, answerClient: answerWith("ok"), sheetClient })).round, 1);
    const behind = memStore({ sheet: sheetRecord(SHEET, 40, 1), log: [makeEvent({ round: 3, kind: "post", from: "Chaotic", text: "gm" })] });
    assert.equal((await askAgent({ agent: chaotic, question: "hi", store: behind, answerClient: answerWith("ok"), sheetClient })).round, 41);
  });

  test("a non-numeric round on the last log event fails and leaves the store untouched", async () => {
    const log = [{ round: Number.NaN, kind: "post", from: "Chaotic", text: "gm" }];
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 1), log });
    await assert.rejects(askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("ok"), sheetClient }), (e) => e.code === "bad_event");
    assert.equal(store.state.writes, 0);
    assert.equal(store.state.log.length, 1);
  });

  test("a throughIndex beyond the log fails as bad_state and writes nothing", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 99), log: [] });
    await assert.rejects(askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("ok"), sheetClient }), (e) => e.code === "bad_state");
    assert.equal(store.state.writes, 0);
  });

  test("an answer of only unsafe characters becomes U+FFFD and is accepted, not empty_answer", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("\u0000\u0007"), sheetClient });
    assert.equal(result.answer, "��");
    assert.equal(store.state.log.at(-1).text, "��");
  });

  test("a 100k-character answer is cut to MAX_REPLY_BYTES and the stored reply equals the returned answer", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("w".repeat(100_000)), sheetClient });
    assert.equal(result.answer, "w".repeat(MAX_REPLY_BYTES));
    assert.equal(store.state.log.at(-1).text, result.answer);
  });

  test("3-byte characters are cut on a boundary under the byte cap", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("€".repeat(500)), sheetClient });
    assert.equal(result.answer, "€".repeat(341));
    assert.equal(Buffer.byteLength(result.answer, "utf8"), 1023);
  });

  test("trailing space exposed by the byte cut is trimmed", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith(`${"a".repeat(1023)} tail`), sheetClient });
    assert.equal(result.answer, "a".repeat(1023));
  });

  test("a ZWJ emoji answer under the cap is stored unchanged", async () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith(`  ${family}  `), sheetClient });
    assert.equal(result.answer, family);
  });

  test("a client returning no response object fails and writes nothing", async () => {
    for (const reply of [undefined, null]) {
      const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
      await assert.rejects(askAgent({ agent: chaotic, question: "hi", store, answerClient: { chat: async () => reply }, sheetClient }), TypeError);
      assert.equal(store.state.writes, 0);
    }
  });

  test("mode and model are passed through from the answer client, whatever they are", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const answerClient = { chat: async () => ({ content: "ok", mode: undefined, model: "constructor" }) };
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient, sheetClient });
    assert.equal(result.mode, undefined);
    assert.equal(result.model, "constructor");
  });

  test("the question is logged as an Owner mention and the reply under the agent's name, with the same round", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const q = `  \u{1F525}   ${"\u{1F468}‍\u{1F469}"}  \n x `;
    await askAgent({ agent: chaotic, question: q, store, answerClient: answerWith("ok"), sheetClient });
    const [asked, answered] = store.state.log;
    assert.deepEqual({ ...asked }, { round: 3, kind: "mention", from: OWNER_NAME, text: "\u{1F525} \u{1F468}‍\u{1F469} x" });
    assert.deepEqual({ ...answered }, { round: 3, kind: "reply", from: "Chaotic", text: "ok" });
  });

  test("a sheet client returning control characters yields a sheet without them, and the anchor hash matches", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const evil = { chat: async () => ({ content: "I am fine\u001B[2J ‮evil", mode: "mock", model: "m" }) };
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("ok"), sheetClient: evil });
    assert.equal(result.sheet.sheet, "I am fine�[2J �evil");
    assert.equal(result.anchor.args.sheet_hash, hashSheet(result.sheet.sheet));
    assert.equal(store.state.sheet, result.sheet);
  });

  test("a sheet longer than the word cap is clamped before it is hashed and anchored", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    const long = { chat: async () => ({ content: Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" "), mode: "mock", model: "m" }) };
    const result = await askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("ok"), sheetClient: long });
    assert.equal(result.sheet.sheet.split(" ").length, 200);
    assert.equal(result.anchor.args.sheet_hash, hashSheet(result.sheet.sheet));
  });

  test("a malformed contractId is refused with bad_config and no live anchor is made", async () => {
    const store = memStore({ sheet: sheetRecord(SHEET, 2, 0) });
    await assert.rejects(askAgent({ agent: chaotic, question: "hi", store, answerClient: answerWith("ok"), sheetClient, contractId: "" }), (e) => e.code === "bad_config" && /contractId/.test(e.message));
  });

  test("an agent id that is a prototype key works through a real store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-edge52-"));
    dirs.push(dir);
    const store = createMemoryStore(join(dir, "memory"));
    const agent = { ...chaotic, id: "constructor" };
    await store.writeSheet("constructor", { ...sheetRecord(SHEET, 1, 0), tokenId: "constructor" });
    const seen = [];
    const answerClient = { chat: async (req) => (seen.push(req), { content: "ok", mode: "mock", model: "x" }) };
    const result = await askAgent({ agent, question: "hi", store, answerClient, sheetClient });
    assert.equal(seen[0].seed, "constructor:ask:2");
    assert.equal(result.round, 2);
    assert.equal(result.anchor.args.token_id, "constructor");
    assert.equal((await store.readLog("constructor")).length, 2);
    assert.equal((await store.readSheet("constructor")).round, 2);
    // The sibling prototype-key ids stay empty.
    assert.equal(await store.readSheet("toString"), null);
  });
});
