// Locks claims in docs/x-post.md, docs/demo-script.md, docs/demo-video.md,
// docs/hosting.md, docs/privacy.md and PRODUCT.md to the real output of the
// commands they reference. One mock `npm run demo` is shared by the tests below.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { moodForText } from "../src/art/moods.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, MOCK_INFERENCE: "1" };
delete env.NEAR_AI_API_KEY;

const doc = async (name) => readFile(join(root, "docs", name), "utf8");
const HEX64 = /\b[0-9a-f]{64}\b/g;
const pageText = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

/** Words inside the double-quoted narration lines of a "## Narration" section. */
function narrationWords(markdown, nextHeading) {
  const section = markdown.split("## Narration")[1].split(nextHeading)[0];
  const quoted = [...section.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(" ");
  return quoted.split(/\s+/).filter(Boolean).length;
}

let dir;
let out;
let stdout;
let demo;
let page;
let transcript;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "docs-facts-"));
  out = join(dir, "out");
  ({ stdout } = await run(process.execPath, [join(root, "scripts/demo.mjs"), "--out", out], { env }));
  demo = JSON.parse(await readFile(join(out, "demo.json"), "utf8"));
  page = pageText(await readFile(join(out, "index.html"), "utf8"));
  transcript = await readFile(join(out, "transcript.txt"), "utf8");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("demo-video.md: every hash is from the real demo output", async () => {
  const video = await doc("demo-video.md");
  const known = new Set([
    demo.finalRoundHash,
    ...demo.roundHashes.map((r) => (typeof r === "string" ? r : r.hash)),
    ...demo.agents.flatMap((a) => a.sheets.map((s) => s.sheetHash)),
    ...demo.transfer.tokens.flatMap((t) => [t.anchoredHash, t.recomputedHash]),
    demo.transfer.tamper.anchoredHash,
    demo.transfer.tamper.recomputedHash,
  ]);
  const shown = video.match(HEX64) ?? [];
  for (const h of shown) assert.ok(known.has(h), `demo-video.md hash ${h} is not in demo.json`);
  const aloof = demo.transfer.tokens.find((t) => t.tokenId === "aloof");
  assert.ok(aloof.match, "aloof transfer row must be a match");
  assert.ok(shown.includes(aloof.anchoredHash), "must show Aloof's anchored sheet hash");
  assert.ok(shown.includes(demo.transfer.tamper.recomputedHash), "must show the tampered re-hash");
  assert.equal(demo.transfer.tamper.match, false);
  assert.ok(shown.includes(demo.finalRoundHash), "must show the final round hash");
  const short = video.match(/`([0-9a-f]{8})\.\.\.([0-9a-f]{4})`/);
  assert.ok(short, "shot 7 abbreviates the anchored hash as `xxxxxxxx...xxxx`");
  assert.ok(aloof.anchoredHash.startsWith(short[1]) && aloof.anchoredHash.endsWith(short[2]));
});

test("demo-video.md and demo-script.md: quoted terminal lines are printed by npm run demo", async () => {
  const video = await doc("demo-video.md");
  const script = await doc("demo-script.md");
  const lines = [
    "[1/5] swarm: 6 rounds, 24 events, verify: ok",
    "[4/5] anchor (dry run): 8 calls prepared, 0 signed",
    "Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.",
  ];
  for (const line of lines) {
    assert.ok(stdout.includes(line), `demo does not print: ${line}`);
    assert.ok(video.includes(line), `demo-video.md does not quote: ${line}`);
  }
  assert.ok(script.includes("Nothing was signed or sent"));
  assert.equal(stdout.match(/^\[\d\/5\] /gm).length, 5, "five [n/5] lines");
});

test("demo-video.md: the quoted Chaotic -> Skeptic line is in round 1 of transcript.txt", async () => {
  const video = await doc("demo-video.md");
  const quoted = video.match(/`(\[Chaotic -> Skeptic\][^`]*)`/);
  assert.ok(quoted, "shot 4 must quote a [Chaotic -> Skeptic] line");
  const round1 = transcript.split("== Round 2 ==")[0];
  assert.ok(round1.includes(quoted[1]), `round 1 of the transcript lacks: ${quoted[1]}`);
  assert.ok(page.includes("Chaotic → Skeptic"), "the page shows the reply as an arrow");
});

test("demo-video.md: the shot 8 grep matches exactly the final-hash line, step 6", async () => {
  const video = await doc("demo-video.md");
  const pattern = video.match(/npm run demo \\\| grep (\w+)/);
  assert.ok(pattern, "shot 8 must show `npm run demo | grep <pattern>`");
  const hits = stdout.split("\n").filter((l) => l.includes(pattern[1]));
  assert.equal(hits.length, 1, `grep ${pattern[1]} must match one line`);
  assert.match(hits[0], /^\s*6\. Run the same command again/);
  assert.ok(hits[0].endsWith(`${demo.finalRoundHash}.`));
  assert.match(video, /step 6 of the "Do this, see that" list/);
  assert.doesNotMatch(video, /step 5 of the "Do this, see that" list|same hash in step 5/);
});

test("demo-video.md: the quoted banner is on the page, and 'mock' appears where the doc says", async () => {
  const video = await doc("demo-video.md");
  const banner = "Mock mode, dry run: inference is mocked and nothing is signed, sent or deployed.";
  assert.ok(video.includes(banner));
  assert.ok(page.includes(banner));
  const mentions = page.match(/mock/gi) ?? [];
  assert.equal(mentions.length, 6, "banner (Mock mode, mocked), MOCK_INFERENCE=0 note, transfer accounts and contract labelled mock placeholder, TEE badge");
  assert.ok(page.includes("MOCK_INFERENCE=0"));
  assert.ok(page.includes("NEAR AI Cloud (TEE) in live mode : mocked"));
});

test("art gains a star per sheet (not a ring); the X post, video and script say star", async () => {
  const stars = async (file) => ((await readFile(join(out, file), "utf8")).match(/data-ring=/g) ?? []).length;
  for (const a of demo.agents) {
    assert.equal(await stars(`art/${a.id}.mint.svg`), 1);
    assert.equal(await stars(`art/${a.id}.svg`), a.memoryDepth);
    assert.equal(a.memoryDepth, 1 + a.sheets.length);
  }
  assert.equal(demo.agents[0].memoryDepth, 3);
  for (const name of ["x-post.md", "demo-video.md", "demo-script.md"]) {
    const text = await doc(name);
    assert.doesNotMatch(text, /\bring (is added|for every|for each)|extra rings/i, `${name} still describes a ring`);
  }
  assert.match(await doc("x-post.md"), /a star is added to its art/);
});

test("demo-script.md: page facts (verify: ok, Chaotic's enemy, one shook per agent, section order)", async () => {
  const script = await doc("demo-script.md");
  assert.ok(page.includes("verify: ok"));
  const chaotic = demo.agents.find((a) => a.id === "chaotic");
  const [r3, r6] = chaotic.sheets.map((s) => s.sheet);
  assert.ok(r3.includes("Public enemy #1: nobody yet"));
  assert.ok(r6.includes("Public enemy #1: Skeptic"));
  assert.ok(r3.includes("Ride-or-die: no one yet") && r6.includes("Ride-or-die: no one yet"), "allies do not grow");
  assert.match(script, /Skeptic became its public enemy #1/);
  assert.doesNotMatch(script, /allies grew|allies have changed/);
  const events = JSON.parse(await readFile(join(out, "events.json"), "utf8"));
  const shook = {};
  for (const e of Array.isArray(events) ? events : events.events) {
    if (moodForText(e.text) === "shook") shook[e.agentId] = (shook[e.agentId] ?? 0) + 1;
  }
  assert.deepEqual(shook, { aloof: 1, chaotic: 1, skeptic: 1, social: 1 }, "each agent is caught off guard once");
  const order = ["Agents", "Memory", "Meme pack", "Transfer: memory travels with the NFT", "Channel", "Anchor (dry run)", "Round hash chain", `${demo.shares.length} share cards`, "Files"];
  const positions = order.map((h) => page.indexOf(` ${h} `));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "section order on the page");
  assert.ok(positions.every((p) => p > 0));
});

test("narration word counts are within 10 of the 'about N words' claims", async () => {
  const script = await doc("demo-script.md");
  const video = await doc("demo-video.md");
  const claimed = (text) => Number(text.match(/about (\d+) words/)[1]);
  assert.ok(Math.abs(narrationWords(script, "## Recording notes") - claimed(script)) <= 10);
  assert.ok(Math.abs(narrationWords(video, "## Screenshot checklist") - claimed(video)) <= 10);
});

test("x-post.md: each draft fits in 280 characters with links counted as 23", async () => {
  const post = await doc("x-post.md");
  const drafts = [...post.matchAll(/```\n([^\n]+)\n```/g)].map((m) => m[1]);
  assert.equal(drafts.length, 3);
  for (const d of drafts) {
    const n = [...d.replace(/<REPO_URL>/g, "x".repeat(23))].length;
    assert.ok(n <= 280, `draft is ${n} characters`);
    assert.ok(d.includes("@NEARProtocol") && d.includes("#NEARHackathon") && /NEAR HACKATHON/.test(d));
  }
  assert.ok(stdout.includes("8 calls prepared, 0 signed"));
  const anchors = JSON.parse(await readFile(join(out, "anchors.json"), "utf8"));
  assert.equal(anchors.calls.length, 8);
  assert.equal(anchors.signed, false);
  assert.ok(anchors.calls.every((c) => c.status === "dry-run" && c.transactionHash === null));
});

test("demo-video.md: npm run render -- --style sticker writes 16 SVGs plus a 1064 x 1064 sheet", async () => {
  const video = await doc("demo-video.md");
  const rdir = join(dir, "render");
  await run(process.execPath, [join(root, "scripts/render-agents.mjs"), "--style", "sticker", "--out", rdir], { env });
  const files = await readdir(join(rdir, "styles/sticker"));
  assert.equal(files.filter((f) => f !== "sheet.svg" && f.endsWith(".svg")).length, 16);
  assert.ok(files.includes("sheet.svg"));
  const sheet = await readFile(join(rdir, "styles/sticker/sheet.svg"), "utf8");
  assert.match(sheet, /^<svg [^>]*width="1064" height="1064"/);
  assert.ok(video.includes("16 SVGs plus `sheet.svg`"));
  assert.ok(video.includes("1064 x 1064"));
  assert.ok(video.includes("page content is 980 px wide"));
  assert.ok((await readFile(join(out, "index.html"), "utf8")).includes("max-width:980px"));
});

test("hosting.md: npm run site prints 'Site ready' and every link on the page is relative", async () => {
  const hosting = await doc("hosting.md");
  const site = join(dir, "site");
  const res = await run(process.execPath, [join(root, "scripts/site.mjs"), site], { env });
  const last = res.stdout.trim().split("\n").at(-1);
  assert.ok(last.startsWith(`Site ready: ${site}/index.html`), last);
  assert.ok(hosting.includes("a last line starting `Site ready: out/site/index.html`"));
  const html = await readFile(join(site, "index.html"), "utf8");
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"#]+)"/g)) {
    assert.doesNotMatch(url, /^(\/|[a-z]+:)/i, `absolute link on the hosted page: ${url}`);
  }
});

test("PRODUCT.md: every `npm run X` is a package.json script and every repo path it names exists", async () => {
  const product = await readFile(join(root, "PRODUCT.md"), "utf8");
  const { scripts } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const commands = [...product.matchAll(/npm run\s+([\w:-]+)/g)].map((m) => m[1]);
  assert.ok(commands.includes("swarm") && commands.includes("demo") && commands.includes("mint"));
  for (const name of commands) assert.ok(name in scripts, `PRODUCT.md names npm run ${name}, which is not in package.json`);
  assert.doesNotMatch(product, /npm run summarize|Planned, no such npm script|Nov 11/);
  const paths = [...product.matchAll(/`((?:scripts|src|docs|contracts|board)\/[^`\s]+)`/g)].map((m) => m[1]);
  assert.ok(paths.includes("scripts/verify.sh"));
  for (const p of paths) {
    await assert.doesNotReject(stat(join(root, p)), `PRODUCT.md names ${p}, which does not exist`);
  }
});

test("privacy.md: attest-check prints CONSISTENT, NOT VERIFIED (exit 0) and REJECT with --tamper (exit 1)", async () => {
  const privacy = await doc("privacy.md");
  const ok = await run(process.execPath, [join(root, "scripts/attest-check.mjs")], { env });
  assert.match(ok.stdout, /^CONSISTENT, NOT VERIFIED:/m);
  await assert.rejects(
    run(process.execPath, [join(root, "scripts/attest-check.mjs"), "--tamper"], { env }),
    (err) => err.code === 1 && /^REJECT:/m.test(err.stdout),
  );
  assert.ok(privacy.includes("`CONSISTENT, NOT VERIFIED` and exits 0, or `REJECT` and exits 1"));
});
