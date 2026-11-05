// Spike: NEAR chain signatures (MPC) for a NEAR-account ed25519 key. DRY RUN ONLY.
//
// Reimplements, with no dependencies, what v1.signer-prod.testnet does in
//   crates/near-mpc-crypto-types/src/kdf.rs   derive_tweak (sha3-256 over prefix + "predecessor,path")
//   crates/contract/src/crypto_shared/kdf.rs  derive_public_key_edwards_point_ed25519 (root + G * tweak mod L)
//   crates/near-mpc-crypto-types/src/sign.rs  SignRequestArgs { path, payload_v2: { Eddsa: hex }, domain_id }
// and builds the borsh NEAR transaction whose sha256 hash becomes the Eddsa payload.
// Nothing here sends a transaction, creates an account or holds a private key.

import { createHash } from 'node:crypto';

export const MPC_CONTRACT_TESTNET = 'v1.signer-prod.testnet';
export const ED25519_DOMAIN_ID = 1; // public_key {domain_id:1} -> ed25519:... on testnet (evidence/testnet-mpc-views.txt)
export const SIGN_DEPOSIT_YOCTO = 1n; // near-mpc-contract-interface/src/deposits.rs
export const SIGN_MIN_GAS_TGAS = 15n; // config.sign_call_gas_attachment_requirement_tera_gas on testnet
const TWEAK_PREFIX = 'near-mpc-recovery v0.1.0 epsilon derivation:';

// ---------- base58 (bitcoin alphabet, as NEAR uses) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  let n = 0n;
  let i = 0;
  for (const b of bytes) {
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError(`base58Encode: byte at index ${i} is not an integer 0..255: ${String(b)}`);
    n = (n << 8n) | BigInt(b); i++;
  }
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
export function base58Decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 character: ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of str) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export function parseEd25519PublicKey(s) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(s);
  if (!m) throw new Error(`not an ed25519 NEAR public key: ${s}`);
  const bytes = base58Decode(m[1]);
  if (bytes.length !== 32) throw new Error(`ed25519 key must be 32 bytes, got ${bytes.length}`);
  return bytes;
}
export const formatEd25519PublicKey = (bytes) => `ed25519:${base58Encode(bytes)}`;

// ---------- tweak (kdf.rs) ----------
export function deriveTweak(predecessorId, path) {
  return new Uint8Array(createHash('sha3-256').update(`${TWEAK_PREFIX}${predecessorId},${path}`).digest());
}

// ---------- ed25519 point math (affine twisted Edwards, a = -1) ----------
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = P) => ((a % m) + m) % m;
function pow(b, e) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = mod(r * b); b = mod(b * b); e >>= 1n; }
  return r;
}
const inv = (a) => pow(a, P - 2n);
const D = mod(-121665n * inv(121666n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
const BASE = {
  x: 15112221349535400772501151409588531511454012693041857206046113283949847762202n,
  y: 46316835694926478169428394003475163141307993866256225615783033603165251855960n,
};
const IDENTITY = { x: 0n, y: 1n };

function add(p1, p2) {
  const t = mod(D * p1.x * p2.x * p1.y * p2.y);
  return {
    x: mod((p1.x * p2.y + p1.y * p2.x) * inv(1n + t)),
    y: mod((p1.y * p2.y + p1.x * p2.x) * inv(1n - t)),
  };
}
function mul(point, k) {
  let r = IDENTITY, q = point;
  while (k > 0n) { if (k & 1n) r = add(r, q); q = add(q, q); k >>= 1n; }
  return r;
}
const leToBig = (bytes) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);

function decompress(bytes) {
  const yRaw = leToBig(bytes);
  const sign = yRaw >> 255n;
  const y = yRaw & ((1n << 255n) - 1n);
  if (y >= P) throw new Error('point y out of range');
  const u = mod(y * y - 1n), v = mod(D * y * y + 1n);
  const x2 = mod(u * inv(v));
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * SQRT_M1);
  if (mod(x * x) !== x2) throw new Error('not a point on ed25519');
  if ((x & 1n) !== sign) x = mod(-x);
  return { x, y };
}
function compress({ x, y }) {
  let n = y | ((x & 1n) << 255n);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** derived = root + G * (tweak mod L), exactly derive_public_key_edwards_point_ed25519. */
export function deriveEd25519PublicKey(rootPublicKey, predecessorId, path) {
  const root = decompress(parseEd25519PublicKey(rootPublicKey));
  const tweak = mod(leToBig(deriveTweak(predecessorId, path)), L);
  return formatEd25519PublicKey(compress(add(root, mul(BASE, tweak))));
}

// ---------- borsh NEAR transaction (V0) ----------
class Writer {
  constructor() { this.parts = []; }
  bytes(b) { this.parts.push(Uint8Array.from(b)); return this; }
  u8(n) { return this.bytes([n]); }
  uint(n, size) {
    let v = BigInt(n);
    if (v < 0n || v >= 1n << BigInt(size * 8)) throw new Error(`u${size * 8} out of range: ${n}`);
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
    return this.bytes(b);
  }
  u32(n) { return this.uint(n, 4); }
  u64(n) { return this.uint(n, 8); }
  u128(n) { return this.uint(n, 16); }
  vec(b) { return this.u32(b.length).bytes(b); }
  string(s) { return this.vec(new TextEncoder().encode(s)); }
  publicKey(s) { return this.u8(0).bytes(parseEd25519PublicKey(s)); }
  done() { return Buffer.concat(this.parts); }
}

function writeAction(w, a) {
  switch (a.type) {
    case 'FunctionCall':
      w.u8(2).string(a.methodName).vec(new TextEncoder().encode(JSON.stringify(a.args)))
        .u64(a.gas).u128(a.deposit);
      return;
    case 'AddKey': {
      w.u8(5).publicKey(a.publicKey).u64(0); // access key nonce
      if (a.permission === 'FullAccess') { w.u8(1); return; }
      const p = a.permission;
      if (p === null || typeof p !== 'object' || typeof p.receiverId !== 'string' || !Array.isArray(p.methodNames)) {
        throw new Error(`unknown AddKey permission: ${JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
      }
      w.u8(0);
      if (p.allowance == null) w.u8(0); else w.u8(1).u128(p.allowance);
      w.string(p.receiverId).u32(p.methodNames.length);
      for (const m of p.methodNames) w.string(m);
      return;
    }
    default:
      throw new Error(`unsupported action type: ${a.type}`);
  }
}

export function serializeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const hash = typeof blockHash === 'string' ? base58Decode(blockHash) : blockHash;
  if (hash.length !== 32) throw new Error('blockHash must be 32 bytes');
  const w = new Writer().string(signerId).publicKey(publicKey).u64(nonce).string(receiverId).bytes(hash).u32(actions.length);
  for (const a of actions) writeAction(w, a);
  return w.done();
}

export const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

/**
 * Arguments for `sign` on the MPC contract (what the agent contract forwards).
 * NEAR verifies an ed25519 signature over sha256(borsh(tx)), so that hash is the Eddsa payload.
 */
export function buildSignRequest({ path, txHash }) {
  if (txHash.length !== 32) throw new Error('txHash must be 32 bytes');
  return { request: { path, payload_v2: { Eddsa: Buffer.from(txHash).toString('hex') }, domain_id: ED25519_DOMAIN_ID } };
}

/** Borsh SignedTransaction = Transaction || Signature { key_type: 0, 64 bytes }. For when MPC replies. */
export function attachSignature(txBytes, signature64) {
  if (signature64.length !== 64) throw new Error('ed25519 signature must be 64 bytes');
  return Buffer.concat([txBytes, Buffer.from([0]), Buffer.from(signature64)]);
}
