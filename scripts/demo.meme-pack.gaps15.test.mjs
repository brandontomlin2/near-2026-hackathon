// npm run demo and the meme pack: stdout wording, files written, page links, and what a re-run with other rounds removes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const demo = (out, ...args) => spawnSync(process.execPath, ["scripts/demo.mjs", "--out", out, ...args], { cwd: ROOT, encoding: "utf8" });
const memeFiles = (out) => readdirSync(join(out, "share")).filter((f) => f.startsWith("meme-")).sort();
const tmp = () => mkdtempSync(join(tmpdir(), "gaps15-demo-"));

test("default demo: three meme cards on disk, listed in demo.json, linked from the page, named in stdout", (t) => {
  const out = tmp();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = demo(out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[3\/5\] art: .*, 24 share cards, 3 meme cards\n/);
  assert.ok(r.stdout.includes("See one of 3 meme cards (caption, villain arc)"));
  const files = ["share/meme-caption-chaotic.svg", "share/meme-caption-skeptic.svg", "share/meme-villain-chaotic.svg"];
  assert.deepEqual(memeFiles(out).map((f) => `share/${f}`), files);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "demo.json"), "utf8")).memes.map((m) => m.file), files);
  const html = readFileSync(join(out, "index.html"), "utf8");
  for (const f of files) {
    assert.ok(html.includes(`src="${f}"`) || html.includes(`href="${f}"`), `page links ${f}`);
    assert.ok(r.stdout.includes(join(out, f)) || r.stdout.includes(f), `file list names ${f}`);
  }
});

test("every meme card is a 900x900 SVG with its format, a title and the project footer, and no script or external reference", (t) => {
  const out = tmp();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.equal(demo(out).status, 0);
  for (const f of memeFiles(out)) {
    const svg = readFileSync(join(out, "share", f), "utf8");
    const format = /^meme-(caption|villain)-/.exec(f)[1];
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900"'), f);
    assert.ok(svg.includes(`data-format="${format}"`), f);
    assert.match(svg, /<title>[^<]+<\/title>/, f);
    assert.ok(svg.includes("#NEARHackathon"), `${f} carries the project footer`);
    assert.ok(!/<script|href="https?:|xlink:href="https?:|\bon\w+=/i.test(svg), `${f} has no script or remote reference`);
  }
});

test("a one-meme run says '1 meme card' and 'the one meme card', never '1 meme cards'", (t) => {
  const out = tmp();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const r = demo(out, "--rounds", "2", "--every", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(memeFiles(out), ["meme-villain-chaotic.svg"]);
  assert.match(r.stdout, /, 1 meme card\n/);
  assert.ok(r.stdout.includes("See the one meme card (caption, villain arc)"));
  assert.ok(!/\b1 meme cards\b|one of 1 /.test(r.stdout));
});

test("re-running over an output directory drops meme cards the new run no longer earns and keeps unrelated files", (t) => {
  const out = tmp();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.equal(demo(out).status, 0);
  assert.equal(memeFiles(out).length, 3);
  writeFileSync(join(out, "share", "notes.txt"), "mine");
  assert.equal(demo(out, "--rounds", "2", "--every", "1").status, 0);
  assert.deepEqual(memeFiles(out), ["meme-villain-chaotic.svg"]);
  assert.equal(readFileSync(join(out, "share", "notes.txt"), "utf8"), "mine");
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(!html.includes("meme-caption-"), "the page no longer links the removed cards");
  assert.ok(existsSync(join(out, "share", "meme-villain-chaotic.svg")));
});

test("the meme pack is deterministic: two runs of the same command write byte-identical cards", (t) => {
  const a = tmp();
  const b = tmp();
  t.after(() => { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); });
  assert.equal(demo(a).status, 0);
  assert.equal(demo(b).status, 0);
  for (const f of memeFiles(a)) assert.equal(readFileSync(join(a, "share", f), "utf8"), readFileSync(join(b, "share", f), "utf8"), f);
});
