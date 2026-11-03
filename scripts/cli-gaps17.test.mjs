// Behaviour gaps on the README demo path (gaps 17): the --rounds ceiling accepted at
// exactly the documented maximum, the demo's printed meme line, the page's "first sheet" /
// "then" captions, and share-card text wrapping at the width boundary.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { wrapText } from "../src/demo/share.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const dirs = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "gaps17-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const run = (name, args) =>
  spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    env: { ...process.env, MOCK_INFERENCE: "1", SWARM_ROUNDS: "", SUMMARY_EVERY_N_ROUNDS: "" },
  });

test("npm run viewer accepts exactly 1000 rounds and rejects 1001 with exit 2 and no file", () => {
  const dir = scratch();
  const ok = run("viewer.mjs", ["--rounds", "1000", "--out", join(dir, "max.html")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^wrote .*max\.html\n$/);
  assert.ok(existsSync(join(dir, "max.html")));

  const bad = run("viewer.mjs", ["--rounds", "1001", "--out", join(dir, "over.html")]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, "viewer: rounds must be at most 1000, got 1001 (see --help)\n");
  assert.equal(existsSync(join(dir, "over.html")), false);
});

test("npm run swarm accepts exactly 1000 rounds and rejects 1001 with exit 2 and no output directory", () => {
  const dir = scratch();
  const ok = run("swarm.mjs", ["--rounds", "1000", "--every", "1000", "--out", join(dir, "max")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /verify: ok \(1000 rounds\)/);
  assert.ok(existsSync(join(dir, "max", "events.json")));

  const bad = run("swarm.mjs", ["--rounds", "1001", "--out", join(dir, "over")]);
  assert.equal(bad.status, 2);
  assert.equal(bad.stderr, "swarm: --rounds must be at most 1000, got 1001 (see --help)\n");
  assert.equal(existsSync(join(dir, "over")), false);
});

test("npm run demo tells the viewer which meme card to open and how many there are, and the page captions each sheet", () => {
  const dir = scratch();
  const out = join(dir, "d");
  const r = run("demo.mjs", ["--rounds", "6", "--every", "3", "--out", out]);
  assert.equal(r.status, 0, r.stderr);

  const memes = JSON.parse(readFileSync(join(out, "demo.json"), "utf8")).memes;
  assert.ok(memes.length > 1, "the default demo makes several meme cards");
  const stepLine = r.stdout.split("\n").find((l) => l.includes("Then open "));
  assert.ok(stepLine, "the meme step is printed");
  assert.ok(stepLine.includes(join(out, memes[0].file)), stepLine);
  assert.ok(stepLine.includes(`See one of ${memes.length} meme cards`), stepLine);
  assert.ok(!stepLine.includes("the one meme card"), stepLine);

  // Two sheets per agent (round 3 and round 6): the first is captioned "first sheet", the next "then".
  const html = readFileSync(join(out, "index.html"), "utf8");
  assert.equal([...html.matchAll(/class="mut">first sheet, round 3 · /g)].length, 4);
  assert.equal([...html.matchAll(/class="mut">then, round 6 · /g)].length, 4);
  assert.equal(html.includes('class="mut">then, round 3'), false);
});

test("wrapText keeps a line exactly as wide as the limit and only breaks a word that is longer than it", () => {
  assert.deepEqual(wrapText("abcde fghij", 5), ["abcde", "fghij"]);
  assert.deepEqual(wrapText("abcde", 5), ["abcde"]);
  assert.deepEqual(wrapText("abcdef", 5), ["abcde", "f"]);
  assert.deepEqual(wrapText("ab cde", 6), ["ab cde"]);
  assert.deepEqual(wrapText("ab cdef", 6), ["ab", "cdef"]);
});
