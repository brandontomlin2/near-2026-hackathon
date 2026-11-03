import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SEND_COMMAND, TX_FILE, TX_FILE_LABEL, TX_LABELS, evidenceCommand, extractTransactionHashes, run } from "./live-proof.mjs";

const OWNER = "agent-owner.testnet";
const CONTRACT = "agent-nft.testnet";
const APPROVED_ENV = { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT };
// Where the owner hosts the four SVGs. mint --send refuses to run without it, so every
// complete send invocation carries it.
const MEDIA_BASE = "https://art.example";
const SEND = ["--send", "--i-approve", "--media-base", MEDIA_BASE];
// Six distinct base58 hashes, one per planned transaction.
const HASHES = TX_LABELS.map((_, i) => `${"ABCDEF"[i]}${"x".repeat(43)}`.replace(/x/g, "2"));

// What near-cli-rs prints for a sent transaction: the id line and the explorer link, both naming the same hash.
const nearOutput = (hashes) => hashes.map((h) => `Transaction ID: ${h}\nTo see the transaction in the transaction explorer, please open this url in your browser:\nhttps://explorer.testnet.near.org/transactions/${h}\n`).join("");

// Mocked stage output in send order: deploy prints one hash, mint prints four, anchor_sheet one.
const stageOutput = (bin, args) => {
  if (args.includes("deploy")) return nearOutput(HASHES.slice(0, 1));
  if (args.includes("mint")) return nearOutput(HASHES.slice(1, 5));
  if (bin === "near") return nearOutput(HASHES.slice(5));
  return "";
};

async function go(argv, env = {}, { output = () => "", fail = () => false } = {}) {
  const lines = [];
  const errs = [];
  const spawned = [];
  const file = path.join(mkdtempSync(path.join(tmpdir(), "live-proof-")), "evidence.example.json");
  const code = await run([...argv, ...(argv.includes("--send") ? [] : ["--out", file])], env, {
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    exec: (bin, args) => { spawned.push([bin, args]); return { code: fail(bin, args) ? 1 : 0, output: output(bin, args) }; },
  });
  return { code, text: lines.join("\n"), errs: errs.join("\n"), spawned, file };
}

const removeTxFile = () => rmSync(TX_FILE, { force: true });

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
  const r = await go(SEND, {});
  assert.notEqual(r.code, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.errs, /NEAR_ACCOUNT_ID/);
});

test("--send --i-approve without --media-base fails before the deploy step and spawns nothing", async () => {
  // Regression: live-proof used to deploy first and only then spawn `mint --send`, which
  // testnet-deploy refuses without --media-base, so a real run stopped after deploy.
  removeTxFile();
  const r = await go(["--send", "--i-approve"], APPROVED_ENV);
  assert.equal(r.code, 2);
  assert.equal(r.spawned.length, 0, "nothing may be spawned: deploy would have been sent");
  assert.match(r.errs, /^error: --send needs --media-base <url>.*\(see --help\)$/m);
  assert.doesNotMatch(r.text, /^send:/m, "the send banner is printed only once every gate passed");
  assert.ok(!existsSync(TX_FILE), "no transaction file for a run that sent nothing");
});

test("--send with a --media-base that mint would refuse fails before any spawn", async () => {
  for (const bad of ["not a url", "data:text/plain,x", "https://art.example/?q=1", "https://art.example/#frag"]) {
    const r = await go(["--send", "--i-approve", "--media-base", bad], APPROVED_ENV);
    assert.equal(r.code, 2, bad);
    assert.equal(r.spawned.length, 0, bad);
    assert.match(r.errs, /--media-base must be an http\(s\), ipfs or ar URL/, bad);
  }
});

test("--media-base without a value is a usage error", async () => {
  const r = await go(["--media-base"], {});
  assert.equal(r.code, 2);
  assert.match(r.errs, /--media-base needs a value/);
  const r2 = await go(["--media-base", "--send"], {});
  assert.equal(r2.code, 2);
  assert.match(r2.errs, /--media-base needs a value/);
});

test("--send --i-approve --media-base runs deploy, mint, anchor in order and passes --media-base to mint only (mocked spawn)", async () => {
  const r = await go(SEND, APPROVED_ENV);
  assert.equal(r.code, 0);
  assert.equal(r.spawned.length, 3);
  const [deploy, mint, anchor] = r.spawned;
  assert.equal(deploy[0], "node");
  assert.ok(deploy[1].includes("deploy"));
  assert.ok(!deploy[1].includes("--media-base"), "testnet-deploy rejects --media-base on deploy");
  assert.equal(mint[0], "node");
  assert.ok(mint[1].includes("mint"));
  assert.ok(mint[1].includes("--send"));
  const at = mint[1].indexOf("--media-base");
  assert.ok(at >= 0, `mint argv must carry --media-base: ${JSON.stringify(mint[1])}`);
  assert.equal(mint[1][at + 1], MEDIA_BASE);
  assert.equal(anchor[0], "near");
  assert.ok(anchor[1].includes("anchor_sheet"));
  removeTxFile();
});

test("the mint argv live-proof sends is accepted by testnet-deploy's own parser", async () => {
  // The two scripts must agree: what live-proof passes is exactly what mint --send requires.
  const { parseArgs } = await import("./testnet-deploy.mjs");
  const r = await go(SEND, APPROVED_ENV);
  assert.equal(r.code, 0);
  const mintArgv = r.spawned[1][1].slice(1); // drop the script path
  const opts = parseArgs(mintArgv);
  assert.equal(opts.command, "mint");
  assert.equal(opts.send, true);
  assert.equal(opts.mediaBase, MEDIA_BASE);
  removeTxFile();
});

test("dry run with --media-base shows the hosted media URLs, without it the labelled placeholder", async () => {
  const { MEDIA_PLACEHOLDER_BASE } = await import("./testnet-deploy.mjs");
  const hosted = await go(["--media-base", MEDIA_BASE], APPROVED_ENV);
  assert.equal(hosted.code, 0);
  assert.equal(hosted.spawned.length, 0);
  for (const id of ["aloof", "chaotic", "social", "skeptic"]) assert.ok(hosted.text.includes(`${MEDIA_BASE}/${id}.svg`), id);
  assert.ok(!hosted.text.includes(MEDIA_PLACEHOLDER_BASE));
  const placeholder = await go([], APPROVED_ENV);
  assert.ok(placeholder.text.includes(`${MEDIA_PLACEHOLDER_BASE}/aloof.svg`));
});

test("SEND_COMMAND is the complete owner command: approval and media base, in that order", () => {
  assert.equal(SEND_COMMAND, "npm run live-proof -- --send --i-approve --media-base <url>");
});

test("--help documents --media-base as required with --send", async () => {
  const lines = [];
  assert.equal(await run(["--help"], {}, { out: (l) => lines.push(l), err: () => {}, exec: () => { throw new Error("no spawn"); } }), 0);
  const usage = lines.join("\n");
  assert.match(usage, /--media-base <url>/);
  assert.match(usage, /\[--send --i-approve --media-base <url>\]/);
});

test("a failing step stops the run", async () => {
  const spawned = [];
  const code = await run(SEND, APPROVED_ENV, {
    out: () => {}, err: () => {},
    exec: (bin, args) => { spawned.push(args); return { code: 1, output: "" }; },
  });
  assert.equal(code, 1);
  assert.equal(spawned.length, 1);
  removeTxFile();
});

test("the evidence command is exactly what scripts/evidence.mjs reads", () => {
  assert.equal(TX_FILE_LABEL, "out/live-proof/txs.json");
  assert.equal(evidenceCommand(CONTRACT), "EVIDENCE_NETWORK=testnet NEAR_ACCOUNT_ID=agent-nft.testnet EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence");
  assert.deepEqual(TX_LABELS, ["deploy", "mint aloof", "mint chaotic", "mint social", "mint skeptic", "anchor_sheet"]);
});

test("extractTransactionHashes takes the near CLI id line and explorer link once each, nothing else", () => {
  const [a, b] = HASHES;
  assert.deepEqual(extractTransactionHashes(nearOutput([a, b])), [a, b]);
  assert.deepEqual(extractTransactionHashes(`Transaction ID: ${a}`), [a]);
  assert.deepEqual(extractTransactionHashes(`https://explorer.testnet.near.org/transactions/${b}`), [b]);
  // A bare base58-looking string (account ids, a base64 media_hash echoed in args) is not a hash.
  assert.deepEqual(extractTransactionHashes(`args {"media_hash":"${a}"} signer ${b}`), []);
  assert.deepEqual(extractTransactionHashes("Transaction ID: not-base58-0OIl"), []);
  assert.deepEqual(extractTransactionHashes(""), []);
});

test("--send writes every hash it collected to out/live-proof/txs.json and prints the exact evidence command", async () => {
  removeTxFile();
  const r = await go(SEND, APPROVED_ENV, { output: stageOutput });
  try {
    assert.equal(r.code, 0);
    assert.equal(r.errs, "");
    const tail = r.text.split("\n").slice(-3);
    assert.deepEqual(tail, [
      `wrote 6 of 6 transaction hashes to ${TX_FILE_LABEL}`,
      "done. Next, with read-only RPC views (nothing signed):",
      `  ${evidenceCommand(CONTRACT)}`,
    ]);
    assert.doesNotMatch(r.text, /WARN/);
    const txs = JSON.parse(readFileSync(TX_FILE, "utf8"));
    assert.deepEqual(txs, {
      network: "testnet",
      contract: CONTRACT,
      owner: OWNER,
      transactions: TX_LABELS.map((label, i) => ({ label, hash: HASHES[i] })),
    });
    // The printed command names a path npm run resolves from the package root: the file we wrote.
    const root = path.resolve(path.dirname(TX_FILE), "..", "..");
    assert.equal(path.resolve(root, r.text.match(/EVIDENCE_TX_FILE=(\S+)/)[1]), TX_FILE);
  } finally {
    removeTxFile();
  }
});

test("--send file is accepted by scripts/evidence.mjs loadTransactions", async () => {
  removeTxFile();
  const { loadTransactions } = await import("./evidence.mjs");
  await go(SEND, APPROVED_ENV, { output: stageOutput });
  try {
    assert.deepEqual(loadTransactions(TX_FILE).map((t) => t.label), TX_LABELS);
  } finally {
    removeTxFile();
  }
});

test("--send with hashes missing from the CLI output warns, names them, and still prints the command", async () => {
  removeTxFile();
  const r = await go(SEND, APPROVED_ENV, { output: (bin, args) => (args.includes("deploy") ? stageOutput(bin, args) : "") });
  try {
    assert.equal(r.code, 0);
    assert.match(r.text, new RegExp(`^wrote 1 of 6 transaction hashes to ${TX_FILE_LABEL}$`, "m"));
    assert.match(r.text, /^WARN: no hash found in the near CLI output for: mint aloof, mint chaotic, mint social, mint skeptic, anchor_sheet\./m);
    assert.equal(r.text.split("\n").at(-1), `  ${evidenceCommand(CONTRACT)}`);
    assert.deepEqual(JSON.parse(readFileSync(TX_FILE, "utf8")).transactions, [{ label: "deploy", hash: HASHES[0] }]);
  } finally {
    removeTxFile();
  }
});

test("a failed step still saves the hashes sent before it and names the step", async () => {
  removeTxFile();
  const r = await go(SEND, APPROVED_ENV, { output: stageOutput, fail: (bin, args) => args.includes("mint") });
  try {
    assert.equal(r.code, 1);
    assert.equal(r.spawned.length, 2);
    assert.match(r.errs, /^error: mint failed with exit 1; stopping\. Earlier transactions were not rolled back\.$/m);
    const txs = JSON.parse(readFileSync(TX_FILE, "utf8")).transactions;
    assert.deepEqual(txs.map((t) => t.label), ["deploy", "mint aloof", "mint chaotic", "mint social", "mint skeptic"]);
    assert.match(r.text, /WARN: no hash found in the near CLI output for: anchor_sheet\./);
    assert.equal(r.text.split("\n").at(-1), `  ${evidenceCommand(CONTRACT)}`);
  } finally {
    removeTxFile();
  }
});

test("a dry run never writes the transaction file", async () => {
  removeTxFile();
  const r = await go([], APPROVED_ENV);
  assert.equal(r.code, 0);
  assert.ok(!existsSync(TX_FILE));
  assert.doesNotMatch(r.text, /txs\.json|npm run evidence/);
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
