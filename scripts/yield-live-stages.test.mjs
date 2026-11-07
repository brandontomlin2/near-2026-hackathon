// The human live path is split: setup (deploy, fund, one small swap) comes before the agent send;
// withdraw, pause, revoke and delete come after it. These tests pin that order in every printed list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { armedLines } from "../src/yield/demo-live.mjs";
import { buildLivePlan, setupStepCount } from "../src/yield/live-plan.mjs";

const SCRIPT = new URL("./yield-live.mjs", import.meta.url).pathname;
const EXAMPLE = new URL("../config/yield-vault.live.example.json", import.meta.url).pathname;
const config = JSON.parse(readFileSync(EXAMPLE, "utf8"));
const TEARDOWN = /withdraw|delete|pause|revoke/i;

function dry(args) {
  const r = spawnSync(process.execPath, [SCRIPT, "dry-run", ...args], { encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const ids = (args) => JSON.parse(dry([...args, "--json"]).stdout).transactions.map((t) => t.id);

test("ARMED lines: nothing before the agent send (step 3) mentions teardown; rollback is step 4, after it", () => {
  const lines = armedLines("out/yield-vault.live.json", config);
  const step3 = lines.findIndex((l) => /^ {2}3\. /.test(l));
  const step4 = lines.findIndex((l) => /^ {2}4\. /.test(l));
  assert.ok(step3 > 0 && step4 > step3, "step 4 follows step 3");
  assert.doesNotMatch(lines.slice(0, step4).join("\n"), TEARDOWN);
  assert.match(lines[step4], /--rollback/);
  assert.match(lines[step4 + 1], /AFTER|Do not sign any of them before step 3|teardown/i);
  assert.doesNotMatch(lines[lines.findIndex((l) => /^ {2}2\. /.test(l))], /--rollback/);
  assert.ok(lines.some((l) => /SETUP stage only/.test(l)));
});

for (const [label, cfg] of [
  ["yield-optimizer", config],
  ["personality agent", (() => {
    const c = structuredClone(config);
    delete c.vault_profile;
    c.agent = c.token_id = "chaotic";
    c.swap = { pool_id: 0, token_in: "wrap.testnet", token_out: "rft.tokenfactory.testnet", amount_in: "10000000000000000000000", min_amount_out: "50000000" };
    c.deposit = { token_id: "wrap.testnet", amount: "20000000000000000000000" };
    return c;
  })()],
]) {
  test(`ARMED lines (${label}): preflight -> setup stops before the swap -> one swap + read-back -> optional teardown`, () => {
    const lines = armedLines("out/yield-vault.live.json", cfg);
    const text = lines.join("\n");
    const swap = buildLivePlan(cfg).steps.findIndex((s) => s.id === "execute-swap") + 1;
    const at = (n) => lines.findIndex((l) => l.startsWith(`  ${n}. `));
    const [s1, s2, s3, s4] = [1, 2, 3, 4].map(at);
    assert.ok(s1 > 0 && s1 < s2 && s2 < s3 && s3 < s4, "steps 1-4 print in order");
    assert.match(lines[s1], /yield:live:preflight/);
    const setup = lines.slice(s2, s3).join("\n");
    assert.match(setup, new RegExp(`signs plan steps 1-${swap - 1} by hand.*STOPS before plan step ${swap} \\(execute_swap\\)`));
    assert.doesNotMatch(setup, /signs each one/);
    const trade = lines.slice(s3, s4).join("\n");
    assert.match(trade, /ONE swap only/);
    assert.match(trade, /never resend it blind, and do not go on to step 4/);
    assert.match(trade, new RegExp(`read plan step ${swap + 1}`));
    assert.doesNotMatch(lines.slice(0, s4).join("\n"), TEARDOWN);
    assert.match(lines[s4], /AFTER step 3's read-back only \(rollback, optional\).*--rollback/);
    // Exactly one instruction to send the swap: step 3. Step 2 only names it as where to stop.
    assert.equal((text.match(/sends plan step \d+ \(execute_swap\) once|--send --i-approve/g) ?? []).length, 1);
    if (label === "personality agent") assert.match(trade, new RegExp(`do not also sign step ${swap}`));
  });
}

test("default dry-run is setup only: ends at the swap read-back, no teardown step or command", () => {
  const plan = buildLivePlan(config);
  const n = setupStepCount(plan);
  const got = ids([]);
  assert.equal(got.length, n);
  assert.equal(got.at(-1), "view-state-2");
  assert.ok(got.includes("execute-swap") && got.includes("deploy-init") && got.includes("deposit-into-vault"));
  for (const id of got) assert.doesNotMatch(id, /withdraw|delete|pause|revoke/);
  const r = dry([]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /setup stage, plan steps 1-19 of 35/);
  assert.match(r.stdout, /SETUP ONLY/);
  assert.doesNotMatch(r.stdout, /near-cli-rs \(text only\):.*(delete-account|withdraw|pause|revoke_all_runners)/);
  assert.doesNotMatch(r.stdout, /\[rollback\]|\[withdraw\]/);
});

test("--rollback prints only the deferred steps, numbered after the setup, with a run-after-send banner", () => {
  const plan = buildLivePlan(config);
  const n = setupStepCount(plan);
  const got = ids(["--rollback"]);
  assert.deepEqual(got, plan.steps.slice(n).map((s) => s.id));
  for (const need of ["withdraw-out", "pause", "revoke-runners", "delete-vault", "delete-runner"]) assert.ok(got.includes(need), need);
  assert.ok(!got.includes("execute-swap") && !got.includes("deploy-init"));
  const r = dry(["--rollback"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rollback stage, plan steps 20-35 of 35/);
  assert.match(r.stdout, /ROLLBACK: run these only AFTER the agent send/);
  assert.match(r.stdout, new RegExp(`^${String(n + 1).padStart(2)}\\. \\[`, "m"));
});

test("setup and rollback lists are disjoint and together are the whole plan (--all)", () => {
  const setup = ids([]);
  const rollback = ids(["--rollback"]);
  const all = ids(["--all"]);
  assert.deepEqual([...setup, ...rollback], all);
  assert.equal(new Set(all).size, all.length);
  assert.match(dry(["--all"]).stdout, /REVIEW ONLY/);
});

test("--rollback and --all together are a usage error", () => {
  assert.equal(dry(["--rollback", "--all"]).code, 2);
});

test("every dry-run stage still validates the whole plan and exits 1 on a plan problem", () => {
  for (const args of [[], ["--rollback"], ["--all"]]) assert.deepEqual(JSON.parse(dry([...args, "--json"]).stdout).problems, []);
});

test("yield:live:once stops at the swap and defers rollback to after the agent send", () => {
  const src = readFileSync(new URL("./yield-live-once.mjs", import.meta.url), "utf8");
  assert.match(src, /deferred until AFTER the agent send/);
  assert.match(src, /--rollback/);
});
