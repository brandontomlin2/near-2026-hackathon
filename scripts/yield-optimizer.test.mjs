// Behaviour tests for the Yield Optimizer CLI (scripts/yield-optimizer.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SNAPSHOT, main, parseArgs, UsageError } from "./yield-optimizer.mjs";

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
    assert.equal(a.snapshot, DEFAULT_SNAPSHOT);
    assert.equal(a.json, false);
    assert.deepEqual(a.opts, {});
  });
  it("reads every option", () => {
    const a = parseArgs(["--snapshot", "x.json", "--slippage-bps", "100", "--min-edge-bps", "0", "--json"]);
    assert.deepEqual(a, { help: false, snapshot: "x.json", json: true, opts: { slippage_bps: 100, min_edge_bps: 0 } });
  });
  it("throws UsageError for bad input", () => {
    for (const argv of [["--nope"], ["stray"], ["--slippage-bps"], ["--slippage-bps", "abc"], ["--slippage-bps", "-1"], ["--slippage-bps", "10000"], ["--min-edge-bps", "10001"], ["--snapshot", "--json"]]) {
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
    assert.equal(j.decision, "swap");
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
    const j = JSON.parse(run(["--json", "--slippage-bps", "100", "--min-edge-bps", "10000"]).stdout);
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
      const raw = JSON.parse(fs.readFileSync(DEFAULT_SNAPSHOT, "utf8"));
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
