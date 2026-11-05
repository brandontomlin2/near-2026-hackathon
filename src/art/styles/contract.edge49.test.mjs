// Edge cases for the shared style contract helpers: definedIds parsing, the
// exported constants, and that runStyleContract really fails on a style that
// breaks the contract (run in a child process so its tests stay out of ours).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { definedIds, MAX_SVG_BYTES, LAYER_IDS } from "./contract.mjs";
import { LAYER_IDS as SHARED_LAYER_IDS } from "./shared.mjs";

test("definedIds: empty, id-free and non-matching input yields an empty list", () => {
  assert.deepEqual(definedIds(""), []);
  assert.deepEqual(definedIds("<svg></svg>"), []);
  assert.deepEqual(definedIds('<g data-id="x" xid="y" idx="z" identity="w">'), []);
});

test("definedIds: only double-quoted id attributes preceded by whitespace count", () => {
  assert.deepEqual(definedIds("<g id='single'>"), []);
  assert.deepEqual(definedIds('<g id=""></g>'), []);
  assert.deepEqual(definedIds('<g\nid="newline"><g\tid="tab">'), ["newline", "tab"]);
  assert.deepEqual(definedIds('<g class="a" id="b">'), ["b"]);
});

test("definedIds: keeps document order and duplicates so collisions are detectable", () => {
  const svg = '<linearGradient id="z"/><g id="a"/><g id="z"/>';
  assert.deepEqual(definedIds(svg), ["z", "a", "z"]);
});

test("definedIds: ids with unicode and url-ish characters are returned verbatim", () => {
  assert.deepEqual(definedIds('<g id="café-\u{1F680}"/><g id="a.b:c"/>'), ["café-\u{1F680}", "a.b:c"]);
});

test("definedIds: does not read url(#x) references as definitions", () => {
  assert.deepEqual(definedIds('<rect fill="url(#grad)" clip-path="url(#clip)"/>'), []);
});

test("definedIds: throws on undefined and null input instead of returning an empty list", () => {
  assert.throws(() => definedIds(undefined), TypeError);
  assert.throws(() => definedIds(null), TypeError);
});

test("contract constants: the byte budget is a positive integer and LAYER_IDS is the shared frozen list", () => {
  assert.ok(Number.isInteger(MAX_SVG_BYTES) && MAX_SVG_BYTES > 0);
  assert.equal(LAYER_IDS, SHARED_LAYER_IDS);
  assert.ok(Object.isFrozen(LAYER_IDS));
  assert.deepEqual([...LAYER_IDS], ["background", "rings", "glyph", "face"]);
});

// Child-process check: wrap the real sticker style with a defect and run only
// the named contract tests. A healthy wrapper must pass; a broken one must fail.
const contractUrl = pathToFileURL(fileURLToPath(new URL("./contract.mjs", import.meta.url))).href;
const stickerUrl = pathToFileURL(fileURLToPath(new URL("./sticker.mjs", import.meta.url))).href;

function runVariant({ opts, result }, namePattern) {
  const dir = mkdtempSync(join(tmpdir(), "edge49-contract-"));
  try {
    const file = join(dir, "wrapped.test.mjs");
    writeFileSync(
      file,
      `import { runStyleContract } from ${JSON.stringify(contractUrl)};
import { style as real } from ${JSON.stringify(stickerUrl)};
const style = { ...real, render(t, o) { const svg = real.render(t, ${opts}); return ${result}; } };
runStyleContract(style);
`,
    );
    return spawnSync(process.execPath, ["--test", `--test-name-pattern=${namePattern}`, file], {
      encoding: "utf8",
      timeout: 60000,
      // Inside `node --test` this variable makes a child report to the parent runner instead of exiting non-zero.
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runStyleContract: a faithful wrapper passes the structural tests", () => {
  const r = runVariant({ opts: "o", result: "svg" }, "well-formed|unknown mood throws|data-ring");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("runStyleContract: a style that leaks NaN into its SVG fails the well-formed test", () => {
  const r = runVariant({ opts: "o", result: 'svg.replace("<g id=\\"face\\">", "<g id=\\"face\\" data-x=\\"NaN\\">")' }, "well-formed");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /not ok \d+ - .*well-formed/, r.stdout + r.stderr);
});

test("runStyleContract: a style that ignores the mood fails the unknown-mood test", () => {
  const r = runVariant({ opts: "{ mood: 'neutral' }", result: "svg" }, "unknown mood throws");
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /not ok \d+ - .*unknown mood throws/, r.stdout + r.stderr);
});
