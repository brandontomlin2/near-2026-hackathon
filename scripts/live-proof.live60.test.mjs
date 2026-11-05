// `--dry-run` is the one documented command that prints the whole live testnet plan.
// Everything here is offline: exec is injected as a function that fails the test if called.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareAnchor } from "../src/anchor/anchor.mjs";
import { run, totalDeposit } from "./live-proof.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "live-proof.mjs");
const dirs = [];
const freshOut = () => {
  const d = mkdtempSync(path.join(tmpdir(), "live60-"));
  dirs.push(d);
  return path.join(d, "e.json");
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const noExec = () => { throw new Error("exec must not be called in a dry run"); };
const ENV = { NEAR_ACCOUNT_ID: "owner-x.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft-x.testnet" };

async function dry(argv, env = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l), exec: noExec });
  return { code, text: out.join("\n"), err: err.join("\n") };
}

describe("live-proof --dry-run (live60)", () => {
  it("exits 0 and prints the 6 steps in order with the right methods", async () => {
    const r = await dry(["--dry-run", "--out", freshOut()], ENV);
    assert.equal(r.code, 0, r.err);
    const heads = [...r.text.matchAll(/^\[(\d)\/6\] (.+)$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(heads, [["1", "deploy"], ["2", "mint aloof"], ["3", "mint chaotic"], ["4", "mint social"], ["5", "mint skeptic"], ["6", "anchor_sheet"]]);
    const methods = [...r.text.matchAll(/^ {2}call {5}(\S+)$/gm)].map((m) => m[1].split(".").pop());
    assert.deepEqual(methods, ["new_default_meta", "nft_mint", "nft_mint", "nft_mint", "nft_mint", "anchor_sheet"]);
  });

  it("names the configured contract and owner and prints no placeholders", async () => {
    const r = await dry(["--dry-run", "--out", freshOut()], ENV);
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /summary: contract nft-x\.testnet {2}owner owner-x\.testnet /);
    assert.ok(r.text.includes("nft-x.testnet.nft_mint"));
    assert.ok(!r.text.includes("<NEAR_"), "no account placeholders");
  });

  it("lists the four agents and the deposits, total 0.21 NEAR", async () => {
    const r = await dry(["--dry-run", "--out", freshOut()], ENV);
    assert.match(r.text, /agents aloof, chaotic, social, skeptic {2}total deposit 0\.21 NEAR/);
    const deposits = [...r.text.matchAll(/^ {2}deposit {2}(\S+ NEAR)/gm)].map((m) => m[1]);
    assert.deepEqual(deposits, ["0 NEAR", "0.05 NEAR", "0.05 NEAR", "0.05 NEAR", "0.05 NEAR", "0.01 NEAR"]);
  });

  it("anchor sheet_hash equals prepareAnchor's for the same inputs", async () => {
    const sheet = "Aloof. Observer. Watches the channel, speaks rarely.\nAllies: none yet.\n";
    const expected = prepareAnchor({ contractId: "nft-x.testnet", tokenId: "aloof", sheet, network: "testnet" }).sheetHash;
    assert.match(expected, /^[0-9a-f]{64}$/);
    const r = await dry(["--dry-run", "--out", freshOut()], ENV);
    assert.ok(r.text.includes(`summary: anchor sheet_hash ${expected}`));
    assert.ok(r.text.includes(`"sheet_hash":"${expected}"`));
  });

  it("is byte-stable across two runs", async () => {
    const a = await dry(["--dry-run", "--out", freshOut()], ENV);
    const b = await dry(["--dry-run", "--out", freshOut()], ENV);
    assert.equal(a.text, b.text);
  });

  it("with no account env still runs, using labelled placeholders", async () => {
    const r = await dry(["--dry-run", "--out", freshOut()], {});
    assert.equal(r.code, 0, r.err);
    assert.match(r.text, /summary: contract <NEAR_CONTRACT_ACCOUNT_ID> {2}owner <NEAR_ACCOUNT_ID> /);
  });

  it("--dry-run --send exits 2 and never calls exec", async () => {
    for (const argv of [["--dry-run", "--send", "--i-approve", "--media-base", "https://m.example/"], ["--send", "--dry-run"]]) {
      const r = await dry(argv, ENV);
      assert.equal(r.code, 2);
      assert.match(r.err, /--dry-run and --send/);
      assert.equal(r.text, "");
    }
  });

  it("writes the example evidence file only to --out", async () => {
    const out = freshOut();
    const r = await dry(["--dry-run", "--out", out], ENV);
    assert.equal(r.code, 0, r.err);
    const ev = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(ev.example, true);
    assert.equal(ev.contract, "nft-x.testnet");
  });

  it("works as a real process: exit 0, nothing but the plan", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--out", freshOut()], { env: { ...process.env, ...ENV, NEAR_NETWORK: "" }, encoding: "utf8", timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /total deposit 0\.21 NEAR/);
  });

  it("package.json has live:dry-run matching the command", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.scripts["live:dry-run"], "node scripts/live-proof.mjs --dry-run");
  });

  it("totalDeposit adds exactly, with no float drift", () => {
    const steps = (...d) => d.map((deposit) => ({ name: "x", deposit }));
    assert.equal(totalDeposit(steps("0.1 NEAR", "0.2 NEAR")), "0.3 NEAR");
    assert.equal(totalDeposit(steps("0 NEAR")), "0 NEAR");
    assert.equal(totalDeposit(steps("1 NEAR", "0.000000000000000000000001 NEAR")), "1.000000000000000000000001 NEAR");
    assert.throws(() => totalDeposit(steps("lots")), /unreadable deposit/);
  });
});
