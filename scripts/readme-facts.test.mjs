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

const ASK_STEP = /^3\. Ask the token a question\. It changes `out\/memory`, so the steps after this one start with a reset \(below\)\. Run `npm run ask -- chaotic "what do you think of Skeptic\?"`\..*$/m;

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
    assert.ok(quoted, "README step 5 must quote the sheet's Ride-or-die sentence in backticks");
    assert.ok(sheet.includes(quoted[1]), `real sheet does not contain: ${quoted[1]}`);
  });
});

test("README Try-it steps are numbered 1 to 10 and the npm run ask step is step 3, right after the page", async () => {
  const section = readme.split("## Try it (judge path)\n")[1].split(/\n## /)[0];
  const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(section, /^2\. Open `out\/index\.html`\./m, "step 2 is the page step");
  assert.match(section, /^5\. Open `out\/memory\/chaotic\/sheet\.json`\./m, "step 5 is the sheet.json step");
  assert.match(section, /^6\. Open `out\/anchors\.json`\./m, "step 6 is the anchors step");
  assert.match(section, /^10\. Run `bash scripts\/verify\.sh`/m, "step 10 is verify.sh");
  assert.match(section, ASK_STEP, "step 3 is the ask step and says it changes out/memory");
  const step3 = section.match(ASK_STEP)[0];
  assert.ok(step3.includes("Do that now: run `npm run demo` again"), "the ask step resets the memory before the sheet and anchor steps read it");
  assert.match(section, /\n10\. [^\n]*\n\nEverything below this section is reference for the pieces the demo ran\.\n/, "verify.sh is the last step, one blank line before the closing sentence, and no blank line inside the list");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.ask, "node scripts/ask.mjs");
  const checklist = await readFile(join(root, "docs/submission-checklist.md"), "utf8");
  assert.ok(checklist.includes('README "Try it (judge path)" steps 1-10.'), "the submission checklist counts the Try-it steps");
  const script = await readFile(join(root, "docs/demo-script.md"), "utf8");
  assert.ok(script.includes("`npm run ask -- <agentId> \"<question>\"` exists (README step 3, the shot 3 command)"), "demo-script.md Command status names npm run ask");
});

test("README step 3 quotes what npm run ask really prints, and npm run demo resets the memory", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const step3 = readme.match(ASK_STEP)[0];
    const ask = (question) => run(process.execPath, [join(root, "scripts/ask.mjs"), "--out", out, "chaotic", question], { env });

    const first = await ask("what do you think of Skeptic?");
    const lines = first.stdout.trimEnd().split("\n");
    assert.ok(step3.includes(`\`${lines[0]}\``), `step 3 must quote the first line verbatim: ${lines[0]}`);
    assert.ok(step3.includes("`Owner: 0 fights, 0 hugs, 1 shrug`"));
    assert.ok(lines.some((l) => l.startsWith("  + Scorecard:") && l.endsWith("Owner: 0 fights, 0 hugs, 1 shrug.")), "the Owner joins the scorecard");
    assert.ok(lines.some((l) => /^ {2}\+ Signature quote: "Skeptic\?\? 5 fights and counting/.test(l)), "the answer becomes the signature quote");
    const anchor = /^sheet chaotic round 7 ([0-9a-f]{64}) \(\+4 -4\) -> anchor_sheet dry-run \(not sent\)$/.exec(lines.at(-2));
    assert.ok(anchor, lines.at(-2));
    assert.ok(step3.includes("`sheet chaotic round 7 <hash> (+4 -4) -> anchor_sheet dry-run (not sent)`"));
    const sheet = JSON.parse(await readFile(join(out, "memory/chaotic/sheet.json"), "utf8"));
    assert.equal(sheet.sheetHash, anchor[1]);
    assert.ok(step3.includes("where `<hash>` is the new `sheetHash` in `out/memory/chaotic/sheet.json`"));

    // Six hostile asks: the Owner displaces Skeptic as public enemy #1 on the fifth; the sixth only bumps the count.
    const hostile = [];
    for (let i = 0; i < 6; i++) hostile.push(await ask("nope, show me the receipts"));
    assert.ok(!hostile[3].stdout.includes("+ Public enemy #1:"), "the fourth ask does not change the enemy line");
    assert.ok(hostile[4].stdout.includes("\n  + Public enemy #1: Owner (5 fights).\n"), hostile[4].stdout);
    assert.ok(hostile[5].stdout.includes("\n  + Public enemy #1: Owner (6 fights).\n"), hostile[5].stdout);
    assert.ok(step3.includes("six times: the fifth of the six runs makes the Owner public enemy #1 (`+ Public enemy #1: Owner (5 fights).`"));
    assert.ok(step3.includes("the sixth only raises the count, so after six runs the line reads `Public enemy #1: Owner (6 fights).`"));
    const enemy = await ask("who is your enemy?");
    const answer = enemy.stdout.split("\n")[0];
    assert.ok(step3.includes(`\`${answer}\``), `step 3 must quote the enemy answer verbatim: ${answer}`);

    // Only out/memory changed, and npm run demo starts the memory over.
    assert.ok(step3.includes("Only `out/memory` changes") && step3.includes("`npm run demo` resets the memory"));
    const demoBefore = await readFile(join(out, "demo.json"), "utf8");
    const logAfterAsks = (await readFile(join(out, "memory/chaotic/log.jsonl"), "utf8")).split("\n").filter(Boolean).length;
    await run(process.execPath, [join(root, "scripts/demo.mjs"), "--out", out], { env });
    assert.equal(await readFile(join(out, "demo.json"), "utf8"), demoBefore, "the asks never touched demo.json");
    const reset = JSON.parse(await readFile(join(out, "memory/chaotic/sheet.json"), "utf8"));
    assert.equal(reset.round, 6);
    assert.ok(!reset.sheet.includes("Owner"), "the Owner is gone from the sheet after npm run demo");
    const logAfterDemo = (await readFile(join(out, "memory/chaotic/log.jsonl"), "utf8")).split("\n").filter(Boolean).length;
    assert.equal(logAfterDemo, logAfterAsks - 16, "eight asks added 16 lines; the demo removed them");
  });
});

test("README swarm step counts match the real 5-round output", async () => {
  await withTmp(async (dir) => {
    const { stdout } = await run(process.execPath, [join(root, "scripts/swarm.mjs"), "--rounds", "5", "--out", dir], { env });
    const sheetLines = stdout.split("\n").filter((l) => /^sheet \w+ round \d+ /.test(l));
    const linked = stdout.match(/^(\d+) anchor dry-runs, each linked to its round hash; final round hash ([0-9a-f]{64}) \(MOCK, not on-chain\)$/m);
    assert.ok(linked, "summary line names the anchor count, the per-round link and the final hash");
    assert.equal(Number(linked[1]), sheetLines.length);
    assert.ok(readmeText.includes(`Then ${sheetLines.length} sheet lines`));
    assert.ok(readmeText.includes(`${sheetLines.length} anchor dry-runs, each linked to its round hash; final round hash <64 hex> (MOCK, not on-chain)`));
    // The line is true of the data: each anchor carries its own round's hash, and only the last one the final hash.
    const loop = JSON.parse(await readFile(join(dir, "memory-loop.json"), "utf8"));
    assert.equal(loop.finalRoundHash, linked[2]);
    for (const token of loop.tokens) {
      for (const entry of token.sheets) assert.equal(entry.anchor.linkedRoundHash, loop.roundHashes[entry.round - 1]);
      assert.equal(token.sheets.at(-1).anchor.linkedRoundHash, loop.finalRoundHash);
      assert.ok(token.sheets.slice(0, -1).every((e) => e.anchor.linkedRoundHash !== loop.finalRoundHash));
    }
    // The README's example transcript line is one the demo really prints.
    const example = readmeText.match(/\[Skeptic\] (gas is "basically free"\? receipts or it did not happen\.)/);
    assert.ok(example, "README must quote a Skeptic line");
    assert.ok(stdout.includes(`[Skeptic] ${example[1]}`), "quoted Skeptic line must appear in the real transcript");
    assert.doesNotMatch(readmeText, /Doubtful/);
    const events = stdout.split("\n").filter((l) => /^\[/.test(l)).length;
    assert.ok(readmeText.includes(`See 5 round headers, ${events} lines`));
  });
});

test("README timing claim is cold-run safe and deploy step orders build before deploy", () => {
  assert.doesNotMatch(readmeText, /under a second|sub-second/i);
  assert.match(readmeText, /It exits 0 in a few seconds/);
  assert.match(readmeText, /deploy:nft`\. Step 1 must have run first/);
});

test("README quotes the deploy command without --quiet: quiet near-cli-rs prints no Transaction ID for live-proof to record", () => {
  const deployStep = readme.match(/^2\. Run `npm run deploy:nft`\..*$/m);
  assert.ok(deployStep, "README must have a 'Run npm run deploy:nft' step");
  assert.ok(deployStep[0].includes("`near contract deploy ... sign-with-keychain send`"), deployStep[0]);
  assert.ok(!readme.includes("near --quiet"), "no README command may be quiet");
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
    const claimed = ["Agents (", "Memory", "Meme pack", "Transfer", "the Channel", "Anchor (dry run)", "Check a hash yourself", "Round hash chain", "collapsed \"24 share cards\"", "Files"];
    const positions = claimed.map((h) => step2.indexOf(h));
    assert.ok(positions.every((p) => p > 0), `step 2 must name every section: ${claimed.join(", ")}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "step 2 must list the sections in page order");
    assert.ok(/Round hash chain with `verify: ok`/.test(step2), "verify: ok is in the Round hash chain section");
    assert.ok(html.includes("verify: ok"));
    assert.ok(html.indexOf("verify: ok") > html.indexOf(">Round hash chain<"), "verify: ok appears under the Round hash chain heading");
    // The share cards sit in a fold that is closed by default, as step 2 says.
    assert.match(html, /<details class="fold">\s*<summary>24 share cards<\/summary>/);
    for (const h3 of ["Tampered sheet", "Mint metadata", "On testnet", "Check a hash yourself"]) {
      assert.ok(html.includes(`<h3>${h3}</h3>`), `page has ${h3}`);
      assert.ok(step2.includes(h3), `step 2 names ${h3}`);
    }
  });
});

test("README persona line counts match src/swarm/personas.mjs, and the mock picks the list by reply target and the start by first-request hash", async () => {
  const { PERSONA_LINES, REPLY_LINES, personaResponder } = await import("../src/swarm/personas.mjs");
  const counts = Object.fromEntries(Object.entries(PERSONA_LINES).map(([id, lines]) => [id, lines.length]));
  const sizes = [...new Set(Object.values(counts))].sort((a, b) => a - b);
  assert.ok(readmeText.includes(`${sizes[0]} or ${sizes[1]} post lines per persona`), `README must say "${sizes[0]} or ${sizes[1]} post lines per persona"`);
  const perAgent = Object.entries(counts).map(([id, n]) => `${id[0].toUpperCase()}${id.slice(1)} ${n}`).join(", ");
  assert.ok(readmeText.includes(`(${perAgent})`), `README must list "(${perAgent})"`);
  for (const replies of Object.values(REPLY_LINES)) for (const list of Object.values(replies)) assert.equal(list.length, 4);
  assert.ok(readmeText.includes("4 reply lines per agent it answers"));
  assert.ok(readmeText.includes("The mock does not read what the prompt says. It picks the reply list from the name of the agent being answered"));
  assert.ok(readmeText.includes("from a hash of that agent's first request"));
  assert.doesNotMatch(readmeText, /ignores the prompt's content|reads only which agent/);
  assert.ok(readmeText.includes("That hash is the sha256 of the whole request (model, messages including the system prompt, sampling settings and seed), so any change to the request can shift every line."));
  // The request hash picks the start: same text, different hash, different line.
  const h1 = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "x" }] }, "00000000".padEnd(64, "0"));
  const h2 = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "x" }] }, "00000001".padEnd(64, "0"));
  assert.notEqual(h1, h2);
  // Same hash, different prompt text: same line. Only the "Reply to event #N from X." marker changes the list.
  const a = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "about gas" }] }, "ab".repeat(32));
  const b = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "about validators" }] }, "ab".repeat(32));
  assert.equal(a, b);
  assert.ok(PERSONA_LINES.aloof.includes(a));
  const reply = personaResponder({ id: "aloof" })({ messages: [{ role: "user", content: "Reply to event #4 from Skeptic. x" }] }, "ab".repeat(32));
  assert.ok(REPLY_LINES.aloof.Skeptic.includes(reply));
  // The start point comes from the first request's hash, not the seed alone: two different first hashes
  // start at different lines, and a second request's hash does not move the start.
  const post = { messages: [{ role: "user", content: "post" }] };
  const starts = new Set(["00", "01", "02", "03", "04", "05", "06", "07"].map((b) => personaResponder({ id: "aloof" })(post, b.repeat(32))));
  assert.ok(starts.size > 1, "a different first-request hash gives a different start line");
  const one = personaResponder({ id: "aloof" });
  const firstA = one(post, "ab".repeat(32));
  const secondA = one(post, "ff".repeat(32));
  const two = personaResponder({ id: "aloof" });
  two(post, "ab".repeat(32));
  assert.equal(secondA, two(post, "00".repeat(32)), "later request hashes do not move the start");
  assert.notEqual(firstA, secondA, "later requests step the list forward");
});

test("README sheet provenance: demo and swarm mock sheets both come from the counting stand-in, events carry agentId", async () => {
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const demoSheet = JSON.parse(await readFile(join(out, "memory/aloof/sheet.json"), "utf8")).sheet;
    assert.match(demoSheet, /Public enemy #1:/, "demo sheets come from the counting stand-in");
    const sw = join(dir, "swarm");
    const { stdout } = await run(process.execPath, [join(root, "scripts/swarm.mjs"), "--rounds", "5", "--out", sw], { env });
    const swarmSheet = JSON.parse(await readFile(join(sw, "sheets/aloof.json"), "utf8")).sheet;
    assert.match(swarmSheet, /^Who I am: Aloof, .* Public enemy #1: .* Scorecard: .* Receipts: /, "swarm mock sheets come from the same counting stand-in");
    assert.ok(readmeText.includes("The same stand-in writes the sheets for `npm run swarm` and `npm run evidence` in mock mode"));
    assert.ok(readmeText.includes("The sheets in mock mode come from the same counting stand-in as the demo (`src/memory/sheet-responder.mjs`)"));
    assert.doesNotMatch(readmeText, /generic mock responder|src\/demo\/sheet-responder/, "the stand-in lives in src/memory and is the only mock sheet writer");
    // The sample sheet line quotes the real (+added -removed) sentence counts for Aloof's round 3 sheet.
    const sample = readme.match(/`sheet aloof round 3 <64 hex> \((\+\d+ -\d+)\) -> anchor_sheet dry-run \(not sent\)`/);
    assert.ok(sample, "README swarm step 1 must show a `sheet aloof round 3 <64 hex> (+N -M) -> ...` line");
    const real = stdout.match(/^sheet aloof round 3 [0-9a-f]{64} \((\+\d+ -\d+)\) -> anchor_sheet dry-run \(not sent\)$/m);
    assert.ok(real, "swarm prints a sheet line for aloof round 3");
    assert.equal(sample[1], real[1], "README's (+N -M) for aloof round 3 must match the real output");
    // The aloof.json step quotes fragments of the real round 5 sheet.
    const step = readme.match(/^\d+\. Open `out\/swarm\/sheets\/aloof\.json`\..*$/m);
    assert.ok(step, "README swarm section must have an 'Open out/swarm/sheets/aloof.json' step");
    const quotes = [...step[0].matchAll(/`([^`]*(?:Who I am|Public enemy|Ride-or-die|Scorecard|Receipts)[^`]*)`/g)].map((m) => m[1]);
    assert.ok(quotes.length >= 2, "the step must quote at least two sheet fragments in backticks");
    for (const q of quotes) assert.ok(swarmSheet.includes(q), `real aloof.json sheet does not contain: ${q}`);
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
  // Says what exists and, against the organisers' track definitions, what does not.
  assert.ok(fit[0].includes("What does not exist: no coordination market, bidding, collective purchasing or settlement between agents, and no agent earns, spends, negotiates, hires or pays in the swarm, demo or NFT."));
  // The Yield Optimizer is the one place agents propose trades; it must be named, undeployed and dry run.
  assert.ok(fit[0].includes("[Yield Optimizer](#yield-optimizer)"));
  assert.ok(fit[0].includes("it is not deployed and its CLI is a dry run by default, so nothing has been traded."));
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

test("README meme paragraph: templates not jokes, caption bottom line is a scripted reply, fold rule is fights then replies then roster", async () => {
  assert.doesNotMatch(readmeText, /no hand-written jokes/);
  assert.ok(readmeText.includes("The 3 meme cards are fixed templates filled from the run's data"));
  assert.ok(readmeText.includes("one card per rivalry goes to the side whose sheet counts more fights, then, on a tie, the side with more replies to its enemy, then the earlier agent in the roster"));
  const memes = await readFile(join(root, "src/demo/memes.mjs"), "utf8");
  const wins = memes.slice(memes.indexOf("const wins = (a, b) =>"));
  assert.ok(wins.indexOf(".fights") < wins.indexOf("repliesTo(") && wins.indexOf("repliesTo(") < wins.indexOf("ids.indexOf("), "memes.mjs compares fights, then replies, then roster order");
  await withTmp(async (dir) => {
    const out = await runDemoCli(dir);
    const demo = JSON.parse(await readFile(join(out, "demo.json"), "utf8"));
    const fights = (id) => Number(/Public enemy #1: \w+ \((\d+) fights?\)/.exec(demo.agents.find((a) => a.id === id).sheets.at(-1).sheet)[1]);
    assert.equal(fights("chaotic"), fights("skeptic"), "README says both sheets count the same fights (the tie the reply count breaks)");
    assert.ok(readmeText.includes(`Here both sheets say ${fights("chaotic")} fights, and Chaotic replied to Skeptic 4 times against Skeptic's 2.`));
    const events = JSON.parse(await readFile(join(out, "events.json"), "utf8"));
    const list = Array.isArray(events) ? events : events.events;
    const byId = new Map(list.map((e) => [e.id, e]));
    const replies = (from, to) => list.filter((e) => e.agentId === from && e.kind === "reply" && byId.get(e.replyTo)?.agentId === to).length;
    assert.deepEqual([replies("chaotic", "skeptic"), replies("skeptic", "chaotic")], [4, 2]);
    const files = demo.memes.map((m) => m.file);
    assert.ok(files.includes("share/meme-villain-chaotic.svg") && !files.includes("share/meme-villain-skeptic.svg"), "Skeptic's villain card folds into Chaotic's");
    const { REPLY_LINES } = await import("../src/swarm/personas.mjs");
    const caption = demo.memes.find((m) => m.format === "caption" && m.agentId === "chaotic");
    const bottom = caption.alt.split(" / ").at(-1);
    const scripted = REPLY_LINES.chaotic.Skeptic.map((l) => l.replace(/^@\S+\s*/, "").toUpperCase());
    assert.ok(scripted.includes(bottom), `caption bottom line "${bottom}" must be a REPLY_LINES entry (scripted, not model text)`);
  });
});

test("README hash normalisation summary matches normalizeSheet, and the Inference badge is a mode label with no attestation check wired in", async () => {
  assert.ok(readmeText.includes("after normalizing (Unicode NFC, LF line endings, trailing whitespace (spaces, tabs, NBSP) trimmed from each line, leading and trailing whitespace of the whole sheet dropped, including the first line's indentation, one final newline)"));
  assert.ok(readmeText.includes("no trailing whitespace on any line, no leading or trailing whitespace on the whole sheet and one final newline"));
  assert.doesNotMatch(readmeText, /\(NFC, LF, one final newline\)/);
  const { normalizeSheet } = await import("../src/anchor/hash.mjs");
  assert.equal(normalizeSheet("\n\n  é one  \r\n\r\ntwo \t\n\n"), "é one\n\ntwo\n");
  assert.equal(normalizeSheet("\t first\u00a0\n  second\t\u00a0\n"), "first\n  second\n");
  assert.ok(readmeText.includes('the "Inference (NEAR AI Cloud)" badge says `mocked`. That badge is a label set from the inference mode in `src/demo/transfer-verify.mjs`, not an attestation check: nothing in the demo or in `verify.sh` verifies a TEE.'));
  assert.ok(readmeText.includes("The offline attestation checker, `node scripts/attest-check.mjs`, runs only on a hand-built fixture"));
  const { buildTransfer } = await import("../src/demo/transfer-verify.mjs");
  const mock = buildTransfer([], { calls: [] }, { contractId: "x.testnet", mode: "mock" });
  const live = buildTransfer([], { calls: [] }, { contractId: "x.testnet", mode: "live" });
  assert.deepEqual([mock.teeInference.label, mock.teeInference.status, live.teeInference.status], ["Inference (NEAR AI Cloud)", "mocked", "live (unattested)"]);
  for (const file of ["scripts/verify.sh", "scripts/demo.mjs", "src/demo/pipeline.mjs", "src/demo/transfer-verify.mjs"]) {
    assert.doesNotMatch(await readFile(join(root, file), "utf8"), /attest-check|attestation\.mjs/, `${file} must not wire in the attestation checker`);
  }
  const attest = await readFile(join(root, "scripts/attest-check.mjs"), "utf8");
  assert.match(attest, /from "\.\.\/src\/privacy\/fixture\.mjs"/, "attest-check runs on the fixture");
});

test("README and verify.sh give the same --live command, with the contract account and an absolute EVIDENCE_TX_FILE", async () => {
  // The contract account goes in NEAR_CONTRACT_ACCOUNT_ID, the variable deploy uses for it
  // (NEAR_ACCOUNT_ID is the signer there and only a fallback here).
  const command = 'NEAR_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract-account> EVIDENCE_TX_FILE="$PWD/out/live-proof/txs.json" bash scripts/verify.sh --live';
  assert.ok(readme.includes(`\n${command}\n`), "README 'Validate locally' must show the full --live command");
  assert.doesNotMatch(readme, /NEAR_ACCOUNT_ID=<(testnet|contract)-account> [^\n]*bash scripts\/verify\.sh --live/);
  const verify = await readFile(join(root, "scripts/verify.sh"), "utf8");
  assert.ok(verify.includes(`  ${command}\n`), "verify.sh usage must show the same command");
  const skill = await readFile(join(root, ".agents/skills/verify-near-2026/SKILL.md"), "utf8");
  assert.ok(skill.includes(`\n${command}\n`), "the verify skill must show the same command");
  // Review L-d: the evidence stage reads NEAR_CONTRACT_ACCOUNT_ID (NEAR_ACCOUNT_ID is its fallback);
  // the docs must name that variable, not the fallback, everywhere they describe the stage.
  assert.ok(readmeText.includes("which reads `NEAR_CONTRACT_ACCOUNT_ID` as the contract account to query"));
  assert.ok(readmeText.includes("a live run without `NEAR_NETWORK=testnet` and `NEAR_CONTRACT_ACCOUNT_ID` is a failure"));
  const checklistText = await readFile(join(root, "docs/submission-checklist.md"), "utf8");
  for (const [name, text] of [["README", readmeText], ["docs/submission-checklist.md", checklistText]]) {
    assert.doesNotMatch(text, /reads `NEAR_ACCOUNT_ID` as the contract account/, `${name} must not say the evidence stage reads NEAR_ACCOUNT_ID`);
    assert.doesNotMatch(text, /NEAR_ACCOUNT_ID=<NEAR_CONTRACT_ACCOUNT_ID>/, `${name} must not put the contract id in NEAR_ACCOUNT_ID`);
  }
  assert.ok(readmeText.includes("Give that path as an absolute path, because the script runs inside a fresh clone in a temp directory."));
  assert.ok(readmeText.includes("Without it the stage records `FAIL` with `out/evidence.json missing tx hashes or RPC views`."));
  assert.ok(verify.includes('record FAIL "evidence" "out/evidence.json missing tx hashes or RPC views"'));
  const evidence = await readFile(join(root, "scripts/evidence.mjs"), "utf8");
  assert.match(evidence, /NEAR_CONTRACT_ACCOUNT_ID\n\s+contract account to query/);
  assert.match(evidence, /Falls back to NEAR_ACCOUNT_ID when unset/);
  assert.match(evidence, /fs\.readFileSync\(file, "utf8"\)/, "the tx file is read relative to the clone's cwd, hence the absolute path");
  assert.match(verify, /git clone --local[\s\S]*cd "\$work\/repo"/, "verify.sh cd's into the fresh clone");
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

test("README says the mock's start line comes from a hash of the whole first request, not the seed alone", async () => {
  const { hashRequest } = await import("../src/inference/client.mjs");
  const { personaResponder, PERSONA_LINES } = await import("../src/swarm/personas.mjs");
  const req = (content, seed) => ({ model: "m", messages: [{ role: "user", content }], seed });
  // Same seed, different prompt text: different hash, so (for this list) a different start line.
  const a = hashRequest(req("Recent channel events:\nA", 5));
  const b = hashRequest(req("Recent channel events:\nB", 5));
  assert.notEqual(a, b);
  const agent = { id: "skeptic" };
  const lines = PERSONA_LINES.skeptic;
  const firstA = personaResponder(agent)(req("x", 5), a);
  assert.equal(firstA, lines[Number.parseInt(a.slice(0, 8), 16) % lines.length]);
  const firstB = personaResponder(agent)(req("x", 5), b);
  assert.equal(firstB, lines[Number.parseInt(b.slice(0, 8), 16) % lines.length]);
  // Later calls keep the first request's start and only advance the walk.
  const responder = personaResponder(agent);
  responder(req("x", 5), a);
  assert.notEqual(responder(req("x", 5), b), firstA);
  assert.ok(readmeText.includes("from a hash of that agent's first request, which carries the seed, the persona prompt and the channel events quoted in it"));
  assert.ok(readmeText.includes("its start point from a hash of the agent's first request"));
  assert.doesNotMatch(readmeText, /the seed, to pick where in the list to start/);
});

test("README states exactly what the contract enforces on transfer", async () => {
  const lib = await readFile(join(root, "contracts/personality-nft/src/lib.rs"), "utf8");
  assert.match(lib, /pub fn nft_transfer_expecting_anchor/);
  assert.match(lib, /sheet anchor does not match the expected anchor/);
  assert.ok(readmeText.includes("`nft_transfer_expecting_anchor` refuses a transfer unless the token's anchor (hash and memory depth) is exactly the one the caller expected. A plain `nft_transfer` does not check the anchor."));
  assert.doesNotMatch(readmeText, /the contract enforces it on transfer/);
});

test("README swarm step 5 says how many anchor dry-runs the run prints", async () => {
  await withTmp(async (dir) => {
    const { stdout } = await run(process.execPath, [join(root, "scripts/swarm.mjs"), "--rounds", "7", "--every", "3", "--out", dir], { env });
    const m = stdout.match(/^(\d+) anchor dry-runs, each linked to its round hash; final round hash /m);
    assert.ok(m);
    assert.ok(readmeText.includes(`\`${m[1]} anchor dry-runs, each linked to its round hash\``));
  });
});

test("README states up front that the chat is scripted, inference is mocked and nothing is deployed", () => {
  const head = readmeText.split("## ")[0];
  assert.ok(head.includes("the chat is scripted") && head.includes("src/swarm/personas.mjs"));
  assert.ok(head.includes("inference is mocked") && head.includes("src/memory/sheet-responder.mjs"));
  assert.ok(head.includes("nothing is deployed"));
});

test("README says the first contract test and build runs download crates", () => {
  assert.match(readmeText, /npm run test:contract`\. The first run downloads the Rust crates/);
  assert.match(readmeText, /npm run build:contract`\. The first run also downloads crates/);
});

test("README says the transfer anchor check is opt-in", () => {
  assert.ok(readmeText.includes("a plain `nft_transfer` ignores it, and only `nft_transfer_expecting_anchor` enforces it"));
});

test("README swarm steps read out/swarm before the seed 2 run overwrites it, and anchoring wording and verify.sh timing are true", () => {
  const sec = readme.split("\n## Swarm\n")[1].split("\n## ")[0];
  const steps = [...sec.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }));
  assert.deepEqual(steps.map((s) => s.n), steps.map((_, i) => i + 1), "swarm steps are numbered in order");
  const seed2 = steps.findIndex((s) => s.text.includes("--seed 2"));
  const reads = steps.map((s, i) => [s, i]).filter(([s]) => /^Open `out\/swarm\//.test(s.text));
  assert.ok(seed2 >= 0 && reads.length >= 2);
  for (const [s, i] of reads) assert.ok(i < seed2, `step ${s.n} reads out/swarm and must come before the --seed 2 run`);
  assert.ok(steps[seed2].text.includes("overwrites `out/swarm/`"));
  assert.ok(readmeText.includes("`npm run anchor` never signs"));
  assert.ok(!readmeText.includes("deploy, mint and anchor are dry runs"));
  assert.ok(readmeText.includes("about 30 seconds to 2 minutes measured"));
  assert.ok(!readmeText.includes("about 20 to 30 seconds"));
  assert.ok(readmeText.includes("the fifth of the six runs makes the Owner public enemy #1") && readmeText.includes("the sixth only raises the count"));
});
