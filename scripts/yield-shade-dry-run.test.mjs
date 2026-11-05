// Behaviour tests for `npm run yield:shade:dry-run`. Every run is a real child process, cwd in a temp dir outside the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runDemo } from "../src/yield/demo.mjs";
import { loadSnapshot } from "../src/yield-optimizer/snapshot.mjs";
import { DEFAULT_SNAPSHOT } from "./yield-optimizer.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-shade-dry-run.mjs", import.meta.url));
const PKG = fileURLToPath(new URL("../package.json", import.meta.url));
const BASE_ENV = { PATH: process.env.PATH };
const EVIDENCE_KEY = "ed25519:4FLkw3i5QV11843yboCvBJ4jdSg3ijyLUxzhN47RRdDM";

let work;
before(() => {
  work = mkdtempSync(join(tmpdir(), "yield-shade-dry-run-test-"));
});
after(() => rmSync(work, { recursive: true, force: true }));

function run(args, { env = BASE_ENV } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("yield:shade:dry-run default output", () => {
  const r = {};
  before(() => Object.assign(r, run([])));
  it("exits 0 and ends with the dry_run/signed/sent line", () => {
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^dry_run: true, signed: false, sent: false$/m);
    assert.match(r.stdout.split("\n")[0], /DRY RUN/);
  });
  it("shows each section and points at the plan doc", () => {
    for (const s of ["docs/yield-shade-agent-plan.md", "== derivation", "1 (ed25519)", "add_runner", "AddKey",
      "execute_swap tx", "v1.signer-prod.testnet", "request_signature (UNCONFIRMED)", "revoke_runner", "revoke_all_runners"]) {
      assert.ok(r.stdout.includes(s), s);
    }
  });
});

describe("yield:shade:dry-run --json", () => {
  let plan;
  let demoFirst;
  before(async () => {
    plan = JSON.parse(run(["--json"]).stdout);
    demoFirst = (await runDemo({ rhea: loadSnapshot(DEFAULT_SNAPSHOT), rheaSource: "x" })).calls.calls[0];
  });
  it("is dry run, unsigned, unsent", () => {
    assert.equal(plan.dry_run, true);
    assert.equal(plan.signed, false);
    assert.equal(plan.sent, false);
  });
  it("mpc sign targets the testnet signer with the tx hash; execute_swap has 300 Tgas and 0 deposit", () => {
    assert.equal(plan.mpc.mpcSign.receiverId, "v1.signer-prod.testnet");
    assert.equal(plan.mpc.mpcSign.args.request.payload_v2.Eddsa, plan.execute_swap.txHashHex);
    assert.equal(plan.execute_swap.actions[0].gas, "300000000000000");
    assert.equal(plan.execute_swap.actions[0].deposit, "0");
  });
  it("the proposal is the first rule-checked yield:demo call, with its source recorded", () => {
    assert.deepEqual(plan.execute_swap.actions[0].args.proposal, demoFirst.args.proposal);
    assert.deepEqual(plan.proposal_source, { from: "npm run yield:demo", agent: demoFirst.agent, rule_check: "ok" });
  });
  it("derives the evidence-backed key for yield-agent.testnet / yield-vault-1", () => {
    const p = JSON.parse(run(["--json", "--agent-contract", "yield-agent.testnet", "--path", "yield-vault-1"]).stdout);
    assert.equal(p.derivation.derived_key, EVIDENCE_KEY);
    assert.equal(p.derivation.predecessor, "yield-agent.testnet");
  });
  it("prints only the JSON", () => {
    const out = run(["--json"]).stdout;
    assert.equal(out, `${JSON.stringify(plan, null, 2)}\n`);
  });
});

describe("yield:shade:dry-run refusals and usage", () => {
  for (const args of [["--sign"], ["--send"], ["--broadcast"], ["--i-approve"], ["--mainnet"], ["--network", "mainnet"],
    ["--agent-contract", "agent.near"], ["--json", "--sign"]]) {
    it(`refuses ${args.join(" ")} with exit 1 and no payload`, () => {
      const r = run(args);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /refused/);
    });
  }
  it("refuses --network=mainnet and --mainnet=1 with exit 1 and empty stdout", () => {
    for (const a of ["--network=mainnet", "--mainnet=1", "--agent-contract=agent.near"]) {
      const r = run([a]);
      assert.equal(r.code, 1, a);
      assert.equal(r.stdout, "", a);
      assert.match(r.stderr, /refused/);
    }
  });
  it("accepts --flag=value forms", () => {
    assert.equal(run(["--network=testnet"]).code, 0);
    const p = JSON.parse(run(["--json", "--agent-contract=yield-agent.testnet", "--path=yield-vault-1"]).stdout);
    assert.equal(p.derivation.derived_key, EVIDENCE_KEY);
    const q = JSON.parse(run(["--json", "--path=other-path"]).stdout);
    assert.equal(q.derivation.path, "other-path");
    assert.equal(run(["--json=1"]).code, 2);
    assert.equal(run(["--path="]).code, 2);
  });
  it("refuses NEAR_NETWORK=mainnet", () => {
    const r = run([], { env: { ...BASE_ENV, NEAR_NETWORK: "mainnet" } });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /refused/);
  });
  it("accepts --network testnet", () => assert.equal(run(["--network", "testnet"]).code, 0));
  it("unknown flag exits 2 with no stdout", () => {
    const r = run(["--bogus"]);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, "");
  });
  it("--help exits 0 with usage", () => {
    const r = run(["-h"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^Usage: /);
  });
});

describe("yield:shade:dry-run determinism and side effects", () => {
  it("same args give identical bytes, ignoring MOCK_INFERENCE and NEAR_AI_*", () => {
    const a = run([]);
    const b = run([], { env: { ...BASE_ENV, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "fake-not-a-key" } });
    assert.equal(a.stdout, b.stdout);
    assert.equal(run(["--json"]).stdout, run(["--json"]).stdout);
  });
  it("writes no files", () => {
    run([]);
    run(["--json"]);
    assert.deepEqual(readdirSync(work), []);
  });
  it("npm script points at the file", () => {
    assert.equal(JSON.parse(readFileSync(PKG, "utf8")).scripts["yield:shade:dry-run"], "node scripts/yield-shade-dry-run.mjs");
  });
});
