// Public-repo hygiene for the Yield Optimizer vault docs.
// A fresh clone cannot open files on the developer's machine, so the vault
// docs must not cite local absolute paths, must not call AI agent reviews an
// independent audit, and must document the same VaultState that lib.rs returns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VAULT_README = 'contracts/yield-vault/README.md';
const LIB_RS = 'contracts/yield-vault/src/lib.rs';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function vaultDocs() {
  const yieldDocs = readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => /^yield.*\.md$/.test(f))
    .map((f) => `docs/${f}`);
  return [VAULT_README, ...yieldDocs];
}

// Absolute paths into a local home or temp directory.
const LOCAL_PATH = /(^|[^\w.:/-])(\/Users\/|\/tmp\/|\/home\/[a-z]|\/private\/var\/|~\/\.claude)/;

test('vault docs set is not empty (the scan below is not vacuous)', () => {
  const docs = vaultDocs();
  assert.ok(docs.includes(VAULT_README));
  assert.ok(docs.length >= 3, `expected the vault README plus docs/yield*.md, got ${docs.join(', ')}`);
});

test('vault docs cite no local absolute paths', () => {
  const hits = [];
  for (const rel of vaultDocs()) {
    read(rel).split('\n').forEach((line, i) => {
      if (LOCAL_PATH.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], `local paths found:\n${hits.join('\n')}`);
});

test('the local-path pattern catches the paths it is meant to catch', () => {
  for (const bad of [
    'see `/Users/someone/notes.md`',
    'report (/tmp/review.md)',
    'path /home/dev/x',
    'log at ~/.claude/logs/a.md',
  ]) assert.ok(LOCAL_PATH.test(bad), bad);
  for (const ok of ['https://docs.near.org/tmp/x', 'out/yield-demo/plan.json', 'src/tmp/x']) {
    assert.ok(!LOCAL_PATH.test(ok), ok);
  }
});

test('vault and root READMEs do not call the AI reviews an independent audit', () => {
  for (const rel of [VAULT_README, 'README.md']) {
    const text = read(rel);
    assert.doesNotMatch(text, /\ban independent (audit|review)\b/i, rel);
  }
  assert.match(read(VAULT_README), /AI review agents/);
  assert.match(read(VAULT_README), /No professional or independent auditor/);
});

function structFields(src, name) {
  const m = src.match(new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `struct ${name} not found in ${LIB_RS}`);
  return [...m[1].matchAll(/^\s*pub (\w+):/gm)].map((x) => x[1]);
}

test('README VaultState lists exactly the fields of lib.rs VaultState, in order', () => {
  const rust = structFields(read(LIB_RS), 'VaultState');
  const block = read(VAULT_README).match(/VaultState\s+\{([\s\S]*?)\}/);
  assert.ok(block, 'VaultState block not found in the vault README');
  const documented = [...block[1].matchAll(/(\w+)(?=\s*[,}:]|\s*$)/g)]
    .map((x) => x[1])
    .filter((w) => /^[a-z_]+$/.test(w) && w !== 'u64' && w !== 'bool');
  assert.ok(rust.includes('unverified_on_ref'));
  assert.deepEqual(documented, rust);
});
