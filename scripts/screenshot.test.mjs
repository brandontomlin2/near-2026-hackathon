import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, run } from "./screenshot.mjs";

test("findBrowser returns null when no candidate exists", () => {
  assert.equal(findBrowser(["/nope/a", "/nope/b"], () => false), null);
});

test("run exits 2 with a clear message and writes nothing when no browser is found", () => {
  const errs = [];
  const code = run({ candidates: ["/nope/a"], exists: () => false, out: "/nonexistent/page.png", err: (m) => errs.push(m) });
  assert.equal(code, 2);
  assert.match(errs.join("\n"), /no headless Chrome\/Chromium found/);
});

const SKIP_WIN = process.platform === "win32";

function fakeBrowser(dir, body) {
  const p = join(dir, "fake-browser.sh");
  writeFileSync(p, `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) OUT="\${a#--screenshot=}";; esac; done\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

async function shotCase(t, body) {
  const dir = mkdtempSync(join(tmpdir(), "shot-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "nested", "deeper", "page.png");
  const logs = [];
  const errs = [];
  const code = run({
    candidates: [fakeBrowser(dir, body)], out,
    log: (m) => logs.push(m), err: (m) => errs.push(m),
  });
  return { code, out, logs, errs };
}

test("run writes the image, creates the parent dir, and logs the result", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, 'printf "PNGDATA" > "$OUT"');
  assert.equal(r.code, 0, r.errs.join("\n"));
  assert.ok(statSync(r.out).size > 0);
  assert.ok(r.logs.some((l) => /^wrote .* \(\d+ bytes\) using /.test(l)), r.logs.join("\n"));
});

test("run returns 1 when the browser exits 0 but writes nothing", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, "exit 0");
  assert.equal(r.code, 1);
  assert.match(r.errs.join("\n"), /browser produced no image/);
  assert.equal(existsSync(r.out), false);
});

test("run returns 1 when the browser writes a zero-byte file", { skip: SKIP_WIN }, async (t) => {
  const r = await shotCase(t, ': > "$OUT"');
  assert.equal(r.code, 1);
  assert.match(r.errs.join("\n"), /browser produced no image/);
});
