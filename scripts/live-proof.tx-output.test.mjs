// What near-cli-rs really prints after `... sign-with-keychain send`, and what live-proof
// makes of it. Samples follow the near-cli-rs source (src/lib.rs SimpleFormatter and
// setup_tracing, src/common.rs print_transaction_status, src/config/mod.rs defaults):
//
//   - Interactive mode (no --quiet): the tracing layer writes to STDERR. Each event starts
//     with "├  " and ends with "\x1b[0m"; the multi-line payload is indented with "│    ".
//     The transaction block is "Transaction ID: <base58>" plus the explorer URL, which is
//     explorer_transaction_url + id with no separator (testnet default
//     https://explorer.testnet.near.org/transactions/; a user's config.toml may point it at
//     nearblocks, https://testnet.nearblocks.io/txns/). A function call's return value goes
//     to STDOUT, preceded by an eprintln'd heading. The "Here is your console command" echo
//     repeats the full argv, media_hash and account ids included.
//   - Quiet mode (--quiet): no tracing subscriber is installed, so on success ONLY the raw
//     return value bytes reach stdout. No transaction id is printed at all. That is why no
//     command this repo sends carries --quiet.
//
// Nothing here spawns the real near CLI. The stub executable below is a node script.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TX_FILE, TX_FILE_LABEL, TX_LABELS, defaultExec, evidenceCommand, extractTransactionHashes, run } from "./live-proof.mjs";

const OWNER = "agent-owner.testnet";
const CONTRACT = "agent-nft.testnet";
const APPROVED_ENV = { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT };
const SEND = ["--send", "--i-approve", "--media-base", "https://art.example"];
const EXPLORER = "https://explorer.testnet.near.org/transactions/";
const NEARBLOCKS = "https://testnet.nearblocks.io/txns/";

// Deterministic 44-character base58 strings (no 0, O, I, l), distinct per seed.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeHash = (seed) => Array.from({ length: 44 }, (_, i) => B58[(i * 7 + seed * 13) % B58.length]).join("");
const HASHES = TX_LABELS.map((_, i) => fakeHash(i + 1));
// A media_hash that happens to be made of base58 characters only: a bare scan would take it for a tx hash.
const B58_LOOKING_MEDIA_HASH = fakeHash(99);

const RESET = "\x1b[0m";

/** The return value of nft_mint, as the contract serialises it (stdout in both modes). */
const mintReturnValue = (tokenId) => JSON.stringify({
  token_id: tokenId,
  owner_id: OWNER,
  metadata: { title: "Aloof", description: "I watch.", media: `https://art.example/${tokenId}.svg`, media_hash: B58_LOOKING_MEDIA_HASH, extra: "{\"temperament\":\"cool\"}" },
});

/** One tracing event as SimpleFormatter + indent_payload render it: prefix, indented payload, reset. */
const event = (heading, payloadLines, { colour = "" } = {}) => [`${colour}├  ${heading}`, ...payloadLines.map((l) => `│    ${l}`), RESET, ""].join("\n");

const txBlock = (hash, explorer = EXPLORER) => event("Transaction Execution Info:", [
  "",
  "Gas used: 6.6 Tgas",
  "Transaction fee: 0.00066 NEAR (approximately $0.00 USD, using $2.5 USD/NEAR)",
  "",
  `Transaction ID: ${hash}`,
  "To see the transaction in the transaction explorer, please open this url in your browser:",
  `${explorer}${hash}`,
  " ",
]);

/** Everything a successful interactive `nft_mint ... send` prints, both streams interleaved. */
const interactiveMint = (tokenId, hash, { explorer = EXPLORER } = {}) => [
  "Here is your console command if you need to script it or re-run:",
  `    near contract call-function as-transaction ${CONTRACT} nft_mint json-args '{"token_id":"${tokenId}","receiver_id":"${OWNER}","token_metadata":{"media_hash":"${B58_LOOKING_MEDIA_HASH}"}}' prepaid-gas '100 Tgas' attached-deposit '0.05 NEAR' sign-as ${OWNER} network-config testnet sign-with-keychain send`,
  "",
  event("Function execution logs:", ["", `Logs [${CONTRACT}]:`, `  EVENT_JSON:{"standard":"nep171","version":"1.1.0","event":"nft_mint","data":[{"owner_id":"${OWNER}","token_ids":["${tokenId}"]}]}`]),
  "",
  "Function execution return value (printed to stdout):",
  mintReturnValue(tokenId),
  "",
  `The "nft_mint" call to <${CONTRACT}> on behalf of <${OWNER}> succeeded.`,
  txBlock(hash, explorer),
].join("\n");

/** A successful interactive deploy with init call: no return value, same transaction block. */
const interactiveDeploy = (hash) => [
  event("Function execution logs:", ["", "No logs"]),
  "",
  `Contract code has been successfully deployed to <${CONTRACT}>.`,
  `The "new_default_meta" call to <${CONTRACT}> on behalf of <${CONTRACT}> succeeded.`,
  txBlock(hash),
].join("\n");

/** What --quiet prints on success: the raw return value on stdout, nothing else. */
const quietMint = (tokenId) => mintReturnValue(tokenId);
const quietDeploy = () => "";

const removeTxFile = () => rmSync(TX_FILE, { force: true });

async function send(output) {
  const lines = [];
  const errs = [];
  const code = await run(SEND, APPROVED_ENV, {
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    exec: (bin, args) => ({ code: 0, output: output(bin, args) }),
  });
  return { code, text: lines.join("\n"), errs: errs.join("\n") };
}

test("interactive output: the id line and the explorer link name one hash, once", () => {
  const [h] = HASHES;
  assert.deepEqual(extractTransactionHashes(interactiveMint("aloof", h)), [h]);
  assert.deepEqual(extractTransactionHashes(interactiveDeploy(h)), [h]);
});

test("interactive output: four mints in one stream give four hashes in print order", () => {
  const mints = HASHES.slice(1, 5);
  const stream = ["aloof", "chaotic", "social", "skeptic"].map((id, i) => interactiveMint(id, mints[i])).join("\n");
  assert.deepEqual(extractTransactionHashes(stream), mints);
});

test("the console-command echo, logs, return value and account ids never yield a hash", () => {
  const [h] = HASHES;
  const withoutBlock = interactiveMint("aloof", h).replace(txBlock(h), "");
  assert.ok(withoutBlock.includes(B58_LOOKING_MEDIA_HASH), "sample keeps the base58-looking media_hash");
  assert.ok(!withoutBlock.includes(h));
  assert.deepEqual(extractTransactionHashes(withoutBlock), []);
});

test("a nearblocks explorer URL (user config.toml) is read like the default explorer", () => {
  const [h] = HASHES;
  assert.deepEqual(extractTransactionHashes(interactiveMint("aloof", h, { explorer: NEARBLOCKS })), [h]);
  assert.deepEqual(extractTransactionHashes(`${NEARBLOCKS}${h}\n`), [h]);
});

test("ANSI colour codes around the prefix, the hash and the URL are ignored", () => {
  const [h] = HASHES;
  const coloured = [
    `\x1b[33m├  Warning: something to note${RESET}`,
    `├  Transaction Execution Info:`,
    `│    \x1b[1mTransaction ID:\x1b[22m \x1b[32m${h}${RESET}`,
    `│    To see the transaction in the transaction explorer, please open this url in your browser:`,
    `│    \x1b[4m\x1b[34m${EXPLORER}${h}${RESET}`,
    RESET,
  ].join("\n");
  assert.deepEqual(extractTransactionHashes(coloured), [h]);
  // The id line on its own, with colour codes between the label and the hash (no explorer link to fall back on).
  assert.deepEqual(extractTransactionHashes(`Transaction ID:\x1b[22m \x1b[32m${h}${RESET}`), [h]);
  // The id followed directly by a reset code, no whitespace: still exactly one hash of the full length.
  assert.deepEqual(extractTransactionHashes(`Transaction ID: ${h}${RESET}`), [h]);
});

test("CRLF and a bare CR line ending do not split or extend the hash", () => {
  const [h, k] = HASHES;
  assert.deepEqual(extractTransactionHashes(interactiveMint("aloof", h).replace(/\n/g, "\r\n")), [h]);
  assert.deepEqual(extractTransactionHashes(`Transaction ID: ${h}\r${EXPLORER}${k}\r`), [h, k]);
});

test("the id line with the hash on the next line (wrapped output) is still read", () => {
  const [h] = HASHES;
  assert.deepEqual(extractTransactionHashes(`Transaction ID:\n${h}\n`), [h]);
});

test("--quiet output, the raw return value only, holds no hash and yields none", () => {
  assert.deepEqual(extractTransactionHashes(quietMint("aloof")), []);
  assert.deepEqual(extractTransactionHashes(quietDeploy()), []);
});

test("no hash is invented from an empty, truncated or malformed id line", () => {
  for (const sample of [
    "",
    "   \n\n",
    "Transaction ID:",
    "Transaction ID: \n",
    "Transaction ID: <pending>",
    `Transaction ID: ${"0OIl".repeat(11)}`, // not base58
    `Transaction ID: ${B58.slice(0, 20)}`, // too short
    `${EXPLORER}\n`,
    `${EXPLORER}not-a-hash`,
    "Transaction failed: no id printed",
  ]) {
    assert.deepEqual(extractTransactionHashes(sample), [], JSON.stringify(sample));
  }
  for (const found of [extractTransactionHashes(interactiveDeploy(HASHES[0]))]) {
    assert.ok(found.every((h) => typeof h === "string" && h.length >= 32), "never an empty string");
  }
});

test("extractTransactionHashes accepts a Buffer, as defaultExec collects one", () => {
  const [h] = HASHES;
  assert.deepEqual(extractTransactionHashes(Buffer.from(interactiveDeploy(h), "utf8")), [h]);
});

test("--send with interactive near output (ANSI, CRLF, both streams) records all six hashes", async () => {
  removeTxFile();
  const output = (bin, args) => {
    if (args.includes("deploy")) return interactiveDeploy(HASHES[0]).replace(/\n/g, "\r\n");
    if (args.includes("mint")) return ["aloof", "chaotic", "social", "skeptic"].map((id, i) => interactiveMint(id, HASHES[i + 1])).join("\n");
    if (bin === "near") return interactiveMint("aloof", HASHES[5]).replace("nft_mint", "anchor_sheet");
    return "";
  };
  try {
    const r = await send(output);
    assert.equal(r.code, 0);
    assert.equal(r.errs, "");
    assert.doesNotMatch(r.text, /WARN/);
    assert.match(r.text, new RegExp(`^wrote 6 of 6 transaction hashes to ${TX_FILE_LABEL}$`, "m"));
    const txs = JSON.parse(readFileSync(TX_FILE, "utf8"));
    assert.deepEqual(txs.transactions, TX_LABELS.map((label, i) => ({ label, hash: HASHES[i] })));
  } finally {
    removeTxFile();
  }
});

test("--send with output lacking the id block (what --quiet would print) records no hash at all: a WARN naming every step, never a fake or empty one", async () => {
  removeTxFile();
  const output = (bin, args) => {
    if (args.includes("deploy")) return quietDeploy();
    if (args.includes("mint")) return ["aloof", "chaotic", "social", "skeptic"].map(quietMint).join("");
    if (bin === "near") return "";
    return "";
  };
  try {
    const r = await send(output);
    assert.equal(r.code, 0);
    assert.match(r.text, new RegExp(`^wrote 0 of 6 transaction hashes to ${TX_FILE_LABEL}$`, "m"));
    assert.match(r.text, new RegExp(`^WARN: no hash found in the near CLI output for: ${TX_LABELS.join(", ")}\\.`, "m"));
    assert.equal(r.text.split("\n").at(-1), `  ${evidenceCommand(CONTRACT)}`);
    const txs = JSON.parse(readFileSync(TX_FILE, "utf8"));
    assert.deepEqual(txs.transactions, []);
    assert.ok(!r.text.includes(B58_LOOKING_MEDIA_HASH), "the media_hash from the return value is not mistaken for a transaction");
  } finally {
    removeTxFile();
  }
});

test("a step that prints a Transaction ID but exits non-zero is reported as failed and its id is not recorded (stub near on PATH)", async () => {
  // near-cli-rs prints the Transaction ID of an executed transaction whether it succeeded or
  // failed, and exits non-zero for a failure. The anchor_sheet step here really spawns `near`
  // from PATH through defaultExec; the two testnet-deploy children are canned (a real child
  // would need the built wasm) and succeed.
  removeTxFile();
  const dir = mkdtempSync(path.join(tmpdir(), "live-proof-near-stub-"));
  try {
    const argvFile = path.join(dir, "argv.txt");
    const stub = path.join(dir, "near");
    writeFileSync(stub, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${argvFile}'`,
      "cat >&2 <<'NEAR_STUB_EOF'",
      txBlock(HASHES[5]),
      "NEAR_STUB_EOF",
      'exit "${STUB_NEAR_EXIT:-0}"',
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    const canned = (args) => (args.includes("deploy")
      ? interactiveDeploy(HASHES[0])
      : ["aloof", "chaotic", "social", "skeptic"].map((id, i) => interactiveMint(id, HASHES[i + 1])).join("\n"));
    const attempt = async (exit) => {
      const lines = [];
      const errs = [];
      const env = { ...APPROVED_ENV, PATH: `${dir}${path.delimiter}${process.env.PATH}`, STUB_NEAR_EXIT: String(exit) };
      const code = await run(SEND, env, {
        out: (l) => lines.push(l),
        err: (l) => errs.push(l),
        exec: (bin, args, opts) => (bin === "near" ? defaultExec(bin, args, opts) : { code: 0, output: canned(args) }),
      });
      const argv = readFileSync(argvFile, "utf8").replace(/\n$/, "").split("\n");
      return { code, text: lines.join("\n"), errs: errs.join("\n"), argv, txs: JSON.parse(readFileSync(TX_FILE, "utf8")) };
    };

    const failed = await attempt(1);
    assert.equal(failed.code, 1);
    assert.ok(failed.argv.includes("anchor_sheet") && failed.argv.at(-1) === "send", `the stub saw the anchor call: ${JSON.stringify(failed.argv)}`);
    assert.ok(!failed.argv.includes("--quiet"), "the sent command is not quiet, so the id block above was printed");
    assert.match(failed.errs, /^error: anchor_sheet failed with exit 1; stopping\./m);
    assert.deepEqual(failed.txs.transactions, TX_LABELS.slice(0, 5).map((label, i) => ({ label, hash: HASHES[i] })), "the five steps that exited 0");
    assert.ok(!JSON.stringify(failed.txs).includes(HASHES[5]), "the failed step's id is not in the file");
    assert.match(failed.text, /^FAILED: anchor_sheet exited 1\. Not recorded \(not sent, or sent and failed\): anchor_sheet\./m);
    assert.doesNotMatch(failed.text, /^done/m);
    assert.doesNotMatch(failed.text, /WARN: no hash found/);

    removeTxFile();
    const ok = await attempt(0);
    assert.equal(ok.code, 0, ok.errs);
    assert.equal(ok.errs, "");
    assert.deepEqual(ok.txs.transactions, TX_LABELS.map((label, i) => ({ label, hash: HASHES[i] })), "with exit 0 the same output is recorded");
    assert.match(ok.text, /^done\. Next/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    removeTxFile();
  }
});

test("defaultExec keeps stderr (where the interactive transaction block goes) as well as stdout, and the exit code", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-proof-stub-"));
  try {
    const [h] = HASHES;
    const stub = path.join(dir, "stub-near.mjs");
    // A stand-in for the near CLI: the return value to stdout, the transaction block to stderr, then exit 3.
    writeFileSync(stub, [
      `process.stdout.write(${JSON.stringify(mintReturnValue("aloof"))});`,
      `process.stderr.write(${JSON.stringify(txBlock(h))});`,
      "process.exitCode = 3;",
      "",
    ].join("\n"));
    chmodSync(stub, 0o755);
    const r = await defaultExec(process.execPath, [stub]);
    assert.equal(r.code, 3);
    assert.ok(r.output.includes(mintReturnValue("aloof")), "stdout captured");
    assert.ok(r.output.includes(`Transaction ID: ${h}`), "stderr captured");
    assert.deepEqual(extractTransactionHashes(r.output), [h]);
    const missing = await defaultExec(path.join(dir, "no-such-binary"), []);
    assert.equal(missing.code, 127);
    assert.equal(missing.output, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
