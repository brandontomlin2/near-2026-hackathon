import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runDemo, DEMO_DEFAULTS } from "./pipeline.mjs";
import { formatDeposit, renderDemoPage } from "./page.mjs";
import { main } from "../../scripts/demo.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { verifyRounds } from "../swarm/runner.mjs";
import { sheetHash, MAX_SHEET_WORDS } from "../memory/summarizer.mjs";
import { hashSheet } from "../anchor/hash.mjs";
import { getStyle } from "../art/styles/index.mjs";
import { moodForText, MOODS } from "../art/moods.mjs";
import { renderShareCard, wrapText } from "./share.mjs";

const PINNED_FINAL_ROUND_HASH = "ed0b0c82315a4a04b81026fb90429ff0c7f292ede27a992c6cbadbee5435284d";
const IDS = ["aloof", "chaotic", "social", "skeptic"];
// Pins the sheet writer, summarizer prompt, hashing, art paths and anchors, not just the swarm.
const PINNED_ALOOF_SHEET_HASH = "c5dbce1a701dadfa057cf6aed9f435c773b02b5aeb2641906c22867bb97bc0d0";
const PINNED_DEMO_JSON_SHA256 = "a49d2079fe73c52e4dc2fa7dfe26ee87ecddcbf157fc923a838f19272525d634";

const tmp = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-test-"));
  tmp.push(dir);
  return dir;
}

function walk(root, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out.sort();
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
const lineCount = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8").split("\n").filter(Boolean).length;

// Silence console.error while fn runs; returns what was written.
async function quietly(fn) {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    return { value: await fn(), errors };
  } finally {
    console.error = original;
  }
}

let dirA;
let dirB;
let resultA;
let resultB;

before(async () => {
  dirA = mkTmp();
  dirB = mkTmp();
  resultA = await runDemo({ outDir: dirA });
  resultB = await runDemo({ outDir: dirB });
});

after(() => {
  for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
});

describe("demo: determinism", () => {
  it("two default runs write the same files with identical bytes", () => {
    const a = walk(dirA);
    const b = walk(dirB);
    assert.deepEqual(a, b);
    for (const f of a) {
      assert.ok(
        fs.readFileSync(path.join(dirA, f)).equals(fs.readFileSync(path.join(dirB, f))),
        `${f} differs between runs`,
      );
    }
    assert.equal(resultA.finalRoundHash, resultB.finalRoundHash);
  });

  it("pins Aloof's final sheet hash and the whole demo.json", async () => {
    const { createHash } = await import("node:crypto");
    assert.equal(readJson(dirA, "memory/aloof/sheet.json").sheetHash, PINNED_ALOOF_SHEET_HASH);
    const digest = createHash("sha256").update(fs.readFileSync(path.join(dirA, "demo.json"))).digest("hex");
    assert.equal(digest, PINNED_DEMO_JSON_SHA256);
  });

  it("pins the default final round hash", () => {
    assert.equal(resultA.finalRoundHash, PINNED_FINAL_ROUND_HASH);
    assert.deepEqual({ ...DEMO_DEFAULTS }, {
      rounds: 6,
      seed: 1,
      every: 3,
      style: "sticker",
      contractId: "personality-nft.demo.testnet",
    });
  });
});

describe("demo: files", () => {
  it("result.files equals the files on disk", () => {
    assert.deepEqual([...resultA.files].sort(), walk(dirA));
    assert.equal(resultA.verified, true);
  });

  it("includes the expected outputs", () => {
    const files = new Set(resultA.files);
    for (const f of ["index.html", "demo.json", "anchors.json", "events.json", "transcript.txt"]) {
      assert.ok(files.has(f), `missing ${f}`);
    }
    for (const id of IDS) {
      for (const f of [`art/${id}.svg`, `art/${id}.mint.svg`, `memory/${id}/log.jsonl`, `memory/${id}/sheet.json`]) {
        assert.ok(files.has(f), `missing ${f}`);
      }
    }
  });

  it("agents in the code are the four expected ids", () => {
    assert.deepEqual(AGENTS.map((a) => a.id).sort(), [...IDS].sort());
  });

  it("no written file contains an absolute path or the temp dir", () => {
    for (const f of walk(dirA)) {
      const text = fs.readFileSync(path.join(dirA, f), "utf8");
      for (const needle of [dirA, path.basename(dirA), os.tmpdir(), "/Users/", "/private/var", "/var/folders"]) {
        assert.ok(!text.includes(needle), `${f} contains ${needle}`);
      }
    }
  });
});

describe("demo: rerun", () => {
  it("rerunning into the same dir does not double the append-only logs", async () => {
    const dir = mkTmp();
    await runDemo({ outDir: dir });
    const first = Object.fromEntries(IDS.map((id) => [id, lineCount(dir, `memory/${id}/log.jsonl`)]));
    await runDemo({ outDir: dir });
    for (const id of IDS) {
      assert.ok(first[id] > 0);
      assert.equal(lineCount(dir, `memory/${id}/log.jsonl`), first[id], `${id} log grew`);
    }
  });
});

describe("demo: memory", () => {
  it("each agent has 2 bounded sheets at rounds 3 and 6", () => {
    for (const a of resultA.manifest.agents) {
      assert.deepEqual(a.sheets.map((s) => s.round), [3, 6]);
      for (const s of a.sheets) {
        const words = s.sheet.split(/\s+/).filter(Boolean).length;
        assert.ok(words <= MAX_SHEET_WORDS, `${a.id} round ${s.round}: ${words} words`);
        assert.equal(s.words, words);
      }
    }
  });

  it("sheet.json holds the round-6 sheet and its hash matches the last anchor", () => {
    const anchors = readJson(dirA, "anchors.json");
    for (const id of IDS) {
      const record = readJson(dirA, `memory/${id}/sheet.json`);
      assert.equal(record.round, 6);
      const lastCall = anchors.calls.filter((c) => c.tokenId === id).at(-1);
      assert.equal(lastCall.round, 6);
      assert.equal(record.sheetHash, hashSheet(record.sheet));
      assert.equal(record.sheetHash, sheetHash(record.sheet));
      assert.equal(record.sheetHash, lastCall.args.sheet_hash);
      const agent = resultA.manifest.agents.find((a) => a.id === id);
      assert.equal(agent.sheets.at(-1).sheet, record.sheet);
    }
  });
});

describe("demo: anchors", () => {
  it("are eight unsigned testnet dry-run calls", () => {
    const anchors = readJson(dirA, "anchors.json");
    assert.equal(anchors.network, "testnet");
    assert.equal(anchors.signed, false);
    assert.equal(anchors.calls.length, 8);
    for (const c of anchors.calls) {
      assert.equal(c.status, "dry-run");
      assert.equal(c.transactionHash, null);
      assert.equal(c.method, "anchor_sheet");
    }
  });

  it("first call per token has the larger deposit, the second costs 1 yocto", () => {
    const anchors = readJson(dirA, "anchors.json");
    for (const id of IDS) {
      const [first, second, ...rest] = anchors.calls.filter((c) => c.tokenId === id);
      assert.equal(rest.length, 0);
      assert.equal(first.firstAnchor, true);
      assert.equal(second.firstAnchor, false);
      assert.equal(second.depositYocto, "1");
      assert.ok(BigInt(first.depositYocto) > BigInt(second.depositYocto));
    }
  });
});

describe("demo: round chain", () => {
  it("events.json verifies and the manifest ends on the last round hash", () => {
    const events = readJson(dirA, "events.json");
    assert.equal(verifyRounds(events), true);
    assert.equal(resultA.manifest.finalRoundHash, events.roundHashes.at(-1));
    assert.equal(resultA.manifest.finalRoundHash, resultA.finalRoundHash);
  });
});

describe("demo: art", () => {
  it("writes the sticker style: neutral at memory depth 3, mint at 1, and one file per mood", () => {
    const style = getStyle("sticker");
    for (const agent of AGENTS) {
      const read = (f) => fs.readFileSync(path.join(dirA, f), "utf8");
      assert.equal(read(`art/${agent.id}.svg`), style.render({ ...agent.traits, memory_depth: 3 }, { mood: "neutral" }));
      assert.equal(read(`art/${agent.id}.mint.svg`), style.render({ ...agent.traits, memory_depth: 1 }, { mood: "neutral" }));
      for (const mood of MOODS) {
        assert.equal(read(`art/${agent.id}.${mood}.svg`), style.render({ ...agent.traits, memory_depth: 3 }, { mood }));
      }
    }
  });
});

describe("demo: page content", () => {
  const html = () => fs.readFileSync(path.join(dirA, "index.html"), "utf8");

  it("has the hero text and one short mock notice", () => {
    assert.ok(html().includes("<h1>Your NFT remembers who you are</h1>"));
    assert.equal((html().match(/class="notice"/g) ?? []).length, 1);
  });

  it("each agent card shows four mood images", () => {
    for (const agent of resultA.manifest.agents) {
      const strip = html().split('<div class="card">').find((c) => c.includes(`alt="${agent.name} in mood neutral"`));
      assert.ok(strip, `no card for ${agent.id}`);
      for (const mood of MOODS) assert.ok(strip.includes(`src="art/${agent.id}.${mood}.svg" alt="${agent.name} in mood ${mood}"`), `${agent.id} lacks ${mood}`);
    }
  });

  it("every channel message has a face whose mood matches its text", () => {
    const events = readJson(dirA, "events.json").events;
    const msgs = html().split('<div class="msg">').slice(1);
    assert.equal(msgs.length, events.length);
    msgs.forEach((m, i) => {
      const e = events[i];
      const mood = moodForText(e.text);
      assert.ok(m.includes(`src="art/${e.agentId}.${mood}.svg"`), `message ${e.id}: wrong face`);
      assert.ok(m.includes(`data-mood="${mood}"`));
      assert.ok(m.includes(`<span class="mood">${mood}</span>`));
    });
  });

  it("links every share card and the page stays small", () => {
    for (const x of resultA.manifest.shares) assert.ok(html().includes(`<img src="${x.file}"`));
    assert.ok(Buffer.byteLength(html()) < 100_000);
  });
});

describe("demo: share cards", () => {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  it("exist, are in manifest.files, and carry the quote, an svg and no external refs", () => {
    const events = readJson(dirA, "events.json").events;
    assert.equal(resultA.manifest.shares.length, events.length);
    for (const e of events) {
      const file = `share/${e.agentId}-${e.round}.svg`;
      assert.ok(resultA.manifest.files.includes(file), `${file} not in manifest.files`);
      const svg = fs.readFileSync(path.join(dirA, file), "utf8");
      assert.ok(svg.startsWith("<svg"));
      assert.ok(svg.includes("Personality NFT"));
      assert.ok(svg.includes("<svg", 5), "face is nested");
      assert.ok(!/href=|<script|<image/.test(svg));
      assert.ok(wrapText(e.text).every((l) => svg.includes(esc(l))), `${file} lacks the quote`);
    }
    for (const id of IDS) for (const m of MOODS) assert.ok(resultA.manifest.files.includes(`art/${id}.${m}.svg`));
  });

  it("escapes a hostile quote and agent name", () => {
    const hostile = `<script>alert("x")</script> & 'q'`;
    const faceSvg = getStyle("sticker").render(AGENTS[0].traits, { mood: "shook" });
    const svg = renderShareCard({ agentName: `<b>&"'`, text: hostile, mood: "shook", round: 1, faceSvg });
    assert.ok(!svg.includes("<script"));
    assert.ok(!svg.includes("<b>"));
    assert.ok(svg.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
    assert.ok(svg.includes("&amp; &#39;q&#39;"));
  });

  it("wraps long words and keeps lines within the width", () => {
    const lines = wrapText(`${"x".repeat(60)} short words here`, 22);
    assert.ok(lines.every((l) => l.length <= 22));
    assert.equal(lines.join("").replace(/ /g, ""), `${"x".repeat(60)}shortwordshere`);
  });
});

describe("demo: styles", () => {
  it("--style default works: neutral only, no mood strip, still one share card per message", async () => {
    const dir = mkTmp();
    const r = await main(["--style", "default", "--out", dir], { env: {}, log: () => {} });
    assert.equal(r, 0);
    const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
    assert.ok(!html.includes('class="moods"'));
    assert.ok(html.includes("Your NFT remembers who you are"));
    const manifest = readJson(dir, "demo.json");
    assert.equal(manifest.style, "default");
    assert.deepEqual(manifest.moods, ["neutral"]);
    assert.equal(walk(dir).filter((f) => f.startsWith("share/")).length, 24);
    assert.ok(!fs.existsSync(path.join(dir, "art/aloof.hype.svg")));
    for (const f of walk(dir).filter((x) => x.startsWith("share/"))) {
      assert.ok(fs.readFileSync(path.join(dir, f), "utf8").includes("<svg"));
    }
  });

  it("rejects an unknown --style and runDemo rejects it before writing", async () => {
    const r = await quietly(() => main(["--style", "nope"], { env: {}, log: () => {} }));
    assert.equal(r.value, 2);
    assert.match(r.errors.join("\n"), /unknown style/);
    const dir = path.join(mkTmp(), "out");
    await assert.rejects(runDemo({ outDir: dir, style: "nope" }), /unknown style/);
    assert.equal(fs.existsSync(dir), false);
  });
});

describe("demo: offline", () => {
  it("succeeds with a throwing fetch", async (t) => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network is forbidden in the demo");
    };
    t.after(() => {
      globalThis.fetch = original;
    });
    const dir = mkTmp();
    const result = await runDemo({ outDir: dir });
    assert.equal(result.verified, true);
    assert.equal(result.finalRoundHash, PINNED_FINAL_ROUND_HASH);
  });
});

describe("demo: page", () => {
  it("is self-contained and shows the key facts", () => {
    const html = fs.readFileSync(path.join(dirA, "index.html"), "utf8");
    assert.ok(!html.includes("<script"));
    const urls = html.match(/https?:\/\/[^\s"'<>)]*/g) ?? [];
    for (const u of urls) assert.equal(u, "http://www.w3.org/2000/svg", `unexpected URL ${u}`);
    assert.ok(!html.includes("https://"));
    for (const a of AGENTS) assert.ok(html.includes(a.name), `missing ${a.name}`);
    assert.ok(html.includes(resultA.finalRoundHash));
    assert.ok(html.includes("dry-run"));
    assert.ok((html.match(/<img /g) ?? []).length >= 4);
  });

  it("escapes HTML in sheets and events", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const manifest = structuredClone(resultA.manifest);
    manifest.agents[0].sheets[0].sheet = payload;
    manifest.agents[0].sheets[1].sheet = payload;
    const events = readJson(dirA, "events.json").events.map((e, i) => (i === 0 ? { ...e, text: payload } : e));
    const anchors = readJson(dirA, "anchors.json");
    const html = renderDemoPage(manifest, { events, anchors });
    assert.ok(!html.includes(payload));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  });
});

describe("demo: options", () => {
  it("rounds 2, every 1, seed 7 gives 2 sheets per agent and a different hash", async () => {
    const dir = mkTmp();
    const result = await runDemo({ outDir: dir, rounds: 2, every: 1, seed: 7 });
    for (const a of result.manifest.agents) {
      assert.deepEqual(a.sheets.map((s) => s.round), [1, 2]);
    }
    assert.notEqual(result.finalRoundHash, resultA.finalRoundHash);
  });
});

describe("demo: CLI main", () => {
  const run = async (argv, env = {}) => {
    const lines = [];
    const { value, errors } = await quietly(() => main(argv, { env, log: (l = "") => lines.push(String(l)) }));
    return { code: value, lines, errors };
  };

  it("rejects --rounds 0", async () => {
    const r = await run(["--rounds", "0"]);
    assert.equal(r.code, 2);
    assert.ok(r.errors.length > 0);
  });

  it("rejects --every larger than --rounds, since no sheet would be written", async () => {
    const r = await run(["--rounds", "2", "--every", "3"]);
    assert.equal(r.code, 2);
    assert.match(r.errors.join("\n"), /--every \(3\) must not exceed --rounds \(2\)/);
  });

  it("rejects an --out value that is another flag", async () => {
    const r = await run(["--out", "--rounds"]);
    assert.equal(r.code, 2);
    assert.equal(fs.existsSync("--rounds"), false);
  });

  it("accepts --seed 0", async () => {
    assert.equal((await run(["--seed", "0", "--out", mkTmp()], {})).code, 0);
  });

  it("prints a hash check command that works for an absolute --out", async () => {
    const dir = mkTmp();
    const r = await run(["--out", dir], {});
    assert.ok(r.lines.join("\n").includes(`require("${dir}/memory/aloof/sheet.json")`));
  });

  it("rejects an unknown flag", async () => {
    assert.equal((await run(["--bogus"])).code, 2);
  });

  it("prints usage for --help", async () => {
    const r = await run(["--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.lines.join("\n").includes("Usage"));
  });

  it("refuses live mode and writes nothing", async () => {
    const dir = path.join(mkTmp(), "out");
    const r = await run(["--out", dir], { MOCK_INFERENCE: "0" });
    assert.equal(r.code, 2);
    assert.equal(fs.existsSync(dir), false);
  });

  it("a normal run exits 0 and prints the guide and file paths", async () => {
    const dir = mkTmp();
    const r = await run(["--out", dir], {});
    assert.equal(r.code, 0, r.errors.join("\n"));
    const out = r.lines.join("\n");
    assert.ok(out.includes("Nothing was signed"));
    assert.ok(out.includes("Do this, see that:"));
    for (const f of walk(dir)) assert.ok(out.includes(`${dir}/${f}`), `output lacks ${f}`);
    assert.ok(out.includes(PINNED_FINAL_ROUND_HASH));
  });
});

describe("demo: guards and formatting", () => {
  it("runDemo rejects every > rounds before writing anything", async () => {
    const dir = path.join(mkTmp(), "out");
    await assert.rejects(runDemo({ outDir: dir, rounds: 2, every: 3 }), RangeError);
    assert.equal(fs.existsSync(dir), false);
  });

  it("formatDeposit shows NEAR for storage deposits and yoctoNEAR for 1 yocto", () => {
    assert.equal(formatDeposit("10000000000000000000000"), "0.01 NEAR");
    assert.equal(formatDeposit("1000000000000000000000000"), "1 NEAR");
    assert.equal(formatDeposit("1"), "1 yoctoNEAR");
  });

  it("the page names the placeholder contract, shows deposits in NEAR and how to check a hash", () => {
    const html = fs.readFileSync(path.join(dirA, "index.html"), "utf8");
    assert.ok(html.includes("placeholder contract id"));
    assert.ok(html.includes("0.01 NEAR") && html.includes("1 yoctoNEAR"));
    assert.ok(html.includes("shasum -a 256"));
    assert.ok(html.includes("memory_depth: 1 at mint, 3 now"));
    assert.ok(!/\brings?\b/.test(html));
    assert.ok(!html.includes('href="index.html"'));
  });
});

describe("demo: output dir safety", () => {
  it("removes only the four token memory dirs, never other content under memory/", async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, "memory", "mine"), { recursive: true });
    fs.writeFileSync(path.join(dir, "memory", "mine", "keep.txt"), "user data");
    await runDemo({ outDir: dir });
    await runDemo({ outDir: dir });
    assert.equal(fs.readFileSync(path.join(dir, "memory", "mine", "keep.txt"), "utf8"), "user data");
  });
});
