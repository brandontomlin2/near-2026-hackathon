// Pins the README's "Try to break the live vault" subsection in "Live on testnet".
// No network by default: the four curl commands are only parsed, never run. The decoder and encoder
// one-liners are extracted from the README and run on the real RPC replies recorded on 2026-11-10 in
// scripts/fixtures/break-the-vault/ (raw bodies, unmodified; control_ok is the unchanged base trade).
// Optional live mode: README_BREAK_THE_VAULT_LIVE=1 also runs each README sh block via `sh -c` and
// compares stdout with the quoted text block (needs curl, Node and the network; read-only view calls).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const fixture = (name) => readFileSync(join(root, "scripts/fixtures/break-the-vault", `${name}.response.json`), "utf8");

const live = readme.split("\n## Live on testnet\n")[1].split(/\n## /)[0];
const verifyAt = live.search(/^### Verify it yourself with curl/m);
const breakAt = live.search(/^### Try to break the live vault/m);
const sub = live.slice(breakAt).replace(/^### Try to break the live vault[^\n]*\n/, "").split(/^### /m)[0];
const blocks = (text, lang) => [...text.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map((m) => m[1]);
const steps = sub.split(/^(?=\d\. )/m).slice(1); // [0] is the intro

const VAULT = "vault.near-2026-hackathon.testnet";
const RUNNER = "runner.near-2026-hackathon.testnet";
const base = {
  proposal: { pool_id: 0, token_in: "wrap.testnet", token_out: "rft.tokenfactory.testnet", amount_in: "10000000000000000000000", min_amount_out: "90000000" },
  runner_id: RUNNER,
};
const withProposal = (change) => ({ ...base, proposal: { ...base.proposal, ...change } });
const cases = [
  { code: "ERR_NOT_RUNNER", fixture: "not_runner", args: { ...base, runner_id: "stranger.testnet" },
    reason: "ERR_NOT_RUNNER: stranger.testnet is not an approved runner" },
  { code: "ERR_POOL_NOT_ALLOWED", fixture: "pool_not_allowed", args: withProposal({ pool_id: 5 }),
    reason: "ERR_POOL_NOT_ALLOWED: pool 5" },
  { code: "ERR_PRICE_FLOOR", fixture: "price_floor", args: withProposal({ min_amount_out: "1" }),
    reason: "ERR_PRICE_FLOOR: min_amount_out 1 below floor 1770923779569/374136952131431998480120321 of amount_in 10000000000000000000000" },
  { code: "ERR_MAX_TRADE", fixture: "max_trade", args: withProposal({ amount_in: "11000000000000000000000000", min_amount_out: "100000000000" }),
    reason: "ERR_MAX_TRADE: 11000000000000000000000000 exceeds max_trade 10000000000000000000000000" },
].map((c, i) => ({ ...c, step: steps[i], cmd: blocks(sub, "sh")[i], quoted: blocks(sub, "text")[i] }));

const body = (cmd) => JSON.parse(/ -d '([^']*)'/.exec(cmd)[1]);
const decoder = (cmd) => /\| node -e '([^']*)'/.exec(cmd)?.[1];
const decode = (cmd, input) => spawnSync(process.execPath, ["-e", decoder(cmd)], { input, encoding: "utf8" });

test("the subsection is in 'Live on testnet' after the verify step, read-only, no judge markers, names its test and fixtures", () => {
  assert.ok(verifyAt >= 0 && breakAt > verifyAt, "### Try to break the live vault comes after ### Verify it yourself with curl");
  assert.match(sub, /They are read-only and sign nothing: no account or key is used, and nothing is sent\./);
  assert.match(sub, /They need only `curl` and Node\./);
  assert.doesNotMatch(sub, /judge:(run|expect)/, "unit tests must not need the network, so no judge markers");
  assert.ok(sub.includes("`scripts/readme-break-the-vault.test.mjs`"));
  assert.ok(sub.includes("`scripts/fixtures/break-the-vault/`"));
  assert.equal(blocks(sub, "sh").length, 4, "exactly four sh blocks");
  assert.equal(blocks(sub, "text").length, 4, "exactly four text blocks");
  assert.equal(steps.length, 4, "four numbered steps");
});

test("each command: FASTNEAR endpoint only, call_function check_proposal on the vault at final finality, canonical args_base64", () => {
  for (const c of cases) {
    assert.equal(/^curl -s (\S+) /.exec(c.cmd)?.[1], "https://test.rpc.fastnear.com", c.code);
    const hosts = new Set([...c.cmd.matchAll(/https?:\/\/([^/\s'"]+)/g)].map((m) => m[1]));
    assert.deepEqual([...hosts], ["test.rpc.fastnear.com"], c.code);
    assert.doesNotMatch(c.cmd, /broadcast_tx|send_tx|sign|near contract|--send/i, c.code);
    const b = body(c.cmd);
    assert.equal(b.jsonrpc, "2.0");
    assert.equal(b.method, "query");
    const { args_base64 } = b.params;
    assert.deepEqual(b.params, {
      request_type: "call_function", finality: "final", account_id: VAULT, method_name: "check_proposal", args_base64,
    });
    assert.deepEqual(JSON.parse(Buffer.from(args_base64, "base64").toString()), c.args, c.code);
    assert.equal(args_base64, Buffer.from(JSON.stringify(c.args)).toString("base64"), `${c.code}: canonical base64`);
  }
});

test("the vault id equals the 'Live on testnet' table, and the runner equals the one in the verify step's tx query", () => {
  const rows = live.split("\n").filter((l) => /^\|/.test(l)).slice(2).map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  assert.ok(rows.find((r) => r[0].startsWith("Vault contract id"))[1].includes(`\`${VAULT}\``));
  const verify = live.slice(verifyAt, breakAt);
  const txRunner = JSON.parse(/ -d '([^']*"method":"tx"[^']*)'/.exec(verify)[1]).params.sender_account_id;
  assert.equal(txRunner, RUNNER);
  for (const c of cases.slice(1)) assert.equal(JSON.parse(Buffer.from(body(c.cmd).params.args_base64, "base64")).runner_id, txRunner);
});

test("each documented decoder prints exactly the quoted text block from the recorded reply: ok false and the pinned reason", () => {
  for (const c of cases) {
    const r = decode(c.cmd, fixture(c.fixture));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), c.quoted.trim(), c.code);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.reason.startsWith(`${c.code}: `), c.code);
    assert.equal(out.reason, c.reason);
  }
});

test("the prose names each error code in backticks in its numbered step", () => {
  for (const c of cases) {
    const prose = c.step.split("```")[0];
    assert.ok(prose.includes(`\`${c.code}\``), `${c.code} named in its own step`);
    for (const other of cases.filter((o) => o !== c)) assert.ok(!prose.includes(other.code), `${c.code} step does not name ${other.code}`);
  }
  assert.ok(cases[3].step.split("```")[0].includes("`max_trade` for `wrap.testnet` is 10 wNEAR"));
});

test("the control fixture decodes to {\"ok\":true,\"reason\":\"\"}, quoted by the README, for the unchanged base trade", () => {
  const r = decode(cases[0].cmd, fixture("control_ok"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '{"ok":true,"reason":""}');
  const control = /^Control: [^\n]*/m.exec(sub)?.[0] ?? "";
  assert.ok(control.includes('the base trade unchanged, from the real runner, returned `{"ok":true,"reason":""}`'));
  assert.equal(cases[1].args.runner_id, base.runner_id);
  assert.deepEqual({ ...cases[1].args, proposal: { ...cases[1].args.proposal, pool_id: 0 } }, base, "base trade is call 2 with pool_id restored");
});

test("the documented encoder one-liner prints the args_base64 used in each command", () => {
  const snippet = /`node -e '([^']*)' '<json>'`/.exec(sub)?.[1];
  assert.ok(snippet, "the Control paragraph documents node -e '<snippet>' '<json>'");
  for (const c of cases) {
    const r = spawnSync(process.execPath, ["-e", snippet, JSON.stringify(c.args)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), body(c.cmd).params.args_base64, c.code);
  }
});

test("the fixtures hold nothing key-shaped and are raw successful view replies", () => {
  for (const name of ["not_runner", "pool_not_allowed", "price_floor", "max_trade", "control_ok"]) {
    assert.doesNotMatch(fixture(name), /ed25519:|secp256k1:|PRIVATE KEY/, name);
    const j = JSON.parse(fixture(name));
    assert.equal("error" in j, false, name);
    assert.ok(Array.isArray(j.result.result) && j.result.result.every(Number.isInteger), name);
  }
});

// Registered only when README_BREAK_THE_VAULT_LIVE=1 (default runs have no skipped test).
if (process.env.README_BREAK_THE_VAULT_LIVE === "1") {
  test("live: each README sh block, run as written, prints exactly its quoted text block", { timeout: 120000 }, () => {
    for (const c of cases) {
      const r = spawnSync("sh", ["-c", c.cmd], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), c.quoted.trim(), c.code);
    }
  });
}
