import { test } from "node:test";
import assert from "node:assert/strict";
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
