// The live runbook must not drift from the plan tool or from the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runbookPath = resolve(root, 'docs/yield-vault-live-runbook.md');
const runbook = readFileSync(runbookPath, 'utf8');
const libRs = readFileSync(resolve(root, 'contracts/yield-vault/src/lib.rs'), 'utf8');
const vaultReadme = readFileSync(resolve(root, 'contracts/yield-vault/README.md'), 'utf8');

const run = spawnSync('node', ['scripts/yield-live.mjs', 'dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 60000 });
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
