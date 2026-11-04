import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(fileURLToPath(new URL('.', import.meta.url)), 'dry-run.mjs');
const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
const out = JSON.parse(r.stdout);

test('dry-run CLI exits 0 and prints the placeholder header line (stderr and notice field)', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr + r.stdout, /DRY RUN\. The agent, executor and vault accounts below are invented placeholders that do not exist on testnet/);
  assert.match(out.notice, /nonces and block hash are placeholders/);
});

test('invented accounts are marked placeholder, not deployed', () => {
  for (const k of ['agent', 'executor', 'vault']) {
    assert.match(out.accountStatus[k], /\(placeholder, not deployed\)$/);
  }
  assert.match(out.accountStatus.agent, /^yield-agent\.testnet/);
  assert.match(out.accountStatus.executor, /^yield-executor\.testnet/);
  assert.match(out.accountStatus.vault, /^yield-vault\.testnet/);
});

test('nonces and block hash are marked placeholder', () => {
  assert.match(out.nonceStatus.addKeyAccessKeyNonce, /placeholder/);
  assert.match(out.nonceStatus.swapTxNonce, /placeholder/);
  assert.match(out.nonceStatus.blockHash, /placeholder/);
  assert.match(out.addKey.accessKeyNonce, /placeholder/);
  assert.match(out.swap.txNonce, /placeholder/);
});

test('real testnet contracts are not marked placeholder', () => {
  assert.doesNotMatch(out.accountStatus['wrap.testnet'], /placeholder/);
  assert.match(out.accountStatus['wrap.testnet'], /real testnet contract/);
  assert.equal(out.mpcContract, 'v1.signer-prod.testnet');
  assert.doesNotMatch(out.mpcContractStatus, /placeholder/);
  assert.match(out.mpcContractStatus, /real testnet contract/);
  assert.doesNotMatch(out.mpcSignCall.receiverId + out.swap.args.token_in, /placeholder/);
});
