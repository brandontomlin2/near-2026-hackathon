import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../src/traits/agents.mjs";
import { renderSheet } from "../src/art/sheet.mjs";
import { getStyle, STYLE_NAMES } from "../src/art/styles/index.mjs";
import { renderSvg } from "../src/art/render.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "render-agents.mjs");
const NO_NETWORK = resolve(dirname(fileURLToPath(import.meta.url)), "test-helpers", "no-network.mjs");

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "render-gaps14-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, ["--import", NO_NETWORK, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MOCK_INFERENCE: "1" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("--style default writes one neutral image per agent plus a sheet under styles/default, and no legacy <id>.svg", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "default", "--out", "o"]);
  assert.equal(r.code, 0, r.stderr);
  const dir = join(cwd, "o", "styles", "default");
  assert.deepEqual(readdirSync(dir).sort(), [...AGENTS.map((a) => `${a.id}-neutral.svg`), "sheet.svg"].sort());
  assert.equal(readFileSync(join(dir, "aloof-neutral.svg"), "utf8"), renderSvg(AGENTS[0].traits));
  assert.deepEqual(readdirSync(join(cwd, "o")), ["styles"], "nothing but styles/ under the out root");
  assert.deepEqual(r.stdout.trim().split("\n").at(-1), join("o", "styles", "default", "sheet.svg"));
});

test("each style's sheet.svg on disk is exactly renderSheet(style)", (t) => {
  const cwd = scratch(t);
  assert.equal(run(cwd, ["--style", "all", "--out", "o"]).code, 0);
  for (const name of STYLE_NAMES) {
    assert.equal(readFileSync(join(cwd, "o", "styles", name, "sheet.svg"), "utf8"), renderSheet(getStyle(name)), name);
  }
});

test("a repeated --style or --out: the last one wins", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "sticker", "--style", "pixel", "--out", "first", "--out", "second"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!existsSync(join(cwd, "first")), "the earlier --out is not used");
  assert.deepEqual(readdirSync(join(cwd, "second", "styles")), ["pixel"]);
  for (const line of r.stdout.trim().split("\n")) assert.ok(line.startsWith(join("second", "styles", "pixel")), line);
});

test("unknown style: exit 2, one stderr line naming every valid style, empty stdout, nothing written", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "nope", "--out", "o"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `render: unknown style: nope (expected one of ${STYLE_NAMES.join(", ")}) (see --help)\n`);
  assert.ok(!existsSync(join(cwd, "o")));
});

test("a missing --style value says it needs a value, exits 2 and writes nothing", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--out", "o", "--style"]);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "render: --style needs a value (see --help)\n");
  assert.ok(!existsSync(join(cwd, "o")));
});

test("an unknown flag error quotes the flag and an earlier valid flag does not write before it", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["--style", "pixel", "--out", "o", "--wat"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'render: unknown argument "--wat" (see --help)\n');
  assert.ok(!existsSync(join(cwd, "o")));
});

test("running twice into the same directory gives byte-identical files and leaves unrelated files alone", (t) => {
  const cwd = scratch(t);
  assert.equal(run(cwd, ["--style", "sticker", "--out", "o"]).code, 0);
  const file = join(cwd, "o", "styles", "sticker", "aloof-hype.svg");
  const before = readFileSync(file);
  writeFileSync(join(cwd, "o", "keep.txt"), "mine");
  assert.equal(run(cwd, ["--style", "sticker", "--out", "o"]).code, 0);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(readFileSync(join(cwd, "o", "keep.txt"), "utf8"), "mine");
});

test("-h prints the usage with every style name on stdout, exits 0 and writes nothing", (t) => {
  const cwd = scratch(t);
  const r = run(cwd, ["-h", "--out", "o"]);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /^Usage: node scripts\/render-agents\.mjs /);
  for (const name of STYLE_NAMES) assert.ok(r.stdout.includes(name), name);
  assert.ok(!existsSync(join(cwd, "o")));
});
