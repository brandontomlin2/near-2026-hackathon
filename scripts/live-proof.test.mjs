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

test("the deploy and mint argv live-proof sends are accepted by testnet-deploy's own parser, approval included", async () => {
  // The two scripts must agree: what live-proof passes is exactly what deploy --send and
  // mint --send require. testnet-deploy refuses --send without --i-approve (review L-1), so
  // live-proof must hand its own approval on, or a real run stops at the deploy step.
  const { parseArgs } = await import("./testnet-deploy.mjs");
  const r = await go(SEND, APPROVED_ENV);
  assert.equal(r.code, 0);
  const [deployArgv, mintArgv] = r.spawned.slice(0, 2).map(([, args]) => args.slice(1)); // drop the script path
  const deploy = parseArgs(deployArgv);
  assert.equal(deploy.command, "deploy");
  assert.equal(deploy.send, true);
  assert.equal(deploy.approve, true, `deploy argv must carry --i-approve: ${JSON.stringify(deployArgv)}`);
  const mint = parseArgs(mintArgv);
  assert.equal(mint.command, "mint");
  assert.equal(mint.send, true);
  assert.equal(mint.approve, true, `mint argv must carry --i-approve: ${JSON.stringify(mintArgv)}`);
  assert.equal(mint.mediaBase, MEDIA_BASE);
  removeTxFile();
});

test("every child argv live-proof sends passes all of testnet-deploy's send gates (near and the keychain stubbed)", async () => {
  // Stronger than parsing: run each spawned argv through testnet-deploy's run() with the
  // near binary, the keychain probe and the wasm check stubbed, so every gate that would
  // stop a real child (approval, media base, env, network) is evaluated here, offline.
  const { run: deployRun } = await import("./testnet-deploy.mjs");
  const r = await go(SEND, APPROVED_ENV);
  assert.equal(r.code, 0);
  for (const [bin, args] of r.spawned.filter(([b]) => b === "node")) {
    assert.equal(bin, "node");
    const lines = [];
    const errs = [];
    const nearCalls = [];
    const code = await deployRun(args.slice(1), APPROVED_ENV, {
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      exec: (b, argv) => { nearCalls.push([b, argv]); return 0; },
      hasNear: () => true,
      wasmExists: () => true,
    });
    assert.equal(code, 0, `${args[1]}: ${errs.join("\n")}`);
    assert.equal(errs.join("\n"), "", args[1]);
    assert.match(lines.join("\n"), /^send: \d+ transaction\(s\) on testnet/m, args[1]);
    assert.ok(nearCalls.every(([b]) => b === "near"), "the stub only ever stands in for near");
  }
  removeTxFile();
});

test("--i-approve is never put on the anchor_sheet near argv (near-cli-rs would reject it)", async () => {
  const r = await go(SEND, APPROVED_ENV);
  assert.equal(r.code, 0);
  const anchor = r.spawned[2];
  assert.equal(anchor[0], "near");
  assert.ok(!anchor[1].includes("--i-approve"), JSON.stringify(anchor[1]));
  assert.ok(anchor[1].includes("network-config") && anchor[1][anchor[1].indexOf("network-config") + 1] === "testnet", "the anchor call pins testnet");
  removeTxFile();
});

// Review L-2: live-proof used to rely on the first child refusing a non-testnet NEAR_NETWORK.
// It must refuse itself, in both modes, before anything is spawned or written.
test("--send --i-approve with NEAR_NETWORK other than testnet exits 2 and spawns nothing", async () => {
  removeTxFile();
  for (const network of ["mainnet", "betanet", "localnet", "Testnet", "testnet "]) {
    const r = await go(SEND, { ...APPROVED_ENV, NEAR_NETWORK: network });
    assert.equal(r.code, 2, network);
    assert.equal(r.spawned.length, 0, `${network}: nothing may be spawned`);
    assert.equal(r.errs, "error: NEAR_NETWORK must be unset or testnet; this script refuses other networks (see --help)", network);
    assert.doesNotMatch(r.text, /^send:/m, network);
    assert.ok(!existsSync(TX_FILE), `${network}: no transaction file for a run that sent nothing`);
  }
});

// Review L-b: the evidence step refuses any contract that is not a named .testnet account.
// live-proof must refuse the same ids before deploying, so a run is never sent and then
// refused at the evidence step. The owner (signer) keeps the general account-id check.
test("--send --i-approve with a mainnet-looking or implicit NEAR_CONTRACT_ACCOUNT_ID exits 2 and spawns nothing", async () => {
  removeTxFile();
  for (const contract of ["agent-nft.near", "a".repeat(64), "near", "agent-nft.testnet.near"]) {
    const r = await go(SEND, { ...APPROVED_ENV, NEAR_CONTRACT_ACCOUNT_ID: contract });
    assert.equal(r.code, 2, contract);
    assert.equal(r.spawned.length, 0, `${contract}: nothing may be spawned`);
    assert.equal(r.errs, "error: NEAR_CONTRACT_ACCOUNT_ID must be a named .testnet account (value not shown); mainnet and implicit accounts are refused (see --help)", contract);
    assert.equal(r.text, "", `${contract}: nothing printed before the refusal`);
    assert.ok(!existsSync(TX_FILE), `${contract}: no transaction file for a run that sent nothing`);
  }
  // The dry run keeps the looser check: it prints a plan and signs nothing.
  const dry = await go([], { ...APPROVED_ENV, NEAR_CONTRACT_ACCOUNT_ID: "agent-nft.near" });
  assert.equal(dry.code, 0, dry.errs);
});

test("dry run with NEAR_NETWORK other than testnet exits 2 and writes nothing", async () => {
  for (const network of ["mainnet", "betanet"]) {
    const r = await go([], { ...APPROVED_ENV, NEAR_NETWORK: network });
    assert.equal(r.code, 2, network);
    assert.equal(r.spawned.length, 0, network);
    assert.equal(r.text, "", `${network}: nothing printed before the refusal`);
    assert.match(r.errs, /^error: NEAR_NETWORK must be unset or testnet/, network);
    assert.ok(!existsSync(r.file), `${network}: no example file was written`);
  }
});

test("NEAR_NETWORK=testnet, empty or unset is accepted in both modes", async () => {
  for (const env of [{ NEAR_NETWORK: "testnet" }, { NEAR_NETWORK: "" }, {}]) {
    const dry = await go([], { ...APPROVED_ENV, ...env });
    assert.equal(dry.code, 0, dry.errs);
    assert.ok(existsSync(dry.file));
    const sent = await go(SEND, { ...APPROVED_ENV, ...env });
    assert.equal(sent.code, 0, sent.errs);
    assert.equal(sent.spawned.length, 3);
    removeTxFile();
  }
});

// Review L-6: --out, --force and --update-example describe the dry run's example file,
// which --send never writes. Accepting them silently misled; now they are refused.
test("--send refuses --out, --force and --update-example before any spawn", async () => {
  removeTxFile();
  const cases = [
    ["--out", ["--out", "record.json"]],
    ["--force", ["--force"]],
    ["--update-example", ["--update-example"]],
    ["--out and --force", ["--out", "record.json", "--force"]],
  ];
  for (const [label, extra] of cases) {
    const lines = [];
    const errs = [];
    const spawned = [];
    const code = await run([...SEND, ...extra], APPROVED_ENV, {
      out: (l) => lines.push(l),
      err: (l) => errs.push(l),
      exec: (bin, args) => { spawned.push([bin, args]); return { code: 0, output: "" }; },
    });
    assert.equal(code, 2, label);
    assert.equal(spawned.length, 0, `${label}: nothing may be spawned`);
    assert.equal(lines.join("\n"), "", `${label}: nothing printed before the refusal`);
    assert.equal(errs.join("\n"), `error: --out, --force and --update-example apply to the dry run only; --send writes its record to ${TX_FILE_LABEL} (see --help)`, label);
    assert.ok(!existsSync(TX_FILE), `${label}: no transaction file`);
    assert.ok(!existsSync("record.json"), `${label}: no --out file`);
  }
});

test("--help says --out, --force and --update-example are dry-run only and NEAR_NETWORK is testnet only", async () => {
  const lines = [];
  assert.equal(await run(["--help"], {}, { out: (l) => lines.push(l), err: () => {}, exec: () => { throw new Error("no spawn"); } }), 0);
  const usage = lines.join("\n");
  assert.match(usage, /--out <file>\s+dry run only/);
  assert.match(usage, /--force\s+dry run only/);
  assert.match(usage, /--update-example\s+dry run only/);
  assert.match(usage, /NEAR_NETWORK\s+unset or testnet; anything else is refused/);
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
  // Review L-d: the contract goes in NEAR_CONTRACT_ACCOUNT_ID, the variable evidence.mjs reads
  // first (NEAR_ACCOUNT_ID is only its fallback), so the printed command matches the deploy step.
  assert.equal(evidenceCommand(CONTRACT), "EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=agent-nft.testnet EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence");
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

// Audit L-5: --out used to overwrite any existing file. Now it only replaces an example
// evidence file this tool wrote earlier; anything else needs --force.
test("--out that holds someone else's file is refused with exit 2 and left untouched; --force replaces it; own output is replaced freely", async () => {
  const { writeFileSync } = await import("node:fs");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "live-proof-")), "notes.json");
  writeFileSync(file, '{"example": false, "mine": true}\n');
  const go2 = async (argv) => {
    const lines = [];
    const errs = [];
    const code = await run(argv, {}, { out: (l) => lines.push(l), err: (l) => errs.push(l), exec: () => { throw new Error("must not spawn"); } });
    return { code, text: lines.join("\n"), errs: errs.join("\n") };
  };
  const refused = await go2(["--out", file]);
  assert.equal(refused.code, 2);
  assert.equal(refused.text, "", "nothing printed before the refusal");
  assert.equal(refused.errs, `error: --out ${file} exists and is not an example evidence file this tool wrote; pass --force to replace it (see --help)`);
  assert.equal(readFileSync(file, "utf8"), '{"example": false, "mine": true}\n', "the foreign file is untouched");

  for (const content of ["not json at all", "[]", "null", '{"transactions": []}']) {
    writeFileSync(file, content);
    assert.equal((await go2(["--out", file])).code, 2, content);
    assert.equal(readFileSync(file, "utf8"), content);
  }

  const forced = await go2(["--out", file, "--force"]);
  assert.equal(forced.code, 0, forced.errs);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.example, true);

  // Now it is ours: a plain re-run replaces it.
  const again = await go2(["--out", file]);
  assert.equal(again.code, 0, again.errs);
  assert.match(again.text, /wrote example evidence \(example: true\) to the --out file/);
});

test("--help documents --force", async () => {
  const lines = [];
  const code = await run(["--help"], {}, { out: (l) => lines.push(l), err: () => {} });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /--force\s+dry run only: replace an existing --out/);
});
