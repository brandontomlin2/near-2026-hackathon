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
import { PLACEHOLDER_RUNNER, defaultVaultConfig } from "../src/yield/strategies.mjs";
import { createLedger } from "../src/yield/ledger.mjs";
import { MOCK_EPOCH_MS } from "../src/yield/mock.mjs";
import { parseSnapshot, rulesView } from "../src/yield-optimizer/snapshot.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-demo.mjs", import.meta.url));
const RHEA = fileURLToPath(new URL("../src/yield-optimizer/fixtures/rhea-testnet-snapshot.json", import.meta.url));
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
      assert.match(summary, new RegExp(`^${id} +pool \\d+: `, "m"));
      assert.ok(r.stdout.indexOf(`\n[${id}] `) > r.stdout.indexOf("== details =="), `${id} detail comes after the summary`);
    }
    assert.match(summary, /^4 unsigned execute_swap calls planned, 0 signed, 0 sent$/m);
    assert.match(summary, /chaotic .* OK +vetoed$/m);
    assert.match(summary, /REFUSED ERR_NO_LIMIT: no limit for dai\.fixture\.testnet/);
    assert.match(summary, /REFUSED ERR_POOL_NOT_ALLOWED: pool 99/);
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

  it("writes exactly plan.json and calls.json", () => {
    assert.deepEqual(files(dir), ["calls.json", "plan.json"]);
  });

  it("plan.json is a dry-run plan with five agents", () => {
    const plan = readJson(join(dir, "plan.json"));
    assert.equal(plan.dry_run, true);
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
    assert.equal(plan.mode, "mock");
    assert.deepEqual(plan.agents.map((a) => a.agent), ["aloof", "chaotic", "social", "skeptic", "yield-optimizer"]);
    assert.equal(plan.snapshots.ref_pools.fetched, false);
    assert.equal(plan.snapshots.rhea.fetched, false);
    const by = Object.fromEntries(plan.agents.map((a) => [a.agent, a]));
    assert.equal(by.chaotic.outcome, "vetoed");
    assert.equal(by.chaotic.veto.by, "skeptic");
    const refused = by["yield-optimizer"].candidates.filter((c) => c.status === "refused").map((c) => c.rule_check.reason);
    assert.deepEqual(refused, ["ERR_NO_LIMIT: no limit for dai.fixture.testnet", "ERR_POOL_NOT_ALLOWED: pool 99"]);
    assert.equal(plan.calls_planned, 4);
    assert.equal(plan.calls_signed, 0);
    assert.equal(plan.calls_sent, 0);
  });

  it("calls.json holds exactly the executable calls, each passing the vault rules when re-checked", () => {
    const plan = readJson(join(dir, "plan.json"));
    const calls = readJson(join(dir, "calls.json"));
    assert.equal(calls.signed, false);
    assert.equal(calls.sent, false);
    const executing = plan.agents.filter((a) => a.outcome === "execute").map((a) => a.agent);
    assert.deepEqual(calls.calls.map((c) => c.agent), executing);
    assert.equal(calls.calls.length, 4);

    const fixture = loadPoolFixture();
    const { states } = createLedger({ fixture });
    const rhea = parseSnapshot(readJson(RHEA));
    const view = rulesView(rhea);
    for (const c of calls.calls) {
      assert.equal(c.method_name, "execute_swap");
      assert.equal(c.signed, false);
      assert.equal(c.sent, false);
      assert.deepEqual(Object.keys(c.args), ["proposal"]);
      assert.deepEqual(Object.keys(c.args.proposal), PROPOSAL_KEYS);
      assert.equal(typeof c.args.proposal.amount_in, "string");
      assert.match(c.args.proposal.amount_in, /^[0-9]+$/);
      assert.match(c.args.proposal.min_amount_out, /^[0-9]+$/);
      const check =
        c.agent === "yield-optimizer"
          ? checkProposal(c.args.proposal, view.config, view.state, rhea.runner_id, view.nowMs)
          : checkProposal(c.args.proposal, defaultVaultConfig(c.agent, { runner: PLACEHOLDER_RUNNER }), states[c.agent], PLACEHOLDER_RUNNER, MOCK_EPOCH_MS);
      assert.equal(check.ok, true, `${c.agent}: ${check.reason}`);
      if (c.agent !== "yield-optimizer") assert.match(c.command, /^near contract call-function as-transaction /);
    }
    const planner = calls.calls.find((c) => c.agent === "yield-optimizer");
    assert.equal(planner.gas, "280.0 Tgas");
    assert.equal(planner.receiver_id, "yield-vault.fixture.testnet");
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
    assert.deepEqual(files(join(work, "rel-out")), ["calls.json", "plan.json"]);
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
    assert.equal((r.stdout.match(/^ {2}signed: false$/gm) ?? []).length, 4);
    assert.equal((r.stdout.match(/^ {2}sent: false$/gm) ?? []).length, 4);
    assert.match(r.stdout, /^ {2}method: execute_swap$/m);
    assert.equal(existsSync(dir), false);
  });

  it("--json is the same content as plan.json", () => {
    const r = run(["--json"]);
    assert.equal(r.code, 0);
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
    assert.match(r.stdout, /4 unsigned execute_swap calls planned, 0 signed, 0 sent/);
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

  it("a valid --snapshot override is used and recorded", () => {
    const copy = join(work, "copy.json");
    writeFileSync(copy, readFileSync(RHEA));
    const dir = join(work, "snap-ok");
    const r = run(["--snapshot", copy, "--out", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readJson(join(dir, "plan.json")).snapshots.rhea.file, copy);
  });
});
