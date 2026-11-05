import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { judgePathChecks, listFiles, runChecks, treeHash } from "./fresh-clone-judge-path.mjs";

const SCRIPT = fileURLToPath(new URL("./fresh-clone-judge-path.mjs", import.meta.url));

describe("fresh-clone-judge-path", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-path-test-"));
    fs.writeFileSync(path.join(dir, "stub.sh"), "echo 'Files written (3)'\nmkdir -p out\necho hi > out/a.txt\nexit 3\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (checks, readme) => runChecks({ cwd: dir, readme, checks, log: () => {} });

  it("PASSes when output, exit code, README and assertions agree", () => {
    const [row] = run(
      [
        {
          step: "t:match",
          command: "bash stub.sh",
          code: 3,
          expects: ["Files written (3)"],
          assert: (ctx) => ctx.check(ctx.exists("out/a.txt"), "out/a.txt missing"),
        },
      ],
      "The demo prints `Files written (3)`.",
    );
    assert.equal(row.status, "PASS", row.detail);
    assert.equal(row.step, "t:match");
  });

  it("names the README as the drifted side when it stops quoting the output", () => {
    const [row] = run([{ step: "t:readme", command: "bash stub.sh", code: 3, expects: ["Files written (3)"] }], "It prints `Files written (64)`.");
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /README drifted: .*Files written \(3\)/);
    assert.doesNotMatch(row.detail, /code drifted/);
  });

  it("names the code as the drifted side when the output stops matching the README", () => {
    const [row] = run([{ step: "t:code", command: "bash stub.sh", code: 3, expects: ["Files written (64)"] }], "It prints `Files written (64)`.");
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /code drifted: output lacks "Files written \(64\)"/);
    assert.doesNotMatch(row.detail, /README drifted/);
  });

  it("fails on a wrong exit code and on a throwing assertion", () => {
    const rows = run(
      [
        { step: "t:exit", command: "bash stub.sh", code: 0 },
        {
          step: "t:throw",
          assert: (ctx) => ctx.json("out/missing.json"),
        },
      ],
      "",
    );
    assert.match(rows[0].detail, /exit 3, README says 0/);
    assert.equal(rows[1].status, "FAIL");
    assert.match(rows[1].detail, /check error/);
  });

  it("drops a caller's SUMMARY_EVERY_N_ROUNDS=1 so children use the default cadence", () => {
    const prev = process.env.SUMMARY_EVERY_N_ROUNDS;
    process.env.SUMMARY_EVERY_N_ROUNDS = "1";
    try {
      const [row] = runChecks({
        cwd: dir,
        readme: "",
        log: () => {},
        env: { SUMMARY_EVERY_N_ROUNDS: "1" },
        checks: [{ step: "t:every", command: 'echo "every=${SUMMARY_EVERY_N_ROUNDS-unset}"', expects: ["every=unset"], readme: [] }],
      });
      assert.equal(row.status, "PASS", row.detail);
    } finally {
      if (prev === undefined) delete process.env.SUMMARY_EVERY_N_ROUNDS;
      else process.env.SUMMARY_EVERY_N_ROUNDS = prev;
    }
  });

  it("times out a hung command", () => {
    const [row] = runChecks({ cwd: dir, readme: "", log: () => {}, timeoutMs: 300, checks: [{ step: "t:hang", command: "sleep 5" }] });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /timed out/);
  });

  it("runs commands with a scrubbed env and a throwaway HOME", () => {
    const rows = runChecks({
      cwd: dir,
      readme: "",
      log: () => {},
      env: { NEAR_CONTRACT_ACCOUNT_ID: "someone.testnet", MY_API_KEY: "not-a-real-value" },
      checks: [
        {
          step: "t:env",
          command: 'echo "home=$HOME contract=${NEAR_CONTRACT_ACCOUNT_ID-unset} key=${MY_API_KEY-unset} mock=$MOCK_INFERENCE"',
          expects: ["contract=unset", "key=unset", "mock=1"],
          readme: [],
          assert: (ctx) => {
            const home = /home=(\S+)/.exec(ctx.output)[1];
            ctx.shared.home = home;
            ctx.check(home !== os.homedir(), "HOME was not replaced");
          },
        },
        {
          step: "t:home-gone",
          assert: (ctx) => ctx.check(!fs.existsSync(ctx.shared.home), "temp HOME was not removed"),
        },
      ],
    });
    for (const row of rows) assert.equal(row.status, "PASS", row.detail);
  });

  it("treeHash changes with content and path, listFiles is relative and sorted", () => {
    const before = treeHash(path.join(dir, "out"));
    assert.equal(before, treeHash(path.join(dir, "out")));
    fs.writeFileSync(path.join(dir, "out", "b.txt"), "x");
    assert.notEqual(before, treeHash(path.join(dir, "out")));
    assert.deepEqual(listFiles(path.join(dir, "out")), ["a.txt", "b.txt"]);
  });

  it("ships a check list with unique steps for the README judge path", () => {
    const checks = judgePathChecks();
    const steps = checks.map((c) => c.step);
    assert.equal(new Set(steps).size, steps.length);
    for (const s of ["judge:1 demo", "judge:8 rerun", "judge:9 live refused", "swarm:1 five rounds", "art:3 all styles"]) {
      assert.ok(steps.includes(s), s);
    }
    for (const c of checks) {
      assert.doesNotMatch(c.command ?? "", /--send|--i-approve|--live|\bnear\b|verify\.sh|npm test|cargo/);
    }
  });

  describe("CLI", () => {
    const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30000 });

    it("exits 2 without arguments, with an unknown flag, or with a missing directory", () => {
      assert.equal(cli().status, 2);
      assert.equal(cli("--bogus").status, 2);
      assert.equal(cli("--cwd", dir).status, 2);
      const missing = cli("--cwd", path.join(dir, "nope"), "--rows", path.join(dir, "rows.tsv"));
      assert.equal(missing.status, 2);
      assert.match(missing.stderr, /not a directory/);
      assert.equal(fs.existsSync(path.join(dir, "rows.tsv")), false);
    });

    it("writes a FAIL row instead of throwing when the clone has no README", () => {
      const rows = path.join(dir, "rows2.tsv");
      const res = cli("--cwd", dir, "--rows", rows);
      assert.equal(res.status, 1);
      const [line] = fs.readFileSync(rows, "utf8").trim().split("\n");
      const [status, step, detail] = line.split("\t");
      assert.equal(status, "FAIL");
      assert.equal(step, "judge path");
      assert.match(detail, /README/);
    });
  });
});
