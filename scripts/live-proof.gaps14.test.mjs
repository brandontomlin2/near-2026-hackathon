// Behaviour tests for scripts/live-proof.mjs that live-proof.test.mjs and
// cli-edge-cases.test.mjs do not cover: the anchor_sheet step, the dry-run plan
// header and placeholders, the example evidence views, the argument and account gates
// on the send path, and the process-level dry run. Dry runs only, outputs in a fresh
// temp dir. Send-path cases here stop at a gate, before any exec and before
// out/live-proof/txs.json could be written.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ANCHOR_DEPOSIT_YOCTO, DEFAULT_GAS } from "../src/anchor/anchor.mjs";
import { hashSheet } from "../src/anchor/hash.mjs";
import { buildAnchorStep, run } from "./live-proof.mjs";

const SCRIPT = fileURLToPath(new URL("./live-proof.mjs", import.meta.url));
const NO_NETWORK = fileURLToPath(new URL("./test-helpers/no-network.mjs", import.meta.url));
const OWNER = "agent-owner.testnet";
const CONTRACT = "agent-nft.testnet";
const MEDIA = "https://art.example";

const fresh = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-proof-gaps14-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function dry(t, argv, env = {}) {
  const dir = fresh(t);
  const out = [];
  const errs = [];
  const spawned = [];
  const file = path.join(dir, "nested", "deeper", "evidence.example.json");
  const code = await run(["--out", file, ...argv], env, {
    out: (l) => out.push(l),
    err: (l) => errs.push(l),
    exec: (...a) => { spawned.push(a); return { code: 0, output: "" }; },
  });
  return { code, text: out.join("\n"), errs: errs.join("\n"), spawned, file, dir };
}

test("anchor_sheet step: 30 Tgas and 0.01 NEAR agree with the anchor module, signed by the owner via the keychain", () => {
  const step = buildAnchorStep({ contract: CONTRACT, owner: OWNER });
  assert.equal(step.name, "anchor_sheet");
  assert.equal(step.receiver_id, CONTRACT);
  assert.equal(step.method, "anchor_sheet");
  assert.equal(step.gas, `${Number(BigInt(DEFAULT_GAS) / 10n ** 12n)} Tgas`);
  assert.equal(step.gas, "30 Tgas");
  assert.equal(BigInt(ANCHOR_DEPOSIT_YOCTO), 10n ** 22n);
  assert.equal(step.deposit, "0.01 NEAR");
  assert.deepEqual(step.args, { token_id: "aloof", sheet_hash: step.sheetHash });
  assert.match(step.sheetHash, /^[0-9a-f]{64}$/);
  assert.equal(step.sheetHash, hashSheet("Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n"));
  const i = (s) => step.argv.indexOf(s);
  assert.equal(step.argv[0], "contract");
  assert.ok(!step.argv.includes("--quiet"), "no --quiet: near-cli-rs prints the tx id only without it");
  assert.equal(step.argv[i("sign-as") + 1], OWNER);
  assert.equal(step.argv[i("network-config") + 1], "testnet");
  assert.equal(step.argv[i("prepaid-gas") + 1], "30 Tgas");
  assert.equal(step.argv[i("attached-deposit") + 1], "0.01 NEAR");
  assert.equal(JSON.parse(step.argv[i("json-args") + 1]).token_id, "aloof");
  assert.deepEqual(step.argv.slice(-2), ["sign-with-keychain", "send"]);
});

test("the placeholder contract still yields a valid anchor payload and keeps the placeholder as the receiver", () => {
  const step = buildAnchorStep({ contract: "<NEAR_CONTRACT_ACCOUNT_ID>", owner: "<NEAR_ACCOUNT_ID>" });
  assert.equal(step.receiver_id, "<NEAR_CONTRACT_ACCOUNT_ID>");
  assert.equal(step.signer, "<NEAR_ACCOUNT_ID>");
  assert.match(step.sheetHash, /^[0-9a-f]{64}$/);
});

test("dry run with both accounts set prints the header, six numbered steps and a --send hint; with none set it prints the placeholders", async (t) => {
  const set = await dry(t, ["--media-base", MEDIA], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT });
  assert.equal(set.code, 0, set.errs);
  const lines = set.text.split("\n");
  assert.equal(lines[0], "dry-run: nothing is signed or sent. Add --send --i-approve to broadcast on testnet.");
  assert.equal(lines[1], `network: testnet   owner: ${OWNER}   contract: ${CONTRACT}`);
  assert.deepEqual(set.text.match(/^\[\d\/\d\] .+$/gm), ["[1/6] deploy", "[2/6] mint aloof", "[3/6] mint chaotic", "[4/6] mint social", "[5/6] mint skeptic", "[6/6] anchor_sheet"]);
  assert.match(set.text, new RegExp(`^  call     ${CONTRACT}\\.anchor_sheet$`, "m"));
  assert.match(set.text, /^  deposit  0\.01 NEAR   gas 30 Tgas$/m);

  const none = await dry(t, []);
  assert.equal(none.code, 0, none.errs);
  assert.match(none.text, /^network: testnet   owner: <NEAR_ACCOUNT_ID>   contract: <NEAR_CONTRACT_ACCOUNT_ID>$/m);
  assert.match(none.text, /^  call     <NEAR_CONTRACT_ACCOUNT_ID>\.nft_mint$/m);
});

test("dry run deploy step uses the repo-relative wasm path, never an absolute one", async (t) => {
  const r = await dry(t, [], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT });
  const deploy = r.text.split("\n").find((l) => l.startsWith("  command  near") && l.includes("deploy"));
  assert.ok(deploy, "deploy command line present");
  assert.match(deploy, /use-file contracts\/personality-nft\/target\/near\/personality_nft\.wasm /);
});

test("example evidence: supply 4, token aloof for the owner, and the sheet_anchor hash equals the anchor step's hash", async (t) => {
  const r = await dry(t, [], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT });
  assert.equal(r.code, 0, r.errs);
  const ev = JSON.parse(readFileSync(r.file, "utf8"));
  assert.equal(ev.network, "testnet");
  assert.equal(ev.mock, true);
  assert.match(ev.note, /^EXAMPLE ONLY\./);
  const view = (m) => ev.views.find((v) => v.method === m);
  assert.equal(view("nft_total_supply").result, "4");
  assert.equal(view("nft_token").args.token_id, "aloof");
  assert.equal(view("nft_token").result.owner_id, OWNER);
  assert.equal(view("sheet_anchor").result.sheet_hash, buildAnchorStep({ contract: CONTRACT, owner: OWNER }).sheetHash);
  assert.ok(ev.transactions.every((tx) => tx.explorer === `https://explorer.testnet.near.org/transactions/${tx.hash}`));
});

test("--out creates missing parent directories and the dry run names the file by role, not by path", async (t) => {
  const r = await dry(t, []);
  assert.equal(r.code, 0, r.errs);
  assert.ok(existsSync(r.file));
  assert.ok(r.text.endsWith("wrote example evidence (example: true) to the --out file"));
  assert.ok(!r.text.includes(r.dir));
  assert.equal(r.spawned.length, 0);
});

test("a dry run rejects an invalid account id with exit 2 and writes nothing", async (t) => {
  for (const env of [{ NEAR_ACCOUNT_ID: "NOT VALID!" }, { NEAR_CONTRACT_ACCOUNT_ID: "NOT VALID!" }]) {
    const r = await dry(t, [], env);
    assert.equal(r.code, 2, JSON.stringify(env));
    const name = Object.keys(env)[0];
    assert.match(r.errs, new RegExp(`^error: .*${name}.* \\(see --help\\)$`));
    assert.ok(!existsSync(r.file), "no example file after a usage error");
  }
});

test("--send gates: a missing or invalid contract account stops before any exec", async (t) => {
  const send = ["--send", "--i-approve", "--media-base", MEDIA];
  for (const [env, name] of [
    [{ NEAR_ACCOUNT_ID: OWNER }, "NEAR_CONTRACT_ACCOUNT_ID"],
    [{ NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: "NOT VALID!" }, "NEAR_CONTRACT_ACCOUNT_ID"],
    [{ NEAR_ACCOUNT_ID: "NOT VALID!", NEAR_CONTRACT_ACCOUNT_ID: CONTRACT }, "NEAR_ACCOUNT_ID"],
  ]) {
    const spawned = [];
    const errs = [];
    const outs = [];
    const code = await run(send, env, { out: (l) => outs.push(l), err: (l) => errs.push(l), exec: (...a) => { spawned.push(a); return { code: 0, output: "" }; } });
    assert.equal(code, 2, JSON.stringify(env));
    assert.equal(spawned.length, 0);
    assert.deepEqual(outs, [], "no 'send:' banner before the gates pass");
    assert.match(errs.join("\n"), new RegExp(`^error: .*${name}.* \\(see --help\\)$`));
  }
});

test("--out and --media-base reject a following flag as their value, with the offending value quoted", async () => {
  const run1 = async (argv) => {
    const errs = [];
    const code = await run(argv, {}, { out: () => {}, err: (l) => errs.push(l), exec: () => assert.fail("no spawn") });
    return { code, err: errs.join("\n") };
  };
  const out = await run1(["--out", "--force"]);
  assert.equal(out.code, 2);
  assert.equal(out.err, 'error: --out needs a file path, got "--force" (see --help)');
  const none = await run1(["--out"]);
  assert.equal(none.err, "error: --out needs a file path, got undefined (see --help)");
  const mb = await run1(["--media-base", "--send"]);
  assert.equal(mb.code, 2);
  assert.equal(mb.err, 'error: --media-base needs a value, got "--send" (see --help)');
  const unk = await run1(["--bogus"]);
  assert.equal(unk.err, "error: unknown argument: --bogus (see --help)");
});

test("process-level dry run: exit 0, no stderr, offline, example file written where --out says", (t) => {
  const dir = fresh(t);
  const out = path.join(dir, "ex.json");
  const env = { PATH: process.env.PATH, HOME: dir, NODE_OPTIONS: `--import ${NO_NETWORK}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--out", out], { encoding: "utf8", env, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).example, true);
  assert.deepEqual(readdirSync(dir), ["ex.json"], "nothing else is written next to it");
});
