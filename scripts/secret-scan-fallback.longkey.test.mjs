import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText } from "./secret-scan-fallback.mjs";

const words = (n, w = "alpha") => Array.from({ length: n }, () => w).join(" ");

test("seed-phrase: key name longer than 40 chars after the keyword is still detected", () => {
  const f = scanText(".env", `seed${"x".repeat(41)}=${words(12)}\n`);
  assert.deepEqual(f.map((x) => x.rule), ["seed-phrase"]);
});

test("seed-phrase: very long secret_..._key name is still detected", () => {
  const f = scanText(".env", `secret_${"a".repeat(100)}_key=${words(12)}\n`);
  assert.deepEqual(f.map((x) => x.rule), ["seed-phrase"]);
});

test("seed-phrase: long key name without a keyword is not flagged", () => {
  const f = scanText(".env", `${"k".repeat(100)}=${words(12)}\n`);
  assert.equal(f.length, 0);
});

test("seed-phrase: huge single-line key-name run finishes quickly", () => {
  const t0 = Date.now();
  scanText(".env", `seed${"a".repeat(200000)}\n`);
  scanText(".env", `${"seed ".repeat(40000)}\n`);
  assert.ok(Date.now() - t0 < 5000);
});
