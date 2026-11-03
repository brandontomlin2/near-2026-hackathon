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

test("README names the product, pins the exact Rust toolchain and describes live:check's real output", async () => {
  assert.match(readme, /^# Personality NFT\n\nNEAR 2026 Hackathon entry\./, "H1 must be the product name, hackathon line under it");
  const toolchain = await readFile(join(root, "contracts/personality-nft/rust-toolchain.toml"), "utf8");
  const channel = toolchain.match(/^channel = "([^"]+)"/m)[1];
  assert.ok(readmeText.includes(`Needs Rust ${channel} (pinned in the crate's \`rust-toolchain.toml\``), `README must say Rust ${channel}`);
  assert.doesNotMatch(readmeText, /Rust [\d.]+ or newer/);
  const check = await run(process.execPath, [join(root, "scripts/live-check.mjs")], {
    env: { ...env, NEAR_ACCOUNT_ID: "", NEAR_CONTRACT_ACCOUNT_ID: "", NEAR_NETWORK: "" },
  }).then(
    () => assert.fail("live:check must exit 1 when nothing is configured"),
    (e) => e,
  );
  assert.equal(check.code, 1);
  const tags = new Set(check.stdout.match(/^\[(todo|ok|skip)\]/gm));
  assert.deepEqual([...tags].sort(), ["[ok]", "[skip]", "[todo]"]);
  const ready = check.stdout.match(/^ready: no\..*$/m)[0];
  assert.ok(readmeText.includes(`\`${ready}\``), `README must quote the final line verbatim: ${ready}`);
  assert.ok(readmeText.includes("`[ok]`/`[skip]` lines for the rest"));
});

test("README 'Live on testnet' is one short paragraph after the working sections, with the owner-only command", async () => {
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
  const { SEND_COMMAND } = await import("./live-proof.mjs");
  assert.ok(body.includes(`\`${SEND_COMMAND}\``), `must name the complete owner-approved command: ${SEND_COMMAND}`);
  assert.doesNotMatch(body, /--i-approve`/, "an owner command that stops at --i-approve is incomplete: mint --send needs --media-base");
  assert.ok(body.includes("`out/evidence.json`"), "must say where the evidence will appear");
});

test("the submission checklist and live:check name the complete owner command, with --media-base", async () => {
  const { SEND_COMMAND } = await import("./live-proof.mjs");
  const checklist = await readFile(join(root, "docs/submission-checklist.md"), "utf8");
  assert.ok(checklist.includes(`\`${SEND_COMMAND}\``), `docs/submission-checklist.md must quote ${SEND_COMMAND}`);
  assert.doesNotMatch(checklist, /--i-approve`/);
  const { check } = await import("./live-check.mjs");
  const r = await check({ NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" }, {
    statWasm: () => 1, fetch: async () => ({ json: async () => ({ result: { amount: "1" } }) }), wasm: "/w.wasm",
  });
  assert.equal(r.ready, true);
  assert.match(r.lines.at(-1), /^ready: yes\. .*--send --i-approve --media-base <url>/);
});

test("README and the submission checklist quote the evidence command live-proof --send prints, with the tx file it writes", async () => {
  // A bare `npm run evidence` is mock mode; the docs must give the testnet invocation exactly as scripts/live-proof.mjs prints it.
  const { TX_FILE_LABEL, evidenceCommand } = await import("./live-proof.mjs");
  const command = `\`${evidenceCommand("<NEAR_CONTRACT_ACCOUNT_ID>")}\``;
  const body = readme.split("## Live on testnet\n")[1].split(/\n## /)[0];
  assert.ok(body.includes(`\`${TX_FILE_LABEL}\``), `README 'Live on testnet' must name ${TX_FILE_LABEL}`);
  assert.ok(body.includes(command), `README 'Live on testnet' must quote ${command}`);
  const checklist = await readFile(join(root, "docs/submission-checklist.md"), "utf8");
  assert.ok(checklist.includes(command), `docs/submission-checklist.md must quote ${command}`);
});
