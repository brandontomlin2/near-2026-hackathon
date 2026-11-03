import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./render-agents.mjs";
import { STYLE_NAMES, STYLES, getStyle } from "../src/art/styles/index.mjs";
import { renderSvg } from "../src/art/render.mjs";
import { AGENTS } from "../src/traits/agents.mjs";
import { MOODS } from "../src/art/moods.mjs";
import { renderSheet } from "../src/art/sheet.mjs";

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "render-agents-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("registry: default plus three memeable styles", () => {
  assert.deepEqual([...STYLE_NAMES], ["default", "sticker", "pixel", "deepfried"]);
  for (const n of STYLE_NAMES) assert.equal(STYLES[n].name, n);
  assert.throws(() => getStyle("nope"), /unknown style/);
  assert.throws(() => getStyle("toString"), /unknown style/);
});

test("default style is the original renderer and has no moods", () => {
  const d = getStyle("default");
  assert.deepEqual([...d.moods], ["neutral"]);
  for (const a of AGENTS) assert.equal(d.render(a.traits), renderSvg(a.traits));
  assert.throws(() => d.render(AGENTS[0].traits, { mood: "hype" }));
});

test("no --style keeps the legacy out/<id>.svg layout", () =>
  withTmp((dir) => {
    const paths = main(["--out", dir]);
    assert.deepEqual(paths, AGENTS.map((a) => join(dir, `${a.id}.svg`)));
    assert.equal(readFileSync(paths[0], "utf8"), renderSvg(AGENTS[0].traits));
  }));

test("--style <name> writes every agent x mood and a sheet", () =>
  withTmp((dir) => {
    main(["--style", "sticker", "--out", dir]);
    const files = readdirSync(join(dir, "styles", "sticker")).sort();
    const want = [...AGENTS.flatMap((a) => MOODS.map((m) => `${a.id}-${m}.svg`)), "sheet.svg"].sort();
    assert.deepEqual(files, want);
    const svg = readFileSync(join(dir, "styles", "sticker", "social-shook.svg"), "utf8");
    assert.equal(svg, getStyle("sticker").render(AGENTS[2].traits, { mood: "shook" }));
  }));

test("--style all renders every style", () =>
  withTmp((dir) => {
    main(["--style", "all", "--out", dir]);
    assert.deepEqual(readdirSync(join(dir, "styles")).sort(), [...STYLE_NAMES].sort());
  }));

test("docs/art contact sheets are current (regenerate: node scripts/render-agents.mjs --style all, copy out/styles/<s>/sheet.svg)", () => {
  for (const n of STYLE_NAMES.filter((s) => s !== "default")) {
    const committed = readFileSync(new URL(`../docs/art/${n}-sheet.svg`, import.meta.url), "utf8");
    assert.equal(committed, renderSheet(getStyle(n)), n);
  }
});

test("bad arguments throw", () => {
  assert.throws(() => main(["--style", "nope"]), /unknown style/);
  assert.throws(() => main(["--bogus"]));
});
