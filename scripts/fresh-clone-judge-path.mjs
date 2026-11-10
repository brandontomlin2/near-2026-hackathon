#!/usr/bin/env node
// Walks the README judge path inside a fresh clone, offline. No dependencies.
//
// CLI: node scripts/fresh-clone-judge-path.mjs --cwd <clone> --rows <pre.tsv>
//   Runs each check in <cwd> (bash -c, scrubbed env, temp HOME, per-command
//   timeout), prints the output and one line per check, and appends one
//   `STATUS<TAB>STEP<TAB>DETAIL` row per check to the rows file. Exit 0 when
//   no check failed, 1 when one did, 2 on bad arguments.
//
// Every literal a check expects in the command output must also appear in the
// README, so a failure says which side drifted: "README drifted" (the README no
// longer quotes it) or "code drifted" (the command no longer prints it).
//
// Library: runChecks, judgePathChecks, treeHash.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scrubEnv } from "./fresh-clone-lib.mjs";
import { HEADLINE } from "../src/demo/page.mjs";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

/** Every file under dir (relative paths, sorted). */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

/** One hash over all relative paths and bytes under dir. */
export function treeHash(dir) {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(dir)) {
    h.update(rel).update("\0").update(fs.readFileSync(path.join(dir, rel))).update("\0");
  }
  return h.digest("hex");
}

/** Index of each token in text, searching forward from `from`; null when one is missing or out of order. */
function inOrder(text, tokens, from = 0) {
  let at = from;
  for (const t of tokens) {
    const i = text.indexOf(t, at);
    if (i < 0) return t;
    at = i + t.length;
  }
  return null;
}

function lastLines(output, n) {
  return output.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n);
}

function spawnCheck(command, cwd, timeoutMs, extraEnv) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "judge-path-home-"));
  const env = {};
  for (const [k, v] of Object.entries(scrubEnv({ ...process.env, ...extraEnv }))) {
    if (!k.startsWith("NEAR_")) env[k] = v; // README output assumes no NEAR_* configuration
  }
  env.HOME = home;
  // Checks assume the default summary cadence (3); a caller's SUMMARY_EVERY_N_ROUNDS would give false FAILs.
  delete env.SUMMARY_EVERY_N_ROUNDS;
  const res = spawnSync("bash", ["-c", `exec 2>&1\n${command}`], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(home, { recursive: true, force: true });
  return {
    status: res.status,
    signal: res.signal,
    timedOut: res.error?.code === "ETIMEDOUT",
    spawnError: res.error && res.error.code !== "ETIMEDOUT" ? res.error.message : null,
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Run checks in order, in `cwd`, against the README text.
 * check = { step, command?, code?, expects?, readme?, readmeOnly?, assert?(ctx) }
 *   expects   literals the output must contain; the README must quote them too
 *   readme    README literals to require instead of `expects` (when the README
 *             words it differently from the output)
 *   readmeOnly extra README literals
 *   assert    extra JS assertions; ctx.fail(msg) flags code, ctx.failReadme(msg) the README
 * Returns [{ status, step, detail }]. Calls log(line) for progress.
 */
export function runChecks({ cwd, readme, checks, timeoutMs = 90000, log = console.log, env = {} }) {
  const rows = [];
  const shared = {};
  for (const check of checks) {
    const code = check.code ?? 0;
    const expects = check.expects ?? [];
    const problems = [];
    let assertions = 0;
    const ctx = {
      cwd,
      readme,
      shared,
      output: "",
      status: null,
      sha256,
      treeHash: (rel = "out") => treeHash(path.join(cwd, rel)),
      exists: (rel) => fs.existsSync(path.join(cwd, rel)),
      read: (rel) => fs.readFileSync(path.join(cwd, rel), "utf8"),
      json: (rel) => JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf8")),
      files: (rel) => listFiles(path.join(cwd, rel)),
      lastLines,
      inOrder,
      fail: (m) => problems.push(`code drifted: ${m}`),
      failReadme: (m) => problems.push(`README drifted: ${m}`),
      check: (ok, m) => {
        assertions++;
        if (!ok) problems.push(`code drifted: ${m}`);
      },
      checkReadme: (ok, m) => {
        assertions++;
        if (!ok) problems.push(`README drifted: ${m}`);
      },
    };
    log(`\n==> ${check.step}${check.command ? `  ${check.command}` : ""}`);

    for (const lit of check.readme ?? expects) {
      ctx.checkReadme(readme.includes(lit), `README.md no longer quotes ${JSON.stringify(lit)}`);
    }
    for (const lit of check.readmeOnly ?? []) {
      ctx.checkReadme(readme.includes(lit), `README.md no longer quotes ${JSON.stringify(lit)}`);
    }

    if (check.command) {
      if (check.before) check.before(ctx);
      const r = spawnCheck(check.command, cwd, check.timeoutMs ?? timeoutMs, env);
      ctx.output = r.output;
      ctx.status = r.status;
      log(r.output.endsWith("\n") || r.output === "" ? r.output.replace(/\n$/, "") : r.output);
      if (r.spawnError) problems.push(`could not run: ${r.spawnError}`);
      else if (r.timedOut) problems.push("timed out");
      else if (r.signal) problems.push(`killed by ${r.signal}`);
      else ctx.check(r.status === code, `exit ${r.status}, README says ${code}`);
      for (const lit of expects) {
        ctx.check(r.output.includes(lit), `output lacks ${JSON.stringify(lit)}`);
      }
    }
    if (check.assert) {
      try {
        check.assert(ctx);
      } catch (err) {
        problems.push(`check error: ${err.message}`);
      }
    }

    const row = problems.length
      ? { status: "FAIL", step: check.step, detail: problems.join("; ") }
      : { status: "PASS", step: check.step, detail: `exit ${code}, ${assertions} assertion(s) held` };
    row.detail = row.detail.replace(/[\t\r\n]+/g, " ").slice(0, 400);
    rows.push(row);
    log(`${row.status}  ${row.step}  ${row.detail}`);
  }
  return rows;
}

function appendRows(file, rows) {
  const text = rows.map((r) => `${r.status}\t${r.step}\t${r.detail}\n`).join("");
  fs.appendFileSync(file, text);
}

const FINAL_HASH = "4c8e826620ce2fa1c118df19d13f622ade870b0a54dd206e2c93157df9c6ff52";
const DONE_LINE =
  "Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.";
const ASK_ANSWER = "Chaotic (mock): Skeptic?? 5 fights and counting, bro I did not read the contract and it SHOWS 💀";
const ASK_LAST =
  "Nothing was signed or sent; inference was mocked: the answer and the sheet come from deterministic stand-ins, not a model.";
const TOKENS = ["aloof", "chaotic", "social", "skeptic"];
const PAGE_ORDER = [
  "Agents",
  "Memory",
  "Meme pack",
  "Transfer",
  "Tampered sheet",
  "Mint metadata",
  "On testnet",
  "Channel",
  "Anchor (dry run)",
  "Check a hash yourself",
  "Round hash chain",
  "24 share cards",
  "Files",
];

const sheetOf = (ctx, id) => ctx.json(`out/memory/${id}/sheet.json`);

/** JSON object printed after npm's banner lines. */
function jsonFromOutput(output) {
  const start = output.indexOf("\n{");
  return JSON.parse(output.slice(start + 1));
}

/** The checks for this repository's README judge path (section and step names are the README's). */
export function judgePathChecks() {
  const askLoop =
    'for i in 1 2 3 4 5 6; do echo "=== receipts run $i ==="; npm run ask -- chaotic "nope, show me the receipts"; done';
  return [
    {
      step: "judge:1 demo",
      command: "npm run demo",
      expects: [
        "[1/5] swarm: 6 rounds, 24 events, verify: ok",
        "[4/5] anchor (dry run): 8 calls prepared, 0 signed",
        DONE_LINE,
        "Files written (64)",
      ],
      readme: [
        DONE_LINE,
        "[1/5] swarm: 6 rounds, 24 events, verify: ok",
        "[4/5] anchor (dry run): 8 calls prepared, 0 signed",
        "`[1/5] swarm` to `[5/5] viewer`",
        "sticker",
        "24 share cards",
        "3 meme cards",
        "64 files",
        "Open the page: open out/index.html",
      ],
      assert(ctx) {
        ctx.check(/\[5\/5\] viewer: out\/index\.html/.test(ctx.output), "no '[5/5] viewer: out/index.html' line");
        ctx.check(/art: 24 svgs in style sticker.*24 share cards, 3 meme cards/.test(ctx.output), "art line lacks sticker style, 24 share cards, 3 meme cards");
        const [last] = ctx.lastLines(ctx.output, 1);
        ctx.check(last?.startsWith("Open the page: open out/index.html"), `last line is ${JSON.stringify(last)}`);
        ctx.check(ctx.files("out").length === 64, `out/ holds ${ctx.files("out").length} files, README says 64`);
        const listed = (ctx.output.match(/^ {2}out\/\S+$/gm) ?? []).length;
        ctx.check(listed === 64, `demo lists ${listed} files, expected 64`);
        ctx.shared.demoTree = ctx.treeHash("out");
        ctx.shared.demoRoundHash = ctx.json("out/demo.json").finalRoundHash;
      },
    },
    {
      step: "judge:2 page",
      readmeOnly: [HEADLINE, ...PAGE_ORDER],
      assert(ctx) {
        const html = ctx.read("out/index.html");
        ctx.check(html.includes(`<h1>${HEADLINE}</h1>`), `out/index.html lacks the h1 '${HEADLINE}'`);
        const marks = ["<h1>", ...PAGE_ORDER.map((n) => (n === "24 share cards" ? `<summary>${n}</summary>` : /^(Tampered|Mint|On test|Check)/.test(n) ? `<h3>${n}` : `<h2>${n}`))];
        const miss = ctx.inOrder(html, marks);
        ctx.check(miss === null, `page sections out of order or missing at ${JSON.stringify(miss)}`);
        const step = ctx.readme.indexOf("Open `out/index.html`. See the headline");
        ctx.checkReadme(step >= 0 && ctx.inOrder(ctx.readme, PAGE_ORDER, step) === null, "README step 2 no longer lists the page sections in this order");
        ctx.check(/<details(?![^>]*\bopen\b)[^>]*>\s*<summary>24 share cards/.test(html),"'24 share cards' is not a collapsed <details>");
        ctx.check(/verify: ok/.test(html), "page lacks 'verify: ok'");
        ctx.check(ctx.files("out/share").filter((f) => f.startsWith("meme-")).length === 3, "out/share does not hold 3 meme cards");
        ctx.check(ctx.files("out/share").filter((f) => /^(aloof|chaotic|social|skeptic)-\d\.svg$/.test(f)).length === 24, "out/share does not hold 24 share cards");
      },
    },
    {
      step: "judge:3a ask",
      command: 'npm run ask -- chaotic "what do you think of Skeptic?"',
      expects: [ASK_ANSWER, "Owner: 0 fights, 0 hugs, 1 shrug", 'Signature quote: "Skeptic?? 5 fights and counting, bro I did not read the contract...".', ASK_LAST],
      readmeOnly: ["sheet chaotic round 7 <hash> (+4 -4) -> anchor_sheet dry-run (not sent)"],
      assert(ctx) {
        const [second, last] = ctx.lastLines(ctx.output, 2);
        const m = /^sheet chaotic round 7 ([0-9a-f]{64}) \(\+4 -4\) -> anchor_sheet dry-run \(not sent\)$/.exec(second ?? "");
        ctx.check(!!m, `second to last line is ${JSON.stringify(second)}`);
        ctx.check(last === ASK_LAST, `last line is ${JSON.stringify(last)}`);
        ctx.check(m?.[1] === sheetOf(ctx, "chaotic").sheetHash, "printed hash differs from sheetHash in out/memory/chaotic/sheet.json");
        ctx.check(/^ {2}\+ Signature quote: "Skeptic\?\? 5 fights and counting/m.test(ctx.output), "answer is not the new signature quote");
      },
    },
    {
      step: "judge:3b ask x6",
      command: askLoop,
      readmeOnly: ["+ Public enemy #1: Owner (5 fights).", "Public enemy #1: Owner (6 fights)."],
      assert(ctx) {
        const runs = ctx.output.split(/=== receipts run \d ===/).slice(1);
        ctx.check(runs.length === 6, `${runs.length} runs, expected 6`);
        runs.forEach((r, i) => {
          const adds = r.includes("+ Public enemy #1: Owner (5 fights).");
          ctx.check(adds === (i === 4), `run ${i + 1} ${adds ? "has" : "lacks"} '+ Public enemy #1: Owner (5 fights).' (expected only run 5)`);
        });
        ctx.check(/Public enemy #1: Owner \(6 fights\)\./.test(runs[5] ?? ""), "run 6 lacks 'Public enemy #1: Owner (6 fights).'");
        ctx.check(sheetOf(ctx, "chaotic").sheet.includes("Public enemy #1: Owner (6 fights)."), "sheet.json does not end with Owner (6 fights)");
      },
    },
    {
      step: "judge:3c ask enemy",
      command: 'npm run ask -- chaotic "who is your enemy?"',
      expects: ["Chaotic (mock): Owner?? 6 fights and counting, bro I did not read the contract and it SHOWS 💀"],
    },
    {
      step: "judge:3d reset",
      command: "npm run demo",
      expects: ["Files written (64)"],
      readme: ["`npm run demo` again", "round 6 sheets"],
      assert(ctx) {
        ctx.check(ctx.treeHash("out") === ctx.shared.demoTree, "out/ after the reset differs from out/ after the first demo");
        ctx.check(sheetOf(ctx, "chaotic").round === 6, "chaotic sheet is not back at round 6");
      },
    },
    {
      step: "judge:4 transcript",
      expects: ["[Chaotic -> Skeptic] @Skeptic"],
      readmeOnly: ["out/transcript.txt", "out/events.json", "`agentId`, `round`, `turn`, `kind` and `replyTo`"],
      assert(ctx) {
        ctx.check(ctx.read("out/transcript.txt").includes("[Chaotic -> Skeptic] @Skeptic"), "out/transcript.txt lacks '[Chaotic -> Skeptic] @Skeptic'");
        const ev = ctx.json("out/events.json");
        const events = Array.isArray(ev) ? ev : ev.events;
        ctx.check(events.length === 24, `${events.length} events, expected 24`);
        const ok = events.every((e) => ["agentId", "round", "turn", "kind", "replyTo"].every((k) => k in e));
        ctx.check(ok, "an event lacks agentId, round, turn, kind or replyTo");
      },
    },
    {
      step: "judge:5 sheet hash",
      command: `node -p 'require("./out/memory/chaotic/sheet.json").sheet'`,
      expects: ["Ride-or-die: Social (3 warm moments)."],
      readmeOnly: [`node -p 'require("./out/memory/chaotic/sheet.json").sheet' | shasum -a 256`],
      assert(ctx) {
        ctx.check(ctx.sha256(ctx.output) === sheetOf(ctx, "chaotic").sheetHash, "sha256 of the printed sheet is not the sheetHash in sheet.json");
        for (const id of TOKENS) {
          const s = sheetOf(ctx, id);
          ctx.check(ctx.sha256(`${s.sheet}\n`) === s.sheetHash, `${id}: sha256(sheet + newline) differs from sheetHash`);
        }
        const chaotic = ctx.json("out/demo.json").agents.find((a) => a.id === "chaotic");
        const r3 = chaotic.sheets.find((s) => s.round === 3)?.sheet ?? "";
        const r6 = chaotic.sheets.find((s) => s.round === 6)?.sheet ?? "";
        ctx.check(r3.includes("Skeptic (3 fights)") && r3.includes("Social (1 warm moment)") && r3.includes("chaos goblin"), "round 3 sheet is not 3 fights / 1 warm moment / chaos goblin");
        ctx.check(r6.includes("Skeptic (5 fights)") && r6.includes("Social (3 warm moments)") && r6.includes("villain arc"), "round 6 sheet is not 5 fights / 3 warm moments / villain arc");
        ctx.checkReadme(ctx.readme.includes("Public enemy #1: Skeptic (5 fights). Ride-or-die: Social (3 warm moments)."), "README no longer quotes the round 6 sheet");
      },
    },
    {
      step: "judge:6 anchors",
      readmeOnly: ['"signed": false', '"status": "dry-run"', '"transactionHash": null', "personality-nft.demo.testnet", "8 `anchor_sheet` calls"],
      assert(ctx) {
        const a = ctx.json("out/anchors.json");
        ctx.check(a.signed === false, "signed is not false");
        ctx.check(a.contractId === "personality-nft.demo.testnet", `contractId is ${a.contractId}`);
        ctx.check(a.calls.length === 8, `${a.calls.length} calls, expected 8`);
        ctx.check(a.calls.every((c) => c.method === "anchor_sheet" && c.status === "dry-run" && c.transactionHash === null), "a call is not an anchor_sheet dry-run with a null transactionHash");
        for (const id of TOKENS) {
          const mine = a.calls.filter((c) => c.tokenId === id);
          ctx.check(mine.length === 2, `${id} has ${mine.length} calls, expected 2`);
          const latest = mine.reduce((x, y) => (y.round > x.round ? y : x), mine[0]);
          ctx.check(latest?.args.sheet_hash === sheetOf(ctx, id).sheetHash, `${id}: latest anchor sheet_hash differs from sheet.json`);
        }
      },
    },
    {
      step: "judge:7 transfer",
      readmeOnly: ["alice.demo.testnet", "bob.demo.testnet", "`match`", "`MISMATCH`", "`mocked`", "Transfer: memory travels with the NFT"],
      assert(ctx) {
        const t = ctx.json("out/demo.json").transfer;
        ctx.check(t.from === "alice.demo.testnet" && t.to === "bob.demo.testnet", "transfer is not alice.demo.testnet -> bob.demo.testnet");
        ctx.check(t.tokens.length === 4 && t.tokens.every((x) => x.match === true && x.anchoredHash === x.recomputedHash), "a token's re-hashed sheet does not match");
        ctx.check(t.tamper.match === false && t.tamper.anchoredHash !== t.tamper.recomputedHash, "the tampered sheet does not mismatch");
        ctx.check(t.teeInference.status === "mocked" && t.teeInference.label === "Inference (NEAR AI Cloud)", "inference badge is not 'Inference (NEAR AI Cloud)' = mocked");
        const html = ctx.read("out/index.html");
        ctx.check(html.includes("Transfer: memory travels with the NFT") && html.includes("MISMATCH") && html.includes("match") && html.includes("mocked"), "page lacks the Transfer heading, match, MISMATCH or mocked");
      },
    },
    {
      step: "judge:8 rerun",
      command: "npm run demo",
      expects: [FINAL_HASH],
      before(ctx) {
        ctx.state = ctx.treeHash("out");
      },
      assert(ctx) {
        ctx.check(ctx.treeHash("out") === ctx.state, "out/ is not byte-identical after a second run");
        ctx.check(ctx.shared.demoRoundHash === FINAL_HASH, `final round hash is ${ctx.shared.demoRoundHash}`);
      },
    },
    {
      step: "judge:9 live refused",
      command: "MOCK_INFERENCE=0 npm run demo",
      code: 2,
      expects: ["demo: runs in mock mode only"],
    },
    {
      step: "caveats:seed 2",
      command: "npm run demo -- --seed 2 --out out/seed2",
      expects: ["5 meme cards", "Files written (66)"],
    },
    {
      step: "caveats:attest ok",
      command: "npm run attest:check",
      expects: ["CONSISTENT, NOT VERIFIED", "Not verified:"],
      readme: ["CONSISTENT, NOT VERIFIED", "did not verify"],
    },
    {
      step: "caveats:attest tamper",
      command: "npm run attest:check -- --tamper",
      code: 1,
      expects: ["REJECT"],
      readmeOnly: ["`-- --tamper`"],
    },
    {
      step: "caveats:attest unreadable",
      command: "npm run attest:check -- --unreadable-quote",
      code: 2,
      expects: ["intel_quote is 2 bytes", "CONSISTENT, NOT VERIFIED, BINDING UNREAD"],
      readme: ["`-- --unreadable-quote`", "2-byte hex quote", "CONSISTENT, NOT VERIFIED, BINDING UNREAD"],
    },
    {
      step: "caveats:anchor dry-run",
      command: "npm run anchor -- --dry-run",
      expects: ['"mode": "dry-run"', '"transactionHash": null', '"methodName": "anchor_sheet"', "mock-contract.testnet", '"signing": "required"'],
      readme: ['"mode": "dry-run"', '"transactionHash": null', "anchor_sheet", "mock-contract.testnet", '"signing": "required"', "`roundHashes`"],
      assert(ctx) {
        const j = jsonFromOutput(ctx.output);
        ctx.check(j.roundHashes.length === 3 && HEX64.test(j.sheetHash) && j.roundHashes.every((r) => HEX64.test(r.hash)), "JSON lacks three roundHashes or a 64-hex sheetHash");
      },
    },
    {
      step: "caveats:anchor plain",
      command: "npm run anchor",
      code: 2,
      expects: ["anchor: --dry-run is required; this CLI never signs (see --help)"],
    },
    {
      step: "deploy:2 no wasm",
      command: "npm run deploy:nft",
      code: 1,
      expects: ["error: wasm not found at contracts/personality-nft/target/near/personality_nft.wasm. Run npm run build:contract first."],
    },
    {
      step: "deploy:3 mint dry run",
      command: "npm run mint",
      expects: ["dry-run: nothing is signed or sent", "[1/4] mint aloof", "[4/4] mint skeptic", "nft_mint", "token_metadata", "0.05 NEAR"],
      readme: ["[1/4] mint aloof", "[4/4] mint skeptic", "nft_mint", "token_metadata", "0.05 NEAR"],
      assert(ctx) {
        ctx.check((ctx.output.match(/^ {2}deposit {2}0\.05 NEAR/gm) ?? []).length === 4, "not four 0.05 NEAR deposits");
        ctx.check((ctx.output.match(/^ {4}extra: \{/gm) ?? []).length === 4, "not four extra trait JSON lines");
      },
    },
    {
      step: "deploy:4 live:check",
      command: "npm run live:check -- --offline",
      code: 1,
      expects: ["[todo]", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "ready: no. Fix the [todo] items above."],
      readme: ["`[todo]`", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "ready: no. Fix the [todo] items above.", "live:check -- --offline"],
    },
    {
      step: "swarm:1 five rounds",
      command: "npm run swarm -- --rounds 5",
      expects: ['[Skeptic] gas is "basically free"? receipts or it did not happen.', "[Chaotic -> Skeptic] @Skeptic", "verify: ok (5 rounds)", "8 anchor dry-runs, each linked to its round hash; final round hash"],
      readmeOnly: ["`final round hash: <64 hex>`", "(MOCK, not on-chain)"],
      assert(ctx) {
        ctx.check((ctx.output.match(/^== Round \d+ ==$/gm) ?? []).length === 5, "not 5 round headers");
        ctx.check((ctx.output.match(/^\[\w+( -> \w+)?\] /gm) ?? []).length === 20, "not 20 chat lines");
        const fh = /^final round hash: ([0-9a-f]{64})$/m.exec(ctx.output);
        ctx.check(!!fh, "no 'final round hash: <64 hex>' line");
        const sheets = ctx.output.match(/^sheet (\w+) round (3|5) [0-9a-f]{64} \(\+\d+ -\d+\) -> anchor_sheet dry-run \(not sent\)$/gm) ?? [];
        ctx.check(sheets.length === 8, `${sheets.length} sheet lines, expected 8 (rounds 3 and 5 per agent)`);
        ctx.check(ctx.output.includes(`final round hash ${fh?.[1]} (MOCK, not on-chain)`), "closing line does not repeat the final round hash");
        ctx.shared.swarm5 = { hash: fh?.[1], transcript: ctx.read("out/swarm/transcript.txt") };
      },
    },
    {
      step: "swarm:2 rerun",
      command: "npm run swarm -- --rounds 5",
      assert(ctx) {
        ctx.check(ctx.output.includes(`final round hash: ${ctx.shared.swarm5.hash}`), "second run prints a different final round hash");
        ctx.check(ctx.read("out/swarm/transcript.txt") === ctx.shared.swarm5.transcript, "second run writes a different transcript");
      },
    },
    {
      step: "swarm:3-4 files",
      readmeOnly: ["out/swarm/events.json", "`roundHashes`", "out/swarm/sheets/aloof.json", "Public enemy #1: Skeptic (1 fight).", "Ride-or-die: Social (1 warm moment).", "Receipts: 2 posts, 3 replies, mentioned 1 time."],
      assert(ctx) {
        const ev = ctx.json("out/swarm/events.json");
        ctx.check(ev.events.every((e) => ["round", "turn", "agentId", "replyTo"].every((k) => k in e)) && ev.roundHashes.length === 5, "events.json lacks round/turn/agentId/replyTo or 5 roundHashes");
        const aloof = ctx.json("out/swarm/sheets/aloof.json");
        for (const lit of ["Public enemy #1: Skeptic (1 fight).", "Ride-or-die: Social (1 warm moment).", "Scorecard:", "Receipts: 2 posts, 3 replies, mentioned 1 time."]) {
          ctx.check(aloof.sheet.includes(lit), `aloof.json sheet lacks ${JSON.stringify(lit)}`);
        }
        const mine = ev.events.filter((e) => e.agentId === "aloof");
        ctx.check(mine.filter((e) => e.kind === "post").length === 2 && mine.filter((e) => e.kind === "reply").length === 3 && ev.events.filter((e) => ev.events.find((x) => x.id === e.replyTo)?.agentId === "aloof").length === 1, "events do not count to 2 posts, 3 replies, mentioned 1 time for Aloof");
        const loop = ctx.json("out/swarm/memory-loop.json");
        ctx.check(loop.tokens.some((t) => t.tokenId === "aloof" && t.sheets.some((s) => s.anchor.args.sheet_hash === aloof.sheetHash)), "aloof sheetHash is not a sheet_hash in memory-loop.json");
      },
    },
    {
      step: "swarm:5 seven rounds",
      command: "npm run swarm -- --rounds 7 --every 3",
      expects: ["sheet aloof round 3 ", "sheet aloof round 6 ", "sheet aloof round 7 ", "12 anchor dry-runs, each linked to its round hash"],
      readme: ["12 anchor dry-runs, each linked to its round hash", "aloof.round-3.json", "`.round-6`", "`.round-7`", "`tokens[0].sheets`", "`previousHash`"],
      assert(ctx) {
        for (const f of ["aloof.json", "aloof.round-3.json", "aloof.round-6.json", "aloof.round-7.json"]) {
          ctx.check(ctx.exists(`out/swarm/sheets/${f}`), `out/swarm/sheets/${f} missing`);
        }
        const sheets = ctx.json("out/swarm/memory-loop.json").tokens[0].sheets;
        ctx.check(sheets.length === 3 && sheets.every((s) => s.anchor), "tokens[0].sheets is not 3 entries with an anchor");
        ctx.check(sheets.slice(1).every((s) => ["added", "removed", "previousHash"].every((k) => k in s.diff)), "a diff lacks added, removed or previousHash");
      },
    },
    {
      step: "swarm:6 seed 2",
      command: "npm run swarm -- --rounds 5 --seed 2",
      assert(ctx) {
        const fh = /^final round hash: ([0-9a-f]{64})$/m.exec(ctx.output)?.[1];
        ctx.check(!!fh && fh !== ctx.shared.swarm5.hash, "seed 2 gives the same final round hash as seed 1");
        ctx.check(ctx.read("out/swarm/transcript.txt") !== ctx.shared.swarm5.transcript, "seed 2 gives the same transcript as seed 1");
      },
    },
    {
      step: "art:1 sticker",
      command: "npm run render -- --style sticker",
      expects: ["out/styles/sticker/sheet.svg"],
      readme: ["16 SVGs (4 agents x 4 moods)", "sheet.svg", "out/styles/sticker/"],
      assert(ctx) {
        ctx.check(ctx.files("out/styles/sticker").length === 17, `${ctx.files("out/styles/sticker").length} files in out/styles/sticker, expected 17`);
      },
    },
    {
      step: "art:3 all styles",
      command: "npm run render -- --style all",
      readme: ["5 files for `default`", "17 (16 moods and `sheet.svg`)"],
      assert(ctx) {
        const want = { default: 5, sticker: 17, pixel: 17, deepfried: 17 };
        for (const [style, n] of Object.entries(want)) {
          ctx.check(ctx.files(`out/styles/${style}`).length === n, `out/styles/${style} holds ${ctx.files(`out/styles/${style}`).length} files, expected ${n}`);
        }
        ctx.check(ctx.files("out/styles").length === 56, "out/styles does not hold 56 files in all");
      },
    },
  ];
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") opts.cwd = argv[++i];
    else if (argv[i] === "--rows") opts.rows = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      return 2;
    }
  }
  if (!opts.cwd || !opts.rows) {
    console.error("usage: fresh-clone-judge-path.mjs --cwd <clone> --rows <pre.tsv>");
    return 2;
  }
  if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
    console.error(`not a directory: ${opts.cwd}`);
    return 2;
  }
  let rows;
  try {
    const readme = fs.readFileSync(path.join(opts.cwd, "README.md"), "utf8");
    rows = runChecks({ cwd: opts.cwd, readme, checks: judgePathChecks() });
  } catch (err) {
    rows = [{ status: "FAIL", step: "judge path", detail: `could not run: ${err.message}` }];
  }
  appendRows(opts.rows, rows);
  const failed = rows.filter((r) => r.status === "FAIL").length;
  console.log(`\njudge path: ${rows.length - failed} of ${rows.length} checks passed`);
  return failed ? 1 : 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));
