import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Every `npm run <script>` that appears in the README (inline code or fenced block).
const commands = [...readme.matchAll(/npm run ([A-Za-z0-9:_-]+)([^`\n]*)/g)].map((m) => ({
  script: m[1],
  rest: m[2],
}));

test("README mentions npm run commands", () => {
  assert.ok(commands.length > 0);
});

test("every npm run script in the README exists in package.json", () => {
  const missing = [...new Set(commands.map((c) => c.script))].filter((s) => !(s in pkg.scripts));
  assert.deepEqual(missing, []);
});

test("README shows npm run anchor only in its working --dry-run form", () => {
  const anchors = commands.filter((c) => c.script === "anchor");
  assert.ok(anchors.length > 0, "README shows the anchor command");
  assert.ok(
    anchors.some((c) => /^\s+--\s+--dry-run\b/.test(c.rest)),
    "README includes `npm run anchor -- --dry-run`",
  );
});
