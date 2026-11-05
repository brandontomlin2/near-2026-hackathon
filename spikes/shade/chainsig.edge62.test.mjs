import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MPC_CONTRACT_TESTNET, ED25519_DOMAIN_ID, SIGN_DEPOSIT_YOCTO, SIGN_MIN_GAS_TGAS,
  base58Encode, base58Decode, parseEd25519PublicKey, formatEd25519PublicKey, deriveTweak,
  deriveEd25519PublicKey, serializeTransaction, buildSignRequest, attachSignature, sha256,
} from './chainsig.mjs';
import { TESTNET_ED25519_ROOT } from './dry-run.mjs';

const R = TESTNET_ED25519_ROOT;
const hex = (b) => Buffer.from(b).toString('hex');
const txBase = () => ({ signerId: 'a', publicKey: R, nonce: 1n, receiverId: 'b', blockHash: new Uint8Array(32), actions: [] });

test('module constants match the documented testnet values', () => {
  assert.equal(MPC_CONTRACT_TESTNET, 'v1.signer-prod.testnet');
  assert.equal(ED25519_DOMAIN_ID, 1);
  assert.equal(SIGN_DEPOSIT_YOCTO, 1n);
  assert.equal(SIGN_MIN_GAS_TGAS, 15n);
});

test('module has no network or process dependencies (static import check)', () => {
  const src = readFileSync(fileURLToPath(new URL('./chainsig.mjs', import.meta.url)), 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specs, ['node:crypto']);
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket|child_process|process\.env)\b|import\(/);
});

test('base58: empty input, single zero, all-zero and 0xff inputs round-trip', () => {
  assert.equal(base58Encode(new Uint8Array()), '');
  assert.equal(base58Decode('').length, 0);
  assert.equal(base58Encode(Uint8Array.from([0])), '1');
  for (const bytes of [[0], [0, 0, 0], [255], [255, 255, 255, 255], [0, 255, 0]]) {
    assert.deepEqual(base58Decode(base58Encode(Uint8Array.from(bytes))), Uint8Array.from(bytes));
  }
});

test('base58Decode rejects whitespace, unicode, and the ambiguous characters 0 O I l', () => {
  for (const bad of [' ', 'abc ', '\n', 'é', '日本', '0', 'O', 'I', 'l', '😀']) {
    assert.throws(() => base58Decode(bad), /invalid base58 character/, JSON.stringify(bad));
  }
});

test('base58Encode refuses non-byte input with an error, not silent output', () => {
  assert.throws(() => base58Encode('abc'));
});

test('base58Decode of a non-string throws', () => {
  assert.throws(() => base58Decode(undefined));
  assert.throws(() => base58Decode(null));
});

test('parseEd25519PublicKey rejects malformed key strings with a clear message', () => {
  for (const bad of [undefined, null, 5, {}, '', 'ed25519:', 'ed25519', 'ED25519:abc', ' ' + R, R + ' ', R + '\n', 'ed25519:0OIl', 'ed25519:é', 'secp256k1:' + R.slice(8)]) {
    assert.throws(() => parseEd25519PublicKey(bad), /not an ed25519 NEAR public key/, String(bad));
  }
});

test('parseEd25519PublicKey rejects keys that decode to 31 or 33 bytes', () => {
  assert.throws(() => parseEd25519PublicKey(formatEd25519PublicKey(new Uint8Array(31).fill(7))), /32 bytes, got 31/);
  assert.throws(() => parseEd25519PublicKey(formatEd25519PublicKey(new Uint8Array(33).fill(7))), /32 bytes, got 33/);
});

test('format and parse are inverse for a 32-byte key', () => {
  const bytes = parseEd25519PublicKey(R);
  assert.equal(formatEd25519PublicKey(bytes), R);
});

test('deriveTweak is 32 bytes, deterministic, and separates predecessor from path at the comma', () => {
  const a = deriveTweak('a.testnet', 'p');
  assert.equal(a.length, 32);
  assert.equal(hex(a), hex(deriveTweak('a.testnet', 'p')));
  // The KDF input is "predecessor,path"; this documents the upstream ambiguity rather than hiding it.
  assert.equal(hex(deriveTweak('a,b', 'c')), hex(deriveTweak('a', 'b,c')));
});

test('deriveTweak and deriveEd25519PublicKey reject non-string ids instead of deriving a key for "undefined"', () => {
  for (const [pred, path] of [[undefined, 'p'], ['a', undefined], [null, 'p'], [1, 2], [{}, 'p'], [['a'], 'p']]) {
    assert.throws(() => deriveTweak(pred, path), /must be strings/);
    assert.throws(() => deriveEd25519PublicKey(R, pred, path), /must be strings/);
  }
});

test('deriveEd25519PublicKey accepts empty and unicode ids deterministically, and they all differ', () => {
  const keys = [['', ''], ['a', ''], ['', 'a'], ['é.testnet', '路径'], ['é.testnet', '路径']]
    .map(([p, q]) => deriveEd25519PublicKey(R, p, q));
  for (const k of keys) assert.match(k, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(new Set(keys).size, keys.length); // NFC vs NFD forms are distinct bytes, so distinct keys
  assert.equal(deriveEd25519PublicKey(R, 'é.testnet', '路径'), keys[3]);
});

test('derived key is a valid 32-byte ed25519 key that differs from the root', () => {
  const k = deriveEd25519PublicKey(R, 'a.testnet', 'p');
  assert.equal(parseEd25519PublicKey(k).length, 32);
  assert.notEqual(k, R);
});

test('deriveEd25519PublicKey rejects a malformed root before doing any math', () => {
  for (const bad of [undefined, null, '', 'ed25519:', R.slice(0, -1) + '0', 'secp256k1:abc']) {
    assert.throws(() => deriveEd25519PublicKey(bad, 'a', 'p'), /not an ed25519|invalid base58/, String(bad));
  }
});

test('serializeTransaction is deterministic and sensitive to every field', () => {
  const a = serializeTransaction(txBase());
  assert.equal(hex(a), hex(serializeTransaction(txBase())));
  for (const change of [{ signerId: 'c' }, { receiverId: 'c' }, { nonce: 2n }, { blockHash: new Uint8Array(32).fill(1) }]) {
    assert.notEqual(hex(serializeTransaction({ ...txBase(), ...change })), hex(a), JSON.stringify(Object.keys(change)));
  }
});

test('serializeTransaction rejects non-string account ids rather than encoding the text "undefined"', () => {
  for (const key of ['signerId', 'receiverId']) {
    for (const bad of [undefined, null, 5]) {
      assert.throws(() => serializeTransaction({ ...txBase(), [key]: bad }), /expected a string/, `${key}=${bad}`);
    }
  }
});

test('serializeTransaction nonce and gas bounds: u64 max accepted, 2^64 and negatives rejected', () => {
  const max = (1n << 64n) - 1n;
  assert.equal(serializeTransaction({ ...txBase(), nonce: max }).subarray(4 + 1 + 1 + 32, 4 + 1 + 1 + 32 + 8).toString('hex'), 'ffffffffffffffff');
  assert.throws(() => serializeTransaction({ ...txBase(), nonce: max + 1n }), /u64 out of range/);
  assert.throws(() => serializeTransaction({ ...txBase(), nonce: -1n }), /u64 out of range/);
  const fc = (gas, deposit) => [{ type: 'FunctionCall', methodName: 'm', args: {}, gas, deposit }];
  assert.throws(() => serializeTransaction({ ...txBase(), actions: fc(max + 1n, 0n) }), /u64 out of range/);
  assert.throws(() => serializeTransaction({ ...txBase(), actions: fc(1n, 1n << 128n) }), /u128 out of range/);
  assert.doesNotThrow(() => serializeTransaction({ ...txBase(), actions: fc(max, (1n << 128n) - 1n) }));
});

test('serializeTransaction rejects a fractional nonce', () => {
  assert.throws(() => serializeTransaction({ ...txBase(), nonce: 1.5 }));
});

test('serializeTransaction blockHash may be a base58 string; wrong lengths rejected', () => {
  const asString = serializeTransaction({ ...txBase(), blockHash: base58Encode(new Uint8Array(32).fill(5)) });
  assert.equal(hex(asString), hex(serializeTransaction({ ...txBase(), blockHash: new Uint8Array(32).fill(5) })));
  assert.throws(() => serializeTransaction({ ...txBase(), blockHash: new Uint8Array(33) }), /blockHash must be 32 bytes/);
  assert.throws(() => serializeTransaction({ ...txBase(), blockHash: '' }), /blockHash must be 32 bytes/);
});

test('serializeTransaction encodes unicode method names and ids by UTF-8 byte length', () => {
  const tx = serializeTransaction({ ...txBase(), signerId: '日本', actions: [{ type: 'FunctionCall', methodName: 'é', args: {}, gas: 1n, deposit: 0n }] });
  assert.equal(tx.readUInt32LE(0), 6);
  assert.ok(tx.includes(Buffer.from([2, 0, 0, 0, 0xc3, 0xa9])));
});

test('serializeTransaction: malformed actions raise errors (unsupported type, bad AddKey key)', () => {
  assert.throws(() => serializeTransaction({ ...txBase(), actions: [{ type: 'Transfer' }] }), /unsupported action type: Transfer/);
  assert.throws(() => serializeTransaction({ ...txBase(), actions: [{ type: 'AddKey', publicKey: 'ed25519:2', permission: 'FullAccess' }] }), /32 bytes/);
  assert.throws(() => serializeTransaction({ ...txBase(), publicKey: undefined }), /not an ed25519/);
});

test('AddKey with an allowance encodes Some(u128) and method list in order', () => {
  const tx = serializeTransaction({
    ...txBase(),
    actions: [{ type: 'AddKey', publicKey: R, permission: { allowance: 5n, receiverId: 'v', methodNames: ['x', 'yy'] } }],
  });
  const tail = Buffer.concat([
    Buffer.from([0, 1]), Buffer.from([5]), Buffer.alloc(15), // FunctionCall perm, Some(allowance)
    Buffer.from([1, 0, 0, 0]), Buffer.from('v'),
    Buffer.from([2, 0, 0, 0]), Buffer.from([1, 0, 0, 0]), Buffer.from('x'), Buffer.from([2, 0, 0, 0]), Buffer.from('yy'),
  ]);
  assert.ok(tx.subarray(tx.length - tail.length).equals(tail));
});

test('buildSignRequest rejects bad hashes and paths with clear errors', () => {
  const ok = new Uint8Array(32);
  assert.throws(() => buildSignRequest({ path: 'p', txHash: new Uint8Array(33) }), /32 bytes/);
  assert.throws(() => buildSignRequest({ path: 'p', txHash: 'a'.repeat(32) }), /32 bytes/);
  assert.throws(() => buildSignRequest({ path: 'p' }), /32 bytes/);
  assert.throws(() => buildSignRequest({ path: undefined, txHash: ok }), /path must be a string/);
  assert.throws(() => buildSignRequest({ path: 5, txHash: ok }), /path must be a string/);
});

test('buildSignRequest: hex is lowercase, 64 chars, zero-padded; empty path is allowed', () => {
  const h = new Uint8Array(32); h[0] = 0x0a; h[31] = 0xff;
  const r = buildSignRequest({ path: '', txHash: h });
  assert.match(r.request.payload_v2.Eddsa, /^[0-9a-f]{64}$/);
  assert.ok(r.request.payload_v2.Eddsa.startsWith('0a00'));
  assert.ok(r.request.payload_v2.Eddsa.endsWith('ff'));
  assert.equal(r.request.path, '');
  assert.equal(r.request.domain_id, 1);
  assert.deepEqual(Object.keys(r), ['request']);
});

test('attachSignature keeps the tx bytes intact and rejects 63 and 65 byte signatures', () => {
  const tx = Buffer.from([9, 8, 7]);
  const sig = new Uint8Array(64).map((_, i) => i);
  const signed = attachSignature(tx, sig);
  assert.ok(signed.subarray(0, 3).equals(tx));
  assert.equal(signed[3], 0);
  assert.equal(hex(signed.subarray(4)), hex(sig));
  assert.throws(() => attachSignature(tx, new Uint8Array(63)), /64 bytes/);
  assert.throws(() => attachSignature(tx, new Uint8Array(65)), /64 bytes/);
  assert.throws(() => attachSignature(tx, undefined));
});

test('sha256 matches the known empty-input digest and is deterministic', () => {
  assert.equal(hex(sha256(new Uint8Array())), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(Buffer.from('x'))), hex(sha256(Buffer.from('x'))));
});
