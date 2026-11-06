import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_TAKEN_AT, TRANSCRIPT_FILE, TRANSCRIPT_NOW, cli, firstDifference, renderTranscript } from "./yield-live-transcript.mjs";

const rendered = await renderTranscript();
const section = (n) => {
  const parts = rendered.split(/^## /m).slice(1);
  return parts[n - 1];
};

test("the committed transcript equals what the command prints now", () => {
  const diff = firstDifference(rendered, readFileSync(TRANSCRIPT_FILE, "utf8"));
  assert.equal(diff, null, `docs/yield-live-dry-run-transcript.md is out of date, ${diff}; run: node scripts/yield-live-transcript.mjs`);
});

test("the clock is pinned exactly 24 h after the snapshot", () => {
  assert.equal(TRANSCRIPT_NOW - Date.parse(SNAPSHOT_TAKEN_AT), 24 * 3_600_000);
});

test("run 1: exit 0, unsigned header, preflight table, valid plan, setup stage 1-19 of 35", () => {
  const s = section(1);
  assert.match(s, /^Exit code: 0$/m);
  assert.ok(s.includes("UNSIGNED (nothing is signed or sent)"));
  assert.ok(s.includes("PREFLIGHT (offline; nothing is read from .env, no value is printed)"));
  assert.match(s, /^snapshot age\s+fresh\s+24\.0 h old/m);
  assert.ok(s.includes("plan valid against contracts/yield-vault/src/lib.rs"));
  assert.ok(s.includes("setup stage, plan steps 1-19 of 35"));
  assert.ok(s.includes("Command: `npm run yield:live:dry-run`"));
});

test("run 2: exit 3 listing the missing items", () => {
  const s = section(2);
  assert.match(s, /^Exit code: 3$/m);
  assert.ok(s.includes("stdout: identical to run 1"));
  for (const item of ["NEAR_NETWORK", "YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID", "config placeholders"]) assert.match(s, new RegExp(`^  - ${item}: `, "m"));
  assert.ok(!s.includes("fresh snapshot"));
});

test("run 3: exit 2 with the refusal and empty stdout", () => {
  const s = section(3);
  assert.match(s, /^Exit code: 2$/m);
  assert.ok(s.includes("refused: this tool never signs or sends"));
  assert.match(s, /stdout:\n\n```text\n```/);
});

test("no explorer links and no 64-hex strings", () => {
  assert.ok(!/explorer|nearblocks|nearscan/i.test(rendered));
  assert.ok(!/[0-9a-f]{64}/i.test(rendered));
});

test("--check exits 0 on the committed file and 1 on a tampered copy", async () => {
  const quiet = { log: () => {}, err: () => {} };
  assert.equal(await cli(["--check"], quiet), 0);
  const dir = mkdtempSync(join(tmpdir(), "ylt72-"));
  const copy = join(dir, "t.md");
  copyFileSync(TRANSCRIPT_FILE, copy);
  assert.equal(await cli(["--check", "--file", copy], quiet), 0);
  const lines = readFileSync(copy, "utf8").split("\n");
  lines[10] = `${lines[10]} tampered`;
  writeFileSync(copy, lines.join("\n"));
  const errs = [];
  assert.equal(await cli(["--check", "--file", copy], { log: () => {}, err: (m) => errs.push(m) }), 1);
  assert.match(errs.join("\n"), /line 11:/);
});
