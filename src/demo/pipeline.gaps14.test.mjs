import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEMO_DEFAULTS, runDemo } from "./pipeline.mjs";
import { moodForText } from "../art/moods.mjs";
import { getStyle } from "../art/styles/index.mjs";
import { AGENTS } from "../traits/agents.mjs";

const read = (dir, f) => readFileSync(join(dir, f), "utf8");
const readJson = (dir, f) => JSON.parse(read(dir, f));

function withTmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-gaps14-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("runDemo: options", () => {
  it("a custom contractId reaches anchors.json, the transfer section and the page, and no call is signed", async (t) => {
    const out = withTmp(t);
    await runDemo({ outDir: out, rounds: 2, every: 2, contractId: "my-nft.testnet" });
    const anchors = readJson(out, "anchors.json");
    assert.equal(anchors.contractId, "my-nft.testnet");
    assert.equal(anchors.signed, false);
    assert.ok(anchors.calls.every((c) => c.status === "dry-run" && c.transactionHash === null));
    assert.equal(readJson(out, "demo.json").transfer.contractId, "my-nft.testnet");
    assert.ok(read(out, "index.html").includes("<code>my-nft.testnet</code>"));
    assert.ok(!read(out, "index.html").includes(DEMO_DEFAULTS.contractId));
  });

  for (const every of [1.5, 0, -1, Number.NaN, "2"]) {
    it(`every = ${JSON.stringify(every)} is rejected with a RangeError before anything is written`, async (t) => {
      const out = join(withTmp(t), "never");
      await assert.rejects(runDemo({ outDir: out, rounds: 4, every }), (e) => e instanceof RangeError && /every must be between 1 and rounds \(4\)/.test(e.message));
      assert.ok(!existsSync(out));
    });
  }

  it("an unknown style is rejected before the out dir is created", async (t) => {
    const out = join(withTmp(t), "never");
    await assert.rejects(runDemo({ outDir: out, style: "nope" }), /unknown style: nope/);
    assert.ok(!existsSync(out));
  });
});

describe("runDemo: share cards", () => {
  it("writes exactly one card per channel message, named <agent>-<round>, with the mood the text implies", async (t) => {
    const out = withTmp(t);
    const { manifest } = await runDemo({ outDir: out, rounds: 3, every: 3 });
    const events = readJson(out, "events.json").events;
    assert.equal(manifest.shares.length, events.length);
    assert.deepEqual(readdirSync(join(out, "share")).filter((f) => /^[a-z]+-\d+\.svg$/.test(f)).sort(), manifest.shares.map((s) => s.file.replace("share/", "")).sort());
    for (const s of manifest.shares) {
      const e = events.find((x) => x.id === s.eventId);
      assert.equal(s.file, `share/${e.agentId}-${e.round}.svg`);
      assert.equal(s.mood, moodForText(e.text));
      const svg = read(out, s.file);
      assert.ok(svg.includes(`data-mood="${s.mood}"`));
      assert.ok(svg.includes(`round ${e.round} · ${s.mood}`));
    }
  });
});

describe("runDemo: art and memory depth", () => {
  it("each agent's now image is the style render at depth 1 + sheets, the mint image at depth 1", async (t) => {
    const out = withTmp(t);
    const { manifest } = await runDemo({ outDir: out, rounds: 4, every: 2, style: "pixel" });
    const style = getStyle("pixel");
    for (const a of AGENTS) {
      const entry = manifest.agents.find((x) => x.id === a.id);
      assert.equal(entry.sheets.length, 2);
      assert.equal(entry.memoryDepth, 3);
      assert.equal(read(out, `art/${a.id}.svg`), style.render({ ...a.traits, memory_depth: 3 }, { mood: "neutral" }));
      assert.equal(read(out, `art/${a.id}.mint.svg`), style.render({ ...a.traits, memory_depth: 1 }, { mood: "neutral" }));
      assert.equal(read(out, `art/${a.id}.hype.svg`), style.render({ ...a.traits, memory_depth: 3 }, { mood: "hype" }));
    }
  });
});

describe("runDemo: rerun ownership", () => {
  it("a default-style rerun over a sticker run drops its stale mood faces, share and meme cards but keeps foreign files", async (t) => {
    const out = withTmp(t);
    await runDemo({ outDir: out, rounds: 4, every: 2, style: "sticker" });
    assert.ok(existsSync(join(out, "art", "aloof.hype.svg")));
    writeFileSync(join(out, "art", "notes.txt"), "mine");
    writeFileSync(join(out, "share", "keep.txt"), "mine");
    mkdirSync(join(out, "memory", "other"), { recursive: true });
    writeFileSync(join(out, "memory", "other", "x.txt"), "mine");

    const { files, manifest } = await runDemo({ outDir: out, rounds: 2, every: 1, style: "default" });
    assert.ok(!existsSync(join(out, "art", "aloof.hype.svg")), "a sticker-only face is gone");
    assert.ok(!existsSync(join(out, "share", "aloof-4.svg")), "a round-4 card is gone after a 2-round run");
    const memesOnDisk = readdirSync(join(out, "share")).filter((f) => f.startsWith("meme-")).map((f) => `share/${f}`).sort();
    assert.deepEqual(memesOnDisk, manifest.memes.map((m) => m.file).sort(), "only this run's meme cards remain");
    for (const keep of ["art/notes.txt", "share/keep.txt", "memory/other/x.txt"]) assert.equal(read(out, keep), "mine", keep);
    for (const f of files) assert.ok(existsSync(join(out, f)), f);
    assert.deepEqual(files, [...files].sort());
    assert.equal(new Set(files).size, files.length);
  });
});

describe("runDemo: result", () => {
  it("returns the final round hash that demo.json, the page and the last roundHashes entry agree on", async (t) => {
    const out = withTmp(t);
    const run = await runDemo({ outDir: out, rounds: 3, every: 3, seed: 5 });
    assert.equal(run.verified, true);
    assert.equal(run.outDir, out);
    const manifest = readJson(out, "demo.json");
    assert.equal(manifest.schema, "near-demo/run@1");
    assert.equal(manifest.mode, "mock");
    assert.equal(manifest.seed, 5);
    assert.equal(manifest.finalRoundHash, run.finalRoundHash);
    assert.equal(manifest.roundHashes.at(-1), run.finalRoundHash);
    assert.ok(read(out, "index.html").includes(`final round hash <span class="hash">${run.finalRoundHash}</span>`));
  });

  it("a different seed changes the final round hash; the same seed does not", async (t) => {
    const a = await runDemo({ outDir: withTmp(t), rounds: 3, every: 3, seed: 1 });
    const b = await runDemo({ outDir: withTmp(t), rounds: 3, every: 3, seed: 1 });
    const c = await runDemo({ outDir: withTmp(t), rounds: 3, every: 3, seed: 2 });
    assert.equal(a.finalRoundHash, b.finalRoundHash);
    assert.notEqual(a.finalRoundHash, c.finalRoundHash);
  });
});
