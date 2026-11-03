// Locks docs/check-sheet.md to the real output of `npm run check-sheet -- --mock`
// after one mock `npm run demo` in a temp dir. No network, no keys.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, MOCK_INFERENCE: "1" };
delete env.NEAR_AI_API_KEY;

let cwd;
let doc;
let match;
let tampered;

const check = async (sheet) => {
  const args = [join(root, "scripts/check-sheet.mjs"), "--mock", "--token", "aloof", "--sheet", sheet];
  try {
    const { stdout } = await run(process.execPath, args, { cwd, env });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.code, stdout: err.stdout };
  }
};

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "check-sheet-docs-"));
  await run(process.execPath, [join(root, "scripts/demo.mjs"), "--out", "out"], { cwd, env });
  doc = await readFile(join(root, "docs/check-sheet.md"), "utf8");
  match = await check("out/memory/aloof/sheet.json");
  // Run the doc's own tamper snippet, found by its marker.
  const rest = doc.split("<!-- tamper-snippet -->")[1];
  const snippet = rest.split("\n").map((l) => l.trim()).find((l) => l.startsWith("node -e "));
  assert.ok(snippet, "tamper snippet present in the doc");
  await run("sh", ["-c", snippet], { cwd, env });
  tampered = await check("out/tampered.json");
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const line = (stdout, label) => stdout.split("\n").find((l) => l.startsWith(label));

test("doc shows the exact command", () => {
  assert.ok(doc.includes("npm run check-sheet -- --mock --token aloof --sheet out/memory/aloof/sheet.json"));
});

test("doc quotes the real MATCH output", () => {
  assert.equal(match.code, 0);
  for (const label of ["sheet hash:", "anchor hash:", "result:"]) {
    assert.ok(doc.includes(line(match.stdout, label)), `doc has: ${line(match.stdout, label)}`);
  }
  assert.equal(line(match.stdout, "result:"), "result: MATCH");
});

test("doc quotes the real MISMATCH output from its own tamper snippet", () => {
  assert.equal(tampered.code, 1);
  for (const label of ["sheet hash:", "anchor hash:", "result:"]) {
    assert.ok(doc.includes(line(tampered.stdout, label)), `doc has: ${line(tampered.stdout, label)}`);
  }
  assert.equal(line(tampered.stdout, "result:"), "result: MISMATCH");
  assert.notEqual(line(tampered.stdout, "sheet hash:"), line(match.stdout, "sheet hash:"));
});

test("doc quotes the header and file lines", () => {
  for (const l of match.stdout.split("\n").filter(Boolean)) assert.ok(doc.includes(l), `doc has: ${l}`);
});

test("doc links costs.md and names the pinned transfer", () => {
  assert.ok(doc.includes("](costs.md)"));
  assert.ok(doc.includes("nft_transfer_expecting_anchor"));
});
