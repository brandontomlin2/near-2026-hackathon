// Pins the README's "Verify it yourself with curl" step in "Live on testnet".
// No network: the two curl commands are only parsed, never run. The decoder one-liner and the
// grep pattern are extracted from the README and run on recorded responses in
// scripts/fixtures/live-verify/ (get_state.response.json is the real RPC response from
// 2026-11-09; tx.response.json is trimmed from the real tx response, see its _note).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(root, "README.md"), "utf8");
const fixture = (name) => readFileSync(join(root, "scripts/fixtures/live-verify", name), "utf8");

const live = readme.split("\n## Live on testnet\n")[1].split(/\n## /)[0];
const verify = live.match(/^### Verify it yourself with curl[^\n]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1] ?? "";
const blocks = (lang) => [...verify.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```", "g"))].map((m) => m[1]);
const [stateCmd, txCmd] = blocks("sh");
const [stateQuoted, txQuoted] = blocks("text");

const VAULT = "vault.near-2026-hackathon.testnet";
const RUNNER = "runner.near-2026-hackathon.testnet";
const SWAP_TX = "B4oDeCFzeEpDaKMJe6F5rDh5F2ie2qdTKTm7YQVg24Em";

const endpoint = (cmd) => /^curl -s (\S+) /.exec(cmd)?.[1];
const body = (cmd) => JSON.parse(/ -d '([^']*)'/.exec(cmd)[1]);

test("the verify step is in 'Live on testnet', read-only, needs only curl and Node, and has no judge markers", () => {
  assert.ok(verify, "### Verify it yourself with curl subsection exists under ## Live on testnet");
  assert.match(verify, /read-only JSON-RPC queries/);
  assert.match(verify, /nothing is signed or sent, and no account or key is used/);
  assert.match(verify, /only `curl` and Node/);
  assert.equal(blocks("sh").length, 2, "exactly two sh blocks: the state query and the tx query");
  assert.doesNotMatch(verify, /judge:(run|expect)/, "unit tests must not need the network, so no judge markers");
  assert.match(live, /Check it yourself: `near contract call-function/, "the near-cli-rs sentence stays as the alternative");
});

test("state query: FASTNEAR endpoint, call_function get_state on the vault, final finality, empty args", () => {
  assert.equal(endpoint(stateCmd), "https://test.rpc.fastnear.com");
  const b = body(stateCmd);
  assert.equal(b.jsonrpc, "2.0");
  assert.equal(b.method, "query");
  assert.deepEqual(b.params, {
    request_type: "call_function",
    finality: "final",
    account_id: VAULT,
    method_name: "get_state",
    args_base64: b.params.args_base64,
  });
  assert.equal(Buffer.from(b.params.args_base64, "base64").toString(), "{}");
});

test("tx query: archival endpoint, tx method for the live swap, signed by the runner, waits for FINAL", () => {
  assert.equal(endpoint(txCmd), "https://archival-rpc.testnet.near.org");
  const b = body(txCmd);
  assert.equal(b.jsonrpc, "2.0");
  assert.equal(b.method, "tx");
  assert.deepEqual(b.params, { tx_hash: SWAP_TX, sender_account_id: RUNNER, wait_until: "FINAL" });
});

test("the commands only reach the two documented hosts and never sign or send", () => {
  const hosts = new Set([...`${stateCmd}\n${txCmd}`.matchAll(/https?:\/\/([^/\s'"]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts].sort(), ["archival-rpc.testnet.near.org", "test.rpc.fastnear.com"]);
  for (const cmd of [stateCmd, txCmd]) {
    assert.doesNotMatch(cmd, /broadcast_tx|send_tx|sign|near contract|--send/i);
    assert.ok(["query", "tx"].includes(body(cmd).method));
  }
});

test("the tx hash and vault id in the curl step equal the ones in the 'Live on testnet' table", () => {
  const rows = live.split("\n").filter((l) => /^\|/.test(l)).slice(2).map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  const cell = (name) => rows.find((r) => r[0].startsWith(name))[1];
  assert.ok(cell("Vault contract id").includes(`\`${body(stateCmd).params.account_id}\``));
  assert.ok(cell("Rhea/Ref").includes(`[${body(txCmd).params.tx_hash}](`));
  assert.ok(body(txCmd).params.sender_account_id.endsWith(".near-2026-hackathon.testnet"));
  assert.ok(cell("Explorer links").includes(`/transactions/${body(txCmd).params.tx_hash})`));
});

test("the documented node decoder prints the vault state from the recorded RPC response, with the fragments the README names", () => {
  const snippet = /\| node -e '([^']*)'/.exec(stateCmd)?.[1];
  assert.ok(snippet, "the state command pipes into node -e '<snippet>'");
  const r = spawnSync(process.execPath, ["-e", snippet], { input: fixture("get_state.response.json"), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const printed = r.stdout.trim();
  assert.equal(printed, stateQuoted.trim(), "the output the README quotes is what the decoder prints");
  const state = JSON.parse(printed);
  assert.equal(state.swaps_executed, 1);
  const named = [...verify.matchAll(/Look for ([^\n]*?)\. The vault's/g)][0]?.[1] ?? "";
  const fragments = [...named.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual(fragments, ['"swaps_executed":1', '"swap_in_flight":false', '"stranded_on_ref":[]']);
  for (const f of fragments) assert.ok(printed.includes(f), `decoded state contains ${f}`);
  assert.ok(verify.includes('`"balances":[["rft.tokenfactory.testnet","94246798"],...`'), "README names the rft balance fragment");
  assert.ok(printed.includes('"balances":[["rft.tokenfactory.testnet","94246798"],'));
});

test("the documented grep pattern prints exactly the swap_executed line the README quotes", () => {
  const pattern = /\| grep -o '([^']*)'/.exec(txCmd)?.[1];
  assert.equal(pattern, "swap_executed[^]]*");
  const recorded = JSON.parse(fixture("tx.response.json"));
  assert.match(recorded._note, /Trimmed from the real response/);
  delete recorded._note; // the note itself says "swap_executed"; a live reply has no such field
  const reply = JSON.stringify(recorded); // compact, as the RPC sends it
  const r = spawnSync("grep", ["-o", pattern], { input: reply, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), txQuoted.trim());
  // What the README says the full response shows is in the recorded reply.
  const res = recorded.result;
  assert.equal(res.final_execution_status, "FINAL");
  assert.equal(res.transaction.signer_id, RUNNER);
  assert.equal(res.transaction.receiver_id, VAULT);
  assert.equal(res.transaction.hash, SWAP_TX);
  assert.equal(res.transaction.actions[0].FunctionCall.method_name, "execute_swap");
  assert.equal(Buffer.from(res.status.SuccessValue, "base64").toString(), '"94246798"');
  assert.deepEqual(res.status, JSON.parse('{"SuccessValue":"Ijk0MjQ2Nzk4Ig=="}'));
  assert.ok(verify.includes('{"SuccessValue":"Ijk0MjQ2Nzk4Ig=="}'));
  assert.ok(txQuoted.includes('\\"amount_out\\":\\"94246798\\"'));
});

test("the fixtures hold nothing key-shaped", () => {
  for (const name of ["get_state.response.json", "tx.response.json"]) {
    assert.doesNotMatch(fixture(name), /ed25519:|secp256k1:|PRIVATE KEY/, name);
  }
  assert.equal("public_key" in JSON.parse(fixture("tx.response.json")).result.transaction, false);
});
