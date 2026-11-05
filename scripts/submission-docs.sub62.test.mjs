// Submission docs must only quote npm scripts and repo paths that exist.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['docs/demo-script.md', 'docs/demo-video.md', 'docs/judge-checklist.md'];
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const topLevel = new Set(tracked.map((f) => f.split('/')[0]));

// Every `npm run <name>` anywhere in the text (script names may hold ':' and '-').
function extractCommands(text) {
  return [...text.matchAll(/\bnpm run ([A-Za-z0-9](?:[\w:-]*\w)?)/g)].map((m) => m[1]);
}

// Repo paths inside backticks: a word whose first segment is a tracked top-level
// entry and which has a '/' or is itself a top-level file. out/ is generated; globs and placeholders are skipped.
function extractPaths(text) {
  const found = new Set();
  for (const [, code] of text.matchAll(/`([^`\n]+)`/g)) {
    for (let word of code.split(/[\s"'()\\|;&]+/)) {
      word = word.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/[.,;:!?]+$/, '');
      if (!word || /[*<{]|\.\.\./.test(word)) continue;
      const first = word.split('/')[0];
      if (first === 'out' || !topLevel.has(first)) continue;
      if (word.includes('/') || tracked.includes(word)) found.add(word);
    }
  }
  return [...found];
}

const missingScripts = (names) => names.filter((n) => !Object.hasOwn(scripts, n));
// Tracked in git (what a fresh clone gets), not merely present on this disk.
const isTracked = (p) => {
  const dir = p.replace(/\/$/, '') + '/';
  return tracked.includes(p) || tracked.some((f) => f.startsWith(dir));
};
const missingPaths = (paths) => paths.filter((p) => !isTracked(p));

describe('submission docs reference real scripts and paths', () => {
  for (const doc of DOCS) {
    const text = readFileSync(join(root, doc), 'utf8');
    const commands = extractCommands(text);
    const paths = extractPaths(text);

    it(`${doc}: extractor finds paths (and commands where the doc has any)`, () => {
      assert.ok(paths.length >= 3, `${doc}: only ${paths.length} repo paths found`);
      if (doc !== 'docs/judge-checklist.md') {
        assert.ok(commands.length >= 3, `${doc}: only ${commands.length} npm run commands found`);
      }
      assert.ok(commands.length >= 1, `${doc}: no npm run command found`);
    });

    it(`${doc}: every npm run names a package.json script`, () => {
      const bad = missingScripts(commands);
      assert.deepEqual(bad, [], `${doc}: "npm run ${bad.join('", "npm run ')}" is not in package.json scripts`);
    });

    it(`${doc}: every quoted repo path exists`, () => {
      const bad = missingPaths(paths);
      assert.deepEqual(bad, [], `${doc}: quoted path(s) ${bad.map((p) => `\`${p}\``).join(', ')} are not tracked in the repo`);
    });
  }

  it('self-check: a fake script and a fake path are reported missing', () => {
    const sample = 'Run `npm run nope-xyz` then open `scripts/does-not-exist.mjs` or `npm run demo` in `out/x.json`.';
    assert.deepEqual(missingScripts(extractCommands(sample)), ['nope-xyz']);
    assert.deepEqual(extractPaths(sample), ['scripts/does-not-exist.mjs']);
    assert.deepEqual(missingPaths(extractPaths(sample)), ['scripts/does-not-exist.mjs']);
  });
});
