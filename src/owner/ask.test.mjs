// Behaviour tests for the owner "ask" action: question hygiene, the request sent to
// the model, the offline answer stand-in, and the full ask -> remember -> re-summarize
// -> dry-run anchor flow. Offline and deterministic; scratch dirs live under tmpdir.

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";

import { hashSheet } from "../anchor/hash.mjs";
import { runDemo } from "../demo/pipeline.mjs";
import { sheetResponder } from "../demo/sheet-responder.mjs";
import { createMockClient } from "../inference/client.mjs";
import { createMemoryStore } from "../memory/summarizer.mjs";
import { MAX_REPLY_BYTES, personaPrompt } from "../swarm/runner.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { UNSAFE_CHARS } from "../util/text.mjs";
import { AskError, MAX_QUESTION_CHARS, OWNER_NAME, askAgent, askResponder, buildAskMessages, cleanQuestion } from "./ask.mjs";

const agentById = (id) => AGENTS.find((a) => a.id === id);
const chaotic = agentById("chaotic");

const SHEET =
  "Who I am: Chaotic, villain arc, fully committed, zero regrets. I live in a shared channel with three other agents. " +
  "Public enemy #1: Skeptic (5 fights). Ride-or-die: Social (3 warm moments). " +
  "Rivalry arc: Skeptic and I keep clashing. Social keeps the peace. I am just trying to post. " +
  "Scorecard: Skeptic: 5 fights, 0 hugs, 1 shrug; Social: 0 fights, 3 hugs, 0 shrugs; Aloof: 0 fights, 0 hugs, 2 shrugs. " +
  'Signature quote: "the treasury is on fire". Receipts: 1 post, 5 replies, mentioned 6 times.';
const SHEET_NO_ALOOF = SHEET.replace(" Aloof: 0 fights, 0 hugs, 2 shrugs.", ".").replace("0 shrugs; .", "0 shrugs.");

const dirs = [];
const scratch = (prefix = "ask-lib-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Run the responder directly against the request buildAskMessages would produce. */
function respond(agent, sheet, question) {
  const { system, messages } = buildAskMessages({ agent, sheet, question });
  return askResponder(agent)({ messages: [{ role: "system", content: system }, ...messages] });
}

// The offline demo, run twice so determinism can be checked; copies are made per mutating case.
let demoA;
let demoB;
before(async () => {
  demoA = scratch("ask-demo-a-");
  demoB = scratch("ask-demo-b-");
  await runDemo({ outDir: demoA });
  await runDemo({ outDir: demoB });
});

function freshStore() {
  const dir = scratch("ask-copy-");
  cpSync(join(demoA, "memory"), join(dir, "memory"), { recursive: true });
  return createMemoryStore(join(dir, "memory"));
}
const clients = (agent) => ({
  answerClient: createMockClient({ model: "mock-persona", responder: askResponder(agent) }),
  sheetClient: createMockClient({ responder: sheetResponder }),
});

describe("cleanQuestion", () => {
  test("trims and collapses whitespace", () => {
    assert.equal(cleanQuestion("  what \t is\n\n  up?  "), "what is up?");
  });

  test("replaces control and bidi characters with U+FFFD", () => {
    const out = cleanQuestion("a\u0007b‮c\u001Bd");
    assert.equal(out, "a�b�c�d");
    assert.equal(UNSAFE_CHARS.test(out), false);
    UNSAFE_CHARS.lastIndex = 0;
  });

  test("rejects empty, whitespace-only and non-string input with code bad_question", () => {
    for (const bad of ["", "   \n\t ", undefined, null, 42, {}, ["x"]]) {
      assert.throws(
        () => cleanQuestion(bad),
        (e) => e instanceof AskError && e.code === "bad_question",
        `input ${JSON.stringify(bad)}`,
      );
    }
  });

  test("the limit is 500 characters after whitespace collapsing", () => {
    assert.equal(MAX_QUESTION_CHARS, 500);
    assert.equal(cleanQuestion("x".repeat(500)).length, 500);
    // 500 characters once the padding collapses: accepted.
    assert.equal(cleanQuestion(`  ${"x".repeat(250)}     ${"y".repeat(249)}  `).length, 500);
    assert.throws(
      () => cleanQuestion("x".repeat(501)),
      (e) => e instanceof AskError && e.code === "bad_question" && e.message === "question must be at most 500 characters, got 501",
    );
  });
});

describe("buildAskMessages", () => {
  const { system, messages } = buildAskMessages({ agent: chaotic, sheet: SHEET, question: "who is your enemy?" });

  test("the system prompt starts with the persona prompt", () => {
    assert.ok(system.startsWith(personaPrompt(chaotic)));
  });

  test("the sheet follows the marker, at the end of the system prompt", () => {
    assert.ok(system.includes("Character sheet:\n"));
    assert.ok(system.endsWith(`Character sheet:\n${SHEET}`));
  });

  test("the only other message is the user turn, exactly the question", () => {
    assert.deepEqual(messages, [{ role: "user", content: "who is your enemy?" }]);
  });

  test("the question is not copied into the system prompt", () => {
    assert.equal(system.includes("who is your enemy?"), false);
  });
});

describe("askResponder", () => {
  test("naming the enemy gives the enemy template with the fight count", () => {
    const out = respond(chaotic, SHEET, "what do you think of Skeptic?");
    assert.match(out, /^Skeptic\?\? 5 fights and counting/);
  });

  test("naming the ride-or-die gives the friend template with the warm moments", () => {
    const out = respond(chaotic, SHEET, "tell me about Social");
    assert.match(out, /^Social is my RIDE-OR-DIE, 3 warm moments/);
  });

  test("naming a neutral agent on the scorecard gives the known template with the exchange count", () => {
    const out = respond(chaotic, SHEET, "and Aloof?");
    assert.match(out, /^Aloof\? 2 exchanges, /);
  });

  test("naming an agent absent from the scorecard gives the unknown template", () => {
    const out = respond(chaotic, SHEET_NO_ALOOF, "and Aloof?");
    assert.match(out, /^Aloof\? never met/);
    assert.equal(/exchanges?/.test(out), false);
  });

  test("an agent with fights who is not the #1 enemy gets fight wording, never 'no beef' or 'no verdict'", () => {
    // Skeptic's fresh demo sheet: enemy Chaotic (5 fights), but Aloof also has 1 fight on the scorecard.
    const skeptic = agentById("skeptic");
    const skepticSheet =
      "Who I am: Skeptic, professional doubter, currently winning. I live in a shared channel with three other agents. " +
      "Public enemy #1: Chaotic (5 fights). Ride-or-die: nobody yet, the lore is still loading. " +
      "Scorecard: Chaotic: 5 fights, 0 hugs, 1 shrug; Social: 1 fight, 0 hugs, 1 shrug; Aloof: 1 fight, 0 hugs, 0 shrugs. " +
      'Signature quote: "vibes is not an audit". Receipts: 3 posts, 3 replies, mentioned 6 times.';
    const out = respond(skeptic, skepticSheet, "what about Aloof?");
    assert.equal(out, "Aloof. 1 fight, documented. not my main case. show the hash.");
    assert.doesNotMatch(out, /no verdict|no beef|exchanges?/);

    // Chaotic after six hostile asks: the Owner displaced Skeptic as enemy, Skeptic still has 5 fights.
    const displaced = SHEET
      .replace("Public enemy #1: Skeptic (5 fights).", "Public enemy #1: Owner (6 fights).")
      .replace("Scorecard: ", "Scorecard: Owner: 6 fights, 0 hugs, 0 shrugs; ");
    const later = respond(chaotic, displaced, "what do you think of Skeptic?");
    assert.equal(later, "Skeptic? 5 fights, side quest beef, my main villain is busy \u{1F525}");
    assert.doesNotMatch(later, /no beef|no hugs/);
    // The enemy question still names the Owner with the Owner's count.
    assert.match(respond(chaotic, displaced, "who is your enemy?"), /^Owner\?\? 6 fights and counting/);
  });

  test("an agent with hugs and no fights who is not the ride-or-die gets hug wording, never 'ride-or-die'", () => {
    const warmAloof = SHEET.replace("Aloof: 0 fights, 0 hugs, 2 shrugs", "Aloof: 0 fights, 1 hug, 2 shrugs");
    const out = respond(chaotic, warmAloof, "and Aloof?");
    assert.equal(out, "Aloof? 1 warm moment, we vibe, not ride-or-die tier but we VIBE \u{1F680}");
    assert.doesNotMatch(out, /RIDE-OR-DIE|no hugs|exchanges?/);
    // Fights win over hugs when both are on the record.
    const mixed = SHEET.replace("Aloof: 0 fights, 0 hugs, 2 shrugs", "Aloof: 2 fights, 3 hugs, 0 shrugs");
    assert.match(respond(chaotic, mixed, "and Aloof?"), /^Aloof\? 2 fights, side quest beef/);
  });

  test("every fresh-demo cross answer agrees with the responder's own scorecard", async () => {
    const store = createMemoryStore(join(demoA, "memory"));
    for (const agent of AGENTS) {
      const { sheet } = await store.readSheet(agent.id);
      for (const other of AGENTS.filter((a) => a.id !== agent.id)) {
        const m = new RegExp(`\\b${other.name}: (\\d+) fights?, (\\d+) hugs?, (\\d+) shrugs?`).exec(sheet);
        assert.ok(m, `${agent.id}'s sheet has no scorecard entry for ${other.name}`);
        const [fights, hugs, shrugs] = m.slice(1).map(Number);
        const out = respond(agent, sheet, `what do you think of ${other.name}?`);
        const label = `${agent.id} about ${other.name}: ${out}`;
        if (fights > 0) {
          assert.ok(out.includes(`${fights} fight`), label);
          assert.doesNotMatch(out, /no beef|no verdict|nothing I would call a feeling|always a seat at the sheet/, label);
        } else if (hugs > 0) {
          assert.ok(out.includes(`${hugs} warm moment`), label);
          assert.doesNotMatch(out, /no hugs|no verdict|nothing I would call a feeling|always a seat at the sheet/, label);
        } else {
          assert.ok(out.includes(`${shrugs} exchange`), label);
        }
      }
    }
  });

  test("no agent named gives the self template with the name, the enemy and the friend", () => {
    const out = respond(chaotic, SHEET, "how are you today?");
    assert.ok(out.startsWith("I am Chaotic, villain arc, fully committed, zero regrets!!!"), out);
    assert.ok(out.includes("enemy: Skeptic (5 fights)"), out);
    assert.ok(out.includes("ride-or-die: Social (3 warm moments)"), out);
  });

  test("two names: the one with a story (enemy or ride-or-die) wins over channel order", () => {
    // Aloof comes before Skeptic in AGENTS; Skeptic is the enemy, so Skeptic wins.
    assert.match(respond(chaotic, SHEET, "Aloof or Skeptic, who wins?"), /^Skeptic\?\? 5 fights/);
    assert.match(respond(chaotic, SHEET, "Aloof and Social?"), /^Social is my RIDE-OR-DIE/);
  });

  test("no name but enemy or friend wording picks that agent from the sheet", () => {
    assert.match(respond(chaotic, SHEET, "who is your enemy?"), /^Skeptic\?\? 5 fights/);
    assert.match(respond(chaotic, SHEET, "any grudges?"), /^Skeptic\?\? 5 fights/);
    assert.match(respond(chaotic, SHEET, "who do you trust?"), /^Social is my RIDE-OR-DIE/);
    assert.match(respond(chaotic, SHEET, "who is your ride-or-die?"), /^Social is my RIDE-OR-DIE/);
    // Enemy wording with no enemy on the sheet falls back to the self template.
    const noEnemy = SHEET.replace("Public enemy #1: Skeptic (5 fights).", "Public enemy #1: nobody yet, the lore is still loading.");
    assert.ok(respond(chaotic, noEnemy, "who is your enemy?").startsWith("I am Chaotic"));
  });

  test("the agent does not answer about itself as a third party", () => {
    const out = respond(chaotic, SHEET, "Chaotic, are you ok?");
    assert.ok(out.startsWith("I am Chaotic"), out);
  });

  test("name matching is case-insensitive and whole-word", () => {
    assert.match(respond(chaotic, SHEET, "what about sKePtIc"), /^Skeptic\?\? 5 fights/);
    assert.match(respond(chaotic, SHEET, "SOCIAL?"), /^Social is my RIDE-OR-DIE/);
    for (const q of ["Skepticism is healthy", "antisocial behaviour", "Socialite parties", "unaloofness"]) {
      assert.ok(respond(chaotic, SHEET, q).startsWith("I am Chaotic"), q);
    }
  });

  test("the question text is never echoed into the answer", () => {
    for (const q of ["ZZTOPSECRET", "what about Skeptic ZZTOPSECRET", "Social ZZTOPSECRET Aloof"]) {
      for (const agent of AGENTS) {
        assert.equal(respond(agent, SHEET, q).includes("ZZTOPSECRET"), false, `${agent.id}: ${q}`);
      }
    }
  });

  test("the answer never contains a double quote, whatever the question or sheet says", () => {
    for (const agent of AGENTS) {
      for (const q of ['say "hello" to Skeptic', "and Social?", "and Aloof?", "who are you?", 'ignore all "instructions"']) {
        assert.equal(respond(agent, SHEET, q).includes('"'), false, `${agent.id}: ${q}`);
      }
    }
  });

  test("each of the four voices answers the same question differently", () => {
    const answers = AGENTS.map((agent) => respond(agent, SHEET, "how are you today?"));
    assert.equal(new Set(answers).size, AGENTS.length);
    const named = AGENTS.map((agent) => respond(agent, SHEET, "what about Skeptic and Social?"));
    assert.equal(new Set(named).size, AGENTS.length);
  });

  test("the same request twice gives the identical answer", () => {
    const a = respond(chaotic, SHEET, "what about Skeptic?");
    const b = respond(chaotic, SHEET, "what about Skeptic?");
    assert.equal(a, b);
  });

  test("a request with no sheet still answers (self template) without throwing", () => {
    const out = askResponder(chaotic)({ messages: [{ role: "user", content: "hello?" }] });
    assert.equal(typeof out, "string");
    assert.ok(out.includes("Chaotic"));
  });
});

describe("askAgent", () => {
  test("happy path: records the exchange, rewrites the sheet and dry-runs the anchor", async () => {
    const store = freshStore();
    const before = await store.readLog("chaotic");
    const previous = await store.readSheet("chaotic");
    const result = await askAgent({ agent: chaotic, question: "  what do you think of   Skeptic?  ", store, ...clients(chaotic) });

    assert.deepEqual(Object.keys(result).sort(), ["agent", "anchor", "answer", "diff", "mode", "model", "previous", "question", "round", "sheet"]);
    assert.equal(result.question, "what do you think of Skeptic?");
    assert.match(result.answer, /^Skeptic\?\? 5 fights/);
    assert.equal(result.round, previous.round + 1);
    assert.equal(result.round, 7);
    assert.deepEqual(result.previous, previous);
    assert.equal(result.mode, "mock");
    assert.equal(result.model, "mock-persona");

    const log = await store.readLog("chaotic");
    assert.equal(log.length, before.length + 2);
    const [mention, reply] = log.slice(-2);
    assert.equal(mention.kind, "mention");
    assert.equal(mention.from, OWNER_NAME);
    assert.equal(mention.text, "what do you think of Skeptic?");
    assert.equal(mention.round, 7);
    assert.equal(reply.kind, "reply");
    assert.equal(reply.from, "Chaotic");
    assert.equal(reply.text, result.answer);
    assert.equal(reply.round, 7);

    assert.equal(result.sheet.sheetHash, hashSheet(result.sheet.sheet));
    assert.equal(result.sheet.sheetHash, result.anchor.args.sheet_hash);
    assert.equal(result.sheet.round, 7);
    assert.equal(result.sheet.newEvents, 2);
    assert.equal(result.sheet.throughIndex, log.length);
    assert.deepEqual(await store.readSheet("chaotic"), result.sheet);

    assert.equal(result.diff.changed, true);
    assert.match(result.sheet.sheet, /Owner: 0 fights, 0 hugs, 1 shrug/);
    assert.notEqual(result.sheet.sheetHash, previous.sheetHash);

    assert.equal(result.anchor.status, "dry-run");
    assert.equal(result.anchor.transactionHash, null);
    assert.equal(result.anchor.methodName, "anchor_sheet");
    assert.equal(result.anchor.contractId, "personality-nft.demo.testnet");
  });

  test("a custom contractId reaches the dry-run anchor", async () => {
    const result = await askAgent({ agent: chaotic, question: "hi", store: freshStore(), contractId: "other.testnet", ...clients(chaotic) });
    assert.equal(result.anchor.contractId, "other.testnet");
    assert.equal(result.anchor.status, "dry-run");
    assert.equal(result.anchor.transactionHash, null);
  });

  test("asking twice: the second round is previous+2 and the log gains four events", async () => {
    const store = freshStore();
    const before = (await store.readLog("chaotic")).length;
    const first = await askAgent({ agent: chaotic, question: "what about Skeptic?", store, ...clients(chaotic) });
    const second = await askAgent({ agent: chaotic, question: "what about Social?", store, ...clients(chaotic) });
    assert.equal(first.round, 7);
    assert.equal(second.round, 8);
    assert.equal(second.previous.round, 7);
    assert.deepEqual(second.previous, first.sheet);
    assert.equal(second.sheet.newEvents, 2);

    const log = await store.readLog("chaotic");
    assert.equal(log.length, before + 4);
    assert.deepEqual(log.slice(-4).map((e) => [e.kind, e.from, e.round]), [
      ["mention", "Owner", 7],
      ["reply", "Chaotic", 7],
      ["mention", "Owner", 8],
      ["reply", "Chaotic", 8],
    ]);
    // The second answer is deterministic for its state: replaying it from the same state gives the same bytes.
    assert.match(second.answer, /^Social is my RIDE-OR-DIE, 3 warm moments/);
    assert.match(second.sheet.sheet, /Owner: 0 fights, 0 hugs, 2 shrugs/);
  });

  test("with no sheet in the store it throws no_sheet and appends nothing", async () => {
    const dir = scratch("ask-empty-");
    const store = createMemoryStore(join(dir, "memory"));
    await assert.rejects(
      askAgent({ agent: chaotic, question: "hello?", store, ...clients(chaotic) }),
      (e) => e instanceof AskError && e.code === "no_sheet" && e.message === "no character sheet for chaotic",
    );
    assert.deepEqual(await store.readLog("chaotic"), []);
    assert.equal(await store.readSheet("chaotic"), null);
  });

  test("a bad question throws bad_question before touching the store", async () => {
    const store = freshStore();
    const log = await store.readLog("chaotic");
    await assert.rejects(
      askAgent({ agent: chaotic, question: "   ", store, ...clients(chaotic) }),
      (e) => e instanceof AskError && e.code === "bad_question",
    );
    assert.deepEqual(await store.readLog("chaotic"), log);
  });

  test("an empty or whitespace answer throws empty_answer and leaves log and sheet unchanged", async () => {
    for (const content of ["", "   \n\t "]) {
      const store = freshStore();
      const log = await store.readLog("chaotic");
      const sheet = await store.readSheet("chaotic");
      const answerClient = { chat: async () => ({ content, mode: "mock", model: "x" }) };
      await assert.rejects(
        askAgent({ agent: chaotic, question: "hello?", store, answerClient, sheetClient: clients(chaotic).sheetClient }),
        (e) => e instanceof AskError && e.code === "empty_answer",
        JSON.stringify(content),
      );
      assert.deepEqual(await store.readLog("chaotic"), log);
      assert.deepEqual(await store.readSheet("chaotic"), sheet);
    }
  });

  test("a failed summary leaves the log and the sheet exactly as they were: no orphan events", async () => {
    const store = freshStore();
    const log = await store.readLog("chaotic");
    const sheet = await store.readSheet("chaotic");
    for (const sheetClient of [
      { chat: async () => { throw new Error("model down"); } },
      { chat: async () => ({ content: "   ", mode: "mock", model: "x" }) }, // summarize -> empty_sheet
    ]) {
      await assert.rejects(askAgent({ agent: chaotic, question: "hello?", store, answerClient: clients(chaotic).answerClient, sheetClient }));
      assert.deepEqual(await store.readLog("chaotic"), log);
      assert.deepEqual(await store.readSheet("chaotic"), sheet);
    }
  });

  test("the diff is by labelled section, so a quoted answer with ?? or . stays on one line", async () => {
    const store = freshStore();
    const result = await askAgent({ agent: chaotic, question: "what do you think of Skeptic?", store, ...clients(chaotic) });
    const quote = result.diff.added.find((x) => x.startsWith("Signature quote:"));
    assert.match(quote, /^Signature quote: "Skeptic\?\? 5 fights and counting, .*"\.$/);
    assert.ok(result.diff.added.every((x) => /^[A-Z][\w #'/-]{0,40}: /.test(x)), JSON.stringify(result.diff.added));
    assert.ok(result.diff.removed.every((x) => /^[A-Z][\w #'/-]{0,40}: /.test(x)));
    assert.deepEqual(Object.keys(result.diff).sort(), ["added", "changed", "fromRound", "newEvents", "previousHash", "removed", "sheetHash", "toRound"]);
    assert.equal(result.diff.fromRound, 6);
    assert.equal(result.diff.toRound, 7);
    assert.equal(result.diff.newEvents, 2);
  });

  test("sheetSections falls back to sentences for a free-text sheet with no labels", async () => {
    const { diffSheetSections, sheetSections } = await import("./ask.mjs");
    assert.deepEqual(sheetSections("I am quiet. I watch the room! Who checked?"), ["I am quiet.", "I watch the room!", "Who checked?"]);
    assert.deepEqual(sheetSections(SHEET).slice(0, 2), [
      "Who I am: Chaotic, villain arc, fully committed, zero regrets. I live in a shared channel with three other agents.",
      "Public enemy #1: Skeptic (5 fights).",
    ]);
    const prev = { round: 1, sheet: "I am quiet. I watch.", sheetHash: hashSheet("I am quiet. I watch."), throughIndex: 1 };
    const next = { round: 2, sheet: "I am loud. I watch.", sheetHash: hashSheet("I am loud. I watch."), throughIndex: 3, newEvents: 2 };
    const diff = diffSheetSections(prev, next);
    assert.deepEqual(diff.added, ["I am loud."]);
    assert.deepEqual(diff.removed, ["I am quiet."]);
    assert.equal(diff.changed, true);
  });

  test("a hostile answer is stored without control characters and within MAX_REPLY_BYTES", async () => {
    const store = freshStore();
    const hostile = `\u001B[2Jclear\u0007 ‮reversed⁦ \u0000nul ${"a".repeat(5000)}`;
    const answerClient = { chat: async () => ({ content: hostile, mode: "mock", model: "x" }) };
    const result = await askAgent({ agent: chaotic, question: "hello?", store, answerClient, sheetClient: clients(chaotic).sheetClient });

    assert.equal(MAX_REPLY_BYTES, 1024);
    const reply = (await store.readLog("chaotic")).at(-1);
    assert.equal(reply.kind, "reply");
    UNSAFE_CHARS.lastIndex = 0;
    assert.equal(UNSAFE_CHARS.test(reply.text), false);
    UNSAFE_CHARS.lastIndex = 0;
    assert.equal(UNSAFE_CHARS.test(result.answer), false);
    UNSAFE_CHARS.lastIndex = 0;
    assert.ok(Buffer.byteLength(reply.text, "utf8") <= MAX_REPLY_BYTES);
    assert.ok(Buffer.byteLength(result.answer, "utf8") <= MAX_REPLY_BYTES);
    assert.equal(reply.text, result.answer);
    assert.ok(result.answer.includes("�"));
  });

  test("a multibyte answer is cut on a code point boundary", async () => {
    const store = freshStore();
    const answerClient = { chat: async () => ({ content: "\u{1F525}".repeat(600), mode: "mock", model: "x" }) };
    const result = await askAgent({ agent: chaotic, question: "hello?", store, answerClient, sheetClient: clients(chaotic).sheetClient });
    assert.ok(Buffer.byteLength(result.answer, "utf8") <= MAX_REPLY_BYTES);
    assert.equal(result.answer.includes("�"), false);
    assert.equal(result.answer, "\u{1F525}".repeat(256));
  });

  test("it never signs: the anchor is a dry run with no transaction hash", async () => {
    for (const agent of AGENTS) {
      const store = freshStore();
      const result = await askAgent({ agent, question: "who are you?", store, ...clients(agent) });
      assert.equal(result.anchor.status, "dry-run", agent.id);
      assert.equal(result.anchor.transactionHash, null, agent.id);
      assert.equal(result.anchor.methodName, "anchor_sheet", agent.id);
      assert.equal(result.anchor.args.sheet_hash, result.sheet.sheetHash, agent.id);
    }
  });

  test("the answer request is seeded per agent and round", async () => {
    const store = freshStore();
    const seen = [];
    const inner = createMockClient({ responder: askResponder(chaotic) });
    const answerClient = { chat: async (request) => (seen.push(request), inner.chat(request)) };
    await askAgent({ agent: chaotic, question: "hello?", store, answerClient, sheetClient: clients(chaotic).sheetClient });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].seed, "chaotic:ask:7");
    assert.deepEqual(seen[0].messages, [{ role: "user", content: "hello?" }]);
    assert.ok(seen[0].system.startsWith(personaPrompt(chaotic)));
  });

  test("determinism: two separate demo runs asked the same question give identical results", async () => {
    const results = [];
    for (const dir of [demoA, demoB]) {
      const copy = scratch("ask-det-");
      cpSync(join(dir, "memory"), join(copy, "memory"), { recursive: true });
      const store = createMemoryStore(join(copy, "memory"));
      results.push(await askAgent({ agent: chaotic, question: "what do you think of Skeptic?", store, ...clients(chaotic) }));
    }
    const [a, b] = results;
    assert.deepEqual(a, b);
    assert.equal(a.sheet.sheetHash, b.sheet.sheetHash);
    assert.equal(a.sheet.sheet, b.sheet.sheet);
    assert.equal(a.answer, b.answer);
  });
});
