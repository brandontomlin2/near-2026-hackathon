// Behaviour tests for the Yield Optimizer CLI (scripts/yield-optimizer.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main, parseArgs, UsageError } from "./yield-optimizer.mjs";
import { PLACEHOLDER_VAULT } from "../src/yield/strategies.mjs";

const SCENARIO = fileURLToPath(new URL("../src/yield-optimizer/fixtures/scenario.hand-built.json", import.meta.url));

const SCRIPT = fileURLToPath(new URL("./yield-optimizer.mjs", import.meta.url));
const REPO = path.dirname(path.dirname(SCRIPT));

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("parseArgs", () => {
  it("defaults", () => {
    const a = parseArgs([]);
    assert.equal(a.snapshot, null, "no file: the shared Ref snapshot");
    assert.equal(a.json, false);
    assert.deepEqual(a.opts, {});
  });
  it("reads every option", () => {
    const a = parseArgs(["--snapshot", "x.json", "--slippage-bps", "100", "--min-edge-bps", "0", "--max-ref-deviation-bps", "250", "--json"]);
    assert.deepEqual(a, { help: false, snapshot: "x.json", json: true, opts: { slippage_bps: 100, min_edge_bps: 0, max_ref_deviation_bps: 250 } });
  });
  it("throws UsageError for bad input", () => {
    for (const argv of [["--nope"], ["stray"], ["--slippage-bps"], ["--slippage-bps", "abc"], ["--slippage-bps", "-1"], ["--slippage-bps", "10000"], ["--min-edge-bps", "10001"], ["--max-ref-deviation-bps", "1000001"], ["--max-ref-deviation-bps"], ["--snapshot", "--json"]]) {
      assert.throws(() => parseArgs(argv), UsageError, argv.join(" "));
    }
  });
  it("accepts the range limits", () => {
    assert.equal(parseArgs(["--slippage-bps", "9999"]).opts.slippage_bps, 9999);
    assert.equal(parseArgs(["--min-edge-bps", "10000"]).opts.min_edge_bps, 10000);
  });
});

describe("main", () => {
  it("default run prints DRY RUN in both the human text and the JSON", () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.ok(r.stdout.startsWith("DRY RUN"));
    const [human, jsonPart] = r.stdout.split("JSON plan (DRY RUN, not sent):\n");
    assert.match(human, /DRY RUN/);
    const j = JSON.parse(jsonPart);
    assert.equal(j.dry_run, true);
    assert.match(j.notice, /^DRY RUN/);
    // On the real Ref snapshot only pool 747 (a priced stable pair, shallow fake-token liquidity) passes the reference guard and the vault rules.
    assert.equal(j.decision, "swap");
    assert.equal(j.call.args.proposal.pool_id, 747);
    assert.equal(j.vault_id, PLACEHOLDER_VAULT);
    assert.equal(j.snapshot.block_height, 276332963);
    assert.match(human, /^Decision: SWAP 0\.05 usdc -> at least 0\.050406 usdt on pool 747 /m);
  });

  it("--snapshot with the hand-built scenario plans the swap on pool 17", () => {
    const j = JSON.parse(run(["--json", "--snapshot", SCENARIO]).stdout);
    assert.equal(j.decision, "swap");
    assert.equal(j.call.args.proposal.pool_id, 17);
    assert.equal(j.vault_id, "yield-vault.fixture.testnet");
    assert.equal(j.call.gas, "280.0 Tgas");
  });

  it("--max-ref-deviation-bps reaches the plan: 100 bps rejects the 193 bps pool 17 of the scenario", () => {
    const j = JSON.parse(run(["--json", "--snapshot", SCENARIO, "--max-ref-deviation-bps", "100"]).stdout);
    assert.equal(j.params.max_ref_deviation_bps, 100);
    assert.equal(j.decision, "hold");
    assert.equal(j.candidates.find((c) => c.proposal.pool_id === 17).status, "off_reference");
  });

  it("--json prints parseable JSON only", () => {
    const r = run(["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.dry_run, true);
    assert.equal(j.signed, false);
    assert.equal(j.sent, false);
    assert.ok(r.stdout.startsWith("{"));
  });

  it("passes --slippage-bps and --min-edge-bps through to the plan", () => {
    const j = JSON.parse(run(["--json", "--snapshot", SCENARIO, "--slippage-bps", "100", "--min-edge-bps", "10000"]).stdout);
    assert.equal(j.params.slippage_bps, 100);
    assert.equal(j.params.min_edge_bps, 10000);
    assert.equal(j.decision, "hold");
  });

  it("--help exits 0 and prints usage to stdout", () => {
    const r = run(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^usage: node scripts\/yield-optimizer\.mjs/);
    assert.equal(r.stderr, "");
    assert.equal(run(["-h"]).code, 0);
  });

  it("unknown argument exits 2 with (see --help) on stderr", () => {
    const r = run(["--frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown argument "--frobnicate".*\(see --help\)/);
    assert.equal(r.stdout, "");
  });

  it("bad --slippage-bps exits 2 with (see --help) on stderr", () => {
    for (const v of ["abc", "10000", "-5", "1.5"]) {
      const r = run(["--slippage-bps", v]);
      assert.equal(r.code, 2, v);
      assert.match(r.stderr, /\(see --help\)/);
      assert.equal(r.stdout, "");
    }
    assert.equal(run(["--slippage-bps"]).code, 2);
  });

  describe("snapshot files", () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-cli-"));
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("malformed snapshot exits 1 with 'DRY RUN: snapshot rejected' and nothing on stdout", () => {
      const f = path.join(dir, "bad.json");
      fs.writeFileSync(f, "{ not json");
      const r = run(["--snapshot", f]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.ok(r.stderr.startsWith("DRY RUN: snapshot rejected"));
    });

    it("missing snapshot exits 1 the same way", () => {
      const r = run(["--snapshot", path.join(dir, "missing.json")]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^DRY RUN: snapshot rejected/);
    });

    it("structurally invalid snapshot (empty object) exits 1", () => {
      const f = path.join(dir, "empty-obj.json");
      fs.writeFileSync(f, "{}");
      const r = run(["--snapshot", f]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
    });

    it("a zero-pool snapshot holds", () => {
      const raw = JSON.parse(fs.readFileSync(SCENARIO, "utf8"));
      raw.pools = [];
      const f = path.join(dir, "nopools.json");
      fs.writeFileSync(f, JSON.stringify(raw));
      const j = JSON.parse(run(["--json", "--snapshot", f]).stdout);
      assert.equal(j.decision, "hold");
      assert.equal(j.reason, "snapshot has no pools");
    });
  });
});

describe("process smoke test", () => {
  it("runs from the repo root and prints a DRY RUN plan", () => {
    const r = spawnSync(process.execPath, ["scripts/yield-optimizer.mjs", "--json"], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dry_run, true);
  });
});
