// Behaviour tests for `npm run yield:demo` (scripts/yield-demo.mjs). Every run is a real
// child process with its cwd and --out in a temp dir outside the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadPoolFixture } from "../src/yield/pools.mjs";
import { checkProposal } from "../src/yield/rules.mjs";
import { quoteOut } from "../src/yield/pools.mjs";
import { GAS } from "../src/yield/send.mjs";
import { loadSnapshot, rulesView } from "../src/yield-optimizer/snapshot.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-demo.mjs", import.meta.url));
const SCENARIO = fileURLToPath(new URL("../src/yield-optimizer/fixtures/scenario.hand-built.json", import.meta.url));
const BASE_ENV = { PATH: process.env.PATH };
const STACK = /at .*\.mjs:\d+/;
const PROPOSAL_KEYS = ["pool_id", "token_in", "token_out", "amount_in", "min_amount_out"];

let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), "yield-demo-test-"));
});
after(() => rmSync(work, { recursive: true, force: true }));

function run(args, { env = BASE_ENV, cwd = work } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

describe("yield:demo default run", () => {
  let r;
  let dir;
  before(() => {
    dir = join(work, "default");
    r = run(["--out", dir]);
  });

  it("exits 0 with a one-screen summary before the details", () => {
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split("\n");
    const detailsAt = lines.indexOf("== details ==");
    assert.ok(detailsAt > 0 && detailsAt <= 25, `summary is ${detailsAt} lines`);
    const summary = lines.slice(0, detailsAt).join("\n");
    assert.match(lines[0], /^YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent$/);
    for (const id of ["aloof", "chaotic", "social", "skeptic", "yield-optimizer"]) {
      assert.match(summary, new RegExp(`^${id} +(pool \\d+: |HOLD)`, "m"));
      assert.ok(r.stdout.indexOf(`\n[${id}] `) > r.stdout.indexOf("== details =="), `${id} detail comes after the summary`);
    }
    assert.match(summary, /^1 unsigned execute_swap call planned, 0 signed, 0 sent$/m);
    assert.match(summary, /chaotic .* OK +vetoed$/m);
    // The stable pool 1 is ~1860x off its $1 peg: the three agents that picked it are refused, and the table says why.
    for (const [id, bps] of [["aloof", 18590000], ["social", 18590000], ["skeptic", 18490000]]) {
      assert.match(summary, new RegExp(`^${id} .* OK +refused: SOFT_OFF_REFERENCE \\+${bps} bps vs reference \\(limit 100\\)$`, "m"));
    }
    assert.match(r.stdout, /^ {2}reference: quote \+18590000 bps vs mock_usd_price reference \(limit 100 bps, stable pair: OFF REFERENCE\)$/m);
    assert.match(r.stdout, /^ {2}reference: no reference price \(rft has none\): the floor is a spot sanity floor$/m);
    // One market, one story: the planner is on the same Ref snapshot and swaps on the one pool that passes every gate.
    assert.match(lines[1], /^snapshot: one committed Ref testnet snapshot at block 276332963, not fetched, shared by the four agents and the optimizer \(vault vault\.yield-demo\.testnet\)$/);
    assert.doesNotMatch(summary, /Rhea|fixture\.testnet|snapshots:/);
    assert.match(summary, /^yield-optimizer {2}pool 747: 0\.05 usdc -> min 0\.050406 usdt {2}OK {11}execute$/m);
    assert.match(summary, /^ {2}optimizer swap on pool 747, 6 other pools not chosen:$/m);
    assert.match(summary, /^ {4}no mock reference price: pool 0 wrap -> rft$/m);
    assert.match(summary, /^ {4}off reference \(spot limit 1000 bps vs the mock reference price\): pool 1 nusdt -> nusdc spot \+\d+ bps$/m);
    assert.match(summary, /^ {4}refused by the vault rules, ERR_POOL_NOT_ALLOWED: pools 2, 5, 6, 8$/m);
    assert.match(summary, /^wrote .*plan\.json$/m);
    assert.equal(r.stderr, "");
    assert.doesNotMatch(r.stdout, STACK);
  });

  it("summary says why each vetoed agent does not execute, matching plan.json", () => {
    const summary = r.stdout.slice(0, r.stdout.indexOf("== details =="));
    const vetoed = readJson(join(dir, "plan.json")).agents.filter((a) => a.veto);
    assert.ok(vetoed.length >= 1, "the mock round has a veto");
    for (const a of vetoed) {
      assert.ok(summary.split("\n").includes(`  ${a.agent} vetoed by ${a.veto.by}: ${a.veto.reason}`), `${a.agent} veto line`);
    }
    assert.match(summary, /^ {2}chaotic vetoed by skeptic: size is 10000 bps of max_trade, above the 8000 bps audit line$/m);
  });

  it("plan.json carries the reference deviation and refuses every pool 1 proposal; index.html shows it", () => {
    const plan = readJson(join(dir, "plan.json"));
    const personalities = plan.agents.filter((a) => a.kind === "personality");
    const pool1 = personalities.filter((a) => a.proposal?.pool_id === 1);
    assert.deepEqual(pool1.map((a) => a.agent), ["aloof", "social", "skeptic"]);
    for (const a of pool1) {
      assert.equal(a.outcome, "refused", a.agent);
      assert.equal(a.call, null, a.agent);
      assert.deepEqual(a.strategy_check.violations.map((v) => v.code), ["SOFT_OFF_REFERENCE"], a.agent);
      assert.equal(a.reference.max_reference_deviation_bps, 100);
      assert.equal(a.reference.pair_kind, "stable");
      assert.ok(a.reference.reference_deviation_bps > 18_000_000, `${a.agent}: ${a.reference.reference_deviation_bps}`);
    }
    const chaotic = plan.agents.find((a) => a.agent === "chaotic");
    assert.deepEqual(chaotic.reference, { reference_deviation_bps: null, max_reference_deviation_bps: null, pair_kind: null, unpriced_token: "rft" });
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.ok(html.includes("quote +18590000 bps vs mock_usd_price reference (limit 100 bps, stable pair: OFF REFERENCE)"));
    assert.ok(html.includes("SOFT_OFF_REFERENCE: pool 1 quote is +18590000 bps off the reference price"));
  });

  it("writes exactly plan.json, calls.json and index.html", () => {
    assert.deepEqual(files(dir), ["calls.json", "index.html", "plan.json"]);
  });

  it("prints the three wrote lines in order and index.html is the dry-run page", () => {
    const wrote = r.stdout.split("\n").filter((l) => l.startsWith("wrote "));
    assert.equal(wrote.length, 3);
    assert.match(wrote[0], /plan\.json$/);
    assert.match(wrote[1], /calls\.json$/);
    assert.match(wrote[2], /index\.html$/);
    const html = readFileSync(join(dir, "index.html"), "utf8");
    assert.match(html, /<h1>Yield vault demo \(dry run\)<\/h1>/);
    assert.match(html, /DRY RUN: mock inference, committed fixtures, nothing was signed or sent\./);
    assert.doesNotMatch(html, /<script|https?:\/\//);
  });

  it("plan.json is a dry-run plan with five agents on one market", () => {
    const plan = readJson(join(dir, "plan.json"));
    assert.equal(plan.dry_run, true);
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
    assert.equal(plan.mode, "mock");
    assert.deepEqual(plan.agents.map((a) => a.agent), ["aloof", "chaotic", "social", "skeptic", "yield-optimizer"]);
    assert.equal("snapshots" in plan, false);
    assert.equal(plan.snapshot.fetched, false);
    assert.equal(plan.snapshot.shared_by_agents_and_planner, true);
    assert.equal(plan.snapshot.file, "src/yield/fixtures/ref-testnet-pools.json");
    assert.equal(plan.snapshot.block_height, 276332963);
    assert.equal(plan.planner_vault.vault_id, plan.personality_agents.vault_id);
    assert.equal(plan.planner_vault.runner_id, plan.personality_agents.runner_id);
    assert.equal(plan.planner_vault.same_as_agents, true);
    const by = Object.fromEntries(plan.agents.map((a) => [a.agent, a]));
    assert.equal(by.chaotic.outcome, "vetoed");
    assert.equal(by.chaotic.veto.by, "skeptic");
    const opt = by["yield-optimizer"];
    assert.equal(opt.decision, "swap");
    assert.equal(opt.outcome, "execute");
    assert.equal(opt.rule_check.ok, true);
    assert.deepEqual(opt.proposal, { pool_id: 747, token_in: "usdc.fakes.testnet", token_out: "usdt.fakes.testnet", amount_in: "50000", min_amount_out: "50406" });
    assert.equal(opt.reason, "best edge that passes every vault rule and the reference guard: pool 747");
    assert.deepEqual(opt.candidates.map((c) => [c.pool_id, c.status]), [[0, "no_reference_price"], [1, "off_reference"], [2, "refused"], [5, "refused"], [6, "refused"], [8, "refused"], [747, "ok"]]);
    assert.equal(opt.candidates[1].ref_deviation_bps > 1_000_000, true);
    assert.equal(opt.candidates[6].edge_bps > 25, true);
    assert.equal(plan.calls_planned, 1);
    assert.equal(plan.calls_signed, 0);
    assert.equal(plan.calls_sent, 0);
  });

  it("calls.json holds exactly the executable calls: the optimizer's one swap on pool 747, no personality agent", () => {
    const plan = readJson(join(dir, "plan.json"));
    const calls = readJson(join(dir, "calls.json"));
    assert.equal(calls.signed, false);
    assert.equal(calls.sent, false);
    const executing = plan.agents.filter((a) => a.outcome === "execute").map((a) => a.agent);
    assert.deepEqual(executing, ["yield-optimizer"]);
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0].agent, "yield-optimizer");
    assert.deepEqual(calls.calls[0].args.proposal, { pool_id: 747, token_in: "usdc.fakes.testnet", token_out: "usdt.fakes.testnet", amount_in: "50000", min_amount_out: "50406" });
    assert.deepEqual(plan.agents.find((a) => a.agent === "yield-optimizer").call, calls.calls[0]);
    for (const a of plan.agents.filter((x) => x.agent !== "yield-optimizer")) assert.equal(a.call, null, `${a.agent} (${a.outcome}) carries no call`);
  });

  it("the planner is on the same market: its quotes are the pools.mjs quotes of the Ref snapshot", () => {
    const plan = readJson(join(dir, "plan.json"));
    const opt = plan.agents.find((a) => a.agent === "yield-optimizer");
    const fixture = loadPoolFixture();
    for (const c of opt.candidates) {
      const pool = fixture.pools.find((p) => p.pool_id === c.proposal.pool_id);
      assert.ok(pool, `pool ${c.proposal.pool_id} is in the Ref snapshot`);
      assert.ok(quoteOut(pool, c.proposal.token_in, c.proposal.amount_in) >= BigInt(c.proposal.min_amount_out), `pool ${pool.pool_id} min_amount_out is under the shared quote`);
    }
  });

  it("summary shows the four on-chain rule rejections with the contract's own messages", () => {
    const vectors = readJson(fileURLToPath(new URL("../contracts/yield-vault/tests/rule-vectors.json", import.meta.url)));
    const expectOf = (name) => vectors.cases.find((c) => c.name === name).expect;
    const lines = r.stdout.split("\n");
    const summary = lines.slice(0, lines.indexOf("== details ==")).join("\n");
    assert.ok(summary.includes("on-chain rules, vectors from contracts/yield-vault/tests/rule-vectors.json (same message as the Rust check_rules):"));
    const names = ["ERR_MAX_TRADE: amount_in one above max_trade", "ERR_DAILY_CAP: spent plus amount_in one above the daily cap", "ERR_PRICE_FLOOR: pool 0 a->b one below the floor", "ERR_PAUSED: vault is paused"];
    const at = [];
    for (const n of names) {
      const msg = expectOf(n);
      const line = lines.find((l) => l.endsWith(`REJECTED ${msg}`));
      assert.ok(line, `no REJECTED line for ${msg}`);
      at.push(lines.indexOf(line));
    }
    assert.deepEqual(at, [...at].sort((a, b) => a - b), "scenario order");
    assert.match(summary, /\(spent today 1501\)/);
    assert.match(summary, /\(vault paused\)/);
    assert.match(summary, /^1 unsigned execute_swap call planned, 0 signed, 0 sent$/m);
  });

  it("plan.json records the rule scenarios and they add no calls", () => {
    const plan = readJson(join(dir, "plan.json"));
    assert.equal(plan.rule_rejections, 4);
    assert.equal(plan.calls_planned, 1); // the optimizer's swap; the four rule scenarios add none
    assert.deepEqual(plan.rule_scenarios.scenarios.map((s) => s.id), ["max_trade", "daily_cap", "price_floor", "paused"]);
    assert.ok(plan.rule_scenarios.scenarios.every((s) => s.outcome === "rejected" && s.matches_contract === true));
    assert.equal(readJson(join(dir, "calls.json")).calls.length, 1);
  });

  it("is byte-identical across runs", () => {
    const dir2 = join(work, "default2");
    const r2 = run(["--out", dir]);
    assert.equal(r2.stdout, r.stdout);
    const r3 = run(["--out", dir2]);
    assert.equal(readFileSync(join(dir2, "plan.json"), "utf8"), readFileSync(join(dir, "plan.json"), "utf8"));
    // Only the out-dir name differs. The demo may print it relative to a realpath'd cwd
    // (macOS /tmp is /private/tmp), so swap the directory name, not the absolute path.
    assert.match(r3.stdout, /^wrote \S*default2\/plan\.json$/m);
    assert.equal(r3.stdout.replaceAll("default2/", "default/"), r.stdout);
  });

  it("prints out-dir paths relative to cwd when inside it", () => {
    const rel = run(["--out", "rel-out"]);
    assert.equal(rel.code, 0);
    assert.match(rel.stdout, /^wrote rel-out\/plan\.json$/m);
    assert.deepEqual(files(join(work, "rel-out")), ["calls.json", "index.html", "plan.json"]);
  });
});

describe("yield:demo --calls and --json", () => {
  it("--calls prints only the unsigned calls and writes nothing", () => {
    const dir = join(work, "calls-out");
    const r = run(["--calls", "--out", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /== details ==|YIELD DEMO|vault rules/);
    const ref = readJson(join(work, "default", "calls.json"));
    for (const c of ref.calls) assert.ok(r.stdout.includes(`args: ${JSON.stringify(c.args)}`), c.agent);
    assert.equal((r.stdout.match(/^ {2}signed: false$/gm) ?? []).length, ref.calls.length);
    assert.equal((r.stdout.match(/^ {2}sent: false$/gm) ?? []).length, ref.calls.length);
    assert.equal(ref.calls.length, 1);
    assert.match(r.stdout, /^call 1 of 1 \(yield-optimizer\)$/m);
    assert.equal((r.stdout.match(/^ {2}method: execute_swap$/gm) ?? []).length, 1);
    assert.match(r.stdout, /^ {2}gas: 280\.0 Tgas$/m);
    assert.match(r.stdout, /"pool_id":747/);
    assert.equal(existsSync(dir), false);
    // On a market where nothing passes every gate (the hand-built scenario with a paused vault) --calls prints the one-line no-call message.
    const paused = join(work, "paused-scenario.json");
    const raw = readJson(SCENARIO);
    raw.vault.state.paused = true;
    writeFileSync(paused, JSON.stringify(raw));
    const none = run(["--calls", "--snapshot", paused, "--out", dir]);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, "no calls planned (DRY RUN: nothing signed, nothing sent)\n");
    assert.equal(existsSync(dir), false);
    assert.doesNotMatch(r.stdout, /index\.html/);
  });

  it("--json is the same content as plan.json and writes no index.html", () => {
    const dir = join(work, "json-out");
    const r = run(["--json", "--out", dir]);
    assert.equal(r.code, 0);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(join(work, "index.html")), false);
    assert.equal(r.stdout, readFileSync(join(work, "default", "plan.json"), "utf8"));
  });

  it("--help exits 0", () => {
    const r = run(["-h"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: node scripts\/yield-demo\.mjs/);
  });
});

describe("yield:demo stays offline and keyless", () => {
  it("ignores MOCK_INFERENCE=0 and a fake key: same output, one note on stderr", () => {
    const base = run(["--out", join(work, "env-a")]);
    const r = run(["--out", join(work, "env-a")], { env: { ...BASE_ENV, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "fake-key-for-test", NEAR_AI_MODEL: "x" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, base.stdout);
    assert.equal(r.stderr.trim(), "yield:demo: MOCK_INFERENCE=0 ignored: this demo is always offline mock");
    assert.ok(!r.stdout.includes("fake-key-for-test") && !r.stderr.includes("fake-key-for-test"));
  });

  it("runs with no HOME and an empty env", () => {
    const r = run(["--out", join(work, "env-b")], { env: {} });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 unsigned execute_swap call planned, 0 signed, 0 sent/);
  });

  it("refuses NEAR_NETWORK=mainnet and writes nothing", () => {
    const dir = join(work, "mainnet-out");
    const r = run(["--out", dir], { env: { ...BASE_ENV, NEAR_NETWORK: "mainnet" } });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /^yield:demo: refused: NEAR_NETWORK=mainnet/);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(dir), false);
    assert.doesNotMatch(r.stderr, STACK);
  });
});

describe("yield:demo bad input", () => {
  it("unknown flag and missing value exit 2", () => {
    for (const [args, msg] of [
      [["--bogus"], /^yield:demo: unknown argument "--bogus" \(see --help\)/],
      [["--out"], /^yield:demo: --out needs a value \(see --help\)/],
      [["--snapshot"], /^yield:demo: --snapshot needs a value/],
      [["--calls", "--json"], /^yield:demo: --calls and --json cannot be combined/],
    ]) {
      const r = run(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stderr, msg);
      assert.doesNotMatch(r.stderr, STACK);
      assert.equal(r.stdout, "");
    }
  });

  it("--out that is a file or unsafe exits 2 with a message", () => {
    const file = join(work, "a-file");
    writeFileSync(file, "x");
    const r = run(["--out", file]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^yield:demo: --out ".*a-file" exists and is not a directory/);
    assert.equal(readFileSync(file, "utf8"), "x");
    const home = run(["--out", "/"]);
    assert.equal(home.code, 2);
    assert.match(home.stderr, /^yield:demo: refusing --out/);
    for (const x of [r, home]) assert.doesNotMatch(x.stderr, STACK);
  });

  it("a bad --snapshot exits 1, names the file, and writes no files", () => {
    const missing = join(work, "nope.json");
    const notJson = join(work, "not-json.json");
    const invalid = join(work, "invalid.json");
    writeFileSync(notJson, "{ this is not json");
    writeFileSync(invalid, JSON.stringify({ hello: "world" }));
    for (const [file, problem] of [[missing, /cannot read snapshot/], [notJson, /not valid JSON/], [invalid, /./]]) {
      const dir = join(work, `snap-out-${file.split("/").pop()}`);
      const r = run(["--snapshot", file, "--out", dir]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, /^yield:demo: /);
      assert.ok(r.stderr.includes(file), `names ${file}: ${r.stderr}`);
      assert.match(r.stderr, problem);
      assert.match(r.stderr, /Nothing was written\./);
      assert.doesNotMatch(r.stderr, STACK);
      assert.equal(r.stdout, "");
      assert.equal(existsSync(dir), false);
    }
  });

  it("a valid --snapshot override is used and recorded: the planner swaps on the hand-built scenario", () => {
    const copy = join(work, "copy.json");
    writeFileSync(copy, readFileSync(SCENARIO));
    const dir = join(work, "snap-ok");
    const r = run(["--snapshot", copy, "--out", dir]);
    assert.equal(r.code, 0, r.stderr);
    const plan = readJson(join(dir, "plan.json"));
    assert.equal(plan.snapshot.file, copy);
    assert.equal(plan.snapshot.shared_by_agents_and_planner, false);
    assert.equal(plan.planner_vault.vault_id, "yield-vault.fixture.testnet");
    assert.equal(plan.planner_vault.same_as_agents, false);
    const opt = plan.agents.find((a) => a.agent === "yield-optimizer");
    assert.equal(opt.decision, "swap");
    assert.equal(opt.call.gas, GAS);
    assert.equal(plan.calls_planned, 1);
    // The one call is the optimizer's, built like any other and passing the scenario vault's rules when re-checked.
    const calls = readJson(join(dir, "calls.json"));
    assert.equal(calls.calls.length, 1);
    const [c] = calls.calls;
    assert.equal(c.agent, "yield-optimizer");
    assert.equal(c.method_name, "execute_swap");
    assert.equal(c.signed, false);
    assert.equal(c.sent, false);
    assert.equal(c.gas, GAS);
    assert.equal(c.receiver_id, "yield-vault.fixture.testnet");
    assert.deepEqual(Object.keys(c.args.proposal), PROPOSAL_KEYS);
    assert.match(c.command, /^near contract call-function as-transaction /);
    const view = rulesView(loadSnapshot(copy));
    const check = checkProposal(c.args.proposal, view.config, view.state, c.signer_id, view.nowMs);
    assert.equal(check.ok, true, check.reason);
    assert.match(r.stdout, /^snapshot: .*copy\.json \(--snapshot: the planner uses this market and vault, the four agents still use src\/yield\/fixtures\/ref-testnet-pools\.json\)$/m);
  });

  it("the old Rhea-style snapshot shape (token_account_ids, price_usd) is rejected with the bad field named", () => {
    const old = join(work, "old-shape.json");
    const raw = readJson(SCENARIO);
    raw.pools[0] = { pool_id: 17, pool_kind: "SIMPLE_POOL", token_account_ids: ["a", "b"], amounts: ["1", "1"], total_fee: 30 };
    writeFileSync(old, JSON.stringify(raw));
    const r = run(["--snapshot", old, "--out", join(work, "old-out")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pools\[0\]\.token_a must be a non-empty string/);
  });
});

describe("yield:demo refuses a mainnet snapshot", () => {
  it("a .near vault_id exits 1, names .near and testnet, and prints no call-function", () => {
    const raw = readJson(SCENARIO);
    raw.vault.vault_id = "yield-vault.near";
    const f = join(work, "mainnet-snapshot.json");
    writeFileSync(f, JSON.stringify(raw));
    const r = run(["--calls", "--snapshot", f, "--out", join(work, "mainnet-out")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.near/);
    assert.match(r.stderr, /testnet/);
    assert.doesNotMatch(r.stdout, /call-function/);
  });
});
