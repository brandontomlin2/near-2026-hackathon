import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58Encode, serializeTransaction } from './chainsig.mjs';
import { TESTNET_ED25519_ROOT } from './dry-run.mjs';

test('base58Encode keeps byte-identical output for valid input', () => {
  assert.equal(base58Encode([]), '');
  assert.equal(base58Encode(new Uint8Array(0)), '');
  assert.equal(base58Encode([0, 0, 1]), '112');
  assert.equal(base58Encode(Uint8Array.from([0, 0, 1])), '112');
  assert.equal(base58Encode([255]), '5Q');
  assert.equal(base58Encode([0]), '1');
});

test('base58Encode rejects out-of-range or non-integer bytes naming value and index', () => {
  assert.throws(() => base58Encode([256]), (e) => e instanceof RangeError && /index 0/.test(e.message) && /256/.test(e.message));
  assert.throws(() => base58Encode([1, 2, -1]), (e) => e instanceof RangeError && /index 2/.test(e.message) && /-1/.test(e.message));
  assert.throws(() => base58Encode([0, 1.5]), (e) => e instanceof RangeError && /index 1/.test(e.message) && /1\.5/.test(e.message));
  assert.throws(() => base58Encode([NaN]), (e) => e instanceof RangeError && /index 0/.test(e.message) && /NaN/.test(e.message));
  assert.throws(() => base58Encode([7, 7, 7, 'a']), (e) => e instanceof RangeError && /index 3/.test(e.message) && /a/.test(e.message));
  assert.throws(() => base58Encode([1n]), RangeError);
});

const base = { signerId: 'a', publicKey: TESTNET_ED25519_ROOT, nonce: 1n, receiverId: 'a', blockHash: new Uint8Array(32) };
const addKey = (permission) => serializeTransaction({ ...base, actions: [{ type: 'AddKey', publicKey: TESTNET_ED25519_ROOT, permission }] });

test('AddKey with an unknown permission names what it received', () => {
  assert.throws(() => addKey('Bogus'), /unknown AddKey permission: "Bogus"/);
  assert.throws(() => addKey({ receiverId: 'v' }), /unknown AddKey permission: \{"receiverId":"v"\}/);
  assert.throws(() => addKey({ receiverId: 'v', methodNames: 'x' }), /unknown AddKey permission/);
  assert.throws(() => addKey({ allowance: 5n, receiverId: 'v' }), /unknown AddKey permission: \{"allowance":"5n","receiverId":"v"\}/);
  assert.throws(() => addKey({}),/unknown AddKey permission: \{\}/);
  assert.throws(() => addKey(null), /unknown AddKey permission: null/);
  assert.throws(() => addKey(undefined), /unknown AddKey permission/);
});

test('AddKey valid permissions still serialize', () => {
  assert.equal(addKey('FullAccess').at(-1), 1);
  const fc = addKey({ allowance: 5n, receiverId: 'v', methodNames: [] });
  const tail = Buffer.concat([Buffer.from([0, 1, 5]), Buffer.alloc(15), Buffer.from([1, 0, 0, 0]), Buffer.from('v'), Buffer.from([0, 0, 0, 0])]);
  assert.ok(fc.subarray(fc.length - tail.length).equals(tail));
});
