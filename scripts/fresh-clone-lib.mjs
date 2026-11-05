#!/usr/bin/env node
// Helper for scripts/fresh-clone-test.sh. No dependencies.
//
// Library: extractBlocks, checkSafe, commandsOf, scrubEnv, evaluate, formatTable.
// CLI:     node scripts/fresh-clone-lib.mjs run --readme <file> --cwd <dir>
//              [--pre <tsv>] [--allow-empty] [--timeout-ms <n>]
//          Runs every judge:run block of the README in <cwd>, prints the
//          PASS/FAIL table (rows from <tsv> first) and exits 1 on any FAIL.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RUN_RE = /^<!--\s*judge:run\s*-->\s*$/;
const EXPECT_RE = /^<!--\s*judge:expect\s+(.*?)\s*-->\s*$/;
const FENCE_RE = /^(`{3,}(?=[^`]*$)|~{3,})\s*([\w+-]*)[^\n]*$/;
const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh"]);

// Blocks marked runnable must work offline with no keys. This is a lint that
// catches README authors' mistakes, not a sandbox: it is trivially bypassed
// (node -e, npm scripts, eval). The child also gets a temp HOME and a scrubbed env.
const UNSAFE = [
  [/(^|[^\w-])(curl|wget)\s/, "network download"],
  [/--live\b/, "live mode"],
  [/NEAR_NETWORK=(?!testnet\b)\S+/, "non-testnet network"],
  [/(^|[;&|\s(`])near\s/, "near cli (signs transactions)"],
  [/\bcargo\s+near\b/, "cargo near"],
  [/\bgit\s+push\b/, "git push"],
  [/(^|[\s<>"'=/])\.env(\.\w+)?(\s|$|["';&|)<>])/, "reads .env"],
  [/\.near-credentials|\.pem\b|\.key\b|id_rsa/, "reads key files"],
  [/\bnpm\s+(publish|login)\b/, "npm publish/login"],
];

/**
 * Find runnable blocks. A block is runnable when a `<!-- judge:run -->` line
 * precedes its opening fence, with only blank lines and `judge:expect`
 * markers in between. Any other content cancels the pending markers.
 * Returns [{ line, lang, code, expects }] (line is the 1-based fence line).
 */
export function extractBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let armed = false;
  let expects = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (RUN_RE.test(text)) {
      armed = true;
      expects = [];
      continue;
    }
    const exp = EXPECT_RE.exec(text);
    if (exp) {
      if (armed && exp[1]) expects.push(exp[1]);
      continue;
    }
    const fence = FENCE_RE.exec(text);
    if (fence) {
      const close = fence[1];
      const body = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(close)) body.push(lines[j++]);
      if (armed) {
        blocks.push({ line: i + 1, lang: fence[2].toLowerCase(), code: body.join("\n"), expects });
      }
      armed = false;
      expects = [];
      i = j;
      continue;
    }
    if (text !== "") {
      armed = false;
      expects = [];
    }
  }
  return blocks;
}

/** Shell commands in a block: drops blanks, comments and `$ ` prompts; joins `\` continuations. */
export function commandsOf(code) {
  const out = [];
  let acc = "";
  for (const raw of code.split("\n")) {
    const line = raw.replace(/^\s*\$\s+/, "").trimEnd();
    if (acc === "" && (line.trim() === "" || line.trim().startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      acc += line.slice(0, -1) + " ";
      continue;
    }
    out.push((acc + line).trim());
    acc = "";
  }
  if (acc.trim()) out.push(acc.trim());
  return out;
}

/** Returns null when the block is safe to run, else a reason string. */
export function checkSafe(block) {
  if (!SHELL_LANGS.has(block.lang)) return `not a shell block (${block.lang})`;
  for (const cmd of commandsOf(block.code)) {
    for (const [re, why] of UNSAFE) if (re.test(cmd)) return `refused: ${why}`;
  }
  return null;
}

const SECRET_NAME =
  /(^|_)(API_KEY|ACCESS_KEY|SECRET|PRIVATE_KEY|TOKEN|PASSWORD|MNEMONIC|PASSPHRASE|CREDENTIALS?|SEED_PHRASE|KEYPAIR|KEY)($|_)/i;

/** Child env: no secrets, no accounts, mock inference, no network selection. */
export function scrubEnv(env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME.test(name) || name === "NEAR_ACCOUNT_ID" || name === "NEAR_NETWORK") continue;
    out[name] = value;
  }
  out.MOCK_INFERENCE = "1";
  out.CI = "1";
  return out;
}

/** Decide PASS/FAIL for one finished step. */
export function evaluate({ status, signal, timedOut, output }, expects) {
  if (timedOut) return { status: "FAIL", detail: "timed out" };
  if (signal) return { status: "FAIL", detail: `killed by ${signal}` };
  if (status !== 0) return { status: "FAIL", detail: `exit ${status}` };
  const missing = expects.filter((e) => !output.includes(e));
  if (missing.length) {
    return { status: "FAIL", detail: `exit 0 but output lacks: ${missing.map((m) => JSON.stringify(m)).join(", ")}` };
  }
  const note = expects.length ? `exit 0, ${expects.length} expected marker(s) found` : "exit 0";
  return { status: "PASS", detail: note };
}

export function formatTable(rows) {
  const w = Math.max(4, ...rows.map((r) => r.step.length));
  const out = [`${"STATUS".padEnd(6)}  ${"STEP".padEnd(w)}  DETAIL`, `${"------"}  ${"-".repeat(w)}  ------`];
  for (const r of rows) out.push(`${r.status.padEnd(6)}  ${r.step.padEnd(w)}  ${r.detail}`);
  const failed = rows.some((r) => r.status === "FAIL");
  out.push("", `result: ${failed ? "FAIL" : "PASS"}`);
  return { text: out.join("\n"), failed };
}

function runBlock(block, cwd, timeoutMs) {
  const script = ["set -eo pipefail", ...commandsOf(block.code)].join("\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fresh-clone-home-"));
  const res = spawnSync("bash", ["-c", script], {
    cwd,
    env: { ...scrubEnv(process.env), HOME: home },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(home, { recursive: true, force: true });
  if (res.error && res.error.code !== "ETIMEDOUT") return { status: "FAIL", detail: `could not run: ${res.error.message}` };
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(output.endsWith("\n") || output === "" ? output : output + "\n");
  return evaluate(
    { status: res.status, signal: res.signal, timedOut: res.error?.code === "ETIMEDOUT", output },
    block.expects,
  );
}

function readPre(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [status, step, detail = ""] = l.split("\t");
      return { status, step, detail };
    });
}

function main(argv) {
  const opts = { timeoutMs: 120000 };
  const [cmd, ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--readme") opts.readme = rest[++i];
    else if (a === "--cwd") opts.cwd = rest[++i];
    else if (a === "--pre") opts.pre = rest[++i];
    else if (a === "--timeout-ms") {
      const v = rest[++i];
      if (!/^[1-9]\d*$/.test(v ?? "")) {
        console.error("--timeout-ms needs a positive integer (milliseconds)");
        return 2;
      }
      opts.timeoutMs = Number(v);
    }
    else if (a === "--allow-empty") opts.allowEmpty = true;
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }
  if (cmd !== "run" || !opts.readme || !opts.cwd) {
    console.error("usage: fresh-clone-lib.mjs run --readme <file> --cwd <dir> [--pre <tsv>] [--allow-empty] [--timeout-ms <n>]");
    return 2;
  }
  const rows = readPre(opts.pre);
  let blocks = [];
  try {
    blocks = extractBlocks(fs.readFileSync(opts.readme, "utf8"));
  } catch {
    rows.push({ status: "FAIL", step: "README parse", detail: "missing or unreadable" });
  }
  if (!blocks.length && !rows.some((r) => r.step === "README parse")) {
    rows.push(
      opts.allowEmpty
        ? { status: "SKIP", step: "README steps", detail: "no <!-- judge:run --> blocks" }
        : { status: "FAIL", step: "README steps", detail: "no <!-- judge:run --> blocks; a judge cannot reproduce the demo" },
    );
  }
  for (const block of blocks) {
    const step = `README:${block.line}`;
    const label = commandsOf(block.code)[0] ?? "(empty)";
    console.log(`\n==> ${step}  ${label}`);
    const unsafe = checkSafe(block);
    if (unsafe) rows.push({ status: "FAIL", step, detail: unsafe });
    else if (!commandsOf(block.code).length) rows.push({ status: "FAIL", step, detail: "empty block" });
    else {
      const r = runBlock(block, opts.cwd, opts.timeoutMs);
      rows.push({ status: r.status, step, detail: `${Array.from(label).slice(0, 50).join("")}: ${r.detail}` });
    }
  }
  const { text, failed } = formatTable(rows);
  console.log(`\nSUMMARY\n${text}`);
  return failed ? 1 : 0;
}

// Resolve symlinks: import.meta.url is a realpath, argv[1] is not (macOS /tmp -> /private/tmp).
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));
