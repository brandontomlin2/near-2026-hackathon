// The live runbook must not drift from the plan tool or from the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runbookPath = resolve(root, 'docs/yield-vault-live-runbook.md');
const runbook = readFileSync(runbookPath, 'utf8');
const libRs = readFileSync(resolve(root, 'contracts/yield-vault/src/lib.rs'), 'utf8');
const vaultReadme = readFileSync(resolve(root, 'contracts/yield-vault/README.md'), 'utf8');

const run = spawnSync('node', ['scripts/yield-live.mjs', 'dry-run', '--json', '--all'], { cwd: root, encoding: 'utf8', timeout: 60000 });
const plan = JSON.parse(run.stdout);
const pubFns = new Set([...libRs.matchAll(/pub fn (\w+)/g)].map((m) => m[1]));

test('dry-run exits 0 with a plan', () => {
  assert.equal(run.status, 0, run.stderr);
  assert.ok(plan.transactions.length >= 30);
});

test('every plan command appears verbatim in the runbook', () => {
  for (const t of plan.transactions) {
    assert.ok(runbook.includes(t.near_cli), `step ${t.id} command missing from the runbook:\n${t.near_cli}`);
  }
});

test('plan steps appear in the runbook in plan order, one section each', () => {
  let from = 0;
  plan.transactions.forEach((t, i) => {
    const heading = `#### Step ${i + 1} [${t.phase}]`;
    const at = runbook.indexOf(heading, from);
    assert.ok(at >= 0, `missing or out of order: ${heading}`);
    assert.equal(runbook.indexOf(heading), at, `duplicate heading ${heading}`);
    const cmdAt = runbook.indexOf(t.near_cli, at);
    assert.ok(cmdAt > at, `command of step ${i + 1} is not under its heading`);
    from = cmdAt;
  });
  assert.equal((runbook.match(/^#### Step \d+ \[/gm) || []).length, plan.transactions.length);
});

test('every vault method the plan calls exists as a pub fn in lib.rs', () => {
  const vaultMethods = new Set();
  for (const t of plan.transactions) {
    if (t.receiver_id !== plan.vault_id) continue;
    for (const a of t.actions) if (a.method_name) vaultMethods.add(a.method_name);
  }
  assert.ok(vaultMethods.size >= 10);
  for (const m of vaultMethods) assert.ok(pubFns.has(m), `plan method ${m} is not a pub fn in lib.rs`);
});

test('every vault method in the verification table exists as a pub fn in lib.rs', () => {
  const table = runbook.slice(runbook.indexOf('## Verification table'), runbook.indexOf('## Known gaps'));
  const methods = [];
  for (const line of table.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells[2] !== 'vault') continue;
    const m = /^`(\w+)`$/.exec(cells[3]);
    assert.ok(m, `unparseable vault row: ${line}`);
    methods.push(m[1]);
  }
  assert.ok(methods.length >= 20, 'expected the vault rows of the table');
  for (const m of methods) assert.ok(pubFns.has(m), `table method ${m} is not a pub fn in lib.rs`);
  // The recovery table in Rollback names methods too.
  const rec = runbook.slice(runbook.indexOf('### Recovery commands'), runbook.indexOf('## Verification table'));
  for (const m of ['force_release_lock', 'abort_release', 'recover_from_ref', 'sync_balance']) {
    assert.ok(rec.includes('`' + m + '`') && pubFns.has(m), m);
  }
});

test('gas minimums stated for recovery methods match lib.rs', () => {
  const tgas = (name) => Number(new RegExp(`pub const ${name}: Gas = Gas::from_tgas\\((\\d+)\\)`).exec(libRs)?.[1]);
  const table = runbook.slice(runbook.indexOf('### Recovery commands'), runbook.indexOf('Template (replace'));
  assert.match(table, new RegExp(`force_release_lock\`[^\\n]*\\| ${tgas('MIN_FORCE_RELEASE_GAS')} TGas`));
  assert.match(table, new RegExp(`recover_from_ref\`[^\\n]*\\| ${tgas('MIN_RECOVER_GAS')} TGas`));
  assert.match(table, new RegExp(`sync_balance\`[^\\n]*\\| ${tgas('MIN_SYNC_GAS')} TGas`));
});

test('every run-time marker in the plan is explained in the runbook', () => {
  const markers = [];
  for (const t of plan.transactions) {
    for (const m of t.near_cli.matchAll(/<READ [^>]*>/g)) markers.push({ id: t.id, marker: m[0] });
  }
  assert.ok(markers.length >= 3, 'expected run-time markers in the plan');
  assert.deepEqual(
    markers.map((m) => m.id).sort(),
    (plan.filled_at_run_time || []).map((f) => f.step).sort(),
    'markers and the tool\'s filled-at-run-time list disagree',
  );
  for (const { id, marker } of markers) {
    assert.ok(runbook.includes(marker), `marker for ${id} missing: ${marker}`);
    const i = plan.transactions.findIndex((t) => t.id === id);
    const section = runbook.split(/^#### Step /m)[i + 1];
    assert.match(section, /RUN-TIME VALUE/, `step ${id} does not explain its marker`);
  }
  assert.match(runbook, /SKIP this step if that value is 0/);
});

test('totals and step count in the runbook match the plan', () => {
  assert.ok(runbook.includes(`${plan.totals.transactions} transactions, ${plan.totals.views} views`));
  assert.ok(runbook.includes(`prints ${plan.transactions.length} steps`));
  assert.ok(runbook.includes(`${plan.totals.owner_outflow_near} NEAR`));
  assert.ok(runbook.includes(`${plan.totals.gas_tgas} TGas`));
});

test('vault README links to the runbook and the target exists', () => {
  const m = /\]\((\.\.\/\.\.\/docs\/yield-vault-live-runbook\.md)\)/.exec(vaultReadme);
  assert.ok(m, 'link missing');
  assert.ok(existsSync(resolve(root, 'contracts/yield-vault', m[1])));
});

test('runbook marks unverified items and contains no key material', () => {
  assert.match(runbook, /UNCONFIRMED/);
  assert.doesNotMatch(runbook, /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/);
  assert.doesNotMatch(runbook, /secp256k1:[1-9A-HJ-NP-Za-km-z]{80,}/);
  assert.doesNotMatch(runbook, /sk-/);
});

const status = runbook.match(/^## Status\n([\s\S]*?)(?=^## )/m)?.[1] ?? '';

test('Status points to the Shade Agent path and the go/no-go checklist', () => {
  assert.ok(status, 'Status section exists');
  assert.ok(status.includes('`npm run yield:shade:dry-run`'));
  const m = /\]\((yield-shade-go-nogo\.md)\)/.exec(status);
  assert.ok(m, 'Status links yield-shade-go-nogo.md');
  assert.ok(existsSync(resolve(dirname(runbookPath), m[1])), 'linked file exists');
});

test('Status says nothing is signed or sent and chain-changing steps need an explicit yes', () => {
  assert.match(status, /No transaction in this document has been signed or sent/);
  assert.match(status, /Every step that changes chain state needs [^\n]*explicit yes/);
  const shade = status.split('\n').find((l) => l.includes('yield:shade:dry-run')) ?? '';
  assert.match(shade, /Nothing in either is done/);
  assert.match(shade, /explicit yes/);
});

test('runbook contains no imperative invitation to sign', () => {
  const bad = runbook.split('\n').filter((l) => /\b(please|go ahead and|you should now)\b.*\bsign/i.test(l));
  assert.deepEqual(bad, []);
});

// Post-M1 and pool-747 tip: the Status explains how the live swap relates to the
// demo's one planned call, and that a failed Ref swap refunds itself.
const swapTx = plan.transactions.find((t) => t.id === 'execute-swap');
const swapProposal = swapTx?.actions.find((a) => a.method_name === 'execute_swap')?.args.proposal;

test('Status names the live swap pool and the demo call pool as the tools really produce them', () => {
  assert.ok(swapProposal, 'live plan has an execute_swap step');
  const outDir = mkdtempSync(join(tmpdir(), 'yield-demo-runbook-'));
  try {
    const demo = spawnSync('node', ['scripts/yield-demo.mjs', '--out', outDir], { cwd: root, encoding: 'utf8', timeout: 120000 });
    assert.equal(demo.status, 0, demo.stderr);
    const calls = JSON.parse(readFileSync(join(outDir, 'calls.json'), 'utf8')).calls;
    assert.equal(calls.length, 1, 'the demo plans exactly one call');
    const demoProposal = calls[0].args.proposal;
    const line = status.split('\n').find((l) => l.includes('The swap here is the same call')) ?? '';
    assert.ok(line.includes(`pool ${swapProposal.pool_id} (${swapProposal.token_in} to ${swapProposal.token_out})`), `live swap pool/tokens in Status: ${line}`);
    assert.deepEqual(
      { pool_id: swapProposal.pool_id, token_in: swapProposal.token_in, token_out: swapProposal.token_out, amount_in: swapProposal.amount_in, min_amount_out: swapProposal.min_amount_out },
      { pool_id: demoProposal.pool_id, token_in: demoProposal.token_in, token_out: demoProposal.token_out, amount_in: demoProposal.amount_in, min_amount_out: demoProposal.min_amount_out },
      'the live swap is the call yield:demo executes',
    );
    assert.ok(status.includes('UNCONFIRMED'), 'Status flags the unverified usdc.fakes.testnet prerequisite');
    assert.ok(runbook.slice(runbook.indexOf('## Known gaps')).includes('usdc.fakes.testnet'), 'Known gaps lists the usdc.fakes.testnet prerequisite');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('Status and the swap step describe the M1 refund self-heal with events that exist in lib.rs', () => {
  for (const ev of ['swap_refunded', 'swap_failed']) assert.ok(libRs.includes(`"${ev}"`), `${ev} emitted by lib.rs`);
  assert.ok(libRs.includes('fn on_refund_reconciled'), 'refund reconcile callback exists');
  const m1 = status.split('\n').find((l) => l.includes('M1 fix')) ?? '';
  assert.match(m1, /`swap_refunded`, then `swap_failed`/);
  assert.match(m1, /Only a refund that cannot be verified strands/);
  const swapN = plan.transactions.findIndex((t) => t.id === 'execute-swap') + 1;
  const step19 = runbook.slice(runbook.indexOf(`#### Step ${swapN} [swap]`), runbook.indexOf(`#### Step ${swapN + 1} `));
  assert.match(step19, /`swap_refunded` then `swap_failed`/);
  assert.match(step19, /`swaps_executed: 0`/);
  assert.match(step19, /Only if that refund cannot be verified are the funds stranded/);
});
