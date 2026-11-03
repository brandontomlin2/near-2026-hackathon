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

test("README step 2 lists the page's h2 sections in the real order", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const html = await readFile(join(out, "index.html"), "utf8");
    const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    assert.deepEqual(h2s, ["Agents", "Memory", "Meme pack", "Transfer: memory travels with the NFT", "Channel", "Anchor (dry run)", "Round hash chain", "Files"]);
    const step2 = readme.match(/^2\. Open `out\/index\.html`\..*$/m)[0];
    const claimed = ["Memory", "Meme pack", "Transfer", "the Channel", "Anchor (dry run)", "Round hash chain", "share cards", "Files"];
    const positions = claimed.map((h) => step2.indexOf(h));
    assert.ok(positions.every((p) => p > 0), `step 2 must name every section: ${claimed.join(", ")}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "step 2 must list the sections in page order");
    assert.ok(/Round hash chain with `verify: ok`/.test(step2), "verify: ok is in the Round hash chain section");
    assert.ok(html.includes("verify: ok"));
    assert.ok(html.indexOf("verify: ok") > html.indexOf(">Round hash chain<"), "verify: ok appears under the Round hash chain heading");
  });
});

test("README persona line counts match src/swarm/personas.mjs, and the mock reads only the reply target", async () => {
  const { PERSONA_LINES, REPLY_LINES, personaResponder } = await import("../src/swarm/personas.mjs");
  const counts = Object.fromEntries(Object.entries(PERSONA_LINES).map(([id, lines]) => [id, lines.length]));
  const sizes = [...new Set(Object.values(counts))].sort((a, b) => a - b);
  assert.ok(readmeText.includes(`${sizes[0]} or ${sizes[1]} post lines per persona`), `README must say "${sizes[0]} or ${sizes[1]} post lines per persona"`);
  const perAgent = Object.entries(counts).map(([id, n]) => `${id[0].toUpperCase()}${id.slice(1)} ${n}`).join(", ");
  assert.ok(readmeText.includes(`(${perAgent})`), `README must list "(${perAgent})"`);
  for (const replies of Object.values(REPLY_LINES)) for (const list of Object.values(replies)) assert.equal(list.length, 3);
  assert.ok(readmeText.includes("3 reply lines per agent it answers"));
  assert.ok(readmeText.includes("The mock ignores the prompt's content"));
  // Same hash, different prompt text: same line. Only the "Reply to event #N from X." marker changes the list.
  const a = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "about gas" }] }, "ab".repeat(32));
  const b = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "about validators" }] }, "ab".repeat(32));
  assert.equal(a, b);
  assert.ok(PERSONA_LINES.aloof.includes(a));
  const reply = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "Reply to event #4 from Skeptic. x" }] }, "ab".repeat(32));
  assert.ok(REPLY_LINES.aloof.Skeptic.includes(reply));
});

test("README sheet provenance: demo sheets count fights, swarm mock sheets are generic one-liners, events carry agentId", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const demoSheet = JSON.parse(await readFile(join(out, "memory/aloof/sheet.json"), "utf8")).sheet;
    assert.match(demoSheet, /Public enemy #1:/, "demo sheets come from the counting stand-in");
    const sw = join(dir, "swarm");
    await run(process.execPath, [join(root, "scripts/swarm.mjs"), "--rounds", "5", "--out", sw], { env });
    const swarmSheet = JSON.parse(await readFile(join(sw, "sheets/aloof.json"), "utf8")).sheet;
    assert.doesNotMatch(swarmSheet, /Public enemy #1:|Ride-or-die:|fights|hugs/, "swarm mock sheets are not from the counting stand-in");
    assert.ok(swarmSheet.length > 0 && !swarmSheet.includes("\n"), "generic mock responder writes one line");
    assert.ok(readmeText.includes("That counting stand-in is used by `npm run demo` only"));
    assert.ok(readmeText.includes("`npm run swarm` hands its sheets to the generic mock responder in mock mode"));
    const events = JSON.parse(await readFile(join(sw, "events.json"), "utf8"));
    for (const key of ["round", "turn", "agentId", "replyTo"]) assert.ok(key in events.events[0], `events.json lacks ${key}`);
    assert.ok(!("agent" in events.events[0]));
    assert.ok("roundHashes" in events);
    assert.ok(readmeText.includes("See every event with its `round`, `turn`, `agentId` and `replyTo`, plus `roundHashes`."));
  });
});

test("README inference step 4: the || true block exits 0 and the message is the thing to check", async () => {
  const res = await run(process.execPath, [join(root, "scripts/infer.mjs"), "hi"], {
    env: { ...env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "" },
  }).then(
    () => assert.fail("live mode with no key must exit non-zero"),
    (e) => e,
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /inference error \(missing_api_key\)/);
  assert.ok(readmeText.includes("The trailing `|| true` keeps the block's exit code at 0 whatever happens; the line to check is the error message."));
  assert.doesNotMatch(readmeText, /exits 0 only when the command fails/);
});

test("README calls docs/img/page.png the top of the page, and quotes its real pixel size", async () => {
  const png = await readFile(join(root, "docs/img/page.png"));
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(readmeText.includes(`is the top of the generated page (a ${width} x ${height} viewport capture`), `README must say "${width} x ${height} viewport capture"`);
  assert.doesNotMatch(readmeText, /page\.png\]\(docs\/img\/page\.png\) is the generated page/);
  const screenshot = await readFile(join(root, "scripts/screenshot.mjs"), "utf8");
  assert.ok(screenshot.includes(`--window-size=${width},${height}`), "the tracked PNG is a viewport capture at the screenshot script's window size");
});

test("README track-fit paragraph covers every claimed track and disclaims agent economics", () => {
  const tracks = readme.match(/^Tracks: (.+)\.$/m)[1].match(/`([a-z]+)`/g).map((t) => t.replace(/`/g, ""));
  const fit = readme.match(/^Track fit, plainly: .*$/m);
  assert.ok(fit, "README must have a 'Track fit, plainly:' paragraph");
  for (const t of tracks) assert.ok(fit[0].includes(`\`${t}\``), `track fit must mention ${t}`);
  assert.ok(fit[0].includes("There is no bidding, payment or settlement between agents in this version"));
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
  // A quoted command that stops at --i-approve is incomplete (mint --send needs --media-base).
  // Naming the flag on its own (`--i-approve`) is fine: it is what the low-level tools require.
  assert.doesNotMatch(checklist, /--send --i-approve`/, "an owner command that stops at --i-approve is incomplete: mint --send needs --media-base");
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
