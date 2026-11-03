// Locks README claims about `npm run demo` and `npm run swarm` to their real output.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const env = { ...process.env, MOCK_INFERENCE: "1" };
delete env.NEAR_AI_API_KEY;

const readme = await readFile(join(root, "README.md"), "utf8");
const readmeText = readme.replace(/\s+/g, " ");

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "readme-facts-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runDemoCli(dir) {
  const out = join(dir, "out");
  await run(process.execPath, [join(root, "scripts/demo.mjs"), "--out", out], { env });
  return out;
}

test("every 64-hex hash in the README is from the real demo output", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const demo = JSON.parse(await readFile(join(out, "demo.json"), "utf8"));
    const known = new Set([demo.finalRoundHash, ...demo.roundHashes.map((r) => (typeof r === "string" ? r : r.hash))]);
    const shown = readme.match(/\b[0-9a-f]{64}\b/g) ?? [];
    assert.ok(shown.includes(demo.finalRoundHash), "README must show the demo's final round hash");
    for (const h of shown) assert.ok(known.has(h), `README hash ${h} is not in demo.json`);
  });
});

test("README quotes Chaotic's real ride-or-die sheet text", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const { sheet } = JSON.parse(await readFile(join(out, "memory/chaotic/sheet.json"), "utf8"));
    const quoted = readmeText.match(/`(Ride-or-die:[^`]*)`/);
    assert.ok(quoted, "README step 4 must quote the sheet's Ride-or-die sentence in backticks");
    assert.ok(sheet.includes(quoted[1]), `real sheet does not contain: ${quoted[1]}`);
  });
});

test("README swarm step counts match the real 5-round output", async () => {
  await withTmp(async (dir) => {
    const { stdout } = await run(process.execPath, [join(root, "scripts/swarm.mjs"), "--rounds", "5", "--out", dir], { env });
    const sheetLines = stdout.split("\n").filter((l) => /^sheet \w+ round \d+ /.test(l));
    const linked = stdout.match(/linked to (\d+) anchor dry-runs/);
    assert.ok(linked);
    assert.equal(Number(linked[1]), sheetLines.length);
    assert.ok(readmeText.includes(`Then ${sheetLines.length} sheet lines`));
    assert.ok(readmeText.includes(`linked to ${sheetLines.length} anchor dry-runs (MOCK, not on-chain)`));
    const events = stdout.split("\n").filter((l) => /^\[/.test(l)).length;
    assert.ok(readmeText.includes(`See 5 round headers, ${events} lines`));
  });
});

test("README timing claim is cold-run safe and deploy step orders build before deploy", () => {
  assert.doesNotMatch(readmeText, /under a second|sub-second/i);
  assert.match(readmeText, /It exits 0 in a few seconds/);
  assert.match(readmeText, /deploy:nft`\. Step 1 must have run first/);
});

test("README does not pin a contract unit-test count; it claims only 'ok' and '0 failed'", () => {
  // `cargo test` prints "N passed; 0 failed" and N changes with every contract PR.
  const contractStep = readme.match(/^1\. Run `npm run test:contract`\..*$/m);
  assert.ok(contractStep, "README must have a 'Run npm run test:contract' step");
  assert.doesNotMatch(readmeText, /\b\d+ (unit )?tests? pass/i);
  assert.match(contractStep[0], /test result: ok\./);
  assert.match(contractStep[0], /0 failed/);
});

test("README 'Live on testnet' is one short paragraph after the working sections, with the owner-only command", () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const liveIdx = headings.indexOf("Live on testnet");
  assert.ok(liveIdx >= 0, "README must have a 'Live on testnet' section");
  for (const h of ["Try it (judge path)", "Contract", "Deploy to testnet", "Inference", "Swarm", "Art"]) {
    assert.ok(headings.indexOf(h) >= 0 && headings.indexOf(h) < liveIdx, `'${h}' must come before 'Live on testnet'`);
  }
  const body = readme.split("## Live on testnet\n")[1].split(/\n## /)[0].trim();
  assert.equal(body.split(/\n\s*\n/).length, 1, "section must be a single paragraph");
  assert.doesNotMatch(body, /^\|/m, "section must not contain a table");
  assert.doesNotMatch(body, /TBD/);
  assert.match(body, /^Not run yet\./);
  assert.ok(body.includes("`npm run live-proof -- --send --i-approve`"), "must name the exact owner-approved command");
  assert.ok(body.includes("`out/evidence.json`"), "must say where the evidence will appear");
});
