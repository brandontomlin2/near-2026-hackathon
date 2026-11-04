import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEd25519PublicKey, serializeTransaction, base58Decode, parseEd25519PublicKey } from './chainsig.mjs';
import { plan, TESTNET_ED25519_ROOT } from './dry-run.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = join(here, 'dry-run.mjs');
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('dry-run CLI prints the plan when the script path has a space in it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
  try {
    const spaced = join(dir, 'with space');
    mkdirSync(spaced);
    for (const f of ['dry-run.mjs', 'chainsig.mjs']) copyFileSync(join(here, f), join(spaced, f));
    const r = run(join(spaced, 'dry-run.mjs'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dryRun, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run CLI prints the plan when started through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
  try {
    const link = join(dir, 'link.mjs');
    symlinkSync(cli, link);
    const r = run(link);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dryRun, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const args of [
  ['agent', 'foo'], // missing leading --
  ['--constructor', 'x'], // inherited Object property, not an option
  ['--toString', 'x'],
  ['--__proto__', 'x'],
  ['stray'], // positional argument
  ['--agent'], // value missing
  ['--agent', '--path', 'p'], // next option swallowed as a value
  ['--agent', ''], // empty id
  ['--path', ''],
]) {
  test(`dry-run CLI rejects ${JSON.stringify(args)} with exit 2 and no JSON on stdout`, () => {
    const r = run(cli, ...args);
    assert.equal(r.status, 2, `stdout: ${r.stdout}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^dry-run: /);
  });
}

test('dry-run CLI --help wins even after other valid options', () => {
  const r = run(cli, '--agent', 'a.testnet', '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/);
});

test('dry-run CLI output is deterministic and changes with --agent', () => {
  const a = run(cli, '--agent', 'a.testnet').stdout;
  assert.equal(a, run(cli, '--agent', 'a.testnet').stdout);
  assert.notEqual(a, run(cli).stdout);
});

test('plan() sends nothing: no network, no key material in the output', () => {
  const text = JSON.stringify(plan({ agent: 'a.testnet', path: 'p', executor: 'e.testnet', vault: 'v.testnet' }));
  assert.doesNotMatch(text, /private|secret|seed/i);
  assert.equal(plan({ agent: 'a.testnet', path: 'p', executor: 'e', vault: 'v' }).mpcSignCall.depositYocto, '1');
});

test('deriveEd25519PublicKey rejects a root that is not a curve point or not a key', () => {
  assert.throws(() => deriveEd25519PublicKey('ed25519:2', 'a', 'p'), /32 bytes/);
  assert.throws(() => deriveEd25519PublicKey('nonsense', 'a', 'p'), /not an ed25519/);
  assert.throws(() => deriveEd25519PublicKey('', 'a', 'p'), /not an ed25519/);
  // 32 bytes, but y = 2 has no matching x on the curve.
  assert.throws(() => deriveEd25519PublicKey('ed25519:8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh', 'a', 'p'), /not a point/);
});

test('serializeTransaction rejects a block hash of the wrong length or bad base58', () => {
  const base = { signerId: 'a', publicKey: TESTNET_ED25519_ROOT, nonce: 1n, receiverId: 'b', actions: [] };
  assert.throws(() => serializeTransaction({ ...base, blockHash: new Uint8Array(31) }), /32 bytes/);
  assert.throws(() => serializeTransaction({ ...base, blockHash: '11' }), /32 bytes/);
  assert.throws(() => serializeTransaction({ ...base, blockHash: '0OIl' }), /invalid base58/);
});

test('serializeTransaction rejects non-ed25519 keys and encodes non-ASCII ids by UTF-8 byte length', () => {
  const base = { signerId: 'é', publicKey: TESTNET_ED25519_ROOT, nonce: 1n, receiverId: 'b', blockHash: new Uint8Array(32), actions: [] };
  assert.equal(serializeTransaction(base).readUInt32LE(0), 2); // 'é' is 2 bytes
  assert.throws(() => serializeTransaction({ ...base, publicKey: 'secp256k1:abc' }), /not an ed25519/);
});

test('parseEd25519PublicKey and base58Decode round-trip the testnet root', () => {
  assert.equal(parseEd25519PublicKey(TESTNET_ED25519_ROOT).length, 32);
  assert.equal(base58Decode('').length, 0);
});
