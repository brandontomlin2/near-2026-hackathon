import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDemo } from "./pipeline.mjs";
import { AGENTS } from "../traits/agents.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-edge62-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const saying = (content) => ({ chat: async () => ({ content }) });
const files = (dir) => readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).sort();
const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const run = (out, content, extra = {}) => runDemo({ outDir: out, rounds: 3, every: 1, swarmClient: saying(content), ...extra });
const markup = (dir) => files(dir).filter((f) => /\.(svg|html)$/.test(f));
const LEAK = /\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]/;

describe("runDemo edge62: roster shape", () => {
  it("writes one art set and one share card per roster agent per round, with unique ids", async (t) => {
    const out = join(tmp(t), "run");
    const { manifest } = await runDemo({ outDir: out, rounds: 3, every: 1 });
    const ids = manifest.agents.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, AGENTS.map((a) => a.id));
    assert.equal(manifest.shares.length, 3 * AGENTS.length);
    assert.equal(new Set(manifest.shares.map((s) => s.file)).size, manifest.shares.length);
    for (const a of manifest.agents) assert.ok(a.sheets.length >= 1, `${a.id} has a sheet`);
  });

  it("a single-round run (every = 1) still anchors, shares and renders a page", async (t) => {
    const out = join(tmp(t), "run");
    const r = await runDemo({ outDir: out, rounds: 1, every: 1 });
    assert.equal(r.manifest.shares.length, AGENTS.length);
    assert.ok(read(out, "index.html").startsWith("<!doctype html>") || read(out, "index.html").includes("<html"));
    assert.equal(JSON.parse(read(out, "anchors.json")).calls.length, AGENTS.length);
  });
});

describe("runDemo edge62: hostile model text through the real pipeline", () => {
  const unicode = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} \u{1F680} e\u0301\u0301 \u05E9\u05DC\u05D5\u05DD \u0645\u0631\u062D\u0628\u0627 \u202Eevil\u202C";

  it("emoji, ZWJ families, combining marks and RTL text produce well-formed cards with no bidi override", async (t) => {
    const out = join(tmp(t), "run");
    await run(out, unicode);
    for (const f of files(out).filter((x) => x.startsWith("share/"))) {
      const svg = read(out, f);
      assert.ok(svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"), f);
      assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(svg), `${f} keeps no bidi control`);
      assert.ok(svg.includes("\u05E9\u05DC\u05D5\u05DD"), `${f} keeps the Hebrew`);
      assert.ok(!LEAK.test(svg), `${f} leaks a placeholder`);
    }
    assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(read(out, "transcript.txt")));
    JSON.parse(read(out, "demo.json"));
    JSON.parse(read(out, "events.json"));
  });

  it("markup in a reply is escaped in every svg and html file", async (t) => {
    const out = join(tmp(t), "run");
    await run(out, `<script>alert(1)</script> <img src=x onerror=alert(2)> & "q" 'a' $& $' $1`);
    for (const f of markup(out)) {
      const body = read(out, f);
      assert.ok(!body.includes("<script>alert(1)"), `${f} has raw script`);
      assert.ok(!/<img src=x/.test(body), `${f} has raw injected img`);
    }
    assert.ok(read(out, "index.html").includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  });

  it("a 10k-character reply and a 10k-character unbroken word stay bounded in every output file", async (t) => {
    for (const content of ["lorem ipsum ".repeat(900), "x".repeat(10000)]) {
      const out = join(tmp(t), "run");
      const { manifest } = await run(out, content);
      for (const e of JSON.parse(read(out, "events.json")).events) {
        // 1024-byte cap plus the "@Name " prefix a reply gets.
        assert.ok(Buffer.byteLength(e.text) <= 1024 + 32, "event text is capped");
      }
      for (const f of files(out).filter((x) => x.startsWith("share/"))) {
        assert.ok(statSync(join(out, f)).size < 20000, `${f} is bounded`);
      }
      assert.ok(statSync(join(out, "index.html")).size < 400000);
      assert.equal(manifest.shares.length, 3 * AGENTS.length);
    }
  });

  it("an empty or whitespace-only reply does not leak undefined/NaN/null into any svg or the page", async (t) => {
    for (const content of ["", "   \n\t "]) {
      const out = join(tmp(t), "run");
      await run(out, content);
      for (const f of markup(out)) {
        assert.ok(!LEAK.test(read(out, f)), `${f} leaks a placeholder for ${JSON.stringify(content)}`);
      }
    }
  });

  it("hostile replies give byte-identical output on two runs", async (t) => {
    const a = join(tmp(t), "a");
    const b = join(tmp(t), "b");
    await run(a, unicode + " <b>x</b>");
    await run(b, unicode + " <b>x</b>");
    const fa = files(a);
    assert.deepEqual(fa, files(b));
    for (const f of fa) assert.equal(read(a, f), read(b, f), f);
  });
});

describe("runDemo edge62: hostile character sheets", () => {
  it("a long unicode sheet with markup is stored whole, escaped on the page, and anchors to the same hash", async (t) => {
    const out = join(tmp(t), "run");
    const sheet = `Who I am: \u05E9\u05DC\u05D5\u05DD \u{1F680} <i>x</i> ${"word ".repeat(300)}`;
    const { manifest } = await run(out, "hello there", { sheetClient: saying(sheet) });
    const anchors = JSON.parse(read(out, "anchors.json"));
    for (const agent of manifest.agents) {
      assert.ok(agent.sheets.length >= 1);
      for (const s of agent.sheets) {
        assert.equal(s.words, s.sheet.split(/\s+/).filter(Boolean).length);
        assert.ok(s.sheet.includes("<i>x</i>"), "sheet text is stored unescaped");
      }
      const anchored = anchors.calls.filter((c) => c.tokenId === agent.id).map((c) => c.args.sheet_hash);
      assert.deepEqual(anchored, agent.sheets.map((s) => s.sheetHash));
    }
    assert.ok(!read(out, "index.html").includes("<i>x</i>"));
  });
});

describe("runDemo edge62: failure leaves nothing half written", () => {
  it("a sheet client that fails on a later call leaves no manifest, page, temp or partial files", async (t) => {
    const out = join(tmp(t), "run");
    let calls = 0;
    const flaky = { chat: async () => { calls += 1; if (calls > 3) throw new Error("late boom"); return { content: "Who I am: steady. Receipts: 1 post." }; } };
    await assert.rejects(run(out, "hi", { sheetClient: flaky }), /late boom/);
    const left = files(out);
    for (const f of left) {
      assert.ok(!/\.(tmp|part)$|~$/.test(f), `${f} looks like a partial write`);
      assert.ok(!["demo.json", "index.html", "anchors.json", "events.json"].includes(f), `${f} must not exist`);
    }
  });
});
