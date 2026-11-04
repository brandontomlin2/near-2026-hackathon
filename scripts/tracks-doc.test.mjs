import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const doc = readFileSync(new URL('docs/tracks.md', root), 'utf8');
const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts;

test('docs/tracks.md names at least one npm script', () => {
  assert.ok(doc.match(/npm run [\w:-]+/g)?.length > 0);
});

test('every `npm run <script>` in docs/tracks.md exists in package.json', () => {
  const used = new Set([...doc.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]));
  for (const name of used) {
    assert.ok(Object.hasOwn(scripts, name), `npm run ${name} is not in package.json`);
  }
});
