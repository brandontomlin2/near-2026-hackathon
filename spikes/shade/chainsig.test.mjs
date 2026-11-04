import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  deriveTweak, deriveEd25519PublicKey, base58Encode, base58Decode, parseEd25519PublicKey,
  serializeTransaction, buildSignRequest, attachSignature, sha256,
} from './chainsig.mjs';
import { plan, TESTNET_ED25519_ROOT } from './dry-run.mjs';

const hex = (b) => Buffer.from(b).toString('hex');

test('deriveTweak matches the MPC repo insta snapshot (kdf.rs derive_tweak__has_not_changed[0])', () => {
  assert.equal(hex(deriveTweak('dwefqwg', 'frwewegwegweg')), 'ad2d6fc1f445a1b43830415e7e6e3d03cd077673047848a085f130c24f53ee00');
});

// Expected values come from derived_public_key view calls on v1.signer-prod.testnet (evidence/testnet-mpc-views.txt).
for (const [predecessor, path, expected] of [
  ['yield-agent.testnet', 'yield-vault-1', 'ed25519:4FLkw3i5QV11843yboCvBJ4jdSg3ijyLUxzhN47RRdDM'],
  ['shade-agent.testnet', 'vault', 'ed25519:7V9KiQxMVzzYQ9gEi8qZZNxnzGCiB52LP1aRSvEjZJpy'],
  ['alice.testnet', 'ed25519-1', 'ed25519:FrVhMhww95UzBDUiJRnzkFE3hKNcfCHz3LM1uAryjttn'],
]) {
  test(`deriveEd25519PublicKey(${predecessor}, ${path}) equals the testnet contract's derived_public_key`, () => {
    assert.equal(deriveEd25519PublicKey(TESTNET_ED25519_ROOT, predecessor, path), expected);
  });
}

test('different predecessor or path gives a different key', () => {
  const a = deriveEd25519PublicKey(TESTNET_ED25519_ROOT, 'a.testnet', 'p');
  assert.notEqual(a, deriveEd25519PublicKey(TESTNET_ED25519_ROOT, 'b.testnet', 'p'));
  assert.notEqual(a, deriveEd25519PublicKey(TESTNET_ED25519_ROOT, 'a.testnet', 'q'));
});

test('base58 round-trips, keeps leading zeros, rejects bad characters', () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
  assert.throws(() => base58Decode('0OIl'), /invalid base58/);
});

test('parseEd25519PublicKey rejects other curves and wrong lengths', () => {
  assert.throws(() => parseEd25519PublicKey('secp256k1:abc'), /not an ed25519/);
  assert.throws(() => parseEd25519PublicKey('ed25519:2'), /32 bytes/);
});

test('serializeTransaction emits the borsh layout byte by byte', () => {
  const pk = TESTNET_ED25519_ROOT;
  const tx = serializeTransaction({
    signerId: 'a', publicKey: pk, nonce: 7n, receiverId: 'b', blockHash: new Uint8Array(32).fill(9),
    actions: [{ type: 'FunctionCall', methodName: 'm', args: {}, gas: 5n, deposit: 1n }],
  });
  const expected = Buffer.concat([
    Buffer.from([1, 0, 0, 0]), Buffer.from('a'), // signer_id
    Buffer.from([0]), Buffer.from(parseEd25519PublicKey(pk)), // public_key
    Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]), // nonce
    Buffer.from([1, 0, 0, 0]), Buffer.from('b'), // receiver_id
    Buffer.alloc(32, 9), // block_hash
    Buffer.from([1, 0, 0, 0]), // 1 action
    Buffer.from([2]), Buffer.from([1, 0, 0, 0]), Buffer.from('m'), // FunctionCall, method
    Buffer.from([2, 0, 0, 0]), Buffer.from('{}'), // args
    Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]), // gas
    Buffer.concat([Buffer.from([1]), Buffer.alloc(15)]), // deposit u128
  ]);
  assert.equal(hex(tx), hex(expected));
});

test('serializeTransaction encodes a function-call AddKey and a full-access AddKey', () => {
  const base = { signerId: 'a', publicKey: TESTNET_ED25519_ROOT, nonce: 1n, receiverId: 'a', blockHash: new Uint8Array(32) };
  const fc = serializeTransaction({ ...base, actions: [{ type: 'AddKey', publicKey: TESTNET_ED25519_ROOT, permission: { allowance: null, receiverId: 'v', methodNames: ['execute_swap'] } }] });
  const tail = Buffer.concat([Buffer.from([0, 0]), Buffer.from([1, 0, 0, 0]), Buffer.from('v'), Buffer.from([1, 0, 0, 0]), Buffer.from([12, 0, 0, 0]), Buffer.from('execute_swap')]);
  assert.ok(fc.subarray(fc.length - tail.length).equals(tail));
  const full = serializeTransaction({ ...base, actions: [{ type: 'AddKey', publicKey: TESTNET_ED25519_ROOT, permission: 'FullAccess' }] });
  assert.equal(full[full.length - 1], 1);
  assert.throws(() => serializeTransaction({ ...base, actions: [{ type: 'Stake' }] }), /unsupported action/);
  assert.throws(() => serializeTransaction({ ...base, nonce: -1n, actions: [] }), /out of range/);
});

test('buildSignRequest matches SignRequestArgs { path, payload_v2: { Eddsa: hex }, domain_id: 1 }', () => {
  const h = sha256(Buffer.from('x'));
  assert.deepEqual(buildSignRequest({ path: 'p', txHash: h }), { request: { path: 'p', payload_v2: { Eddsa: hex(h) }, domain_id: 1 } });
  assert.throws(() => buildSignRequest({ path: 'p', txHash: new Uint8Array(31) }), /32 bytes/);
});

test('attachSignature appends key type 0 and 64 signature bytes', () => {
  const signed = attachSignature(Buffer.from([1, 2]), new Uint8Array(64).fill(3));
  assert.equal(signed.length, 2 + 1 + 64);
  assert.equal(signed[2], 0);
  assert.throws(() => attachSignature(Buffer.from([1]), new Uint8Array(10)), /64 bytes/);
});

test('plan() wires the derived key into AddKey, execute_swap and the MPC sign call', () => {
  const p = plan({ agent: 'yield-agent.testnet', path: 'yield-vault-1', executor: 'exec.testnet', vault: 'vault.testnet' });
  assert.equal(p.dryRun, true);
  assert.equal(p.derivation.derivedKey, 'ed25519:4FLkw3i5QV11843yboCvBJ4jdSg3ijyLUxzhN47RRdDM');
  assert.equal(p.addKey.action.publicKey, p.derivation.derivedKey);
  assert.deepEqual(p.addKey.action.permission.methodNames, ['execute_swap']);
  assert.equal(p.mpcSignCall.receiverId, 'v1.signer-prod.testnet');
  assert.equal(p.mpcSignCall.depositYocto, '1');
  assert.equal(p.mpcSignCall.args.request.payload_v2.Eddsa, hex(base58Decode(p.swap.txSha256Base58)));
});

const cli = fileURLToPath(new URL('./dry-run.mjs', import.meta.url));
test('dry-run CLI prints JSON, supports --help, exits 2 on a bad option', () => {
  const ok = spawnSync(process.execPath, [cli, '--path', 'yield-vault-1'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).dryRun, true);
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Sends nothing/);
  const bad = spawnSync(process.execPath, [cli, '--bogus', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown or incomplete option/);
});
