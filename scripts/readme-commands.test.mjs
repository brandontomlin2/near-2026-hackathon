import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// "Judge quick path": run the commands it shows and check every line it quotes.
const quick = readme.match(/## Judge quick path\n([\s\S]*?)\n## /)?.[1] ?? "";
const quoted = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

test("Judge quick path has at most 4 numbered commands and says it is mock", () => {
  assert.ok(quick.length > 0, "README has a Judge quick path section");
  assert.ok(/^[1-4]\. /m.test(quick) && !/^5\. /m.test(quick));
  assert.match(quick, /mock or dry-run/);
  assert.match(quick, /Nothing is signed or sent/);
});

test("Judge quick path: npm run demo prints the lines it quotes and writes the page", () => {
  const out = mkdtempSync(join(tmpdir(), "quickpath-"));
  try {
    const run = spawnSync(process.execPath, ["scripts/demo.mjs", "--out", out], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const step1 = quick.split(/^2\. /m)[0];
    const lines = quoted(step1).filter((q) => !q.startsWith("npm install"));
    assert.ok(lines.length >= 4, "step 1 quotes demo output lines");
    for (const line of lines) {
      // The final line's path is machine-specific; compare its fixed prefix.
      const want = line.startsWith("Open the page:") ? "Open the page: open " : line;
      assert.ok(run.stdout.includes(want), `demo output has: ${want}`);
    }
    const headline = quoted(quick.split(/^2\. /m)[1].split(/^3\. /m)[0]).find((q) => /remembers/.test(q));
    assert.ok(readFileSync(join(out, "index.html"), "utf8").includes(headline), "page has the headline");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("Judge quick path: the verify.sh lines it quotes are ones verify.sh prints", () => {
  // Not run here: verify.sh itself runs this test suite.
  const verify = readFileSync(new URL("./verify.sh", import.meta.url), "utf8");
  const step3 = quick.split(/^3\. /m)[1];
  assert.ok(verify.includes('"STATUS" "STAGE" "DETAIL"'));
  assert.ok(verify.includes("result: PASS"));
  assert.match(step3, /`STATUS \/ STAGE \/ DETAIL`/);
  assert.match(step3, /`result: PASS`/);
  assert.ok(verify.includes('planned "demo" "demo" mock'), "verify.sh runs the demo stage in mock mode");
  assert.ok(verify.includes('record PASS "$stage" "npm run ${script} (${mode})"'), "verify.sh row detail format");
  assert.ok(quoted(step3).includes("PASS      demo            npm run demo (mock)"));
});
