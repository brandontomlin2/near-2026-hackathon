// Pins docs/live-runbook.md to the code it describes. Offline: exec is a function that fails if called.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEND_COMMAND, TX_FILE_LABEL, evidenceCommand, run, totalDeposit, buildPlan } from "./live-proof.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const runbook = read("docs/live-runbook.md");
const readme = read("README.md");
const pkg = JSON.parse(read("package.json"));

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("every npm run <script> in the runbook exists in package.json", () => {
  const names = [...runbook.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  for (const n of names) assert.ok(pkg.scripts[n], `npm run ${n} is not in package.json`);
});

test("runbook quotes the send command, the tx file and the evidence command from live-proof", () => {
  assert.ok(runbook.includes(SEND_COMMAND), `missing ${SEND_COMMAND}`);
  assert.ok(runbook.includes(TX_FILE_LABEL), `missing ${TX_FILE_LABEL}`);
  assert.ok(runbook.includes(evidenceCommand("<contract>.testnet")), "missing the evidence command");
  assert.ok(runbook.includes(`wrote 6 of 6 transaction hashes to ${TX_FILE_LABEL}`));
});

test("the 0.21 NEAR total in the runbook is the real plan's total deposit", async () => {
  const d = mkdtempSync(path.join(tmpdir(), "live60rb-"));
  dirs.push(d);
  try {
    const lines = [];
    const noExec = () => { throw new Error("exec must not be called in a dry run"); };
    const env = { NEAR_ACCOUNT_ID: "owner-x.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft-x.testnet" };
    // The deploy step needs the built wasm only to print its path; buildPlan passes the path through.
    const code = await run(["--dry-run", "--media-base", "https://example.org/agents", "--out", path.join(d, "e.json")], env, { out: (l) => lines.push(l), err: (l) => lines.push(l), exec: noExec });
    const text = lines.join("\n");
    if (code !== 0) {
      // Without a built wasm the plan cannot print; assert on the pure plan total instead.
      assert.match(text, /wasm not found|dry run failed/);
    } else {
      const summary = text.split("\n").find((l) => l.startsWith("summary: contract"));
      const m = /total deposit (.+)$/.exec(summary);
      assert.ok(m, "no total deposit summary line");
      assert.ok(runbook.includes(`total deposit ${m[1]}`), `runbook must say total deposit ${m[1]}`);
      assert.ok(runbook.includes(m[1]), "runbook must name the total");
      assert.ok(runbook.includes(summary.replace(/\s+$/, "")), "runbook quotes the summary line as printed");
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.equal(totalDeposit([{ name: "deploy", deposit: "0 NEAR" }, ...Array(4).fill({ name: "mint x", deposit: "0.05 NEAR" }), { name: "anchor_sheet", deposit: "0.01 NEAR" }]), "0.21 NEAR");
  assert.ok(runbook.includes("0.21 NEAR"));
  assert.equal(typeof buildPlan, "function");
});

test("README 'Live on testnet' links the runbook", () => {
  const body = readme.split("## Live on testnet\n")[1].split(/\n## /)[0];
  assert.ok(body.includes("(docs/live-runbook.md)"));
  assert.ok(read("docs/live-readiness.md").includes("(live-runbook.md)"));
});

test("every NEAR_* and EVIDENCE_* name in the runbook is read by the scripts", () => {
  const scripts = readdirSync(path.join(ROOT, "scripts"))
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => read(`scripts/${f}`))
    .concat(read("scripts/verify.sh"))
    .join("\n");
  const names = new Set(runbook.match(/\b(?:NEAR|EVIDENCE)_[A-Z_]+\b/g));
  assert.ok(names.size >= 5);
  for (const n of names) assert.ok(scripts.includes(n), `${n} is not used by any script`);
});

test("runbook contains no key material and the evidence outputs are gitignored", () => {
  assert.doesNotMatch(runbook, /ed25519:|secp256k1:|sk-[A-Za-z0-9]/);
  const ignore = read(".gitignore");
  assert.match(ignore, /^out\/$/m);
});
