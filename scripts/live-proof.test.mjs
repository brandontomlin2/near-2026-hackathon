import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "./live-proof.mjs";

const OWNER = "agent-owner.testnet";
const CONTRACT = "agent-nft.testnet";
const APPROVED_ENV = { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT };

async function go(argv, env = {}) {
  const lines = [];
  const errs = [];
  const spawned = [];
  const file = path.join(mkdtempSync(path.join(tmpdir(), "live-proof-")), "evidence.example.json");
  const code = await run([...argv, ...(argv.includes("--send") ? [] : ["--out", file])], env, {
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    exec: (bin, args) => { spawned.push([bin, args]); return 0; },
  });
  return { code, text: lines.join("\n"), errs: errs.join("\n"), spawned, file };
}

test("dry run lists deploy, 4 mints, anchor_sheet in order and spawns nothing", async () => {
  const r = await go([]);
  assert.equal(r.code, 0);
  assert.equal(r.spawned.length, 0);
  const order = ["] deploy", "] mint aloof", "] mint chaotic", "] mint social", "] mint skeptic", "] anchor_sheet"].map((s) => r.text.indexOf(s));
  assert.ok(order.every((i) => i >= 0), "every step is printed");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(r.text, /nft_mint/);
  assert.match(r.text, /new_default_meta/);
});

test("dry run output is stable", async () => {
  const a = await go([]);
  const b = await go([]);
  assert.equal(a.text, b.text);
  assert.equal(readFileSync(a.file, "utf8"), readFileSync(b.file, "utf8"));
});

test("dry run output is identical with TMPDIR inside the repo and TMPDIR next to it", async () => {
  // Regression: with TMPDIR a sibling of the repo (TMPDIR=~/git/.tmpv.XXXX while the repo is
  // ~/git/near-2026-hackathon) the "wrote ..." line printed a cwd-relative path such as
  // ../.tmpv.XXXX/live-proof-XXXX/evidence.example.json, which changed on every run.
  const { mkdirSync, rmSync } = await import("node:fs");
  const { TRACKED_EXAMPLE } = await import("./live-proof.mjs");
  const root = path.resolve(path.dirname(TRACKED_EXAMPLE), "..");
  mkdirSync(path.join(root, "out"), { recursive: true });
  const insideRepo = mkdtempSync(path.join(root, "out", "tmpdir-inside-"));
  const nextToRepo = mkdtempSync(path.join(root, "..", ".tmpdir-next-to-repo-"));
  const saved = process.env.TMPDIR;
  const withTmpdir = async (dir) => {
    process.env.TMPDIR = `${dir}/`; // trailing slash, as the failing environment had it
    assert.equal(tmpdir(), dir, "os.tmpdir() follows TMPDIR");
    return go([]);
  };
  try {
    const inside = await withTmpdir(insideRepo);
    const sibling = await withTmpdir(nextToRepo);
    assert.equal(inside.code, 0);
    assert.equal(sibling.code, 0);
    assert.ok(inside.file.startsWith(insideRepo + path.sep) && sibling.file.startsWith(nextToRepo + path.sep), "each run wrote under its TMPDIR");
    assert.equal(inside.text, sibling.text);
    assert.ok(!inside.text.includes(".."), `relative hop leaked: ${inside.text.split("\n").at(-1)}`);
    assert.ok(!inside.text.includes("tmpdir-"), `temp path leaked: ${inside.text.split("\n").at(-1)}`);
    assert.match(inside.text, /^wrote example evidence \(example: true\) to the --out file$/m);
    assert.equal(readFileSync(inside.file, "utf8"), readFileSync(sibling.file, "utf8"));
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    rmSync(insideRepo, { recursive: true, force: true });
    rmSync(nextToRepo, { recursive: true, force: true });
  }
});

test("default dry run names its destination relative to the repository root", async () => {
  const { rmSync } = await import("node:fs");
  const { DEFAULT_OUT } = await import("./live-proof.mjs");
  const lines = [];
  const code = await run([], {}, { out: (l) => lines.push(l), err: () => {}, exec: () => 0 });
  assert.equal(code, 0);
  assert.equal(lines.at(-1), "wrote example evidence (example: true) to out/live-proof/evidence.example.json");
  rmSync(DEFAULT_OUT);
});

test("dry run writes example evidence marked example", async () => {
  const r = await go([], APPROVED_ENV);
  const ev = JSON.parse(readFileSync(r.file, "utf8"));
  assert.equal(ev.example, true);
  assert.equal(ev.contract, CONTRACT);
  assert.deepEqual(ev.transactions.map((t) => t.label), ["deploy", "mint aloof", "mint chaotic", "mint social", "mint skeptic", "anchor_sheet"]);
  assert.ok(ev.transactions.every((t) => t.hash.startsWith("EXAMPLE-")));
  assert.equal(ev.views.find((v) => v.method === "nft_total_supply").result, "4");
});

test("--send without --i-approve exits nonzero and spawns nothing", async () => {
  const r = await go(["--send"], APPROVED_ENV);
  assert.notEqual(r.code, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.errs, /--i-approve/);
});

test("--send --i-approve without NEAR_ACCOUNT_ID exits nonzero and spawns nothing", async () => {
  const r = await go(["--send", "--i-approve"], {});
  assert.notEqual(r.code, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.errs, /NEAR_ACCOUNT_ID/);
});

test("--send --i-approve with env runs deploy, mint, anchor in order (mocked spawn)", async () => {
  const r = await go(["--send", "--i-approve"], APPROVED_ENV);
  assert.equal(r.code, 0);
  assert.equal(r.spawned.length, 3);
  assert.ok(r.spawned[0][1].includes("deploy"));
  assert.ok(r.spawned[1][1].includes("mint"));
  assert.equal(r.spawned[2][0], "near");
  assert.ok(r.spawned[2][1].includes("anchor_sheet"));
});

test("a failing step stops the run", async () => {
  const spawned = [];
  const code = await run(["--send", "--i-approve"], APPROVED_ENV, {
    out: () => {}, err: () => {},
    exec: (bin, args) => { spawned.push(args); return 1; },
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 1);
});

test("default dry run leaves git-tracked files unchanged and writes under out/", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, rmSync } = await import("node:fs");
  const { DEFAULT_OUT, TRACKED_EXAMPLE } = await import("./live-proof.mjs");
  const root = path.join(path.dirname(TRACKED_EXAMPLE), "..");
  const snap = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" });
  const before = snap();
  const tracked = readFileSync(TRACKED_EXAMPLE, "utf8");
  const code = await run([], {}, { out: () => {}, err: () => {}, exec: () => 0 });
  assert.equal(code, 0);
  assert.equal(snap(), before);
  assert.equal(readFileSync(TRACKED_EXAMPLE, "utf8"), tracked);
  assert.ok(existsSync(DEFAULT_OUT));
  assert.ok(path.relative(root, DEFAULT_OUT).startsWith("out" + path.sep));
  rmSync(DEFAULT_OUT);
});
