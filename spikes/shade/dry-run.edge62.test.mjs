import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan, DEFAULT_ACCOUNTS, PLACEHOLDER_LABEL, USER_SUPPLIED_LABEL, NOTICE, TESTNET_ED25519_ROOT } from './dry-run.mjs';
import { deriveEd25519PublicKey } from './chainsig.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const cli = join(here, 'dry-run.mjs');
const run = (args = [], opts = {}) => spawnSync(process.execPath, [...(opts.node ?? []), cli, ...args], { encoding: 'utf8', timeout: 30000 });
const P = { agent: 'a.testnet', path: 'p', executor: 'e.testnet', vault: 'v.testnet' };

test('plan() is deterministic: same input gives deep-equal output, no clock or randomness', () => {
  assert.deepEqual(plan(P), plan({ ...P }));
  assert.equal(JSON.stringify(plan(P)), JSON.stringify(plan(P)));
});

test('plan() output says dry-run everywhere it matters', () => {
  const p = plan(P);
  assert.equal(p.dryRun, true);
  assert.equal(p.notice, NOTICE);
  assert.match(p.notice, /^DRY RUN\./);
  assert.match(p.notice, /Nothing is sent\.$/);
});

test('plan() labels default accounts as placeholders and custom ones as user-supplied', () => {
  const d = plan({ ...DEFAULT_ACCOUNTS, path: 'p' });
  for (const role of ['agent', 'executor', 'vault']) assert.ok(d.accountStatus[role].endsWith(PLACEHOLDER_LABEL), role);
  const u = plan(P);
  for (const role of ['agent', 'executor', 'vault']) assert.ok(u.accountStatus[role].endsWith(USER_SUPPLIED_LABEL), role);
  // a default id used in the wrong role is still user-supplied
  const swapped = plan({ agent: DEFAULT_ACCOUNTS.vault, path: 'p', executor: DEFAULT_ACCOUNTS.executor, vault: DEFAULT_ACCOUNTS.agent });
  assert.ok(swapped.accountStatus.agent.endsWith(USER_SUPPLIED_LABEL));
  assert.ok(swapped.accountStatus.executor.endsWith(PLACEHOLDER_LABEL));
});

test('plan() derivation matches chainsig and uses the supplied root', () => {
  const p = plan(P);
  assert.equal(p.derivation.derivedKey, deriveEd25519PublicKey(TESTNET_ED25519_ROOT, 'a.testnet', 'p'));
  assert.equal(p.derivation.rootKey, TESTNET_ED25519_ROOT);
  const other = deriveEd25519PublicKey(TESTNET_ED25519_ROOT, 'zz', 'zz'); // any valid point as an alternate root
  const q = plan({ ...P, root: other });
  assert.equal(q.derivation.rootKey, other);
  assert.notEqual(q.derivation.derivedKey, p.derivation.derivedKey);
});

test('plan() throws a clear error for a bad root, and for missing agent or path', () => {
  assert.throws(() => plan({ ...P, root: 'nonsense' }), /not an ed25519/);
  assert.throws(() => plan({ ...P, agent: undefined }), /must be strings/);
  assert.throws(() => plan({ ...P, path: undefined }), /must be strings/);
  assert.throws(() => plan({ ...P, executor: undefined }), /expected a string/);
  assert.throws(() => plan({ ...P, vault: 42 }), /expected a string/);
});

test('plan() handles unicode and empty-ish ids deterministically', () => {
  const u = plan({ agent: 'é.testnet', path: '路径', executor: '日本.testnet', vault: 'v' });
  assert.equal(u.addKey.signerId, '日本.testnet');
  assert.match(u.swap.txSha256Base58, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(u.swap.txSha256Base58, plan({ agent: 'é.testnet', path: '路径', executor: '日本.testnet', vault: 'v' }).swap.txSha256Base58);
  assert.doesNotThrow(() => plan({ agent: '', path: '', executor: '', vault: '' }));
});

test('plan() swap hash depends on executor and vault, and mpcSignCall carries the same hash', () => {
  const a = plan(P), b = plan({ ...P, vault: 'other.testnet' }), c = plan({ ...P, executor: 'other.testnet' });
  assert.notEqual(a.swap.txSha256Base58, b.swap.txSha256Base58);
  assert.notEqual(a.swap.txSha256Base58, c.swap.txSha256Base58);
  assert.equal(a.mpcSignCall.args.request.path, 'p');
  assert.equal(a.mpcSignCall.minGasTgas, '15');
});

test('plan() output contains no private-key-shaped material and AddKey is vault-scoped, function-call only', () => {
  const p = plan(P);
  assert.doesNotMatch(JSON.stringify(p), /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}|private|secret|seed|mnemonic/i);
  assert.equal(p.addKey.action.permission.receiverId, 'v.testnet');
  assert.notEqual(p.addKey.action.permission, 'FullAccess');
  assert.equal(p.addKey.action.permission.allowance, null);
});

// ---------- CLI ----------
test('CLI default run: exit 0, stdout is pure JSON, stderr is exactly the one DRY RUN header line', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), plan({ agent: DEFAULT_ACCOUNTS.agent, path: 'yield-vault-1', executor: DEFAULT_ACCOUNTS.executor, vault: DEFAULT_ACCOUNTS.vault }));
  assert.equal(r.stderr, `dry-run: ${NOTICE}\n`);
  assert.match(r.stdout, /"dryRun": true/);
});

test('CLI is deterministic across runs, including with all options given', () => {
  const args = ['--agent', 'a.testnet', '--path', 'p', '--executor', 'e.testnet', '--vault', 'v.testnet'];
  const one = run(args), two = run(args);
  assert.equal(one.stdout, two.stdout);
  assert.deepEqual(JSON.parse(one.stdout), plan(P));
});

test('CLI accepts unicode option values and echoes them as valid JSON', () => {
  const r = run(['--agent', 'é.testnet', '--path', '路径 😀']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.derivation.predecessor, 'é.testnet');
  assert.equal(out.derivation.path, '路径 😀');
});

test('CLI --help and -h: exit 0, usage and "Sends nothing" on stdout, nothing on stderr', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^usage: node spikes\/shade\/dry-run\.mjs/);
    assert.match(r.stdout, /Sends nothing\./);
    assert.equal(r.stderr, '');
  }
});

test('CLI bad invocations give one clean "dry-run: ..." line on stderr, exit 2, no stack trace', () => {
  for (const args of [['--bogus'], ['--bogus', 'x'], ['-x'], ['--'], ['--root', 'x'], ['--AGENT', 'x'], ['--agent=a.testnet'], ['--agent', 'a', 'extra'], ['--help=1'], ['--agent', '--help'], ['']]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '', JSON.stringify(args));
    assert.match(r.stderr, /^dry-run: [^\n]+\n$/, JSON.stringify(args));
    assert.doesNotMatch(r.stderr, /\n\s+at |node:internal|TypeError|Error:/, JSON.stringify(args));
  }
});

test('CLI repeated option: last value wins', () => {
  const r = run(['--agent', 'first.testnet', '--agent', 'second.testnet']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).derivation.predecessor, 'second.testnet');
});

test('CLI option error is reported before --help only if it comes first', () => {
  assert.equal(run(['--help', '--bogus']).status, 0);
  assert.equal(run(['--bogus', '--help']).status, 2);
});

test('CLI ignores the ambient environment: no env var changes the output', () => {
  const base = run().stdout;
  const r = spawnSync(process.execPath, [cli], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NEAR_ENV: 'mainnet', NEAR_RPC_URL: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NEAR_ACCOUNT_ID: 'x.near' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, base);
});

test('CLI never touches the network: a preload that throws on any network use is never tripped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'edge62-net-'));
  try {
    const marker = join(dir, 'tripped.txt');
    const preload = join(dir, 'guard.mjs');
    // Writing to the marker (rather than only throwing) means a swallowed exception is still detected.
    writeFileSync(preload, `
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const trip = (what) => () => { appendFileSync(${JSON.stringify(marker)}, what + '\\n'); throw new Error('network use: ' + what); };
globalThis.fetch = trip('fetch');
globalThis.WebSocket = trip('WebSocket');
const net = require('node:net');
net.Socket.prototype.connect = trip('net.Socket.connect');
net.connect = trip('net.connect');
net.createConnection = trip('net.createConnection');
for (const m of ['node:http', 'node:https']) { const mod = require(m); mod.request = trip(m + '.request'); mod.get = trip(m + '.get'); }
require('node:tls').connect = trip('tls.connect');
const dns = require('node:dns');
for (const f of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[f] = trip('dns.' + f);
require('node:dns/promises').lookup = trip('dns.promises.lookup');
require('node:dgram').createSocket = trip('dgram.createSocket');
const cp = require('node:child_process');
for (const f of ['spawn', 'exec', 'execFile', 'fork']) cp[f] = trip('child_process.' + f);
process.env.EDGE62_GUARD_LOADED = '1';
`);
    // Positive control: the guard really fires and is recorded, so a clean run below is meaningful.
    const control = join(dir, 'control.mjs');
    writeFileSync(control, `try { await fetch('http://127.0.0.1:1/'); } catch (e) { console.log(process.env.EDGE62_GUARD_LOADED + ':' + e.message); }`);
    const c = spawnSync(process.execPath, ['--import', preload, control], { encoding: 'utf8', timeout: 30000 });
    assert.equal(c.stdout.trim(), '1:network use: fetch', c.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'fetch\n');
    rmSync(marker);

    for (const args of [[], ['--help'], ['--agent', 'a.testnet', '--path', 'p'], ['--bogus']]) {
      const r = run(args, { node: ['--import', preload] });
      assert.ok([0, 2].includes(r.status), `${JSON.stringify(args)}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /network use/);
    }
    assert.throws(() => readFileSync(marker), { code: 'ENOENT' }, 'guard marker exists: the CLI touched the network or spawned a process');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dry-run.mjs imports only local/Node-builtin non-network modules and has no network API calls', () => {
  const src = readFileSync(cli, 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(specs.sort(), ['./chainsig.mjs', 'node:fs', 'node:url']);
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket|child_process)\b|import\(|process\.env/);
});

test('importing dry-run.mjs as a module has no side effects (prints nothing, does not exit)', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import ${JSON.stringify('file://' + cli)}; console.log('imported');`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'imported\n');
  assert.equal(r.stderr, '');
});
